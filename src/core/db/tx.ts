// 同步事务（做法与 nx-kv core/db/tx.js 同源）。
//
// ── 这个文件存在的唯一理由：把「async 事务」这个静默丢写的坑堵死 ──────
//
// `node:sqlite` 是**同步** API。事务的正确形态是：
//     BEGIN IMMEDIATE …（同步的写）… COMMIT
// 一旦有人写成 `tx(async () => { await fetch(...); db.run(写入) })`：
//   - fn 返回 Promise，tx 立刻 COMMIT（同步代码已跑完）；
//   - await 之后的写入落在**事务外**，一个个自动提交；
//   - 中途抛错时 ROLLBACK 早已执行过，后面的写入照样提交。
// 结果 = 一半进去、一半没进去，而且不报错。
//
// 所以：tx() 检测到返回 Promise 就抛 TypeError，一个都不放过。
// 需要异步 I/O 时：**事务外取，事务内写**。
//
// 另外两条：
//   1. 锁必须拿在 `BEGIN IMMEDIATE` 上（不是 `BEGIN`）—— 两个进程同时首启
//      只能有一个真正迁移；先读版本再锁 = TOCTOU。
//   2. 嵌套调用自动降级为 `SAVEPOINT`（深度计数），「一个 service 函数 =
//      一个顶层事务」与「内部自开事务」可以共存而不互相提交。
import { isBusyError } from './errors.ts';
import type { Conn } from './driver.ts';

/** 当前进程的默认连接（facade 打开库之后装进来）。 */
let defaultDb: Conn | null = null;

/** 由 store facade 调用：登记进程级默认连接。 */
export function setDefaultDb(db: Conn | null): void {
  defaultDb = db;
}

/** 取默认连接；没有就报一条能指路的错。 */
export function currentDb(): Conn {
  if (!defaultDb) {
    throw new Error('数据库尚未打开：先经 core/store.ts 的 loadStore/saveStore（它们会 bootstrap）');
  }
  return defaultDb;
}

// 事务深度按连接记（WeakMap：连接被回收时自动清理）。
const states = new WeakMap<Conn, { depth: number }>();

function stateOf(db: Conn): { depth: number } {
  let st = states.get(db);
  if (!st) {
    st = { depth: 0 };
    states.set(db, st);
  }
  return st;
}

/** 当前连接的事务深度（0 = 不在事务里）。测试用来断言「事务真的关掉了」。 */
export function txDepth(db: Conn | null = defaultDb): number {
  if (!db) return 0;
  return stateOf(db).depth;
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';
}

const SYNC_ONLY_MESSAGE =
  '事务体必须是同步函数：tx(fn) 检测到 fn 返回 Promise。\n' +
  '原因：node:sqlite 是同步 API，第一个 await 之后 COMMIT 已执行，' +
  '后续写入会落到事务外且不报错（静默丢写）。\n' +
  '做法：异步 I/O 放在事务外，事务内只写库。';

/** 同步睡（BUSY 退避用）。CLI 里没有并发任务要跑，阻塞事件循环可接受。 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(0, ms));
}

/**
 * 在一个同步事务里跑 fn。
 *
 * @param fn 事务体，**必须同步**（返回 Promise 立即抛 TypeError）
 * @param opts.mode 顶层事务模式（默认 IMMEDIATE：进门就拿写锁）
 * @param opts.retries SQLITE_BUSY 退避重试次数（只对顶层生效）
 * @param opts.db 连接（缺省用默认连接）
 * @param opts.rollback 收尾 ROLLBACK 而不是 COMMIT（演练用）
 */
export function tx<T>(fn: (db: Conn) => T, { mode = 'IMMEDIATE', retries = 3, db = null, rollback = false }: { mode?: 'IMMEDIATE' | 'DEFERRED' | 'EXCLUSIVE'; retries?: number; db?: Conn | null; rollback?: boolean } = {}): T {
  if (typeof fn !== 'function') throw new TypeError('tx(fn) 需要一个函数');
  const conn = db || currentDb();
  const st = stateOf(conn);

  // 嵌套：SAVEPOINT（rollback 在嵌套层无意义，忽略）
  if (st.depth > 0) return runSavepoint(conn, st, fn);

  let attempt = 0;
  for (;;) {
    try {
      return runTop(conn, st, mode, fn, rollback);
    } catch (err) {
      // BUSY 只重试顶层：BEGIN 会等 busy_timeout，等不到再退避重试几次。
      if (isBusyError(err) && attempt < Math.max(0, Number(retries) || 0)) {
        attempt += 1;
        sleepSync(25 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function runTop<T>(conn: Conn, st: { depth: number }, mode: string, fn: (db: Conn) => T, rollback: boolean): T {
  const m = String(mode || 'IMMEDIATE').toUpperCase();
  const begin = m === 'DEFERRED' || m === 'EXCLUSIVE' ? m : 'IMMEDIATE';
  conn.exec('BEGIN ' + begin);
  st.depth = 1;
  let out: T;
  try {
    out = fn(conn);
    if (isThenable(out)) {
      // 吞掉那个 Promise 的后续异常：它已不属于任何事务，抛出来只会变成
      // unhandledRejection 噪音（真因由下面的 TypeError 说明）。
      try { (out as Promise<unknown>).catch(() => {}); } catch { /* 非标准 thenable */ }
      throw new TypeError(SYNC_ONLY_MESSAGE);
    }
  } catch (err) {
    st.depth = 0;
    try { conn.exec('ROLLBACK'); } catch { /* 事务可能已被 SQLite 自己回滚 */ }
    throw err;
  }
  st.depth = 0;
  try {
    conn.exec(rollback ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
  return out;
}

function runSavepoint<T>(conn: Conn, st: { depth: number }, fn: (db: Conn) => T): T {
  const name = 'sp_' + st.depth;
  conn.exec('SAVEPOINT ' + name);
  st.depth += 1;
  let out: T;
  try {
    out = fn(conn);
    if (isThenable(out)) {
      try { (out as Promise<unknown>).catch(() => {}); } catch { /* ignore */ }
      throw new TypeError(SYNC_ONLY_MESSAGE);
    }
  } catch (err) {
    st.depth -= 1;
    try {
      conn.exec('ROLLBACK TO ' + name);
      conn.exec('RELEASE ' + name);
    } catch { /* ignore */ }
    throw err;
  }
  st.depth -= 1;
  conn.exec('RELEASE ' + name);
  return out;
}
