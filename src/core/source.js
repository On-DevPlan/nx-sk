// 原始资料袋（`type: 'source'`）的条目形状与归一规则。
//
// 为什么单独一个 core 模块：这份形状同时被 CLI、面板、kv-source skill 三处读写。
// 形状若各写一份，迟早漂成「面板能显示、agent 读不出」——所以口径只此一处。
//
// 一条 item 的形状：
//   { id, kind, name, text?, fileId?, url?, addedAt, at?, note?, mapped?,
//     superseded?, supersededBy?, supersedes? }
//
//   kind   text = 粘贴进来的文字；file = 附件库里的原件（fileId）；url = 一个网址
//   name   人读的名字（用户可改），默认从内容推断
//   mapped 整理去向：这条资料已经被同步到哪些字段 key（双向同步的锚点）
//   at     **资料自身的时间**（如邮件时间）；缺省用 addedAt（入袋时间）
//   superseded / supersededBy  被更新的一条取代（旧的**留痕**，不删）
//
// 三条纪律写在代码里，不只是文档：
//   1. **只增不删**——袋里的东西是原始证据，整理完也留着（要删由人显式做）。
//   2. **原文不改写**——text 原样存，整理后的结果写进**字段**或写进新的一条，
//      不就地改写原件（否则「原始」这个词就没意义了）。
//   3. **冲突以新的为准，但旧的留痕**——同名即冲突（同一件事有了新版本）：
//      时间新的那条是「当前版本」，旧的被标 `superseded` 但**仍留在袋里**。
import { newId, nowIso } from './ids.js';

export const SOURCE_KINDS = ['text', 'file', 'url'];

/** 单条上限：袋子是暂存区，不是仓库。真要存几百条就该分条目存，而不是把一个条目塞爆。 */
export const SOURCE_MAX_ITEMS = 500;

export function isSourceItem(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && SOURCE_KINDS.includes(x.kind);
}

/** 这段数组像不像一袋 source（用于「没登记过的键自动推断类型」）。 */
export function looksLikeSourceList(list) {
  if (!Array.isArray(list) || !list.length) return false;
  if (!list.every(isSourceItem)) return false;
  // 光有 kind 不够（entrylist 的列也可能叫 kind）——还得带内容字段之一
  return list.some((x) => x.text || x.fileId || x.url);
}

/**
 * 这条资料的时间：`at`（资料自身的时间，如邮件时间）优先，否则用入袋时间。
 * 「以新的为准」比的就是它。
 */
export function sourceItemTime(item) {
  const t = Date.parse(item?.at || item?.addedAt || '');
  return Number.isFinite(t) ? t : 0;
}

function inferName(item) {
  if (item.name) return String(item.name).trim();
  if (item.kind === 'url') return String(item.url || '').slice(0, 60);
  if (item.kind === 'file') return String(item.fileId || '附件');
  const first = String(item.text || '').split('\n').find((l) => l.trim()) || '';
  return first.trim().slice(0, 40) || '一段文字';
}

/**
 * 归一一条 item：补 id / name / addedAt，丢掉没有内容的空壳。
 * 返回 null = 这条是空的（直接丢弃，不报错）。
 */
export function normalizeSourceItem(raw, { id, addedAt } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = SOURCE_KINDS.includes(raw.kind) ? raw.kind : 'text';
  const item = {
    id: String(raw.id || id || newId('s')),
    kind,
    name: inferName(raw),
    addedAt: raw.addedAt || addedAt || nowIso(),
  };
  if (kind === 'text') {
    const text = String(raw.text ?? '').trim();
    if (!text) return null;
    item.text = text;
  } else if (kind === 'file') {
    const fileId = String(raw.fileId || '').trim();
    if (!fileId) return null;
    item.fileId = fileId;
  } else {
    const url = String(raw.url || '').trim();
    if (!url) return null;
    item.url = url;
  }
  if (raw.at) item.at = String(raw.at);
  if (raw.note) item.note = String(raw.note);
  if (Array.isArray(raw.mapped) && raw.mapped.length) item.mapped = raw.mapped.map(String);
  if (raw.superseded === true) item.superseded = true;
  if (raw.supersededBy) item.supersededBy = String(raw.supersededBy);
  if (Array.isArray(raw.supersedes) && raw.supersedes.length) item.supersedes = raw.supersedes.map(String);
  return item;
}

/**
 * 冲突判定：**同名即冲突**（同一件事有了新版本），**以新的为准**。
 *
 * 规则只有一条，但它是整套「乱入 → 整理」能长期用的前提：
 * 用户第二次发来同一封邮件（改了密码），新的一条成为「当前版本」，
 * 旧的那条**不删**（原始证据要留痕），只被标成 `superseded` + 指到取代它的那条。
 * 面板与 CLI 都能一眼看出「这条是旧版」——但它还在，随时能翻回去看。
 *
 * 显式指定也支持：`--supersedes <id>`（新条指向旧条）会把旧条同样标成被取代。
 */
export function resolveSourceConflicts(items) {
  const out = (items || []).map((x) => ({ ...x }));
  // 显式取代：新条指向的旧条，一律标被取代
  for (const it of out) {
    for (const oldId of it.supersedes || []) {
      const old = out.find((x) => x.id === oldId);
      if (old && old.id !== it.id) { old.superseded = true; old.supersededBy = it.id; }
    }
  }
  // 同名冲突：时间新的胜出（同时间则后加入的胜出）
  const byName = new Map();
  for (const it of out) {
    const key = String(it.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(it);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (sourceItemTime(a) - sourceItemTime(b)) || String(a.addedAt).localeCompare(String(b.addedAt)));
    const newest = sorted[sorted.length - 1];
    for (const it of sorted.slice(0, -1)) {
      it.superseded = true;
      it.supersededBy = newest.id;
    }
  }
  return out;
}

/**
 * 归一整袋。接受三种入口：
 *   - 数组（面板/JSON）
 *   - JSON 串（CLI `--set source='[...]'`）
 *   - 一段普通文字（CLI `--set source=随手记`）→ 变成一条 text item
 */
export function normalizeSourceItems(raw) {
  if (raw === null || raw === undefined) return null;
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.startsWith('[') || s.startsWith('{')) {
      try { list = JSON.parse(s); } catch { list = [{ kind: 'text', text: s }]; }
    } else {
      list = [{ kind: 'text', text: s }];
    }
  }
  if (!Array.isArray(list)) {
    if (isSourceItem(list)) list = [list];
    else list = [{ kind: 'text', text: String(list) }];
  }
  const out = [];
  for (const item of list) {
    const norm = normalizeSourceItem(item);
    if (norm) out.push(norm);
  }
  if (out.length > SOURCE_MAX_ITEMS) {
    throw new Error(`原始资料最多 ${SOURCE_MAX_ITEMS} 条，收到 ${out.length} 条——多了就分成多个条目存`);
  }
  if (!out.length) return null;
  // 冲突判定放在归一这一层：无论数据从哪条路进来（面板 / CLI / 导入），
  // 「同名以新的为准、旧的留痕」都只在这一处发生，不会各写一遍。
  return resolveSourceConflicts(out);
}

/** 当前版本（没被取代的）——面板默认只显示这些，旧的留痕但可展开看。 */
export function currentSourceItems(items) {
  return (items || []).filter((x) => !x.superseded);
}

/** 一条 item 的人读摘要（CLI 一行一条、面板清单副标题都用它）。 */
export function sourceItemSummary(item) {
  if (!isSourceItem(item)) return '';
  if (item.kind === 'url') return item.url || '';
  if (item.kind === 'file') return `附件 ${item.fileId}`;
  const t = String(item.text || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** 人读时间：优先资料自身的时间（at），否则入袋时间。 */
export function sourceItemTimeLabel(item) {
  const raw = item?.at || item?.addedAt || '';
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
