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
import { loadStore, mutateStore, entryStructures, upsertEntryFields, detachEntryField, removeEntryFieldRow, isDetachedField, type EntryFieldView, type Store, type StoreEntry, type StoreSection } from '../../core/store.ts';
import { assertFieldKey } from '../../core/paths.ts';
import { badInput, conflict, notFound } from '../../core/errors.ts';
import { SCALAR_FIELD_TYPES, SOURCE_FIELD, SOURCE_GROUP, findKvSection, findSection, inferFieldType, instantiateTemplate, isSensitiveField, looksSecretish, sectionNames } from '../../core/fields.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { sealOf } from '../../core/fields/seal/index.ts';
import { sealScalar } from '../../core/fields/seal/common.ts';
import { completeness, displaySensitive, isBlank, serializeEntry } from '../../core/render.ts';
import { newId, nowIso } from '../../core/ids.ts';
import { isCipherBlob, maskValue } from '../../core/crypto.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import * as att from '../../core/attachments.ts';
import { mdImageIds, rewriteMdImages } from '../../core/mdimages.ts';
import { normalizeSourceItem, normalizeSourceItems, resolveSourceConflicts, sourceItemTimeLabel } from '../../core/source.ts';
import { displayPath } from '../../core/paths.ts';
import { computeTable, renderTableText } from '../../shared/table.ts';
import { FIELD_TYPES } from '../../shared/fields/types.ts';
import type { FieldDef, SourceItem } from '../../shared/fields/types.ts';

export function mustFindSection(store: Store, ref: unknown): StoreSection {  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

/** 条目定位：id 优先，其次唯一标题；重名时报 CONFLICT 让调用方用 id 指定。 */
export function resolveEntry(store: Store, ref: unknown, sectionRef?: unknown): StoreEntry {
  const key = String(ref ?? '').trim();
  if (!key) throw badInput('缺少条目定位：给条目 id（e_...）或条目名');
  let list = store.entries;
  if (sectionRef) list = list.filter((e) => e.section === mustFindSection(store, sectionRef).id);
  const byId = list.find((e) => e.id === key);
  if (byId) return byId;
  const byTitle = list.filter((e) => e.title === key);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw conflict(`有 ${byTitle.length} 条同名条目「${key}」，请用 id 指定: ${byTitle.map((e) => e.id).join(' / ')}`);
  }
  throw notFound(`找不到条目: ${ref}`);
}

function mergeInputs(set: unknown, data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data && typeof data === 'object') {
    // 兼容 `{values:{...}}` 与直接扁平 `{字段: 值}` 两种写法
    const d = data as Record<string, unknown>;
    Object.assign(out, d.values && typeof d.values === 'object' ? d.values : d);
  }
  if (set && typeof set === 'object') Object.assign(out, set);
  return out;
}

function resolveFieldDef(section: StoreSection, rawKey: unknown): FieldDef | null {
  const key = String(rawKey).trim();
  return section.fields.find((x) => x.key === key || x.label === key) || null;
}

/**
 * v3：在**条目自身结构行**里解析用户敲的键。
 * key 精确优先，其次 label；模板行（出身字典）优先于扩展行。
 * 同类多命中 = 二义，报 CONFLICT 并列出行 id，让调用方用键名精确指定。
 */
function resolveOwnRow(ownRows: EntryFieldView[] | null | undefined, rawKey: unknown): FieldDef | null {
  const rows = ownRows || [];
  const key = String(rawKey).trim();
  const byKey = rows.filter((r) => r.key === key);
  const pool = byKey.length ? byKey : rows.filter((r) => String(r.label ?? '') === key);
  if (!pool.length) return null;
  const template = pool.filter((r) => r.templateFieldId != null);
  const chosen = template.length ? template : pool;
  if (chosen.length > 1) {
    throw conflict(`字段定位「${key}」在条目自身结构里有 ${chosen.length} 行命中（${chosen.map((r) => r.id).join(', ')}），请用键名精确指定`);
  }
  return chosen[0].spec as unknown as FieldDef;
}

/**
 * 把一个既不在字典、也不在条目行里的键推断成**扩展字段** def。
 * key 直接用用户敲的那个词（中文也行）——**写什么就存什么**，不必再记一个英文别名。
 *
 * v3：不再 push 进 section.fields——扩展字段只活在条目自己的结构行上（写时复制），
 * 字典保持「模板 + 台账」的身份。def 用于封装本次值 + 写后归正行。
 */
function inferExtensionField(section: StoreSection, rawKey: unknown, rawValue: unknown): FieldDef {
  // KV 栏目**拒绝加字段**：它的形状就是「一行一个键值对」，多一个字段就散了。
  // 这里必须报错而不是静默登记 —— 静默的后果是用户看到一堆无意义的字段名
  // （真实事故：面板那行「KV 直填」把 `3123312=xxx` 登记成了字段，而不是一个新键）。
  if (section.kv) {
    const wanted = String(rawKey).trim();
    throw badInput(
      `栏目「${section.title}」是一张 KV 表（一行一个键值对），不能加字段「${wanted}」。`
      + `你要加的应该是一个**键** —— 用 nx-sk key set ${wanted} <值>，`
      + '或在面板的 KV 表格里加一行。',
    );
  }
  const key = assertFieldKey(String(rawKey).trim());
  let type: string = inferFieldType(rawValue);
  // 键名长得像凭据（密码 / 令牌 / 密钥 / 账号…）→ **直接建成密文字段**。
  //
  // 这是「大胆写」能成立的前提：agent 可以一把 `--set 密码=…` 写进栏目，
  // 而这把密码**落盘就是密文**，不会明文躺在存储里。
  // 刻意只对标量值生效：数组类（附件 / 结构清单 / 资料袋）有自己的形状，不能改类型。
  if (looksSecretish(key) && SCALAR_FIELD_TYPES.has(type)) type = 'secret';
  return {
    key,
    label: key,
    type: type as FieldDef['type'],
    group: section.groups?.[0]?.id || section.fields?.[0]?.group || 'other',
  } as FieldDef;
}

/**
 * 写入归一的**唯一入口**：类型相关的分支都在 `core/fields/behaviors/<type>.ts`，
 * 这里只保留「空值 = 清空」这条与类型无关的约定。
 */
function normalizeValue(def: FieldDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  return behaviorOf(def.type).coerce(def, raw);
}

function isPlainRow(x: unknown): boolean {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

async function prepareValue(section: StoreSection, def: FieldDef, raw: unknown, current: unknown): Promise<unknown> {
  // 类型级封装（清单行 / 表格列 / secret）查表；其余类型回到「敏感标量」那条与类型无关的分支。
  const seal = sealOf(def.type);
  if (seal) return seal({ section, def, raw, current });
  if (!isSensitiveField(section, def.key)) return normalizeValue(def, raw);
  return sealScalar({ section, def, raw, current });
}

/**
 * 趟 A：解析字段、算出要写进去的值。
 *
 * **不认识的键不再报错**——先查条目自身结构行，再查栏目字典，
 * 都没有就按值推断成扩展字段（v3：只落条目行，不进字典）。
 * 字典从「写入的关卡」降级成「模板 + 已用字段的台账」：
 * 用户想存什么键就存什么键，这才是 KV 该有的手感。
 */
async function prepareWrite({ section, ownRows = null, currentValues = {}, incoming }: {
  section: StoreSection;
  ownRows?: EntryFieldView[] | null;
  currentValues?: Record<string, unknown>;
  incoming: Record<string, unknown>;
}): Promise<{ values: Record<string, unknown>; newFields: FieldDef[] }> {
  const draft = structuredClone(section);
  const newFields: FieldDef[] = [];
  const values: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    let def = resolveOwnRow(ownRows, rawKey) || resolveFieldDef(draft, rawKey);
    if (!def) {
      def = inferExtensionField(draft, rawKey, rawValue);
      newFields.push(def);
    }
    // prepareValue 的敏感判据读字典——保证 def 在草稿里（扩展行/扩展 def 不在；
    // 只影响本次封装值，不落盘）。
    if (!draft.fields.some((x) => x.key === def!.key)) draft.fields.push(def!);
    values[def.key] = await prepareValue(draft, def, rawValue, currentValues[def.key]);
  }
  return { values, newFields };
}

function autoTitle(section: StoreSection, values: Record<string, unknown>): string {
  const v = section.titleField ? values[section.titleField] : undefined;
  return v === undefined || v === null || v === '' ? '' : String(v);
}

/** 条目自身行优先、字典兜底的字段定义清单（序列化/台账共用）。
 *  任务 #20：脱离行（meta.detached）不算——值已不进 values，定义也不该出现在任何读出口。 */
function defsForEntry(sec: StoreSection, ownRows: EntryFieldView[] | null | undefined): FieldDef[] {
  return ownRows ? ownRows.filter((r) => !isDetachedField(r)).map((r) => r.spec as unknown as FieldDef) : sec.fields;
}

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

/** 字段字典的读侧形状：渲染只读这些键，不同字段类型各带其中一部分。 */
interface FieldDictEntry {
  key: string;
  label: string;
  type: string;
  group: string;
  kind?: string;
  fields?: unknown[] | null;
  columns?: Array<{ label: string; type: string; formula?: string }> | null;
  totals?: unknown[] | null;
  maxRows?: number | null;
  hint?: string;
  options?: string[] | null;
  sensitive?: boolean;
}

/** 字段字典：agent 在填之前必须先看这个，否则只能靠猜字段名。 */
export async function fieldDictionary({ section }: { section?: string } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  const shape = (sec: StoreSection) => {
    // 台账 = 栏目字典 + 各条目的**扩展行**（v3：quickAdd 不进字典，但台账要看得见）。
    // 按 key 去重（字典优先），形状从各自的 spec 出。
    const byKey = new Map<string, Record<string, unknown>>();
    for (const x of sec.fields as unknown as FieldDictEntry[]) byKey.set(x.key, x as unknown as Record<string, unknown>);
    for (const e of store.entries) {
      if (e.section !== sec.id) continue;
      for (const r of structures.get(e.id) || []) {
        if (byKey.has(r.key)) continue;
        // 任务 #20：脱离行不进台账——它已从该条目移除，值也不在 values 里了。
        if (isDetachedField(r)) continue;
        byKey.set(r.key, r.spec as Record<string, unknown>);
      }
    }
    return {
      id: sec.id,
      title: sec.title,
      titleField: sec.titleField,
      titleLabel: sec.titleLabel,
      groups: sec.groups,
      fields: [...byKey.values()].map((x) => ({
        key: String(x.key), label: String(x.label ?? x.key), type: String(x.type || 'text'), group: x.group ? String(x.group) : undefined,
        kind: String(x.kind || ''),
        // 结构清单的列跟着字典出去：agent 写行之前得知道行里允许哪些键
        fields: (x.fields as unknown[] | null) || null,
        // 表格的列（带类型/公式）与统计行同理
        columns: (x.columns as FieldDictEntry['columns']) || null,
        totals: (x.totals as unknown[] | null) || null,
        maxRows: (x.maxRows as number | null) ?? null,
        hint: String(x.hint || ''), options: (x.options as string[] | null) || null,
        sensitive: x.sensitive === true || x.type === 'secret' || isSensitiveField(sec, x.key),
      })),
    };
  };
  if (section) return { count: 1, sections: [shape(mustFindSection(store, section))] };
  return { count: store.sections.length, sections: store.sections.map(shape) };
}

/**
 * KV 直通命令（`key *`）——「存个密钥」不该先说 `--section` 再说 `--set 字段=`。
 *
 * 设计要点：这**不是**第二套业务逻辑。下面每个函数都只是把
 * 「哪个栏目 + 哪个值字段」定好，再调 addEntry / updateEntry / removeEntry 本身。
 * 所以加解密、打码、快照、--dry-run 全部只有一份实现，不可能与 `entry` 命令分叉。
 */
/**
 * 找 KV 表格：默认是**标了 `kv: true` 的栏目**（密钥模板自带），
 * 也可以用 `--section` 指定任何一个「只有一个值字段」的栏目。
 */
async function kvTarget(store: Store, ref?: string): Promise<{ sec: StoreSection; valueKey: string }> {
  const sec = ref
    ? findSection(store, ref)
    : findKvSection(store, undefined);
  if (!sec) {
    if (ref) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
    throw badInput('还没有 KV 栏目：用 `nx-sk section add keys --template secret` 建一个。'
      + `现有栏目: ${sectionNames(store)}`);
  }
  const named = (sec.fields || []).find((x) => x.key === 'value');
  if (named) return { sec, valueKey: named.key };
  if (!sec.fields || !sec.fields.length) throw badInput(`栏目「${sec.title}」没有任何字段，不能当 KV 用`);
  if (sec.fields.length > 1) {
    throw badInput(`栏目「${sec.title}」有 ${sec.fields.length} 个字段，不是 KV（KV 表格只能有一个值字段）`);
  }
  return { sec, valueKey: sec.fields[0].key };
}

/** KV 名称不是文件路径，所以比 assertSafeName 宽松：允许中文与空格，只挡路径分隔符。 */
function assertKeyName(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) throw badInput('密钥名不能为空：nx-sk key set <名称> <值>');
  if (s.length > 64) throw badInput(`密钥名过长（${s.length} > 64）: ${s}`);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`密钥名不能含路径分隔符或 '..': ${JSON.stringify(name)}`);
  }
  return s;
}

export async function keyList({ mask, section }: { mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const mine = store.entries.filter((e) => e.section === sec.id);
  const decrypt = await sensitiveViewer(sec, mine);
  return {
    section: sec.id,
    sectionTitle: sec.title,
    valueKey,
    mask: !!mask,
    count: mine.length,
    keys: mine.map((e) => ({
      id: e.id,
      name: e.title,
      value: displaySensitive(e.values?.[valueKey], { mask: !!mask, decrypt }),
      updatedAt: e.updatedAt,
    })),
  };
}

export async function keyGet(name: unknown, { mask, section }: { mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  return {
    id: entry.id,
    name: entry.title,
    section: sec.id,
    value: displaySensitive(entry.values?.[valueKey], { mask: !!mask, decrypt }),
    mask: !!mask,
    updatedAt: entry.updatedAt,
  };
}

/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 */
/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 *
 * 播种不再自带密钥栏目之后，「第一次 `key set`」会撞上「还没有 KV 栏目」。
 * 写路径在这里**自动补建**一个（与 `section add --template secret` 同一模板、同一形状）：
 * `key set` 的语义是「我要存」，被挡回来只会让人去抄一遍建栏目的命令。
 * 读路径（get / list）不建——读不到就是读不到，悄悄建一个空栏目是噪音。
 */
export async function keySet(name: unknown, value: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const key = assertKeyName(name);
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw.trim()) throw badInput(`密钥值不能为空：nx-sk key set ${key} <值>`);

  let store = await loadStore();
  let createdKv = false;
  if (!section && !findKvSection(store, undefined)) {
    await mutateStore((s) => {
      const sec = { ...instantiateTemplate('secret', { id: 'secret', title: '密钥', order: 90 }), createdAt: nowIso(), updatedAt: nowIso() } as StoreSection;
      s.sections.push(sec);
      s.sections.sort((a, b) => a.order - b.order);
    });
    store = await loadStore();
    createdKv = true;
  }
  const { sec, valueKey } = await kvTarget(store, section);

  const existing = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (existing) {
    // 两种「没变」都要认出来，否则会产生无意义的新密文 + 新快照：
    //   ① 明文与现值相同（重复写同一个 key 是常态，agent 会重试）
    //   ② 传进来的是**打码占位**（面板把列表里的值原样回传）
    const decrypt = await sensitiveViewer(sec, [existing]);
    if (decrypt) {
      try {
        const plain = String(decrypt(existing.values?.[valueKey]));
        if (plain === raw || maskValue(plain) === raw) {
          return { status: 'skipped', created: false, unchanged: true, name: key, section: sec.id, id: existing.id, createdKv };
        }
      } catch { /* 解不开（换过密钥）就按覆盖处理 */ }
    }
    const r = await updateEntry(existing.title, { set: { [valueKey]: raw }, section: sec.id, 'dry-run': dryRun });
    if (r.status === 'skipped') return { ...r, name: key, created: false, section: sec.id, createdKv };
    return { status: 'ok', created: false, replaced: true, name: key, section: sec.id, id: r.id, createdKv };
  }

  const r = await addEntry({ section: sec.id, title: key, set: { [valueKey]: raw }, 'dry-run': dryRun });
  if (r.status === 'skipped') return { ...r, name: key, created: true, section: sec.id, createdKv };
  return { status: 'ok', created: true, replaced: false, name: key, section: sec.id, id: r.id, createdKv };
}

export async function keyRemove(name: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const { sec } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}`);
  return removeEntry(entry.id, { 'dry-run': dryRun });
}

// —— 原始资料袋（source 字段）——
//
// 袋是**乱入区**：先原样收下杂乱资料（邮件、截图、PDF 摘录、手抄的表），
// 之后由 agent 或人按栏目字段字典整理成结构化字段。
// 命令族：source list / get / add / remove / ensure。

/** 某条目的袋内容（原始形状）。 */
function sourceItemsOf(entry: StoreEntry | null | undefined): SourceItem[] {
  return normalizeSourceItems(entry?.values?.source) || [];
}

/** 袋里引用的附件解析（名字 / 物理路径 / 链接）——否则只剩一串 f_xxx。 */
/**
 * source 涉及的附件：file item 指向的 + **text（markdown）正文里内嵌的** `![x](f_xxx)`。
 * 渲染（面板解析图片 / CLI 把 id 还原成路径）与完整性检查都以这份为准。
 */
function sourceFiles(store: Store, items: SourceItem[]): Record<string, { id: string; name: string; ext: string; isImage: boolean; path: string; url: string; downloadUrl: string }> {
  const files: Record<string, { id: string; name: string; ext: string; isImage: boolean; path: string; url: string; downloadUrl: string }> = {};
  const put = (id: string | undefined) => {
    if (!id || files[id]) return;
    const rec = att.findFileRecord(store, id);
    if (!rec) return;
    const links = att.fileLinks(rec);
    files[id] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  };
  for (const item of items) {
    if (item.kind === 'file' && item.fileId) put(item.fileId);
    // text 的底层是 markdown：正文里内嵌的 `![x](f_xxx)` 也是正式引用
    else if (item.kind === 'text' && item.text) for (const id of mdImageIds(item.text)) put(id);
  }
  return files;
}

/** source list：各栏目的袋子概况。 */
export async function listSource({ section }: { section?: string } = {}) {
  const store = await loadStore();
  const secs = section
    ? [mustFindSection(store, section)]
    : store.sections.filter((s) => s.kv !== true);
  const out = [];
  for (const sec of secs) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    let items = 0;
    let filled = 0;
    for (const e of mine) {
      const n = sourceItemsOf(e).length;
      if (n) { filled += 1; items += n; }
    }
    out.push({
      section: sec.id,
      sectionTitle: sec.title,
      hasField: sec.fields.some((f) => f.type === 'source'),
      entries: mine.length,
      filled,
      items,
    });
  }
  return { count: out.length, sections: out };
}

/** source get：某条目的袋明细。 */
export async function getSource(ref: unknown, { section }: { section?: string } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const items = sourceItemsOf(entry);
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    hasField: sec.fields.some((f) => f.type === 'source'),
    count: items.length,
    // 当前版本 = 没被取代的；旧的留痕但不算数
    current: items.filter((x) => !x.superseded).length,
    superseded: items.filter((x) => x.superseded).length,
    items,
    files: sourceFiles(store, items),
    updatedAt: entry.updatedAt,
  };
}

/** source add：往袋里加一条（文字 / 文件 / 网址）。 */
export async function addSourceItem(ref: unknown, { section, text, file, url, name, note, mapped, at, supersedes, 'dry-run': dryRun }: {
  section?: string;
  text?: unknown;
  file?: string;
  url?: string;
  name?: string;
  note?: string;
  mapped?: unknown;
  at?: string;
  supersedes?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, target.section);
  if (!sec.fields.some((f) => f.type === 'source')) {
    throw badInput(`栏目「${sec.title}」没有「原始资料」字段（source）——先跑 nx-sk source ensure 补上`);
  }
  const items = sourceItemsOf(target);
  let item = null;
  const extra: { note?: string; mapped?: unknown; at?: string; supersedes?: unknown } = { note, mapped, at };
  if (supersedes) extra.supersedes = Array.isArray(supersedes) ? supersedes : [supersedes];
  if (file) {
    // 文件先进附件库，袋里只留引用。**默认复制不搬走**：「加一条资料」不该把用户本机的
    // 原件搬进库里（那是 `file add` 的语义，且它明写「默认移动」）。
    const outcome = await att.importLocalFile(store, { path: file, copy: true, category: 'other' });
    item = normalizeSourceItem({ kind: 'file', fileId: outcome.record!.id, name: name || outcome.record!.name, ...extra });
    if (!dryRun && !outcome.duplicate) await mutateStore((s) => { s.files.push(outcome.record!); });
  } else if (url) {
    item = normalizeSourceItem({ kind: 'url', url, name, ...extra });
  } else if (text !== undefined && text !== null && String(text).trim() !== '') {
    item = normalizeSourceItem({ kind: 'text', text, name, ...extra });
  } else {
    throw badInput('要给一条资料：--text <文字> | --file <本机路径> | --url <网址>');
  }
  if (!item) throw badInput('这条资料是空的，没东西可加');
  // 冲突判定（同名以新的为准、旧的留痕）在归一层统一发生
  const next = resolveSourceConflicts([...items, item]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: item, count: next.length };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', added: item, count: next.length, current: next.filter((x) => !x.superseded).length, id: target.id, title: target.title, section: sec.id };
}

/**
 * source update：改袋里某一条的**元信息**（名字 / 备注 / 整理去向）。
 *
 * 为什么要它：「整理完要留痕」是双向同步的锚点 —— 一条资料被同步到哪些字段（mapped）
 * 记在它自己身上，下次同步就能知道「这条已经用过」，不会重复整理。
 * 注意**不改正文**（text 永远是原文；改内容 = 删掉重加）。
 */
export async function updateSourceItem(ref: unknown, { section, id, name, note, mapped, at, superseded, 'dry-run': dryRun }: {
  section?: string;
  id?: unknown;
  name?: unknown;
  note?: unknown;
  mapped?: unknown;
  at?: unknown;
  superseded?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) throw notFound(`袋里没有这条资料: ${key}`);
  const item = { ...items[idx] };
  if (name !== undefined) item.name = String(name);
  if (note !== undefined) item.note = String(note);
  if (at !== undefined) item.at = String(at);
  if (superseded !== undefined) {
    if (superseded === true) item.superseded = true;
    else delete item.superseded;
  }
  if (mapped !== undefined) {
    const list = Array.isArray(mapped) ? mapped : String(mapped).split(/[,，、]+/);
    const keys = list.map((x) => String(x).trim()).filter(Boolean);
    if (keys.length) item.mapped = keys;
    else delete item.mapped;
  }
  const next = resolveSourceConflicts([...items.slice(0, idx), item, ...items.slice(idx + 1)]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: item };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', updated: item, count: next.length, id: target.id, title: target.title };
}

/** source remove：从袋里删掉一条。 */
export async function removeSourceItem(ref: unknown, { section, id, 'dry-run': dryRun }: { section?: string; id?: unknown; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) {
    const hint = items.length ? `袋里有 ${items.length} 条，用 nx-sk source get ${target.id} 看 id` : '袋是空的';
    throw notFound(`袋里没有这条资料: ${key}（${hint}）`);
  }
  const [gone] = items.splice(idx, 1);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: gone };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = items.length ? items : null;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', removed: gone, count: items.length, id: target.id, title: target.title };
}

/**
 * source ensure：给所有缺「原始资料」字段的栏目补上。
 *
 * 为什么需要它：栏目是**持久化数据**，模板后来新增的字段不会回溯到已建好的栏目
 * （老问题的同一形状，见 `section sync`）。source 字段是「每个栏目都该有」的那种，
 * 所以给一条命令把缺口一次补齐，而不是让用户逐个栏目加。
 */
export async function ensureSourceFields({ 'dry-run': dryRun }: { 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const added: string[] = [];
  const skipped: Array<{ id: string; title: string; why: string }> = [];
  for (const sec of store.sections) {
    if (sec.kv) { skipped.push({ id: sec.id, title: sec.title, why: 'KV 表（形状固定，不加字段）' }); continue; }
    if (sec.fields.some((f) => f.type === 'source')) { skipped.push({ id: sec.id, title: sec.title, why: '已有' }); continue; }
    added.push(sec.id);
  }
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: added, skipped };
  if (!added.length) return { status: 'ok', added: [], skipped, count: 0 };
  await mutateStore((s) => {
    for (const id of added) {
      const sec = s.sections.find((x) => x.id === id);
      if (!sec) continue;
      if (!sec.groups.some((g) => g.id === SOURCE_GROUP.id)) sec.groups.push({ ...SOURCE_GROUP });
      if (!sec.fields.some((f) => f.key === SOURCE_FIELD.key)) sec.fields.push({ ...SOURCE_FIELD });
      sec.updatedAt = nowIso();
    }
  });
  return { status: 'ok', added, skipped, count: added.length };
}

// —— CLI 人读渲染（KV 系列） ——
export function renderKeyList(d: Awaited<ReturnType<typeof keyList>>) {
  const lines = [`${d.count} 个密钥 · 栏目 ${d.section}${d.mask ? ' · 已打码' : ''}`];
  for (const k of d.keys) lines.push(`  ${String(k.name).padEnd(24)} ${k.value}`);
  lines.push('', `取值: nx-sk key get <名称>　　写入: nx-sk key set <名称> <值>　　（要打码加 --mask）`);
  return lines.join('\n');
}

export function renderKeyGet(d: Awaited<ReturnType<typeof keyGet>>) {
  return `${d.name} = ${d.value}${d.mask ? '\n（已打码显示；去掉 --mask 即原文）' : ''}`;
}

/** renderKeySet 的入参：key set 的落盘 / 试运行 / 未变三种结果。 */
interface KeySetView {
  status?: string;
  unchanged?: boolean;
  name?: string;
  section?: string;
  created?: boolean;
  wouldCreate?: unknown;
  wouldChange?: unknown;
}

export function renderKeySet(d: KeySetView) {
  if (d.status === 'skipped' && d.unchanged) return `未改动：${d.name} 的值与现有值相同`;
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange)}`;
  return `${d.created ? '已新建' : '已覆盖'}密钥 ${d.name}（栏目 ${d.section}）`
    + `\n值已密文落盘；核对用 nx-sk key get ${d.name}`;
}

/** renderKeyRemove 的入参：key remove 的落盘 / 试运行两种结果。 */
interface KeyRemoveView {
  status?: string;
  wouldRemove?: unknown;
  removed?: { title: string };
}

export function renderKeyRemove(d: KeyRemoveView) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldRemove)}`;
  return `已删除密钥 ${d.removed!.title}`;
}

// —— CLI 人读渲染（原始资料） ——
const SOURCE_KIND_LABEL = { text: '文字', file: '附件', url: '网址' };

export function renderSourceList(d: Awaited<ReturnType<typeof listSource>>) {
  const lines = [`原始资料袋 · ${d.count} 个栏目`];
  for (const s of d.sections) {
    const tag = s.hasField ? '' : '　[缺 source 字段：nx-sk source ensure 补上]';
    lines.push(`  ${s.section.padEnd(14)}${s.sectionTitle}　${s.items} 条资料 / ${s.filled} 个条目有袋（栏目共 ${s.entries} 条目）${tag}`);
  }
  lines.push('', '看某个条目的袋: nx-sk source get <条目id>　　加一条: nx-sk source add <条目id> --text "…"');
  return lines.join('\n');
}

export function renderSourceGet(d: Awaited<ReturnType<typeof getSource>>) {
  const lines = [`${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 原始资料 ${d.count} 条`
    + (d.superseded ? `（当前 ${d.current} 条，另有 ${d.superseded} 条被更新的取代、留痕可查）` : '')];
  if (!d.count) {
    lines.push('  （袋子是空的）');
    lines.push('', `加一条: nx-sk source add ${d.id} --text "随手记的一句"`);
    return lines.join('\n');
  }
  for (const item of d.items) {
    const kind = SOURCE_KIND_LABEL[item.kind] || item.kind;
    const mapped = item.mapped?.length ? `　→ 已整理到 ${item.mapped.join('、')}` : '';
    const old = item.superseded ? '　[已被取代，留痕]' : '';
    const when = sourceItemTimeLabel(item);
    lines.push(`  ${item.id}　[${kind}] ${item.name}${when ? `　${when}` : ''}${old}${mapped}`);
    if (item.kind === 'file') {
      const f = item.fileId ? d.files?.[item.fileId] : undefined;
      lines.push(`      ${f ? `${f.name}　${f.path}` : `附件 ${item.fileId}（库里已不存在）`}`);
    } else if (item.kind === 'text') {
      // text 的底层是 markdown：图片引用还原成「[图片: 说明] 本地路径」，外链标注「外链」——
      // CLI 没法显示图，但读者要知道这里本来有图、图在哪。
      const text = rewriteMdImages(item.text, (id) => d.files?.[id] || null);
      for (const line of String(text).split('\n')) lines.push(`      ${line}`);
    } else if (item.kind === 'url') {
      lines.push(`      ${item.url}`);
    }
    if (item.note) lines.push(`      备注: ${item.note}`);
  }
  lines.push('', `整理成结构化字段: nx-sk entry update ${d.id} --data @整理.json`);
  return lines.join('\n');
}

/** renderSourceChange 的入参：source add/update/remove/ensure 的结果共用的读侧形状。 */
interface SourceChangeView {
  status?: string;
  wouldAdd?: unknown;
  wouldChange?: unknown;
  wouldRemove?: unknown;
  added?: unknown;
  removed?: SourceItem | null;
  count?: number;
}

export function renderSourceChange(d: SourceChangeView) {
  if (d.status === 'skipped') {
    // 顺序要紧：ensure 的 wouldAdd 是**栏目 id 数组**，add 的是**一条资料对象**——
    // 数组也是真值，先判 item 会把数组当成资料渲染成 "[undefined] undefined"。
    if (Array.isArray(d.wouldAdd)) {
      return d.wouldAdd.length
        ? `试运行（未落盘）：将给 ${d.wouldAdd.length} 个栏目补上「原始资料」字段：${d.wouldAdd.join('、')}`
        : '试运行（未落盘）：所有栏目都已有「原始资料」字段，无需补';
    }
    if (d.wouldAdd) return `试运行（未落盘）：将加入一条资料 [${(d.wouldAdd as SourceItem).kind}] ${(d.wouldAdd as SourceItem).name}`;
    if (d.wouldRemove) return `试运行（未落盘）：将移除 ${(d.wouldRemove as SourceItem).id}（${(d.wouldRemove as SourceItem).name}）`;
    return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldRemove || {})}`;
  }
  if (d.removed) return `已从资料袋移除 ${d.removed.id}（${d.removed.name}）· 袋里还剩 ${d.count} 条`;
  if (d.added && !Array.isArray(d.added)) return `已加入资料 [${(d.added as SourceItem).kind}] ${(d.added as SourceItem).name} · 袋里共 ${d.count} 条`;
  if (Array.isArray(d.added)) {
    return d.added.length
      ? `已给 ${d.added.length} 个栏目补上「原始资料」字段：${d.added.join('、')}`
      : '所有栏目都已有「原始资料」字段，无需补';
  }
  return '没有改动';
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

/**
 * entry.add-field：在条目内添加**扩展字段**（显式指定类型/分组）。
 *
 * v3 写时复制语义：只写条目自身的结构行（template_field_id 由 upsert 按字典判定），
 * **不动栏目字典**——字典保持「模板 + 台账」身份。--value 顺手给初值时走
 * updateEntry 的同一条封装链（凭据样键落盘即密文）。
 */
export async function addEntryField(ref: unknown, ctx: {
  key?: unknown; label?: unknown; type?: unknown; group?: unknown; value?: unknown;
  section?: string; 'dry-run'?: boolean;
} = {}) {
  const key = assertFieldKey(String(ctx.key ?? '').trim());
  const type = String(ctx.type || 'text');
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    throw badInput(`未知字段类型 "${type}"（可用: ${FIELD_TYPES.join(', ')}）`);
  }
  const store = await loadStore();
  const target = resolveEntry(store, ref, ctx.section);
  const sec = mustFindSection(store, target.section);
  if (sec.kv) {
    throw badInput(`栏目「${sec.title}」是一张 KV 表（一行一个键值对），不给它加字段——要加键用 nx-sk key set <名称> <值>，或在面板 KV 表格里加一行。`);
  }
  const rows = entryStructures(store).get(target.id) || [];
  const hit = rows.find((r) => r.key === key);
  if (hit) throw conflict(`条目已有字段「${key}」（行 ${hit.id}）——直接写值即可：nx-sk entry update ${target.id} --set ${key}=值`);
  const groupIds = (sec.groups || []).map((g) => g.id);
  const group = String(ctx.group ?? '').trim() || groupIds[0] || 'other';
  if (!groupIds.includes(group) && group !== 'other') {
    throw badInput(`栏目「${sec.title}」没有分组 "${group}"（可用: ${groupIds.join(', ') || '无'}）`);
  }
  const def = { key, label: String(ctx.label ?? '').trim() || key, type, group } as unknown as FieldDef;
  if (ctx['dry-run']) {
    return { status: 'skipped', dryRun: true, entry: target.id, wouldAddField: def, wouldSetValue: ctx.value !== undefined && ctx.value !== '' };
  }
  await upsertEntryFields(target.id, [def]);
  const hasInitial = ctx.value !== undefined && ctx.value !== '';
  if (hasInitial) await updateEntry(target.id, { section: sec.id, set: { [key]: ctx.value } });
  const got = await getEntry(target.id, { section: sec.id });
  return { ...got, addedField: def, valueSet: hasInitial };
}

export function renderEntryAddField(d: Awaited<ReturnType<typeof addEntryField>>) {
  if ((d as { status?: string }).status === 'skipped') {
    const w = (d as unknown as { wouldAddField: FieldDef }).wouldAddField;
    return `试运行（未落盘）：将给条目 ${String((d as unknown as { entry: string }).entry)} 添加扩展字段「${w.label}」(${w.key}) · 类型 ${w.type} · 分组 ${String(w.group)}${(d as unknown as { wouldSetValue: boolean }).wouldSetValue ? ' · 带初值' : ''}`;
  }
  const got = d as Awaited<ReturnType<typeof getEntry>> & { addedField: FieldDef; valueSet: boolean };
  return `已添加扩展字段「${got.addedField.label}」(${got.addedField.key}) · 类型 ${got.addedField.type} · 分组 ${String(got.addedField.group)}${got.valueSet ? ' · 已写入初值' : ''}\n${renderEntryGet(got)}`;
}

/**
 * 在**条目自身结构行**里定位一行（任务 #20：返回行本体，不是 spec）。
 * key 精确优先、其次 label；与 resolveOwnRow 同一口径——**含脱离行**（restore 要用它找到藏着的行）。
 */
function findOwnRow(rows: EntryFieldView[], rawKey: unknown): EntryFieldView | null {
  const key = String(rawKey ?? '').trim();
  const byKey = rows.filter((r) => r.key === key);
  if (byKey.length) return byKey[0];
  const byLabel = rows.filter((r) => String(r.label ?? '') === key);
  if (byLabel.length > 1) {
    throw conflict(`字段定位「${key}」在条目自身结构里有 ${byLabel.length} 行命中（${byLabel.map((r) => r.id).join(', ')}），请用键名精确指定`);
  }
  return byLabel[0] || null;
}

/**
 * entry.remove-field：条目级字段移除（任务 #20，v3 写时复制模型）。
 *
 * 三种语义（与栏目字典侧同一条纪律：内置 source 袋不许动）：
 *   - 扩展行（template_field_id NULL）→ **硬删** entry_fields 行，field_data 随 CASCADE 走，
 *     值没了就是没了（面板必须先弹确认）。
 *   - 模板行 → **脱离（detach）**：行保留、meta 记 detached=1；该条目不再渲染/序列化/计完整度
 *     这个字段，**栏目字典与其他条目不受影响**；值仍住在 field_data。
 *   - 已脱离 + --restore → 去掉 detached 标记，值原样回来（脱离从不动 field_data）。
 *
 * 返回该条目最新 getEntry 形状 + `removed|detached|restored` 标记与 `field` 明细。
 */
export async function removeEntryField(ref: unknown, ctx: {
  key?: unknown; section?: string; restore?: boolean; 'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, ctx.section);
  const sec = mustFindSection(store, target.section);
  const rows = entryStructures(store).get(target.id) || [];
  const row = findOwnRow(rows, ctx.key);
  if (!row) {
    throw notFound(`条目「${target.title || target.id}」没有字段: ${String(ctx.key ?? '').trim()}`
      + `（看现有字段: nx-sk entry get ${target.id}；已脱离的用 --restore 恢复）`);
  }
  if (row.key === SOURCE_FIELD.key) {
    throw badInput(`「${SOURCE_FIELD.label}」是每个条目自带的内置字段（与栏目字典同一条纪律：删了下回读又会补回来），不给移除。`);
  }
  const detached = isDetachedField(row);
  const kind: 'template' | 'extension' = row.templateFieldId != null ? 'template' : 'extension';
  const field = { key: row.key, label: row.label || row.key, kind };

  if (ctx.restore) {
    if (!detached) throw badInput(`字段「${field.label}」没有被从本条目移除过，无需恢复`);
    if (ctx['dry-run']) return { status: 'skipped', dryRun: true, entry: target.id, wouldRestore: field };
    const changed = await detachEntryField(target.id, row.id, false);
    if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
    const got = await getEntry(target.id, { section: sec.id });
    return { ...got, restored: true, field };
  }
  if (detached) {
    throw conflict(`字段「${field.label}」已从本条目移除（管理条里点「恢复」可找回，值还在）`);
  }
  if (ctx['dry-run']) return { status: 'skipped', dryRun: true, entry: target.id, wouldRemove: field };
  if (kind === 'extension') {
    const changed = await removeEntryFieldRow(target.id, row.id);
    if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
    const got = await getEntry(target.id, { section: sec.id });
    return { ...got, removed: true, field };
  }
  const changed = await detachEntryField(target.id, row.id, true);
  if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
  const got = await getEntry(target.id, { section: sec.id });
  return { ...got, detached: true, field };
}

export function renderEntryRemoveField(d: Awaited<ReturnType<typeof removeEntryField>>) {
  const x = d as unknown as {
    status?: string; id?: string; entry?: string; field?: { key: string; label: string; kind: string };
    wouldRemove?: { key: string; label: string; kind: string }; wouldRestore?: { key: string; label: string; kind: string };
    removed?: boolean; detached?: boolean; restored?: boolean;
  };
  if (x.status === 'skipped') {
    const w = x.wouldRemove || x.wouldRestore;
    const act = x.wouldRestore ? '恢复' : (w?.kind === 'extension' ? '硬删（值一并删除，不可恢复）' : '从本条目脱离（值保留，可 --restore）');
    return `试运行（未落盘）：将${act}条目 ${String(x.entry)} 的字段「${w?.label}」(${w?.key})`;
  }
  const head = x.restored
    ? `已恢复模板字段「${x.field?.label}」(${x.field?.key}) 到本条目，值原样回来`
    : x.removed
      ? `已删除扩展字段「${x.field?.label}」(${x.field?.key})——行与值一并删除，不可恢复`
      : `已从本条目移除模板字段「${x.field?.label}」(${x.field?.key})——值仍保留，用 nx-sk entry remove-field ${x.id} --key ${x.field?.key} --restore 找回`;
  return `${head}\n${renderEntryGet(d as unknown as Awaited<ReturnType<typeof getEntry>>)}`;
}

// —— 表格字段（table）的现值 ——
//
// 为什么要一条专门的命令：`entry get` 会把整条条目都印出来，而表格常常是这个条目的主体；
// 只想看「这张表现在多少、合计多少」时，一条命令给一张对齐的表比翻整条条目快得多。
// 它**不写**任何东西：计算列与统计行都是现算的，没有第二份状态可以走偏。

export async function getTable(ref: unknown, { field, mask, section }: { field?: unknown; mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const structures = entryStructures(store);
  const ownRows = structures.get(entry.id) || null;
  const defs = defsForEntry(sec, ownRows).filter((f) => f.type === 'table');
  if (!defs.length) {
    throw notFound(`栏目「${sec.title}」没有表格字段（table）。现有字段: ${defsForEntry(sec, ownRows).map((f) => `${f.label}(${f.type})`).join('、')}`);
  }
  const wanted = String(field ?? '').trim();
  const def = wanted
    ? (defs.find((f) => f.key === wanted || f.label === wanted) || null)
    : defs[0];
  if (!def) {
    throw notFound(`栏目「${sec.title}」没有叫「${wanted}」的表格字段（有: ${defs.map((f) => `${f.label}(${f.key})`).join('、')}）`);
  }
  const decrypt = await sensitiveViewer(sec, [entry], structures);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt, ownRows });
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    field: def.key,
    fieldLabel: def.label,
    mask: !!mask,
    table: computeTable(def, serialized.values[def.key]),
  };
}

export function renderTable(d: Awaited<ReturnType<typeof getTable>>) {
  const t = d.table;
  const head = `${d.title || d.id}（${d.id}）· 栏目 ${d.sectionTitle} · 表格「${d.fieldLabel}」${d.field} · ${t.count} 行`
    + (t.errorCount ? ` · ${t.errorCount} 处公式错误` : '')
    + (d.mask ? ' · 已打码' : '');
  const totals = t.totals.length
    ? `\n统计行: ${t.totals.map((x) => x.label).join(' / ')}（每列算不算、怎么算，看列定义的 total；整表表达式写在数据的 totals 里）`
    : '';
  const formulas = t.columns.filter((c) => c.computed);
  const fx = formulas.length ? `\n计算列: ${formulas.map((c) => `${c.label} = ${c.formula}`).join('；')}` : '';
  return `${head}\n${renderTableText(t)}${fx}${totals}`;
}

export function renderFields(d: Awaited<ReturnType<typeof fieldDictionary>>) {
  const lines = [`字段字典：${d.count} 个栏目`];
  for (const s of d.sections) {
    lines.push('', `【${s.title}】${s.id}　条目名字段: ${s.titleField || '（未设）'}　共 ${s.fields.length} 字段`);
    for (const g of s.groups) {
      lines.push(`  ${g.title}（${g.id}）`);
      for (const x of s.fields.filter((f) => f.group === g.id)) {
        const cols = Array.isArray(x.columns)
          ? `  列: ${x.columns.map((c) => `${c.label}[${c.type}${c.formula ? ' 算' : ''}]`).join(' / ')}`
          : '';
        lines.push(`    ${x.key.padEnd(22)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.options ? `  可选: ${x.options.join(' / ')}` : ''}${cols}${x.hint ? `　${x.hint}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------- 关键 key 台账（链接 / 账号 / 密码 / 镜像 的跨栏目统一列表） ----------
//
// 需求：散在各栏目条目里的「关键 key」（控制台链接、账号、密码、镜像名…）要有一张
// 统一清单，方便一眼拿到、也方便交给 agent 定位修改。
// 匹配规则：字段 key/label 命中启发式 **或** 字段类型是 secret/标记 sensitive。
// **结构清单要展开成行**：场景凭据（deploy 的「凭据清单」）住在清单的行里，
// 只扫顶层字段的话台账就看不见最该看见的那些。
// 值策略：链接类明文（地址是要点击使用的）；账号/密码/token 类一律打码（短值全 *）；
// 其余长文本前 4+尾 4。--reveal 才出原文（密文走解密）。
const KEY_URL_RE = /(url|link|链接|console|入口|registry|仓库|image|镜像)/i;
const KEY_SECRET_RE = /(account|user(?!id)|账号|帐号|password|密码|passwd|pwd|token|secret|apikey|api_key|密钥|身份证|idcard|phone|电话|bank)/i;
const KEY_FIELD_RE = new RegExp(`${KEY_URL_RE.source}|${KEY_SECRET_RE.source}`, 'i');

export async function keysLedger({ section, q, reveal }: { section?: string; q?: unknown; reveal?: boolean } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  let sections = store.sections;
  if (section) sections = [mustFindSection(store, section)];
  const out: Array<{ section: string; sectionId: string; entry: string; entryId: string; key: string; label: string; sensitive: boolean; value: string }> = [];
  for (const sec of sections) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    if (!mine.length) continue;
    const decrypt = await sensitiveViewer(sec, mine, structures);
    for (const e of mine) {
      const ownRows = structures.get(e.id) || null;
      const item = serializeEntry(sec, e, { decrypt, ownRows });
      for (const def of defsForEntry(sec, ownRows)) {
        const raw = item.values?.[def.key];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;

        // **清单类字段要展开成行**：场景凭据住在清单的行里（deploy 的「凭据清单」、
        // 表格里的「密码」列）—— 只扫顶层字段的话，台账恰好看不见最该看见的那些，
        // 「一条命令看全部凭据」必须真的看得到全部。
        const doc = raw as { rows?: unknown[]; columns?: unknown };
        const listRows = def.type === 'entrylist' && Array.isArray(raw)
          ? (raw as unknown[])
          : (def.type === 'table' && raw && Array.isArray(doc.rows) ? doc.rows : null);
        if (listRows) {
          // 表格的列存在数据里（结构归数据），优先用数据里的那份
          const subs = (def.type === 'table'
            ? (Array.isArray(doc.columns) && doc.columns.length ? doc.columns : (def.columns || []))
            : (def.type === 'entrylist' ? (def.fields || []) : [])) as Array<{ key: string; label?: string; sensitive?: boolean }>;
          for (const row of listRows) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const rowName = String(r.name ?? r['名称'] ?? r.task ?? r['任务'] ?? '');
            for (const [cellKey, cellVal] of Object.entries(r)) {
              if (cellVal === undefined || cellVal === null || String(cellVal).trim() === '') continue;
              const sub = subs.find((x) => x.key === cellKey);
              const cellLabel = sub?.label || cellKey;
              const secretish = sub?.sensitive === true
                || KEY_SECRET_RE.test(cellKey) || KEY_SECRET_RE.test(cellLabel);
              const urlish = KEY_URL_RE.test(cellKey) || KEY_URL_RE.test(cellLabel);
              if (!secretish && !urlish && !KEY_FIELD_RE.test(cellKey) && !KEY_FIELD_RE.test(cellLabel)) continue;
              const s = String(cellVal);
              out.push({
                section: sec.title,
                sectionId: sec.id,
                entry: e.title,
                entryId: e.id,
                key: `${def.key}.${cellKey}`,
                label: rowName ? `${rowName} · ${cellLabel}` : cellLabel,
                sensitive: secretish,
                value: reveal ? s
                  : (secretish || isCipherBlob(s)) ? maskValue(s)
                    : urlish ? s
                      : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
              });
            }
          }
          continue;
        }

        const hit = KEY_FIELD_RE.test(def.key) || KEY_FIELD_RE.test(def.label) || def.type === 'secret' || def.sensitive === true;
        if (!hit) continue;
        const s = Array.isArray(raw) ? raw.join('、') : String(raw);
        const isSecretish = def.type === 'secret' || def.sensitive === true || isSensitiveField(sec, def.key) || KEY_SECRET_RE.test(def.key) || KEY_SECRET_RE.test(def.label);
        const isUrlish = KEY_URL_RE.test(def.key) || KEY_URL_RE.test(def.label);
        out.push({
          section: sec.title,
          sectionId: sec.id,
          entry: e.title,
          entryId: e.id,
          key: def.key,
          label: def.label,
          sensitive: isSecretish,
          value: reveal ? s
            : (isSecretish || isCipherBlob(s)) ? maskValue(s)
              : isUrlish ? s
                : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
        });
      }
    }
  }
  if (q) {
    const needle = String(q).toLowerCase();
    return { count: out.length, reveal: Boolean(reveal), items: out.filter((x) =>
      [x.section, x.entry, x.key, x.label, x.value].some((v) => String(v).toLowerCase().includes(needle))) };
  }
  return { count: out.length, reveal: Boolean(reveal), items: out };
}

export function renderKeysLedger(d: Awaited<ReturnType<typeof keysLedger>>) {
  if (!d.items.length) return '（没有命中关键 key 的字段——往条目里填 链接/账号/密码/镜像 类字段后这里会出现）';
  const lines = [`关键 key 台账：${d.items.length} 条${d.reveal ? '（明文）' : '（打码；--reveal 看原文）'}`];
  let last = '';
  for (const x of d.items) {
    if (x.section !== last) { lines.push('', `【${x.section}】${x.sectionId}`); last = x.section; }
    lines.push(`  ${x.entry}（${x.entryId}）`);
    lines.push(`    ${x.label.padEnd(10)} ${x.key.padEnd(14)} ${x.sensitive ? '[密文] ' : ''}${x.value}`);
  }
  return lines.join('\n');
}


