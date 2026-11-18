// Store 对象的**纯形状层**：版本常量、默认设置、normalize（读边界收口 + 旧 JSON 迁移）。
//
// 为什么从 store.ts 拆出来：store.ts 现在是 SQLite facade（loadStore/saveStore/mutateStore），
// 而 db/importer.ts 与 db/repo.ts 都需要同一份 normalize——留在 store.ts 会形成
// store.ts ⇄ db/* 的运行时循环 import。形状层零依赖 facade，谁都能 import。
//
// 「运行时不做旧结构兼容」的落点就在这里：normalize 里的 v1→v2、v2→v3 迁移
// **只在首启导入旧 store.json 时生效**（输入 version < STORE_VERSION）；
// 从 DB 读出来的形状 version 恒为 STORE_VERSION，那些迁移函数一条都不会跑。
import { ensureSourceBuiltin, instantiateTemplate, seedEntries, seedSections } from './fields.ts';
import { normalizeStructure } from '../shared/fields/structure.ts';
import { normalizeFileRecord, type FileRecord } from './attachments.ts';
import { sanitizeLayout } from '../shared/blockLayout.ts';
import { nowIso } from './ids.ts';
import type {
  Entry as StoreEntry,
  Section as StoreSection,
  SectionGroup,
  Settings as StoreSettings,
} from '../shared/model.ts';

// P6：栏目/条目/设置的形状下沉到 shared，面板与后端共用同一份声明。
export type { StoreEntry, StoreSection, StoreSettings, SectionGroup };

/** v2：密钥栏目从 8 字段模板改成单字段 KV（名称 → 值）。
 *  v3：栏目有了 `kv` 标记——KV 栏目是一张表（面板渲染成表格，key 命令默认作用在它上面），
 *      并去掉 `settings.kvSection` 这个冗余概念。
 *  v4（0.42）：栏目不再有 `groups[]`、字段不再有 `group`——「组」变成 type='group' 的
 *      一条字段（keys 引用同栏目其他字段）。旧 store.json 在首启导入时折成新形状，
 *      DB 侧由 schema v6 迁移一次；运行时不认旧形状。 */
export const STORE_VERSION = 4;

/** store 的完整形状（P4 起作为后端共享类型；DB facade 进出都过它）。 */
export interface Store {
  version: number;
  settings: StoreSettings;
  sections: StoreSection[];
  entries: StoreEntry[];
  files: FileRecord[];
  _migration?: Record<string, unknown> | null;
}

/**
 * 条目自身结构行（schema v3 entry_fields）的读取侧形状。
 *
 * 这是「写时复制」的载体：每个条目带自己的字段行，栏目字典只是模板。
 * templateFieldId 非 NULL = 出身模板（复合串 "<sectionId>:<key>"），NULL = 扩展字段。
 * Store 对象形状不含它（values 仍是逐键的 JSON 形状）——它由 readStore 组装、
 * facade 用 WeakMap 记账，经 entryStructures(store) 取用。
 */
export interface EntryFieldView {
  id: string;
  key: string;
  label: string;
  type: string;
  hint: string;
  fill: string | null;
  position: number;
  templateFieldId: string | null;
  spec: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/**
 * 任务 #20：条目级「脱离」判据（唯一实现）。
 *
 * 模板字段从条目移除 = 行保留、meta 记 `{"detached":1}`；该条目不再渲染/序列化/
 * 计完整度这个字段，但值仍在 field_data（restore 即回）。
 * 所有读边界（values / serializeEntry / completeness / 台账 / 资源定位）都问这一个函数，
 * 而 writeStore 的存量行恢复**不**过滤它（行必须在，否则下次保存会把它当缺行补回来）。
 */
export function isDetachedField(row: { meta?: Record<string, unknown> } | null | undefined): boolean {
  return row?.meta?.detached === 1 || row?.meta?.detached === true;
}

/** 归一前的宽松输入（历史脏数据）。 */
interface RawSection {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  order?: unknown;
  template?: unknown;
  kv?: unknown;
  titleField?: unknown;
  titleLabel?: unknown;
  groups?: unknown;
  fields?: unknown;
  layout?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface RawEntry {
  id?: unknown;
  section?: unknown;
  title?: unknown;
  tags?: unknown;
  values?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function defaultSettings(): StoreSettings {
  return {
    defaultSection: 'demo',
    // 头部导航分组：[{ title, sections: [栏目 id…] }]，数组顺序 = 显示顺序。
    // 缺省空数组 = 全部栏目平铺（保持老行为）；栏目建得多了再在设置页收拢。
    navGroups: [],
    // 任务 #26：默认关——自动保存是可选偏好，老 store 读一次就补上这个键。
    autoSaveFields: false,
    // 任务 #27：字段历史默认每个字段留最近 50 版；切 time 则按天数裁。
    historyMode: 'count',
    historyCount: 50,
    historyDays: 90,
  };
}

export function emptyStore(seed: boolean): Store {
  const at = nowIso();
  return {
    version: STORE_VERSION,
    settings: defaultSettings(),
    // 只有「store 数据压根不存在」才播种。库在、但 sections 为空
    // 说明用户自己删光了栏目——这时候再播种会把它变回来，等于删不掉。
    sections: seed ? seedSections(at) : [],
    // 示例条目跟着「字段样例」栏目一起播种：没有它，那些字段就只是空格子，
    // 「感受能力边界」就少了最有说服力的那部分。
    entries: seed ? seedEntries(at) : [],
    files: [],
  };
}

function normalizeSection(raw: RawSection | null | undefined): StoreSection | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const out: StoreSection = {
    id: String(raw.id),
    title: String(raw.title || raw.id),
    description: String(raw.description || ''),
    order: Number.isFinite(raw.order) ? (raw.order as number) : 50,
    template: raw.template ? String(raw.template) : null,
    kv: raw.kv === true,
    titleField: raw.titleField ? String(raw.titleField) : null,
    titleLabel: String(raw.titleLabel || '名称'),
    fields: Array.isArray(raw.fields) ? raw.fields.map((x) => ({ ...x, key: String(x.key), label: String(x.label || x.key) })) : [],
    // 版式（块布局）是**显示关系**，与字段字典分开存：结构归栏目，版式归这一份 JSON。
    // 读的时候一律过 sanitizeLayout——手搓的脏 JSON 不许进 store，也不许让面板白屏。
    layout: sanitizeLayout(raw.layout as Record<string, unknown> | null | undefined),
    createdAt: (raw.createdAt as string | null) || null,
    updatedAt: (raw.updatedAt as string | null) || null,
  };
  // 0.42：栏目不变量只剩三条，全部收在字段字典上（唯一结构 = fields）：
  //   ① 每个普通字段恰好归属一个组（孤儿入根组）② 组声明的成员必须存在、不成环
  //   ③ 每个非 KV 栏目自带「原始资料」袋（source 字段 + 包住它的组字段）
  // 前两条由 normalizeStructure 统一修（面板/后端共用同一份实现），第三条见 ensureSourceBuiltin。
  out.fields = normalizeStructure(out.fields as any, { ensureRoot: !out.kv }) as typeof out.fields;
  out.fields = ensureSourceBuiltin(out.fields as any, { kv: out.kv }) as typeof out.fields;
  // 袋补完再修一次：source 字段的归属由 ensureSourceBuiltin 决定
  out.fields = normalizeStructure(out.fields as any, { ensureRoot: !out.kv }) as typeof out.fields;
  return out;
}

/**
 * 旧 store.json（v3 及以前）→ 新形状的一次性折算：`section.groups[]` + `field.group`
 * 折成 type='group' 的字段。**只在首启导入旧 JSON 时跑**（normalize 的 oldVersion < 4 分支），
 * DB 读出来的形状不会走这里——DB 侧的同一件事是 migrations/v6-apply.ts。
 */
function foldLegacyGroups(raw: Record<string, unknown>): void {
  const groups = Array.isArray(raw.groups) ? (raw.groups as Array<Record<string, unknown>>) : [];
  const fields = Array.isArray(raw.fields) ? (raw.fields as Array<Record<string, unknown>>) : [];
  if (!groups.length && !fields.some((f) => f && typeof f.group === 'string')) return;
  // 组 id 一次声明可能缺失（历史自愈行）→ 用字段引用补出来，标题就用 id。
  const declared = new Map<string, string>();
  for (const g of groups) {
    if (!g || g.id == null) continue;
    declared.set(String(g.id), String(g.title || g.id));
  }
  const memberOf = new Map<string, string[]>();
  const plain: Array<Record<string, unknown>> = [];
  for (const f of fields) {
    if (!f || f.key == null) continue;
    const { group, ...rest } = f;
    const gid = group == null ? '' : String(group);
    if (gid) {
      if (!declared.has(gid)) declared.set(gid, gid);
      const list = memberOf.get(gid) || [];
      list.push(String(f.key));
      memberOf.set(gid, list);
    }
    plain.push(rest);
  }
  const groupFields = [...declared.keys()].map((gid) => ({
    key: gid, label: declared.get(gid) || gid, type: 'group', keys: memberOf.get(gid) || [],
  }));
  raw.fields = [...groupFields, ...plain];
  delete raw.groups;
}

function normalizeEntry(raw: RawEntry | null | undefined): StoreEntry | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    section: String(raw.section || ''),
    title: String(raw.title || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    values: raw.values && typeof raw.values === 'object' ? { ...(raw.values as Record<string, unknown>) } : {},
    createdAt: (raw.createdAt as string | null) || null,
    updatedAt: (raw.updatedAt as string | null) || null,
  };
}

// v1 的密钥模板字段。迁移时**不动 values 里这些键**——只把 keyValue 搬到 value，
// 并把字典缩成单字段。「不再显示」和「删掉」是两件事：删掉就再也找不回来了。
const LEGACY_SECRET_KEYS = ['keyValue', 'provider', 'baseUrl', 'model', 'purpose', 'expiresAt', 'quota', 'note'];

/**
 * v1 → v2：把「密钥」栏目从 8 字段模板迁成单字段 KV。
 *
 * 幂等：只有 `version < 2` 才调用（首启导入旧 JSON 的唯一入口），
 * 落库后 version 恒为当前，运行时路径不会再触发。
 */
function migrateSecretToKv(store: Store) {
  const sec = store.sections.find((s) => s.id === 'secret');
  if (!sec) return null;
  const looksLegacy = sec.fields.some((x) => LEGACY_SECRET_KEYS.includes(x.key))
    && !sec.fields.some((x) => x.key === 'value');
  if (!looksLegacy) return null;

  const tpl = instantiateTemplate('secret', { id: sec.id, title: sec.title, order: sec.order })!;
  const moved: string[] = [];
  for (const e of store.entries.filter((x) => x.section === sec.id)) {
    const v = e.values || (e.values = {});
    const empty = v.value === undefined || v.value === null || v.value === '';
    if (empty && v.keyValue !== undefined && v.keyValue !== null && v.keyValue !== '') {
      v.value = v.keyValue;
      moved.push(e.id);
    }
  }
  sec.fields = tpl.fields;
  sec.titleField = tpl.titleField;
  sec.titleLabel = tpl.titleLabel;
  sec.template = 'secret';
  sec.description = tpl.description;
  sec.updatedAt = nowIso();

  const stillHolding = store.entries
    .filter((e) => e.section === sec.id)
    .reduce((n: number, e) => n + LEGACY_SECRET_KEYS.filter((k) => k !== 'keyValue'
      && e.values?.[k] !== undefined && e.values?.[k] !== null && e.values?.[k] !== '').length, 0);

  return {
    section: sec.id,
    fieldsBefore: LEGACY_SECRET_KEYS.length + 1,
    fieldsAfter: tpl.fields.length,
    entries: store.entries.filter((e) => e.section === sec.id).length,
    movedValues: moved.length,
    legacyValuesKept: stillHolding,
  };
}

/**
 * v2 → v3：把「密钥」栏目标成 KV 表，并把误当字段用的键值搬进值列。
 *
 * 背景：面板早先那行「KV 直填」在 KV 栏目里也把 `089=xxx` 当成**新字段**登记了
 * （字段名 = `089`），而用户的本意是「加一个新键」。这里把「唯一一个非空且不是 value
 * 的字段值」搬进 value —— 该条目就变成「标题 = 键名，value = 值」的正常样子。
 * 其余留在 values 里的键**一律不删**（不再显示 ≠ 删掉）。
 */
function migrateKvToTable(store: Store, oldSettings: { kvSection?: unknown } | null | undefined) {
  const marked = store.sections.filter((s) => s.kv);
  const target = marked[0]
    || store.sections.find((s) => s.id === String(oldSettings?.kvSection || 'secret'));
  if (!target) return null;

  const tpl = instantiateTemplate('secret', { id: target.id, title: target.title, order: target.order })!;
  const fieldsBefore = target.fields.length;
  const moved: string[] = [];

  for (const e of store.entries.filter((x) => x.section === target.id)) {
    const v = e.values || (e.values = {});
    const valueEmpty = v.value === undefined || v.value === null || v.value === '';
    if (!valueEmpty) continue;
    const others = Object.keys(v).filter((k) => k !== 'value' && v[k] !== undefined && v[k] !== null && v[k] !== '');
    if (others.length === 1) { v.value = v[others[0]]; moved.push(`${e.title}:${others[0]}`); }
  }

  target.kv = true;
  target.fields = tpl.fields;
  target.titleField = tpl.titleField;
  target.titleLabel = tpl.titleLabel;
  target.template = 'secret';
  target.description = tpl.description;
  target.updatedAt = nowIso();

  return {
    section: target.id,
    fieldsBefore,
    fieldsAfter: tpl.fields.length,
    movedValues: moved.length,
    movedDetail: moved,
  };
}

export function normalize(data: unknown): Store {
  if (!data || typeof data !== 'object') return emptyStore(true);
  const d = data as Partial<Store> & { settings?: Record<string, unknown> };
  const oldVersion = Number(d.version || 1);
  const rawSettings = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const base = emptyStore(false);
  base.version = STORE_VERSION;
  base.settings = { ...base.settings, ...rawSettings };
  // v3 起 kvSection 没了：哪个栏目是 KV，由栏目自己的 kv 标记说了算
  delete base.settings.kvSection;
  const rawSections = Array.isArray(d.sections) ? d.sections : [];
  // v4（0.42）：旧 JSON 的分组结构一次性折成 group 字段（DB 读路径 version 恒为 4，不会进这里）
  if (oldVersion < 4) for (const s of rawSections) if (s && typeof s === 'object') foldLegacyGroups(s as unknown as Record<string, unknown>);
  base.sections = rawSections.map(normalizeSection).filter((x): x is StoreSection => x !== null);
  base.entries = (Array.isArray(d.entries) ? d.entries : []).map(normalizeEntry).filter((x): x is StoreEntry => x !== null);
  base.files = (Array.isArray(d.files) ? d.files : []).map(normalizeFileRecord).filter((x): x is FileRecord => x !== null);
  if (oldVersion < 2) base._migration = migrateSecretToKv(base);
  if (oldVersion < 3) {
    const m = migrateKvToTable(base, rawSettings);
    if (m) base._migration = { ...(base._migration || {}), ...m };
  }
  return base;
}

