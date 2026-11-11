// node:sqlite 的唯一引用点（全项目只此一处）。
//
// 为什么收在一处：`node:sqlite` 仍是 experimental，API 有改动史
// （新版把 DatabaseSync 改名成 Database；绑定 undefined 的行为也变过）。
// 只在这里碰它，升级时改一个文件即可。做法与 nx-kv core/db/driver.js 同源。
//
// ── 三个实测坑，全在这个文件里解决 ────────────────────────────────────
//
// 1. **每次 import 都往 stderr 打 ExperimentalWarning**，会污染冒烟测试对
//    CLI stderr 的断言。→ `import './quiet.ts'` **必须排在 node:sqlite 之前**
//    （ESM 依赖按 import 声明顺序求值）。
//
// 2. **行对象是 null 原型** → `assert.deepEqual(row, {a:1})` 失败。
//    → 出站一律 `{...row}`。
//
// 3. **`undefined` 不能绑定**，`boolean` 同样不能绑定。→ 入站统一
//    `bindValue()`：`undefined → null`、`boolean → 0|1`、`Date → ms`、`bigint → number`。
//
// 另一个约束：`PRAGMA journal_mode / foreign_keys / busy_timeout / synchronous`
// 是**连接级**设置，每个连接都要设（SQLite 的 foreign_keys 默认**关**，漏了它
// 所有 REFERENCES 都不会生效，而且不报错）。这些在 openRaw 里一次设好。
import './quiet.ts';
import * as nodeSqlite from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { badInput } from '../errors.ts';
import { isBusyError, mapSqliteError } from './errors.ts';
import { stamp } from '../ids.ts';

// 新版 Node 把 DatabaseSync 改名成 Database；两个都认，只在这里判断。
const sqliteModule = nodeSqlite as unknown as { DatabaseSync?: new (p: string, o?: object) => unknown; Database?: new (p: string, o?: object) => unknown };
const SqliteCtor = sqliteModule.DatabaseSync ?? sqliteModule.Database;

if (typeof SqliteCtor !== 'function') {
  throw new Error(
    '当前 Node 没有内置 SQLite（node:sqlite）。nx-sk 需要 Node >= 22.13.0，' +
      '请升级 Node 后再运行。',
  );
}

/** 语句缓存上限：超过就整体清空（简单可靠，避免无界增长）。 */
const STMT_CACHE_MAX = 256;

/** 驱动对外暴露的连接对象（业务层只认这个形状，不认 node:sqlite 的类型）。 */
export interface Conn {
  path: string;
  readOnly: boolean;
  readonly closed: boolean;
  exec(sql: string): void;
  get(sql: string, params?: Params): Row | null;
  all(sql: string, params?: Params): Row[];
  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number };
  scalar(sql: string, params?: Params): unknown;
  close(): void;
}

export type Row = Record<string, unknown>;
export type Params = unknown[] | Record<string, unknown>;

interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/**
 * 入站参数归一：把 JS 侧的值转成 SQLite 能绑定的类型。
 */
export function bindValue(v: unknown): string | number | null | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  return v as string | number | Uint8Array;
}

/** 出站行归一：**null 原型 → 普通对象**，让 deepEqual / JSON.stringify 行为正常。 */
function plain(row: unknown): Row | null {
  if (row === undefined || row === null) return null;
  const out = { ...(row as Row) };
  // bigint 统一成 number，避免 `1n !== 1`。
  for (const k of Object.keys(out)) if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
  return out;
}

/**
 * 参数列表归一：数组按位置、对象按名字（node:sqlite 默认允许裸名绑 `:name`）。
 */
function argsOf(params: Params | undefined): unknown[] {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    // 允许调用方带 : / @ / $ 前缀写键名，统一剥掉（node:sqlite 只认裸名）。
    out[k.replace(/^[:@$]/, '')] = bindValue(v);
  }
  return [out];
}

/** 同步小睡（BUSY / WAL 切换重试用）。CLI 进程没有别的事要做，阻塞可接受。 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(0, ms));
}

/**
 * 把库切到 WAL（**文件级持久设置**，切一次之后每个连接都受益）。
 *
 * 切换需要短暂的排它锁，两个进程同时首启时会互相撞 —— 一方拿到锁正在切，
 * 另一方会收到 `SQLITE_BUSY`。而 WAL 是持久属性，另一方切换成功后本连接
 * 本来就无所谓，所以策略是「重试几次，还是忙就算」（不当作错误）。
 */
function enableWal(api: Conn): void {
  for (let i = 0; i < 4; i++) {
    try {
      api.get('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusyError(err)) throw mapSqliteError(err);
      sleepSync(20 * (i + 1));
    }
  }
  // 4 次都忙：另一个进程正在切换 / 长期持锁。WAL 一旦由任何人打开就持久生效，
  // 本连接的正确性不受影响，也不是迁移失败，所以放过。
}

// ── 残留 -shm 自愈（Windows 实测，照抄 nx-kv 的处置纪律）────────────────
//
// 现场：上一进程没走 sqlite3_close 就退出，留下 `-shm`（`-wal` 为 0 字节）；
// 新进程以读写方式打开时，SQLite 恢复 wal-index 阶段要 truncate 这个 shm，
// 却拿到 `disk I/O error`（扩展码 1546 / 5386）。库本身与 WAL 都是好的——
// 把 shm 改名后立刻能打开。
//
// 策略（**只改名、不删除、只重试一次**）：
//   - shm 与 0 字节 wal 改名为 `<file>.stale-<时间戳>` 留档；wal 有内容时一个字节不碰
//     （那里面可能还有未 checkpoint 的已提交事务）；
//   - **rename 本身就是活性探针**：Windows 不允许改名仍被别的进程映射的文件，
//     活进程持有时会 EBUSY → 判定为「不是残留」，不插手。
const STALE_SHM_CODES = new Set([1546, 5386]);

function isStaleShmError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null | undefined;
  const code = Number(e && e.errcode);
  if (STALE_SHM_CODES.has(code)) return true;
  if (Number.isFinite(code) && code !== 0) return false;
  return /disk I\/O error/i.test(String((e && e.message) || ''));
}

/** 把残留的 `-shm`（必要时连同 0 字节 `-wal`）改名留档。 */
export function quarantineStaleShm(dbPath: string): string[] {
  const shm = `${dbPath}-shm`;
  const wal = `${dbPath}-wal`;
  if (!existsSync(shm)) return [];
  const tag = stamp();
  const renamed: string[] = [];
  renameSync(shm, `${shm}.stale-${tag}`);
  renamed.push(`${shm}.stale-${tag}`);
  let walBytes = -1;
  try { walBytes = existsSync(wal) ? statSync(wal).size : 0; } catch { /* 取不到就不动 wal */ }
  if (walBytes === 0) {
    try {
      renameSync(wal, `${wal}.stale-${tag}`);
      renamed.push(`${wal}.stale-${tag}`);
    } catch { /* 0 字节 wal 改名失败不影响重试：SQLite 会重建它 */ }
  }
  return renamed;
}

/**
 * 打开失败时尝试一次自愈。rename 即活性探针：改名失败 = 有人在用 → 返回 null，绝不继续动刀。
 */
function healStaleShmOnce(dbPath: string, err: unknown): string[] | null {
  if (!isStaleShmError(err)) return null;
  if (!existsSync(`${dbPath}-shm`)) return null;
  try {
    return quarantineStaleShm(dbPath);
  } catch {
    return null;
  }
}

/**
 * 打开一个原始连接。
 *
 * @param dbPath 库文件路径（`:memory:` 合法）
 * @param opts.readOnly 只读连接（诊断类命令用，不触发升级）
 * @param opts.busyTimeoutMs 写锁等待上限
 */
export function openRaw(dbPath: string, { readOnly = false, busyTimeoutMs = 5000 }: { readOnly?: boolean; busyTimeoutMs?: number } = {}): Conn {
  if (!dbPath) throw new TypeError('openRaw(dbPath) 需要库文件路径');
  if (dbPath !== ':memory:' && !readOnly) mkdirSync(dirname(dbPath), { recursive: true });
  if (readOnly && dbPath !== ':memory:' && !existsSync(dbPath)) {
    // 只读打开**不会**创建文件，SQLite 只报 "unable to open database file" ——
    // 那句话指不出真因（"库还没建"），所以在驱动层就换成能指路的错误。
    throw badInput(`库文件不存在: ${dbPath}（只读打开不会创建它）`);
  }

  const openOnce = (): Conn => {
    let raw: SqlDatabase;
    try {
      raw = new (SqliteCtor as new (p: string, o?: object) => SqlDatabase)(dbPath, readOnly ? { readOnly: true } : {});
    } catch (err) {
      throw mapSqliteError(err);
    }

    const stmts = new Map<string, SqlStatement>();
    let closed = false;

    const api: Conn = {
      path: dbPath,
      readOnly,
      get closed() {
        return closed;
      },
      exec(sql) {
        try {
          raw.exec(sql);
          // exec 是 DDL / 事务控制 / PRAGMA 的通道——schema 可能已经变了。
          // node:sqlite 的已缓存语句**不会刷新列元数据**：实测 v3 迁移里
          // `SELECT * FROM entries ORDER BY rowid`（apply 搬运）在 DROP+RENAME 之后
          // 被运行时 readStore 复用，报 "Cannot get name of column 6"（旧 7 列形状）。
          // 语句缓存只是性能优化，exec 之后整体清空最稳。
          stmts.clear();
        } catch (err) {
          throw mapSqliteError(err);
        }
      },
      get(sql, params) {
        try {
          return plain(prepare(sql).get(...argsOf(params)));
        } catch (err) {
          throw mapSqliteError(err);
        }
      },
      all(sql, params) {
        try {
          return prepare(sql).all(...argsOf(params)).map((r) => plain(r) as Row);
        } catch (err) {
          throw mapSqliteError(err);
        }
      },
      run(sql, params) {
        try {
          const r = prepare(sql).run(...argsOf(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        } catch (err) {
          throw mapSqliteError(err);
        }
      },
      scalar(sql, params) {
        const row = api.get(sql, params);
        if (!row) return null;
        const keys = Object.keys(row);
        return keys.length ? row[keys[0]] : null;
      },
      close() {
        if (closed) return;
        closed = true;
        stmts.clear();
        try {
          raw.close();
        } catch (err) {
          throw mapSqliteError(err);
        }
      },
    };

    function prepare(sql: string): SqlStatement {
      let st = stmts.get(sql);
      if (!st) {
        st = raw.prepare(sql);
        if (stmts.size >= STMT_CACHE_MAX) stmts.clear();
        stmts.set(sql, st);
      }
      return st;
    }

    // ── 连接级 PRAGMA：每个连接都要设，且必须在任何业务语句之前 ──
    // foreign_keys 默认关：漏了它，所有 REFERENCES 静默失效（删栏目不级联），而且不报错。
    const waitMs = Number.isFinite(Number(busyTimeoutMs)) ? Math.max(0, Number(busyTimeoutMs)) : 5000;
    try {
      api.exec('PRAGMA busy_timeout = ' + waitMs);
      api.exec('PRAGMA foreign_keys = ON');
      api.exec('PRAGMA synchronous = NORMAL');
      if (!readOnly) enableWal(api);
    } catch (err) {
      // 关键：先把本进程的映射关掉，否则 Windows 不允许后面改名 shm。
      try { raw.close(); } catch { /* 半成品连接关不掉也继续：下面按原始错误处理 */ }
      throw mapSqliteError(err);
    }

    return api;
  };

  try {
    return openOnce();
  } catch (err) {
    const renamed = readOnly ? null : healStaleShmOnce(dbPath, err);
    if (!renamed || renamed.length === 0) throw err;
    try {
      return openOnce();
    } catch {
      throw err;
    }
  }
}
