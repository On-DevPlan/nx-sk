// 状态读写 facade：所有后端模块通过这里碰存储，不自己拼路径、不自己开库。
//
// 0.36 起内部换心为 SQLite（~/nx-sk/nxsk.db，node:sqlite）：
//   - loadStore = SELECT 组装 Store 对象（行→对象映射过 normalize 做类型收口，
//     **不再做旧版本兼容**——DB 读出来的形状 version 恒为当前）；
//   - saveStore / mutateStore = 单事务全量重写（见 db/repo.ts 的写策略与留缝说明）；
//   - mutateStore 带乐观并发：meta.rev 计数，载入记 rev，提交时 rev 不匹配就抛
//     BLOCKED——修掉 serve + CLI 双进程的 lost-update（旧版整份覆盖，后写的静默抹掉先写的）。
//   - store.json 只在首启被导入一次（db/import-json.ts），之后改名留证，运行时不碰。
//
// 导出 API 与 Store 对象形状保持不变（这是全后端的磁盘纪律边界，见各模块文件头注释）。
import { dbFile, storeFile } from './paths.ts';
import { openAndBootstrap } from './db/bootstrap.ts';
import { readStore, writeStore, upsertEntryFieldRows, propagateSectionTemplate, setEntryFieldDetached, deleteEntryFieldRow } from './db/repo.ts';
import { fileHasContent } from './db/migrator.ts';
import { setDefaultDb, tx } from './db/tx.ts';
import { normalize, type Store, type EntryFieldView } from './store-shape.ts';
import type { Conn } from './db/driver.ts';
import type { FieldDef } from '../shared/fields/types.ts';

// P6：栏目/条目/设置的形状下沉到 shared，面板与后端共用同一份声明。
export type { StoreEntry, StoreSection, StoreSettings, SectionGroup } from './store-shape.ts';
export type { Store, EntryFieldView } from './store-shape.ts';
export { STORE_VERSION, defaultSettings, normalize, isDetachedField } from './store-shape.ts';

// —— 进程级连接 ——
let db: Conn | null = null;
let dbPathInUse = '';
let cacheCorruptNote: { from: string; to: string; error: string } | null = null;
let cacheMigrationNote: Record<string, unknown> | null = null;

/**
 * 每个**载入出来的 Store 对象**对应的 meta.rev（乐观并发判据）。
 * WeakMap：对象被回收即失效；structuredClone 出来的草稿不带 rev，
 * 由 mutateStore 显式传 rev，而不是靠对象身份猜。
 */
const revOf = new WeakMap<object, number>();

/**
 * 每个**载入出来的 Store 对象**对应的条目自身结构行（schema v3 写时复制）。
 * 与 revOf 同一条纪律：loadStore 记账，写路径写后重读刷新；
 * structuredClone 出来的草稿不带——调用方永远拿 loadStore/saveStore 的返回值查。
 */
const structuresOf = new WeakMap<object, Map<string, EntryFieldView[]>>();

/** 取某个 Store 对象的条目结构行（entryId → 按 position 排序的行）。没有记账返回空表。 */
export function entryStructures(store: Store): Map<string, EntryFieldView[]> {
  return structuresOf.get(store) || new Map<string, EntryFieldView[]>();
}

/**
 * 打开库（必要时建库 + 导入 store.json / 播种 + 升级）。
 * 路径变了（测试切 env）就重开——bootstrap 的幂等保证重开不重复导入。
 */
function ensureDb(): Conn {
  const p = dbFile();
  if (db && !db.closed && dbPathInUse === p) return db;
  if (db && !db.closed) {
    try { db.close(); } catch { /* 换路径重开，旧连接尽力关 */ }
  }
  const opened = openAndBootstrap(p);
  db = opened.db;
  dbPathInUse = p;
  setDefaultDb(db);
  cacheCorruptNote = opened.result.corrupt || null;
  cacheMigrationNote = opened.result.migration || null;
  return db;
}

export function storePathInUse(): string {
  return dbFile();
}

/** 最近一次首启时把损坏的 store.json 挪走的记录（bootstrap / health 会展示）。 */
export function corruptNote() {
  return cacheCorruptNote;
}

/** 最近一次旧数据迁移的记录（含留证文件路径），供 bootstrap 展示。 */
export function migrationNote() {
  return cacheMigrationNote;
}

/**
 * 读：SELECT 组装 → normalize 收口。
 *
 * `explicitPath` 参数保留只为兼容签名——存储位置只由 NX_SK_STORE_DB / NX_SK_HOME
 * 决定（SQLite 不是一个可以按调用点切换的"文件参数"）。
 */
export async function loadStore(explicitPath?: string): Promise<Store> {
  void explicitPath;
  const conn = ensureDb();
  const { raw, rev, structures } = readStore(conn);
  const store = normalize(raw);
  delete store._migration;
  revOf.set(store, rev);
  structuresOf.set(store, structures);
  return store;
}

/**
 * 写：normalize 收口后单事务全量重写。
 *
 * 乐观并发：`next` 若来自本进程的 loadStore（WeakMap 里有 rev），提交时校验 rev，
 * 不匹配抛 BLOCKED；若是外部整份构造的对象，则不加校验（与旧版"整份覆盖"语义一致）。
 */
export async function saveStore(next: Store, explicitPath?: string): Promise<Store> {
  void explicitPath;
  const conn = ensureDb();
  const data = normalize(next);
  delete data._migration;
  const expectedRev = revOf.get(next);
  const newRev = writeStore(conn, data, { expectedRev: expectedRev ?? null });
  revOf.set(data, newRev);
  revOf.set(next, newRev);
  // 结构行是 writeStore 物化的产物，不在 Store 对象里——写后重读刷新记账。
  const { structures } = readStore(conn);
  structuresOf.set(data, structures);
  structuresOf.set(next, structures);
  return data;
}

/**
 * 读-改-写事务：fn 直接改传入的**深拷贝**；抛错则不落盘。
 * structuredClone 是必需的——直接改缓存对象会让「抛错不落盘」名存实亡。
 * rev 校验串起整个事务：载入时的 rev 与提交时的当前 rev 不一致 → BLOCKED（重试）。
 */
export async function mutateStore<T>(fn: (draft: Store) => T, explicitPath?: string): Promise<T | Store> {
  void explicitPath;
  const conn = ensureDb();
  const { raw, rev } = readStore(conn);
  const cur = normalize(raw);
  delete cur._migration;
  const draft = structuredClone(cur);
  const result = fn(draft);
  const data = normalize(draft);
  delete data._migration;
  const newRev = writeStore(conn, data, { expectedRev: rev });
  revOf.set(data, newRev);
  // 写后重读刷新结构行记账（与 saveStore 同一口径）。
  structuresOf.set(data, readStore(conn).structures);
  return result === undefined ? data : result;
}

/**
 * 修正条目自身结构行（quickAdd 之后）：把 writeStore 落的占位行按推断出的
 * FieldDef 归正（type/label/spec）。独立事务、不动 rev——它写的是「结构」，
 * 值与形状仍由 Store 对象经 writeStore 收口。
 */
export async function upsertEntryFields(entryId: string, defs: FieldDef[]): Promise<void> {
  const conn = ensureDb();
  tx((db) => upsertEntryFieldRows(db, entryId, defs), { db: conn });
}

/**
 * 任务 #20：条目级字段移除（detach/restore = 翻 meta 标记；行不存在返回 false）。
 * 独立事务、rev 前进（见 db/repo.ts 同名函数注释）——与 upsertEntryFields 同一口径：
 * 写的是「结构」，先前 loadStore 出来的 Store 对象因此变陈旧，
 * 调用方要新形状就重新 loadStore（service 层返回前都会再 getEntry）。
 */
export async function detachEntryField(entryId: string, rowId: string, detached: boolean): Promise<boolean> {
  const conn = ensureDb();
  return tx((db) => setEntryFieldDetached(db, entryId, rowId, detached), { db: conn });
}

/** 扩展行硬删（field_data/边随 CASCADE）；行不存在返回 false。 */
export async function removeEntryFieldRow(entryId: string, rowId: string): Promise<boolean> {
  const conn = ensureDb();
  return tx((db) => deleteEntryFieldRow(db, entryId, rowId), { db: conn });
}

/**
 * sync 第二阶段：把栏目字典传播到存量条目的结构行（只增不改）。
 * 返回 {entries, fieldsAdded, defaultsFilled}（entries = 真的补了东西的条目数）。
 */
export async function syncEntryStructures(sectionId: string): Promise<{ entries: number; fieldsAdded: number; defaultsFilled: number }> {
  const conn = ensureDb();
  return tx((db) => propagateSectionTemplate(db, sectionId), { db: conn });
}

/** 存储存在吗：DB 有内容，或旧 store.json 还在等着被导入。 */
export async function storeExists(): Promise<boolean> {
  return fileHasContent(dbFile()) || fileHasContent(storeFile());
}
