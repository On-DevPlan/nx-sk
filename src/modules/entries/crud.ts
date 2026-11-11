import { entryStructures, loadStore, mutateStore, upsertEntryFields, type StoreEntry, type StoreSection } from '../../core/store.ts';
import { badInput, conflict, notFound } from '../../core/errors.ts';
import { isSensitiveField } from '../../core/fields.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { completeness, displaySensitive, isBlank, serializeEntry } from '../../core/render.ts';
import { newId, nowIso } from '../../core/ids.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import * as att from '../../core/attachments.ts';
import { displayPath } from '../../core/paths.ts';
import { computeTable } from '../../shared/table.ts';
import {
  autoTitle, defsForEntry, isPlainRow, mergeInputs, mustFindSection,
  prepareValue, prepareWrite, resolveEntry, resolveFieldDef, resolveOwnRow,
} from './shared.ts';

// 条目（entry）：栏目下的一条记录。
// 写敏感字段时加密、读时**默认原文**（只有显式 --mask 才打码）——
// 这条边界只在这里实现一次，两端共用。
//
// 写入分两趟：趟 A（异步，在草稿 section 上跑）解析字段、加密敏感值；
// 趟 B（同步，在 mutateStore 事务里）只做赋值。这样加密只发生在事务外，
// 事务里没有 await，也就没有「改了一半又抛错」的中间态。
//
// schema v3（写时复制）：字段解析顺序 = 条目自身结构行 → 栏目字典 → quickAdd 推断。
// quickAdd **不再登记进字典**——推断出的 def 只用于封装本次值，
// 写后由 upsertEntryFields 把条目自身的占位行归正（type/label/spec）。

export async function listEntries({ section, q }: { section?: string; q?: unknown } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  let list = store.entries;
  if (section) list = list.filter((e) => e.section === mustFindSection(store, section).id);
  const viewers = new Map<string, Awaited<ReturnType<typeof sensitiveViewer>>>();
  const out: Array<ReturnType<typeof serializeEntry> & { sectionTitle: string }> = [];
  for (const e of list) {
    const sec = store.sections.find((s) => s.id === e.section);
    if (!sec) continue;
    if (!viewers.has(sec.id)) viewers.set(sec.id, await sensitiveViewer(sec, list.filter((x) => x.section === sec.id), structures));
    const ownRows = structures.get(e.id) || null;
    const item = serializeEntry(sec, e, { decrypt: viewers.get(sec.id), ownRows });
    if (q) {
      // file 字段值是附件 id（可能挂多个），把解析出的附件名都加进搜索文本，
      // 才能按「简历/成绩单」搜到条目
      const fileNames = defsForEntry(sec, ownRows)
        .filter((f) => f.type === 'file')
        .flatMap((f) => att.fileIdsOf(e.values?.[f.key])
          .map((id) => att.findFileRecord(store, id)?.name || ''));
      const hay = [item.title, sec.title, ...fileNames,
        ...Object.values(item.values).map(hayText)]
        .join('\n').toLowerCase();
      if (!hay.includes(String(q).toLowerCase())) continue;
    }
    out.push({ ...item, sectionTitle: sec.title });
  }
  return { count: out.length, total: store.entries.length, entries: out };
}

/** 搜索文本：行对象（entrylist）与表格文档要摊成 JSON 才能按里面的账号/链接搜到条目。 */
function hayText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (isPlainRow(x) ? JSON.stringify(x) : String(x))).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function getEntry(ref: unknown, { mask, section }: { mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const structures = entryStructures(store);
  const ownRows = structures.get(entry.id) || null;
  const decrypt = await sensitiveViewer(sec, [entry], structures);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt, ownRows });
  // 附带附件信息：键 = 附件 id / 文件名，值为名称 / 路径 / 链接。
  // 两个来源：`file` 字段挂的附件，以及**图文字段正文里内嵌的图片**（`![说明](f_x)`）——
  // 后者不进来的话，`entry get` 只能打印一串 f_xxx，而人/agent 要的是「这份文件在磁盘哪」。
  const files: Record<string, { id: string; name: string; ext: string; isImage: boolean; path: string; url: string; downloadUrl: string }> = {};
  const putFile = (ref: string | null | undefined) => {
    if (!ref || files[ref]) return;
    const rec = att.findFileRecord(store, ref);
    if (!rec) return;
    const links = att.fileLinks(rec);
    files[ref] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  };
  // 附件引用由各类型的 `refs` 决定：file 的 id 列表 + md 正文图片 + 资料袋里的 file item。
  // 这里的口径是「谁引用了它」（与 attachments.fileReferences 一致）：资料袋 text 正文里
  // 内嵌的图不算——既有行为，P2 不改；导出打包才算（见 transfer.referencedFileIds）。
  const defs = defsForEntry(sec, ownRows);
  for (const f of defs) {
    for (const id of behaviorOf(f.type).refs(f, serialized.values[f.key])) putFile(id);
  }
  // 字段类型随读出来：CLI 渲染要知道哪个值是「图文」，才能把 f_xxx 换成文件名/路径；
  // 结构清单还要带**列定义**（entryFields），渲染行时才知道每个键的人读标签
  const fieldTypes: Record<string, string> = {};
  const entryFields: Record<string, Array<{ key: string; label: string; sensitive: boolean }>> = {};
  for (const f of defs) {
    fieldTypes[f.key] = f.type;
    if (f.type === 'entrylist') {
      entryFields[f.key] = ((f as unknown as { fields?: Array<{ key: string; label: string; sensitive?: boolean }> }).fields || [])
        .map((s) => ({ key: s.key, label: s.label, sensitive: s.sensitive === true }));
    }
  }
  // 表格的**现值**：计算列与统计行在读的时候现算，不落盘 ——
  // 所以「存的数字」和「算出来的合计」永远同源，不会出现「合计是上个月的值」。
  const tables: Record<string, unknown> = {};
  for (const f of defs) {
    if (f.type !== 'table') continue;
    tables[f.key] = computeTable(f, serialized.values[f.key]);
  }
  return { ...serialized, sectionTitle: sec.title, mask: !!mask, files, fieldTypes, entryFields, tables };
}

export async function addEntry({ section, title, set, data, tags, 'dry-run': dryRun }: {
  section?: string;
  title?: unknown;
  set?: unknown;
  data?: unknown;
  tags?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const sec = mustFindSection(store, section);
  const incoming = mergeInputs(set, data);
  if (!Object.keys(incoming).length && !title) {
    throw badInput(`至少要给一个字段：--set ${sec.fields[0]?.label || '字段'}=值（可重复），或 --data @file.json`);
  }

  const { values, newFields } = await prepareWrite({ section: sec, incoming });
  // 模板默认值（v3）：字典里 defaultValue 非空、本次没给的键，落默认值。
  // 敏感字段走同一个封装入口（落盘即密文），与显式写入零差别。
  for (const def of sec.fields) {
    const d = def as unknown as Record<string, unknown>;
    if (d.defaultValue === undefined || d.defaultValue === null) continue;
    if (values[def.key] !== undefined) continue;
    values[def.key] = await prepareValue(sec, def, d.defaultValue, undefined);
  }
  const finalTitle = String(title || autoTitle(sec, values) || '').trim();
  if (!finalTitle) {
    throw badInput(`无法确定条目名：加 --title <名>，或先填上「${sec.titleField || '首个字段'}」字段`);
  }
  const dup = store.entries.find((e) => e.section === sec.id && e.title === finalTitle);
  if (dup) throw conflict(`栏目「${sec.title}」下已有叫「${finalTitle}」的条目（${dup.id}）。要改它就用 entry update，别再加一条。`);

  const entry = {
    id: newId('e'), section: sec.id, title: finalTitle, tags: Array.isArray(tags) ? tags.map(String) : [],
    values, createdAt: nowIso(), updatedAt: nowIso(),
  };
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldCreate: { ...entry, values: maskAll(sec, entry) }, createdFields: newFields.map((f) => f.key) };
  }
  await mutateStore((s) => {
    // v3 写时复制：自动推断的扩展字段**不进字典**——writeStore 会为新条目
    // 实例化全部模板行，并为 values 里字典没有的键落扩展占位行；
    // 占位行的 type/label/spec 由下方 upsertEntryFields 按推断结果归正。
    s.entries.push(entry);
  });
  if (newFields.length) await upsertEntryFields(entry.id, newFields);
  return {
    status: 'ok', created: true, id: entry.id, title: entry.title, section: sec.id,
    completeness: completeness(sec, entry), createdFields: newFields.map((f) => f.key),
  };
}

export async function updateEntry(ref: unknown, patch: Record<string, any> = {}) {
  // TODO(P4): patch 是 CLI/HTTP 原样传入的键值集合（set/unset/title/tags/...），逐键校验在下方 errors 里
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = resolveEntry(store, ref, patch.section);
  const sec = mustFindSection(store, target.section);
  const incoming = mergeInputs(patch.set, patch.data);
  const unset: string[] = patch.unset || [];

  const changedKeys = [...Object.keys(incoming), ...unset.map((k) => `-${k}`)];
  if (!changedKeys.length && patch.title === undefined && patch.tags === undefined) {
    throw badInput('没有要改的内容：用 --set 字段=值 / --data @file.json / --unset 字段 / --title / --tags');
  }
  const ownRows = entryStructures(store).get(target.id) || null;
  // 先把 unset 的字段名解析出来（错别字要在写盘前就报掉）：条目自身行优先，再字典。
  const unsetKeys: string[] = [];
  for (const k of unset) {
    const def = resolveOwnRow(ownRows, k) || resolveFieldDef(sec, k);
    if (!def) throw notFound(`栏目「${sec.title}」没有字段: ${k}`);
    unsetKeys.push(def.key);
  }

  const { values, newFields } = await prepareWrite({
    section: sec, ownRows, currentValues: target.values, incoming,
  });

  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldChange: {
        id: target.id, fields: Object.keys(values), unset: unsetKeys,
        title: patch.title, tags: patch.tags, newFields: newFields.map((f) => f.key),
      },
    };
  }

  // 重名会让 `entry get <名字>` / `key get <名字>` 变成二义（只能靠 id 定位），
  // 所以改名时挡一下：KV 表格改键名、agent 改条目标题都走这里。
  if (patch.title !== undefined && String(patch.title) !== target.title) {
    const dup = store.entries.find((e) => e.id !== target.id && e.section === target.section && e.title === String(patch.title));
    if (dup) throw conflict(`同栏目下已有叫「${patch.title}」的了（${dup.id}）；先合并或删掉那一条。`);
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    // v3 写时复制：扩展键不再 push 进字典（见 addEntry 同名注释），
    // 行归正在下方 upsertEntryFields。
    for (const [k, v] of Object.entries(values)) e.values[k] = v;
    for (const k of unsetKeys) e.values[k] = null;
    if (patch.title !== undefined) e.title = String(patch.title);
    if (Array.isArray(patch.tags)) e.tags = patch.tags.map(String);
    e.updatedAt = nowIso();
  });
  if (newFields.length) await upsertEntryFields(target.id, newFields);

  const after = await loadStore();
  const finalEntry = after.entries.find((x) => x.id === target.id)!;
  const finalSec = after.sections.find((x) => x.id === finalEntry.section)!;
  return {
    status: 'ok', id: finalEntry.id, title: finalEntry.title, section: finalEntry.section,
    // 报**解析后**的字段 key，而不是用户敲的中文标签——调用方/agent 拿它去对比字典
    changed: [...Object.keys(values), ...unsetKeys.map((k) => `-${k}`)],
    newFields: newFields.map((f) => f.key),
    completeness: completeness(finalSec, finalEntry, entryStructures(after).get(finalEntry.id)),
  };
}

export async function removeEntry(ref: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, title: target.title, section: target.section } };
  }
  await mutateStore((s) => { s.entries = s.entries.filter((e) => e.id !== target.id); });
  return { status: 'ok', removed: { id: target.id, title: target.title, section: target.section } };
}

function maskAll(section: StoreSection, entry: StoreEntry, decrypt?: ((blob: unknown) => string) | undefined, mask = false) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry.values)) {
    out[k] = isSensitiveField(section, k) ? displaySensitive(v, { mask, decrypt }) : v;
  }
  return out;
}

// —— CLI 人读渲染 ——
export function renderEntryList(d: Awaited<ReturnType<typeof listEntries>>) {
  const lines = [`${d.count} 条 / 共 ${d.total} 条`];
  for (const e of d.entries) {
    lines.push(`  ${e.id}  ${(e.title || '（无名）').padEnd(16)} ${String(e.completeness.ratio).padStart(3)}% 完整度　[${e.section}]`);
    const missing = e.missing.slice(0, 6).map((m) => m.label).join('、');
    if (missing) lines.push(`      未填: ${missing}${e.missing.length > 6 ? ` 等 ${e.missing.length} 项` : ''}`);
    // 「不填」只报**真的空着**的可选字段。可选字段填了值还列出来，会让人以为
    // 这份数据缺东西（`excluded` 是策略标记，不是空值清单）。
    const skipped = (e.excluded || []).filter((m) => isBlank(e.values?.[m.key]));
    if (skipped.length) {
      lines.push(`      不填: ${skipped.map((m) => m.label).join('、')}（主动跳过，不计入完整度）`);
    }
  }
  lines.push('', '看全部字段: nx-sk entry get <id> --json　或　nx-sk entry fields --section <id>');
  return lines.join('\n');
}

/**
 * 一个字段值渲染成几行文本。
 * - 附件（`file` 字段，值可能是 id 列表）：解析成「附件名　物理路径」，**几个占几行**
 * - 结构清单（entrylist）：**一行一条**，`列名=值 · 列名=值`——清单本来就是拿来看的
 * - 原始资料（source）：**一行一条**，带类型与摘要——袋里的东西要能一眼分清是字还是文件
 * - 其它数组（tags 之类）：仍旧一行、顿号连接——不要顺手把它们也拆成多行
 */
function valueLines(d: Awaited<ReturnType<typeof getEntry>>, v: unknown, key: string): string[] {
  const type = d.fieldTypes?.[key];
  const files = (d.files || {}) as Record<string, { name: string; path: string }>;
  const asFile = (x: unknown) => (files[String(x)] ? `${files[String(x)].name}　${files[String(x)].path}` : null);
  // 「值本身就是一个/一组已解析的附件」是**类型无关**的通用分支，必须排在类型格式之前
  //（与重构前的顺序一致：md 的值若恰好是一个附件 id，也按附件路径显示）。
  if (Array.isArray(v) && v.length && v.every((x) => asFile(x))) return v.map(asFile) as string[];
  const one = asFile(v);
  if (one) return [one];
  // 类型专属的多行格式查行为体的 `format`：表格整张印出来（表头 + 数据 + 统计行 + 公式报错）、
  // 资料袋逐条、清单逐行、图文把 `![说明](f_x)` 换成文件名/路径；返回 null 的走通用分支。
  const formatted = behaviorOf(type).format({ key, type }, v, { files: d.files, entryFields: d.entryFields, tables: d.tables });
  if (formatted) return formatted;
  if (Array.isArray(v) && v.length && v.every(isPlainRow)) {
    const subs = d.entryFields?.[key] || [];
    const labelOf = (k: string) => subs.find((s) => s.key === k)?.label || k;
    return v.map((row, i) => Object.entries(row)
      .filter(([, x]) => !isBlank(x))
      .map(([k2, x]) => `${labelOf(k2)}=${x}`)
      .join(' · ') || `第 ${i + 1} 行（空）`);
  }
  if (Array.isArray(v)) return [v.join('、')];
  if (typeof v === 'boolean') return [v ? '是' : '否'];
  const s = String(v);
  // 多行正文（YAML / Dockerfile / 一段说明）按行拆开再回填缩进。
  // 不拆的话只有第一行带着键名列宽，后面每一行都从第 0 列开始 ——
  // 一段 40 行的清单打印出来像"掉出了表格"，人眼完全没法对。
  return s.includes('\n') ? s.split('\n') : [s];
}

export function renderEntryGet(d: Awaited<ReturnType<typeof getEntry>>) {
  const c = d.completeness || ({} as { filled: number; total: number; ratio: number });
  // 只算**真的空着**的可选字段：填了值的可选字段不属于「跳过」，
  // 否则一份填满的资料会被报成「另有 7 项已标不填」，自相矛盾。
  const skipped = (d.excluded || []).filter((m) => isBlank(d.values?.[m.key]));
  const lines = [
    `${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
    + (skipped.length ? ` · 另有 ${skipped.length} 项已标不填` : '')
    + `${d.mask ? ' · 已打码' : ''}`,
  ];
  for (const [k, v] of Object.entries(d.values)) {
    if (v === null) continue;
    const rendered = valueLines(d, v, k);
    lines.push(`  ${k.padEnd(24)} ${rendered[0]}`);
    for (const extra of rendered.slice(1)) lines.push(`  ${' '.repeat(24)} ${extra}`);
  }
  if (d.missing.length) {
    lines.push('', `未填（${d.missing.length}）: ${d.missing.map((m) => `${m.label}(${m.key})`).join('、')}`);
  }
  // 「不填」和「未填」必须分开说：混在一起会让人以为这些字段还欠着，
  // 而它们恰恰是用户主动决定跳过的。
  if (skipped.length) {
    lines.push('', `不填（${skipped.length}）· 主动跳过、不计入完整度: `
      + skipped.map((m) => `${m.label}(${m.key}｜${m.fillLabel || m.fill})`).join('、'));
  }
  return lines.join('\n');
}

/**
 * 批量删条目 —— 面板上「勾一堆条目按删除」的后端。
 *
 * 与单个删除的差别：
 *   - 找不到的**跳过并记在 missing 里**（status: 'partial'），不让整批失败；
 *     批量操作里「另一个标签页刚删掉一条」比「全都没删」常见得多，整批回滚只会让人重来。
 *   - 一个都找不到才算错（NOT_FOUND）——那时确实是 id 给错了。
 *   - 只认 NOT_FOUND / CONFLICT 两种业务错，别的（比如解密失败）照常抛，不吞。
 */
export async function removeMany(refs: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要删的条目（把 id 用逗号分隔，或重复传参）');

  const store = await loadStore();
  const ids = new Set<string>();
  const removed: Array<{ id: string; title: string; section: string }> = [];
  const missing: string[] = [];
  for (const ref of list) {
    let e: StoreEntry | null = null;
    try {
      e = resolveEntry(store, ref, section);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== 'NOT_FOUND' && code !== 'CONFLICT') throw err;
      e = null;
    }
    if (!e) { missing.push(ref); continue; }
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    removed.push({ id: e.id, title: e.title, section: e.section });
  }
  if (!ids.size) throw notFound(`这些条目都不存在: ${list.join(', ')}`);

  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: removed, count: removed.length, missing };
  }
  await mutateStore((s) => { s.entries = s.entries.filter((e) => !ids.has(e.id)); });
  return { status: missing.length ? 'partial' : 'ok', removed, count: removed.length, missing };
}

/** renderEntryRemoveMany 的入参：remove-many 的落盘 / 试运行两种结果。 */
interface EntryRemoveManyView {
  status?: string;
  count?: number;
  removed?: Array<{ id: string; title: string; section: string }>;
  wouldRemove?: Array<{ id: string; title: string; section: string }>;
  missing?: string[];
}

export function renderEntryRemoveMany(d: EntryRemoveManyView) {
  const list = d.removed || d.wouldRemove || [];
  const lines = [d.status === 'skipped'
    ? `试运行（未落盘）：将删除 ${d.count} 条条目`
    : `已删除 ${d.count} 条条目`];
  for (const e of list.slice(0, 20)) lines.push(`  ${e.title || '（无名）'}（${e.id}）· ${e.section}`);
  if (list.length > 20) lines.push(`  …另有 ${list.length - 20} 条`);
  if (d.missing?.length) lines.push(`未找到（已跳过）: ${d.missing.join('、')}`);
  return lines.join('\n');
}

/** renderEntryChange 的入参：entry add/update/remove 三种结果共用的读侧形状。 */
interface EntryChangeView {
  status?: string;
  wouldCreate?: unknown;
  wouldChange?: unknown;
  wouldRemove?: unknown;
  created?: boolean;
  title?: string;
  id?: string;
  section?: string;
  completeness?: { filled: number; total: number; ratio: number };
  createdFields?: string[];
  newFields?: string[];
  changed?: string[];
  removed?: { id: string; title: string };
}

export function renderEntryChange(d: EntryChangeView) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove)}`;
  if (d.removed) return `已删除条目 ${d.removed.id}（${d.removed.title}）`;
  const c = d.completeness!;
  if (d.created) {
    return `已创建条目 ${d.title}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
      + (d.createdFields?.length ? `\n新增字段: ${d.createdFields.join(', ')}` : '');
  }
  const extra = d.newFields?.length ? `\n新增字段: ${d.newFields.join(', ')}` : '';
  return `已更新条目 ${d.title}（${d.id}）· 改动 ${(d.changed || []).join(', ')} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%${extra}`;
}
