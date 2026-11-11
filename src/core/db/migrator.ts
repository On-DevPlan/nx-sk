// schema 升级链：按版本号**单向组合**执行的迁移 runner（机制与 nx-kv core/db/migrator.js 同源）。
//
// 版本判据：`meta.schema_version`（brief 指定的权威位置）；`PRAGMA user_version`
// 同步写一份，只给外部检查工具（sqlite3 CLI 之类）看，runner 不依赖它。
//
// 为什么每步**一个事务**（而不是全程一个大事务）：升级是「版本 N 已可用」的累加
// 过程，一步失败时库停在上一版**可用状态**，比整体回滚更好排障。
//
// 与业务层的关系：**不给业务层懒升级的机会**。升级只发生在 bootstrap 里，
// 拿着旧 schema 干活的路径一条都不留；后续版本升级只提供新脚本，不改旧脚本。
import { statSync } from 'node:fs';
import { CURRENT_SCHEMA_VERSION } from './version.ts';
import { MIGRATION_STEPS, planMigrationPath, readMigrationSql } from './migrations/index.ts';
import { tx } from './tx.ts';
import { nowIso } from '../ids.ts';
import type { Conn } from './driver.ts';

/** 迁移步骤表 = migrations/index.js 的直接边。未来加版本 → 在那边追加。 */
export const MIGRATIONS = MIGRATION_STEPS;

// 连接级 PRAGMA 由 driver.ts 在每个连接上执行（journal_mode 在事务里改不动）。
// 留在过滤规则里是为了让人可以在 .sql 里写 PRAGMA 而 runner 不炸。
const CONNECTION_PRAGMA_RE =
  /^\s*PRAGMA\s+(journal_mode|foreign_keys|busy_timeout|synchronous|user_version)\b/i;

/** 从 schema 文件里取出可在事务内执行的 DDL（过滤掉连接级 PRAGMA）。 */
export function ddlOf(sql: string): string {
  return String(sql)
    .split('\n')
    .filter((line) => !CONNECTION_PRAGMA_RE.test(line))
    .join('\n');
}

/** 库里有多少张业务表（不含 sqlite_ 内部表）。0 = 空文件 / 全新库。 */
export function countTables(db: Conn): number {
  const row = db.get(
    "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return Number((row && (row.c as number)) || 0);
}

/** meta 表存在吗（「这是我们建到一半还是建完的库」的判据之一）。 */
export function hasMetaTable(db: Conn): boolean {
  const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  return !!row;
}

/** 读一个 meta 值；不存在返回 null。
 *  表在但形状不对（别人把 SQLite 文件改名成 nxsk.db，meta 是他们的表）时也返回
 *  null——让 bootstrap 走「不是我们的库」的拒绝路径，而不是裸 SQL 错误。 */
export function getMeta(db: Conn, key: string): string | null {
  if (!hasMetaTable(db)) return null;
  try {
    const row = db.get('SELECT value FROM meta WHERE key = :key', { key });
    return row ? String(row.value) : null;
  } catch {
    return null;
  }
}

/** 写一个 meta 值（UPSERT）。必须在事务内调用（与 schema_version 同一事务）。 */
export function setMeta(db: Conn, key: string, value: string | null | undefined, at: string = nowIso()): void {
  db.run(
    `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value: value === null || value === undefined ? '' : String(value), at },
  );
}

/** `PRAGMA user_version`（没设过 = 0）。 */
export function userVersion(db: Conn): number {
  const row = db.get('PRAGMA user_version');
  return Number((row && (row.user_version as number)) || 0);
}

/** 写 `PRAGMA user_version`。PRAGMA 不支持绑定参数，所以强制转整数、杜绝拼接外部字符串。 */
export function setUserVersion(db: Conn, version: number): void {
  const v = Math.max(0, Math.trunc(Number(version) || 0));
  db.exec('PRAGMA user_version = ' + v);
}

/**
 * 库的 schema 版本：`meta.schema_version` 优先（权威），
 * 没有 meta 表 / 没有该键时退回 `PRAGMA user_version`（全新库 = 0）。
 */
export function schemaVersion(db: Conn): number {
  if (hasMetaTable(db)) {
    const v = getMeta(db, 'schema_version');
    if (v !== null) return Number(v) || 0;
  }
  return userVersion(db);
}

/** 存储种类标志（meta.store_kind）；没有 meta 表或没有该键都返回 null。 */
export function storeKindOf(db: Conn): string | null {
  return getMeta(db, 'store_kind');
}

/** 需要执行的步骤（from 之后、to 及之前）。缺边会抛出明确错误，不静默跳过。 */
export function pendingSteps(from: number, to: number = CURRENT_SCHEMA_VERSION) {
  return planMigrationPath(from, to);
}

/**
 * 按步升级。
 *
 * @param db 连接
 * @param opts.from 起始版本（缺省读 schemaVersion）
 * @param opts.to 目标版本（缺省 CURRENT_SCHEMA_VERSION）
 * @param opts.context 传给 step.apply 的迁移上下文
 * @returns 实际执行的版本号
 */
export function migrate(db: Conn, { from, to = CURRENT_SCHEMA_VERSION, context = {} }: { from?: number; to?: number; context?: Record<string, unknown> } = {}): number[] {
  const applied: number[] = [];
  let cur = from === undefined ? schemaVersion(db) : Number(from) || 0;
  for (const step of pendingSteps(cur, to)) {
    const sql = ddlOf(readMigrationSql(step.file));
    tx(
      (conn) => {
        // 双检：并发进程可能刚把这一步做完（锁在 BEGIN IMMEDIATE 上拿到）。
        const now = schemaVersion(conn);
        if (now >= step.to) return;
        conn.exec(sql);
        if (typeof step.apply === 'function') (step.apply as (c: Conn, ctx: Record<string, unknown>) => void)(conn, context);
        setMeta(conn, 'schema_version', String(step.to));
        setUserVersion(conn, step.to);
      },
      { db, mode: 'IMMEDIATE' },
    );
    // 事务里可能因并发跳过，但无论谁做的，此刻库都已在 step.to
    if (schemaVersion(db) >= step.to) applied.push(step.to);
    cur = step.to;
  }
  return applied;
}

/** 文件是否存在且非空（"有没有库"的判据）。 */
export function fileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}
