// 状态读写：原子写 + 按 mtime 失效的缓存 + 读-改-写事务 + 版本迁移。
// 所有模块都通过这里碰磁盘，不自己拼路径、不自己 JSON.parse。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { displayPath, migrationDir, storeFile } from './paths.ts';
import { ensureDir, pathExists, writeAtomic } from './fsx.ts';
import { ensureSourceBuiltin, instantiateTemplate, seedEntries, seedSections, syncSectionGroups } from './fields.ts';
import { normalizeFileRecord, type FileRecord } from './attachments.ts';
import { sanitizeLayout } from '../shared/blockLayout.ts';
import { nowIso, stamp } from './ids.ts';
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
 *      并去掉 `settings.kvSection` 这个冗余概念。 */
export const STORE_VERSION = 3;

/** store.json 的完整形状（P4 起作为后端共享类型）。 */
export interface Store {
  version: number;
  settings: StoreSettings;
  sections: StoreSection[];
  entries: StoreEntry[];
  files: FileRecord[];
  _migration?: Record<string, unknown> | null;
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
  };
}

function emptyStore(seed: boolean): Store {
  const at = nowIso();
  return {
    version: STORE_VERSION,
    settings: defaultSettings(),
    // 只有「store 文件压根不存在」才播种。文件在、但 sections 为空
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
    groups: Array.isArray(raw.groups) ? raw.groups.map((g) => ({ id: String(g.id), title: String(g.title || g.id) })) : [],
    fields: Array.isArray(raw.fields) ? raw.fields.map((x) => ({ ...x, key: String(x.key), label: String(x.label || x.key) })) : [],
    // 版式（块布局）是**显示关系**，与字段字典分开存：结构归栏目，版式归这一份 JSON。
    // 读的时候一律过 sanitizeLayout——手搓的脏 JSON 不许进 store，也不许让面板白屏。
    layout: sanitizeLayout(raw.layout as Record<string, unknown> | null | undefined),
    createdAt: (raw.createdAt as string | null) || null,
    updatedAt: (raw.updatedAt as string | null) || null,
  };
  // 「分组声明 ⊇ 字段引用」是栏目不变量：字段引用了没声明的分组，面板的分组表单
  // 会整组消失（真实事故：servers 栏目 groups 为空，Web 端白屏而 CLI 正常）。
  // 放在 normalize 收口——每条读写路径都会过这里，存量数据读一次就自愈。
  out.groups = syncSectionGroups(out.groups, out.fields);
  // 「原始资料」袋是每个非 KV 栏目自带的结构（不是可选字段）：存量栏目缺了
  // 读一次就补上，与上面的分组自愈同一条收口路径。规则只此一份，见 ensureSourceBuiltin。
  const ensured = ensureSourceBuiltin(out.groups, out.fields, { kv: out.kv });
  out.groups = ensured.groups;
  out.fields = ensured.fields;
  return out;
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
 * 幂等：只有 `version < 2` 才调用，且落盘后 version 变 2，不会再触发。
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
  sec.groups = tpl.groups;
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
  target.groups = tpl.groups;
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
  base.sections = (Array.isArray(d.sections) ? d.sections : []).map(normalizeSection).filter((x): x is StoreSection => x !== null);
  base.entries = (Array.isArray(d.entries) ? d.entries : []).map(normalizeEntry).filter((x): x is StoreEntry => x !== null);
  base.files = (Array.isArray(d.files) ? d.files : []).map(normalizeFileRecord).filter((x): x is FileRecord => x !== null);
  if (oldVersion < 2) base._migration = migrateSecretToKv(base);
  if (oldVersion < 3) {
    const m = migrateKvToTable(base, rawSettings);
    if (m) base._migration = { ...(base._migration || {}), ...m };
  }
  return base;
}

let cache: Store | null = null;
let cachePath: string | null = null;
let cacheMtime = -1;
let cacheCorruptNote: { from: string; to: string; error: string } | null = null;
let cacheMigrationNote: Record<string, unknown> | null = null;

export function storePathInUse(): string {
  return storeFile();
}

/** 最近一次读盘时把损坏文件挪走的记录（bootstrap / health 会展示）。 */
export function corruptNote() {
  return cacheCorruptNote;
}

/** 最近一次数据迁移的记录（含原始快照路径），供 bootstrap 展示。 */
export function migrationNote() {
  return cacheMigrationNote;
}

// 首次读取时播种的并发门闩：两个请求同时发现文件不存在时，只播一次、写一次。
let seedPromise: Promise<Store> | null = null;

export async function loadStore(explicitPath?: string): Promise<Store> {
  const p = explicitPath || storeFile();
  try {
    const st = await fsp.stat(p);
    if (cache && cachePath === p && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    let parsed: unknown = null;
    let corrupt: string | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 读失败**降级返回空结构**（工具不该启动即崩），但先把损坏文件留一份——
      // 直接返回空结构的话，下一次写入就把用户的数据永久覆盖了。
      corrupt = join(p + '.corrupt-' + stamp() + '.json');
      try { await fsp.rename(p, corrupt); } catch { /* 尽力 */ }
      cacheCorruptNote = { from: p, to: corrupt, error: String(e && (e as Error).message) };
    }
    const oldVersion = Number((parsed as { version?: number } | null)?.version || 1);
    const next = normalize(parsed);

    if (!corrupt && oldVersion < STORE_VERSION && next._migration) {
      // 迁移前先把**原始文件**原样留一份（不是迁移后的），出问题能整份退回
      const snapshot = join(migrationDir(), `${stamp()}-migrate-v${oldVersion}-to-v${STORE_VERSION}.json`);
      await ensureDir(migrationDir());
      try { await fsp.copyFile(p, snapshot); } catch { /* 尽力 */ }
      cacheMigrationNote = {
        from: oldVersion,
        to: STORE_VERSION,
        snapshot: displayPath(snapshot),
        snapshotRaw: snapshot,
        ...next._migration,
      };
      delete next._migration;
      // 就地落盘：version 写进去之后就不会再迁移（幂等）
      await saveStore(next, p);
      return next;
    }

    delete next._migration;
    cache = next;
    cachePath = p;
    // 解析失败时文件已被挪走，mtime 用 -1 强制下次重新判断
    cacheMtime = corrupt ? -1 : st.mtimeMs;
    return cache;
  } catch (e) {
    // 文件不存在：播种后**立即落盘一次**。只在内存里播种会让每个请求都重新生成
    // 一套随机 id（`e_...`），前端拿着上一次的 id 保存就会 404（真实走查事故）。
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (seedPromise) return seedPromise;
      seedPromise = (async () => {
        const seeded = emptyStore(true);
        cache = seeded;
        cachePath = p;
        cacheMtime = -1;
        try {
          await saveStore(seeded, p);
        } catch {
          // 只读目录等写失败：保留内存态，至少本次进程内 id 稳定。
        }
        return cache ?? seeded;
      })().finally(() => { seedPromise = null; });
      return seedPromise;
    }
    cache = emptyStore(true);
    cachePath = p;
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next: Store, explicitPath?: string): Promise<Store> {
  const p = explicitPath || storeFile();
  const data = normalize(next);
  delete data._migration;
  await ensureDir(join(p, '..'));
  // 原子写：临时文件 + rename。中断时用户要么看到旧数据，要么看到新数据。
  await writeAtomic(p, JSON.stringify(data, null, 2) + '\n');
  cache = data;
  cachePath = p;
  cacheMtime = -1;
  try { cacheMtime = (await fsp.stat(p)).mtimeMs; } catch { /* 保持 -1 */ }
  return data;
}

/**
 * 读-改-写事务：fn 直接改传入的**深拷贝**；抛错则不落盘。
 * structuredClone 是必需的——直接改缓存对象会让「抛错不落盘」名存实亡。
 */
export async function mutateStore<T>(fn: (draft: Store) => T, explicitPath?: string): Promise<T | Store> {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

export async function storeExists(): Promise<boolean> {
  return pathExists(storeFile());
}
