// 打开库并完成「探测 → 建表/导入/播种/升级」的唯一入口（机制与 nx-kv bootstrap.js 同源）。
//
// 为什么所有进程都只能走这一条路：迁移/导入逻辑写两套是这类改造最常见的翻车点——
// CLI、serve、测试夹具全部调这里的同一个 openAndBootstrap()，两份最终会给出不同的库。
//
// ── 并发（serve 与 CLI 同时首启）──────────────────────────────────────
//
//   P1: BEGIN IMMEDIATE ── 拿到写锁 → 建表/导入 → 写 meta + rev → COMMIT
//   P2: BEGIN IMMEDIATE ── busy_timeout 等锁 → 拿到后**重新读**版本 → 空转 COMMIT
//
//   1. 锁拿在 BEGIN IMMEDIATE 上，**且必须在读版本之前**——先读后锁就是 TOCTOU。
//   2. 读版本的动作在事务体第一行（双检）。
//   3. 幂等来源：所有动作都是「事务内 + 版本判定」，重复执行等于空转。
//   4. 导入成功后重命名 legacy 文件（不删），让「再导入一次」物理上不可能。
//
// ── 两种拒绝而不是猜的情况 ────────────────────────────────────────────
//
//   · 库比程序新（schema_version > CURRENT）：**绝不降级写**。
//   · 有表但没有 meta.store_kind（别人把 SQLite 文件改名成 nxsk.db）：
//     **绝不自动建表**——那会把别人的库就地改成我们的结构。
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, migrationDir, PROJECT_ROOT, storeFile } from '../paths.ts';
import { badInput } from '../errors.ts';
import { stamp } from '../ids.ts';
import { openRaw, type Conn } from './driver.ts';
import { tx } from './tx.ts';
import { CURRENT_SCHEMA_VERSION, checkNodeVersion } from './version.ts';
import {
  countTables,
  fileHasContent,
  getMeta,
  hasMetaTable,
  migrate,
  setMeta,
  storeKindOf,
} from './migrator.ts';
import { importOrSeed, renameLeavingEvidence, type ImportOutcome } from './import-json.ts';
import { setRev } from './repo.ts';
import { displayPath } from '../paths.ts';
import { NotNxSkStoreError, StoreMigrationError, StoreTooNewError, isBusyError, isReadOnlyError } from './errors.ts';

/** meta.store_kind 的值：库是 nx-sk 自己建的。 */
export const STORE_KIND = 'sqlite';

/** 当前程序版本（写进 meta.created_by，排障时能对上版本）。 */
export function appVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export interface BootstrapResult {
  action: 'created' | 'imported' | 'corrupt-seeded' | 'seeded' | 'upgraded' | 'none';
  upgradedFrom?: number | null;
  corrupt?: { from: string; to: string; error: string } | null;
  /** 数据迁移记录（旧版本 JSON 导入时才有），形状与旧版 migrationNote 一致。 */
  migration?: Record<string, unknown> | null;
  /** 导入留证文件路径。 */
  evidence?: string | null;
  /** 升级/导入前对库文件的快照备份路径（`~/nx-sk/migrate/<ts>-pre-*.db`）。 */
  snapshot?: string | null;
}

/**
 * 打开库 + 首启建库/导入/播种 + 版本落后则升级。
 *
 * @param path 库文件路径（缺省 dbFile()）
 * @returns 连接与本次动作记录（corrupt/migration 给 facade 的 note 展示）
 */
export function openAndBootstrap(path: string, { retries = 6 }: { retries?: number } = {}): { db: Conn; result: BootstrapResult } {
  const check = checkNodeVersion();
  if (!check.ok) throw badInput(check.message);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return attemptOpen(path);
    } catch (err) {
      lastErr = err;
      // 只重试「另一个进程正好在动这个库」造成的瞬时错误；真实的失败立刻上抛。
      const transient = isBusyError(err) || isReadOnlyError(err);
      if (!transient || attempt >= retries) throw err;
      sleepSync(40 * (attempt + 1));
    }
  }
  throw lastErr;
}

function attemptOpen(path: string): { db: Conn; result: BootstrapResult } {
  const existedBefore = fileHasContent(path);
  const db = openRaw(path);
  try {
    return { db, result: bootstrap(db) };
  } catch (err) {
    try { db.close(); } catch { /* 关不掉就继续清理 */ }
    // 两种「拒绝」不是迁移失败：库文件不是我们建的/不该动，原样保留。
    if (err instanceof NotNxSkStoreError || err instanceof StoreTooNewError) throw err;
    // 迁移中途出错：store.json 一字节不动（我们从没写过它），库文件回滚到迁移前状态。
    // **但不能无条件删**：并发首启时「文件在我打开之前不存在」不等于「库是我建的」——
    // 先到的进程可能刚建好表并且正在用。删之前探一次：没有已提交的 schema 才允许删。
    if (!existedBefore && !hasCommittedSchema(path)) removeDbFiles(path);
    const logPath = writeFailureLog(err);
    throw new StoreMigrationError(
      `存储初始化失败，已回滚（store.json 未改动）。明细见 ${logPath || '（日志写入失败）'}\n` +
        `原因：${String((err as Error)?.message || err)}`,
      { logPath, cause: String((err as Error)?.message || err) },
    );
  }
}

/** 建库/导入/播种/升级（纯流程，事务由各分支自己开）。 */
function bootstrap(db: Conn): BootstrapResult {
  const tables = countTables(db);

  // ── 情况 A：库里一张业务表都没有（文件不存在 / 空文件 / 上次中断在建表前）──
  if (tables === 0) {
    let outcome: ImportOutcome | null = null;
    tx((conn) => {
      // 双检：并发进程可能刚把表建好（锁是在 BEGIN IMMEDIATE 上等的）
      if (countTables(conn) > 0) return;
      migrate(conn, { from: 0 });
      setMeta(conn, 'store_kind', STORE_KIND);
      setMeta(conn, 'schema_version', String(CURRENT_SCHEMA_VERSION));
      setMeta(conn, 'created_by', 'nx-sk/' + appVersion());
      setRev(conn, 0);
      const jsonPath = fileHasContent(storeFile()) ? storeFile() : null;
      outcome = importOrSeed(conn, jsonPath);
    }, { db, mode: 'IMMEDIATE' });

    if (!outcome) return { action: 'none' }; // 并发被抢先：本进程什么都不欠
    const out = outcome as ImportOutcome;
    // 导入成功 → 提交后改名留证（见 import-json.ts 的原则 2）。
    if (out.action === 'imported' && out.renameFrom) {
      const evidence = renameLeavingEvidence(out.renameFrom, `${out.renameFrom}.imported`);
      const migration = out.migration
        ? { ...out.migration, snapshot: displayPath(evidence), snapshotRaw: evidence, ...(out.migrationDetail || {}) }
        : null;
      return { action: 'imported', migration, evidence };
    }
    if (out.action === 'corrupt-seeded') return { action: 'corrupt-seeded', corrupt: out.corrupt || null };
    return { action: 'seeded' };
  }

  // ── 情况 B：有表 → 必须是我们的库 ──
  if (!hasMetaTable(db) || !storeKindOf(db)) throw new NotNxSkStoreError(db.path);
  if (storeKindOf(db) !== STORE_KIND) throw new NotNxSkStoreError(db.path);

  // ── 情况 C：版本落后 → 逐步升级（每步一个事务，失败回滚并中止启动）──
  // **升级之前先备份**：checkpoint 把 WAL 落进主文件，再整份复制到 migrate/——
  // 升级脚本出错时既有事务回滚，也有一份升级前的完整库可以退回。
  const v = Number(getMeta(db, 'schema_version') || '0') || 0;
  if (v > CURRENT_SCHEMA_VERSION) throw new StoreTooNewError(v, CURRENT_SCHEMA_VERSION);
  let upgradedFrom: number | null = null;
  let snapshot: string | null = null;
  if (v < CURRENT_SCHEMA_VERSION) {
    snapshot = snapshotDb(db, `v${v}-to-v${CURRENT_SCHEMA_VERSION}`);
    const applied = migrate(db, { from: v });
    upgradedFrom = applied.length ? v : null;
  }

  // ── 情况 D：还没从 JSON 迁过，而 store.json 在 → 导入（崩溃恢复窗口）──
  if (!getMeta(db, 'imported_from_json_at') && fileHasContent(storeFile())) {
    snapshot = snapshot || snapshotDb(db, 'import-json');
    let outcome: ImportOutcome | null = null;
    tx((conn) => {
      if (getMeta(conn, 'imported_from_json_at')) return; // 双检
      outcome = importOrSeed(conn, storeFile());
    }, { db, mode: 'IMMEDIATE' });
    const out = outcome as ImportOutcome | null;
    if (out && out.action === 'imported' && out.renameFrom) {
      const evidence = renameLeavingEvidence(out.renameFrom, `${out.renameFrom}.imported`);
      const migration = out.migration
        ? { ...out.migration, snapshot: displayPath(evidence), snapshotRaw: evidence, ...(out.migrationDetail || {}) }
        : null;
      return { action: 'imported', upgradedFrom, migration, evidence, snapshot };
    }
    if (out && out.action === 'corrupt-seeded') return { action: 'corrupt-seeded', upgradedFrom, corrupt: out.corrupt || null, snapshot };
  }

  return { action: upgradedFrom !== null ? 'upgraded' : 'none', upgradedFrom, snapshot };
}

/**
 * 升级/导入前的库快照：先把 WAL checkpoint 进主文件（否则复制出来的库缺最近写入），
 * 再整份复制到 `migrate/<ts>-pre-<reason>.db`。复制失败返回 null（尽力而为——
 * 事务回滚仍是主防线，快照是可退回的额外保险）。
 */
function snapshotDb(db: Conn, reason: string): string | null {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = migrationDir();
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${stamp()}-pre-${reason}.db`);
    copyFileSync(db.path, to);
    return to;
  } catch {
    return null;
  }
}

/** 库里有没有**已提交**的 schema（另一个进程的成果）。探不到就当「有」（保守，不删）。 */
function hasCommittedSchema(path: string): boolean {
  let probe: Conn | null = null;
  try {
    probe = openRaw(path, { readOnly: true });
    return countTables(probe) > 0 || !!storeKindOf(probe);
  } catch {
    return true;
  } finally {
    if (probe) { try { probe.close(); } catch { /* ignore */ } }
  }
}

/** 同步小睡（并发重试用）。CLI 进程没有别的事要做，阻塞可接受。 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(0, ms));
}

/** 删掉库文件及其 WAL 附属文件（本次新建的库才允许）。 */
export function removeDbFiles(path: string): void {
  if (!path || path === ':memory:') return;
  for (const p of [path, path + '-wal', path + '-shm', path + '-journal']) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch { /* Windows 上偶尔还被句柄占着：留给下次 */ }
  }
}

/** 写失败明细日志，返回路径（`~/nx-sk/migration-failed-<时间戳>.log`）。 */
export function writeFailureLog(err: unknown): string | null {
  const path = join(appHome(), `migration-failed-${stamp()}.log`);
  const lines = [
    'nx-sk 存储初始化失败  ' + new Date().toISOString(),
    `node ${process.versions.node}   platform ${process.platform}`,
    '',
    String((err as Error)?.stack || err),
    '',
  ];
  try {
    writeFileSync(path, lines.join('\n'), 'utf8');
    return path;
  } catch {
    return null;
  }
}
