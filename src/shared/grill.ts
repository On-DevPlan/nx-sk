// grill（Grill & Ack）字段的**唯一数据契约**：后端归一、CLI 渲染、面板表单共用。
//
// 这个字段不是「再存一段文本」，而是把一次对齐拆成可逐条回答的问题：
//   AI 写 questions → 用户在面板里填 answer / note / freeform → 面板写 ack。
// 值整体存成 JSON，跟着条目走；没有第二份「答案表」。
//
// 设计底线：
//   - questions 由 AI 写，用户不靠删除问题来表达「不认同」——每条都有 note 写理由；
//   - ack 不是装饰：只有 required 问题全部有 answer 才算 acknowledged；任何修改会把 ack 拉回 pending；
//   - 面板与 CLI 只读这一份 Doc，不各自解释另一种形状。
import type { GrillAnswer, GrillDoc, GrillOption, GrillQuestion, GrillQuestionKind } from './fields/types.ts';

export const GRILL_SCHEMA = 'nx-sk/grill@1';

const KIND_ALIASES: Record<string, GrillQuestionKind> = {
  single: 'single',
  radio: 'single',
  choice: 'single',
  multi: 'multi',
  checkbox: 'multi',
  checkboxes: 'multi',
  multiple: 'multi',
  text: 'text',
  textarea: 'text',
  input: 'text',
  longtext: 'text',
  confirm: 'confirm',
  bool: 'confirm',
  boolean: 'confirm',
  yesno: 'confirm',
  yes_no: 'confirm',
};

export const GRILL_KIND_LABELS: Record<GrillQuestionKind, string> = {
  single: '单选',
  multi: '多选',
  text: '填空',
  confirm: '确认',
};

function blankDoc(): GrillDoc {
  return {
    v: 1,
    schema: GRILL_SCHEMA,
    title: '',
    intro: '',
    prompt: '',
    questions: [],
    freeform: '',
    ack: { status: 'pending' },
  };
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function boolOrNull(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return null;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['是', '对', '同意', 'true', 'yes', 'y', '1', 'ok', '确认'].includes(s)) return true;
    if (['否', '不', '不同意', 'false', 'no', 'n', '0', '取消'].includes(s)) return false;
  }
  return null;
}

function normalizeKind(v: unknown): GrillQuestionKind {
  const key = str(v).trim().toLowerCase().replace(/[-\s]+/g, '_');
  return KIND_ALIASES[key] || 'text';
}

function normalizeOptions(raw: unknown): GrillOption[] {
  if (!Array.isArray(raw)) return [];
  const options: GrillOption[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string' || typeof item === 'number') {
      const label = String(item).trim();
      if (label) options.push({ value: label, label });
      continue;
    }
    if (typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const label = str(o.label ?? o.value ?? o.text).trim();
    const value = str(o.value ?? label).trim() || label;
    if (!label && !value) continue;
    const out: GrillOption = { value, label: label || value };
    if (str(o.detail ?? o.hint ?? o.description).trim()) out.detail = str(o.detail ?? o.hint ?? o.description);
    if (o.recommended === true || o.suggested === true || o.default === true) out.recommended = true;
    options.push(out);
  }
  return options;
}

function normalizeAnswer(kind: GrillQuestionKind, raw: unknown): GrillAnswer {
  if (raw === null || raw === undefined) return null;
  if (kind === 'confirm') return boolOrNull(raw);
  if (kind === 'multi') {
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[,，、;；\n]/) : []);
    const out = list.map((x) => str(x).trim()).filter(Boolean);
    return out.length ? [...new Set(out)] : null;
  }
  if (Array.isArray(raw)) {
    const first = raw.map((x) => str(x).trim()).filter(Boolean)[0];
    return first || null;
  }
  const s = str(raw).trim();
  return s || null;
}

function normalizeQuestion(raw: unknown, index: number, usedIds: Set<string>): GrillQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const q = raw as Record<string, unknown>;
  const kind0 = normalizeKind(q.kind ?? q.type);
  const options = normalizeOptions(q.options ?? q.choices);
  let kind = kind0;
  // 单选/多选却没有候选 = 一条填空。硬撑成空单选只会让用户无路可走。
  if ((kind === 'single' || kind === 'multi') && !options.length) {
    kind = 'text';
  }
  const title = str(q.title ?? q.label ?? q.question ?? q.text).trim() || `待确认 ${index + 1}`;
  const id0 = str(q.id ?? q.key).trim().replace(/\s+/g, '-');
  let id = id0 || `q${index + 1}`;
  if (usedIds.has(id)) {
    let n = 2;
    while (usedIds.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  usedIds.add(id);
  const out: GrillQuestion = {
    id,
    kind,
    title,
    required: q.required !== false && q.optional !== true,
    options: kind === 'single' || kind === 'multi' ? options : [],
    answer: normalizeAnswer(kind, q.answer ?? q.value ?? q.response),
    note: str(q.note ?? q.reason ?? q.comment).trim(),
  };
  const detail = str(q.detail ?? q.description ?? q.hint ?? q.why).trim();
  if (detail) out.detail = detail;
  const placeholder = str(q.placeholder ?? q.eg ?? q.example).trim();
  if (placeholder) out.placeholder = placeholder;
  return out;
}

function normalizeAck(raw: unknown, questions: GrillQuestion[], answered: number, total: number): GrillDoc['ack'] {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawStatus = str(a.status ?? a.state).trim().toLowerCase();
  const acknowledged = rawStatus === 'acknowledged' || rawStatus === 'confirmed' || rawStatus === 'done';
  // 不信任调用方给的 status：required 没答完就不是 ack，避免 agent 自己把「已确认」写进来。
  if (!acknowledged || answered < total) return { status: 'pending' };
  const out: GrillDoc['ack'] = {
    status: 'acknowledged',
    answered,
    total,
  };
  const at = str(a.at ?? a.acknowledgedAt ?? a.confirmedAt).trim();
  if (at) out.at = at;
  const by = str(a.by ?? a.acknowledgedBy ?? a.confirmedBy).trim();
  if (by) out.by = by;
  return out;
}

function makeDoc(raw: Record<string, unknown>): GrillDoc {
  const used = new Set<string>();
  const qsRaw = Array.isArray(raw.questions)
    ? raw.questions
    : (raw.questions && typeof raw.questions === 'object' ? [raw.questions] : []);
  const questions = qsRaw
    .map((q, i) => normalizeQuestion(q, i, used))
    .filter((q): q is GrillQuestion => Boolean(q));
  const doc: GrillDoc = {
    v: 1,
    schema: GRILL_SCHEMA,
    title: str(raw.title ?? raw.name ?? raw.label).trim(),
    intro: str(raw.intro ?? raw.description ?? raw.guide ?? raw.body).trim(),
    prompt: str(raw.prompt ?? raw.source ?? raw.original ?? raw.userPrompt ?? raw.context).trim(),
    questions,
    freeform: str(raw.freeform ?? raw.notes ?? raw.extra ?? raw.additional).trim(),
    ack: { status: 'pending' },
  };
  const p = grillProgress(doc);
  doc.ack = normalizeAck(raw.ack ?? raw.acknowledgement ?? raw.confirmed, questions, p.answered, p.total);
  return doc;
}

/**
 * 宽松解析：空值给空单，坏 JSON / 非对象抛可读错误。
 * 面板与后端都用这一份；后端在外层把 Error 包成 badInput。
 */
export function parseGrill(raw: unknown): GrillDoc {
  if (raw === null || raw === undefined) return blankDoc();
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return blankDoc();
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new Error('grill 字段的值要是 JSON（对象或问题数组），例如 {"questions":[{"type":"text","title":"…"}]}');
    }
    return parseGrill(parsed);
  }
  if (Array.isArray(raw)) return makeDoc({ questions: raw });
  if (typeof raw !== 'object') {
    throw new Error(`grill 字段的值要是 JSON 对象，收到 ${JSON.stringify(raw).slice(0, 80)}`);
  }
  return makeDoc(raw as Record<string, unknown>);
}

export function isGrillAnswered(q: GrillQuestion): boolean {
  if (q.kind === 'confirm') return typeof q.answer === 'boolean';
  if (q.kind === 'multi') return Array.isArray(q.answer) && q.answer.length > 0;
  return typeof q.answer === 'string' && q.answer.trim().length > 0;
}

export function grillProgress(doc: GrillDoc): { answered: number; total: number; optional: number; all: boolean } {
  const required = doc.questions.filter((q) => q.required);
  const optional = doc.questions.length - required.length;
  const answered = required.filter(isGrillAnswered).length;
  return { answered, total: required.length, optional, all: answered >= required.length };
}

export function answerText(q: GrillQuestion): string {
  if (!isGrillAnswered(q)) return '';
  if (q.kind === 'confirm') return q.answer === true ? '是' : '否';
  if (q.kind === 'single') {
    const v = String(q.answer);
    return q.options.find((o) => o.value === v)?.label || v;
  }
  if (q.kind === 'multi') {
    const values = q.answer as string[];
    return values.map((v) => q.options.find((o) => o.value === v)?.label || v).join('、');
  }
  return String(q.answer);
}

/** 面板折叠条 / template dump 用的极短摘要。 */
export function grillSummary(doc: GrillDoc): string {
  const p = grillProgress(doc);
  const state = doc.ack.status === 'acknowledged' ? '已确认' : '待确认';
  return `${state} ${p.answered}/${p.total}`;
}

/** CLI 人读渲染：一条问题一段，答案和备注都在。 */
export function formatGrill(doc: GrillDoc): string[] {
  const p = grillProgress(doc);
  const head = `${doc.ack.status === 'acknowledged' ? '已确认' : '待确认'} · 必答 ${p.answered}/${p.total}`
    + (p.optional ? ` · 可选 ${p.optional}` : '')
    + (doc.ack.at ? ` · ${doc.ack.at}` : '');
  const lines = [head];
  if (doc.intro) lines.push(`说明：${doc.intro}`);
  if (doc.prompt) lines.push(`原话：${doc.prompt.replace(/\s+/g, ' ').slice(0, 180)}${doc.prompt.length > 180 ? '…' : ''}`);
  for (const q of doc.questions) {
    lines.push(`  [${GRILL_KIND_LABELS[q.kind]}${q.required ? '' : '·可选'}] ${q.title}`);
    const a = answerText(q);
    lines.push(`    回答: ${a || '（未答）'}`);
    if (q.note) lines.push(`    备注: ${q.note}`);
  }
  if (doc.freeform) lines.push(`  补充: ${doc.freeform}`);
  return lines;
}
