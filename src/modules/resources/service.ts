// 内部资源检索与定位解析（任务 #18）。
//
// 两个只读出口，是 debug 引用字段与前端搜索面板的**共用后端**：
//   · searchResources：跨全部内部资源（栏目/条目/字段/附件）搜关键字，
//     每项返回 { locator, kind, title, subtitle, sectionId?, entryId?, key? }；
//   · resolveLocator：给一个 locator 返回它指向资源的存在性与摘要。
//     找不到就 NOT_FOUND，不静默——「链接性」的前提是坏链能被看见。
//
// 密文边界：resolve 的字段值**默认打码**（locator 文本是要粘给 agent / 进剪贴板的，
// 默认吐原文等于给敏感值开了第二个出口）；`--reveal` 才解密出原文。
import { existsSync } from 'node:fs';
import { loadStore, entryStructures, isDetachedField, type StoreSection, type EntryFieldView } from '../../core/store.ts';
import { findSection, isSensitiveField, sectionNames } from '../../core/fields.ts';
import { parseLocator, formatLocator, locatorAliases, type LocatorParts } from '../../shared/locator.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { displaySensitive } from '../../core/sensitive.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { completeness } from '../../core/render.ts';
import { displayPath } from '../../core/paths.ts';
import { fileRecordAbs, fileLinks } from '../../core/attachments.ts';
import type { FieldDef } from '../../shared/fields/types.ts';

/** 检索命中的一项（面板分组与 CLI 共用这份形状）。 */
export interface ResourceHit {
  locator: string;
  kind: string;
  title: string;
  subtitle: string;
  sectionId?: string;
  entryId?: string;
  key?: string;
}

const hay = (...parts: unknown[]) => parts.map((p) => String(p ?? '')).join('\n').toLowerCase();
const match = (needle: string, ...parts: unknown[]) => hay(...parts).includes(needle);

/** 字段命中的构造：模板字段用 <sectionId> 段（等价旧写法见 locatorAliases）；带 entryId 时是条目-字段位置。 */
function fieldHit(sec: StoreSection, def: { key: string; label?: string }, entryId?: string, entryTitle?: string): ResourceHit {
  const parts: LocatorParts = entryId
    ? { kind: 'field', entryId, key: def.key }
    : { kind: 'field', sectionId: sec.id, key: def.key };
  return {
    locator: formatLocator(parts),
    kind: 'field',
    title: String(def.label || def.key),
    subtitle: entryId ? `${sec.title} › 条目 ${entryTitle || entryId}` : `${sec.title}（栏目字段）`,
    sectionId: sec.id,
    ...(entryId ? { entryId } : {}),
    key: def.key,
  };
}

export async function searchResources({ q, kind, section, scope }: { q?: unknown; kind?: string; section?: string; scope?: string } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  const needle = String(q ?? '').trim().toLowerCase();
  let sections = store.sections;
  if (section) {
    const sec = findSection(store, section);
    if (!sec) throw notFound(`找不到栏目: ${section} —— 现有: ${sectionNames(store)}`);
    sections = [sec];
  }
  const want = (k: string) => !kind || kind === k;
  // #21：debug 引用面板口径——只出**数据位置**（条目/条目-字段/附件）。
  // 栏目命中与模板字段命中（结构）不出现；字段命中改为「各条目的结构行」（含模板行），
  // locator 直接就是 `nx-sk://field/<条目id>/<key>`——面板格子内联数据板要绑的就是这个位置。
  const debugScope = scope === 'debug';

  const items: ResourceHit[] = [];
  for (const sec of sections) {
    if (want('section') && !debugScope && (!needle || match(needle, sec.id, sec.title, sec.description))) {
      items.push({
        locator: formatLocator({ kind: 'section', sectionId: sec.id }),
        kind: 'section', title: sec.title, subtitle: `栏目 ${sec.id}`, sectionId: sec.id,
      });
    }
    const mine = store.entries.filter((e) => e.section === sec.id);
    if (want('entry')) {
      for (const e of mine) {
        if (!needle || match(needle, e.title, (e.tags || []).join(' '), sec.title)) {
          items.push({
            locator: formatLocator({ kind: 'entry', entryId: e.id }),
            kind: 'entry', title: e.title || '（无标题）', subtitle: sec.title,
            sectionId: sec.id, entryId: e.id,
          });
        }
      }
    }
    if (want('field')) {
      if (debugScope) {
        for (const e of mine) {
          for (const r of structures.get(e.id) || []) {
            if (isDetachedField(r)) continue;
            if (!needle || match(needle, r.key, r.label)) items.push(fieldHit(sec, { key: r.key, label: r.label }, e.id, e.title));
          }
        }
      } else {
        // 栏目字典字段（= 全局字段；等价旧写法是复合串 `section:key`）
        for (const def of sec.fields) {
          if (!needle || match(needle, def.key, def.label)) items.push(fieldHit(sec, def));
        }
        // 条目扩展行（quickAdd / 条目内 add-field 出来的、不在字典的行）
        for (const e of mine) {
          for (const r of structures.get(e.id) || []) {
            if (r.templateFieldId != null) continue;
            if (!needle || match(needle, r.key, r.label)) items.push(fieldHit(sec, { key: r.key, label: r.label }, e.id, e.title));
          }
        }
      }
    }
  }
  if (want('file')) {
    for (const f of store.files) {
      if (!needle || match(needle, f.name, f.note, (f.tags || []).join(' '))) {
        items.push({
          locator: formatLocator({ kind: 'file', fileId: f.id }),
          kind: 'file', title: f.name, subtitle: `附件 ${f.ext || ''}`.trim(),
        });
      }
    }
  }
  return { count: items.length, q: String(q ?? ''), kind: kind || null, section: section || null, items };
}

/** resolve 的返回：kind + locator 原样 + exists + 各类型的摘要键。 */
export interface ResolveResult {
  locator: string;
  kind: string;
  exists: boolean;
  aliases: string[];
  [k: string]: unknown;
}

export async function resolveLocator(loc: unknown, { reveal = false }: { reveal?: boolean } = {}): Promise<ResolveResult> {
  const text = String(loc ?? '').trim();
  const parts = parseLocator(text);
  if (!parts) {
    throw badInput(
      `无法解析定位符: ${JSON.stringify(text)}。`
      + '写法: nx-sk://section/<id> | nx-sk://entry/<id> | nx-sk://field/<条目id或栏目id>/<key> | nx-sk://file/<id>（模板字段也可用旧复合串 <栏目>:<key>）',
    );
  }
  const locator = formatLocator(parts);
  const aliases = locatorAliases(parts);
  const store = await loadStore();
  const structures = entryStructures(store);

  if (parts.kind === 'section') {
    const sec = store.sections.find((s) => s.id === parts.sectionId);
    if (!sec) throw notFound(`栏目不存在: ${parts.sectionId}`);
    return {
      locator, kind: 'section', exists: true, aliases,
      sectionId: sec.id, title: sec.title, description: sec.description,
      entryCount: store.entries.filter((e) => e.section === sec.id).length,
    };
  }

  if (parts.kind === 'entry') {
    const entry = store.entries.find((e) => e.id === parts.entryId);
    if (!entry) throw notFound(`条目不存在: ${parts.entryId}`);
    const sec = store.sections.find((s) => s.id === entry.section) || null;
    const c = sec ? completeness(sec, entry, structures.get(entry.id)) : null;
    return {
      locator, kind: 'entry', exists: true, aliases,
      entryId: entry.id, title: entry.title,
      sectionId: entry.section, sectionTitle: sec?.title || '',
      completeness: c ? { filled: c.filled, total: c.total, ratio: c.ratio } : null,
      updatedAt: entry.updatedAt,
    };
  }

  if (parts.kind === 'file') {
    const rec = store.files.find((f) => f.id === parts.fileId);
    if (!rec) throw notFound(`附件记录不存在: ${parts.fileId}`);
    return {
      locator, kind: 'file', exists: true, aliases,
      fileId: rec.id, title: rec.name, name: rec.name, ext: rec.ext, bytes: rec.bytes,
      path: displayPath(fileRecordAbs(rec)),
      physicalExists: existsSync(fileRecordAbs(rec)),
      ...fileLinks(rec),
    };
  }

  // field：先按「条目自身结构行」解（规范语义），再退回「栏目字典模板字段」。
  const head = parts.entryId ?? parts.sectionId ?? '';
  const key = parts.key ?? '';
  const entry = store.entries.find((e) => e.id === head);
  if (entry) {
    const sec = store.sections.find((s) => s.id === entry.section);
    if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
    // 任务 #20：脱离行对本条目已不存在——locator 解不到它（读边界同一口径）。
    const row: EntryFieldView | undefined = (structures.get(entry.id) || []).find((r) => r.key === key && !isDetachedField(r));
    if (!row) throw notFound(`条目 ${entry.id} 没有字段: ${key}`);
    const def = row.spec as unknown as FieldDef;
    const rawValue = entry.values?.[key];
    const sensitive = def.sensitive === true || def.type === 'secret' || isSensitiveField(sec, key);
    let value: unknown = rawValue;
    if (sensitive && rawValue !== null && rawValue !== undefined) {
      let decrypt: ((blob: unknown) => string) | undefined;
      if (reveal) {
        const viewer = await sensitiveViewer(sec, [entry], structures);
        decrypt = viewer || undefined;
      }
      value = displaySensitive(rawValue, { mask: !reveal, decrypt });
    }
    return {
      locator, kind: 'field', exists: true, aliases,
      entryId: entry.id, sectionId: sec.id, key,
      title: String(def.label || key),
      def, value, sensitive, masked: sensitive && !reveal,
    };
  }
  const sec = store.sections.find((s) => s.id === head);
  if (sec) {
    const def = sec.fields.find((x) => x.key === key);
    if (!def) throw notFound(`栏目 ${sec.id} 的字典里没有字段: ${key}`);
    return {
      // 模板字段：aliases 用 sectionId 段构造，旧写法（复合串）才算得出来
      locator, kind: 'field', exists: true, aliases: locatorAliases({ kind: 'field', sectionId: sec.id, key }),
      sectionId: sec.id, key, title: String(def.label || key),
      def, entryId: null, value: null,
      note: '模板字段（栏目字典）：值住在各条目上，用条目级 locator nx-sk://field/<条目id>/<key> 取',
    };
  }
  throw notFound(`定位符指向的资源不存在（既不是条目也不是栏目）: ${head}`);
}

/**
 * 批量解析（面板「内联数据板」的出口，任务 #21）：一次请求拿回所有绑定位置的实时值。
 * 与单条 resolve 的区别只有两点：坏链**不抛**（每项自带 ok/error，格子照常标灰），
 * 以及**永远打码口径**（reveal 不开这个口子——批量出口是给面板渲染用的）。
 */
export async function resolveBatch({ refs }: { refs?: unknown } = {}) {
  const list = Array.isArray(refs) ? refs : [];
  const items: Array<{ locator: string; ok: boolean; info?: ResolveResult; error?: string }> = [];
  for (const r of list) {
    const text = String(r ?? '').trim();
    if (!text) continue;
    try {
      items.push({ locator: text, ok: true, info: await resolveLocator(text) });
    } catch (e) {
      items.push({ locator: text, ok: false, error: (e as Error)?.message || String(e) });
    }
  }
  return { count: items.length, items };
}

// —— CLI 人读渲染 ——
const KIND_LABEL: Record<string, string> = { section: '栏目', entry: '条目', field: '字段', file: '附件' };

export function renderResourceSearch(d: Awaited<ReturnType<typeof searchResources>>) {
  if (!d.count) return `没有命中「${d.q}」的内部资源（栏目/条目/字段/附件都搜过了）`;
  const lines = [`资源检索：${d.count} 项命中${d.q ? `（关键字「${d.q}」）` : ''}${d.kind ? ` · 只看 ${KIND_LABEL[d.kind] || d.kind}` : ''}`];
  for (const x of d.items.slice(0, 60)) {
    lines.push(`  [${KIND_LABEL[x.kind] || x.kind}] ${x.title}　${x.subtitle}\n      ${x.locator}`);
  }
  if (d.count > 60) lines.push(`  …另有 ${d.count - 60} 项`);
  lines.push('', '看内容: nx-sk resource resolve <定位符>　（字段值默认打码，--reveal 出原文）');
  return lines.join('\n');
}

export function renderResourceResolve(d: ResolveResult) {
  const lines = [`[${KIND_LABEL[String(d.kind)] || String(d.kind)}] ${d.exists ? '存在' : '不存在'} · ${d.locator}`];
  if (d.aliases?.length) lines.push(`  等价旧写法: ${d.aliases.join('　')}`);
  if (d.kind === 'section') lines.push(`  栏目 ${d.sectionId}「${d.title}」· ${d.entryCount} 条条目　${d.description || ''}`);
  if (d.kind === 'entry') lines.push(`  条目 ${d.entryId}「${d.title}」· 栏目 ${d.sectionTitle}(${d.sectionId}) · 完整度 ${(d.completeness as { ratio?: number })?.ratio ?? '?'}%`);
  if (d.kind === 'file') lines.push(`  附件 ${d.fileId}「${d.name}」· ${d.bytes} 字节\n  路径: ${d.path}　物理文件: ${d.physicalExists ? '在' : '已丢失'}`);
  if (d.kind === 'field') {
    const def = d.def as FieldDef;
    lines.push(`  字段 ${d.key}（${def?.type || 'text'}）· ${d.entryId ? `条目 ${d.entryId}` : `栏目字典 ${d.sectionId}`}`);
    if (d.note) lines.push(`  ${d.note}`);
    if (d.value !== null && d.value !== undefined) {
      lines.push(`  值${d.masked ? '（打码；--reveal 看原文）' : ''}: ${typeof d.value === 'object' ? JSON.stringify(d.value) : String(d.value)}`);
    }
  }
  return lines.join('\n');
}
