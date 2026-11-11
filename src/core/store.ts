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
import { readStore, writeStore } from './db/repo.ts';
import { fileHasContent } from './db/migrator.ts';
import { setDefaultDb } from './db/tx.ts';
import { normalize, type Store } from './store-shape.ts';
import type { Conn } from './db/driver.ts';

// P6：栏目/条目/设置的形状下沉到 shared，面板与后端共用同一份声明。
export type { StoreEntry, StoreSection, StoreSettings, SectionGroup } from './store-shape.ts';
export type { Store } from './store-shape.ts';
export { STORE_VERSION, defaultSettings, normalize } from './store-shape.ts';

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
  const { raw, rev } = readStore(conn);
  const store = normalize(raw);
  delete store._migration;
  revOf.set(store, rev);
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
  return result === undefined ? data : result;
}

/** 存储存在吗：DB 有内容，或旧 store.json 还在等着被导入。 */
export async function storeExists(): Promise<boolean> {
  return fileHasContent(dbFile()) || fileHasContent(storeFile());
}
