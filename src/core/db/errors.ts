// SQLite / 存储层的错误类型与映射。
//
// 分工（与 core/errors.ts 的契约一致）：
//   - **失败**（约束冲突、库锁死、迁移校验不过）→ throw AppError 子类
//   - **业务结果**（已是当前版本、没有 legacy 数据）→ 返回状态，不抛
//
// 映射规则（照抄 nx-kv core/db/errors.js 的口径）：
//   SQLITE_BUSY / LOCKED         → blocked('存储忙，请重试')（409，可退避重试）
//   SQLITE_CONSTRAINT_UNIQUE     → conflict()
//   SQLITE_CONSTRAINT_FOREIGNKEY → badInput()
//   其余原样抛出：包一层 INTERNAL 会丢掉 errcode，排障时无从下手。
import { AppError, CODES, badInput, blocked, conflict } from '../errors.ts';

/** SQLite 主错误码（`err.errcode`，不是字符串 `err.code`）。 */
export const SQLITE = {
  BUSY: 5,
  LOCKED: 6,
  READONLY: 8,
  CONSTRAINT_UNIQUE: 2067,
  CONSTRAINT_PRIMARYKEY: 1555,
  CONSTRAINT_FOREIGNKEY: 787,
};

interface Errish { errcode?: number; code?: string; message?: string }

/** 这个错误是不是「库被别的进程锁着」（可退避重试）。 */
export function isBusyError(err: unknown): boolean {
  const e = err as Errish | null | undefined;
  const code = Number(e && e.errcode);
  if (code === SQLITE.BUSY || code === SQLITE.LOCKED) return true;
  return /database is locked|database table is locked|busy/i.test(String((e && e.message) || ''));
}

/**
 * 这个错误是不是「连接被降级成只读」。
 *
 * 实测场景（nx-kv 同款）：两个进程同时首启、其中一个正把库切到 WAL 时，
 * 另一个连接的第一次写会拿到 `attempt to write a readonly database`。
 * **这是瞬时的**——先到的进程提交完之后重开一切正常，所以 bootstrap 为它退避重试。
 */
export function isReadOnlyError(err: unknown): boolean {
  const e = err as Errish | null | undefined;
  if (Number(e && e.errcode) === SQLITE.READONLY) return true;
  return /attempt to write a readonly database|readonly database/i.test(String((e && e.message) || ''));
}

/** 这个错误是不是唯一约束 / 主键冲突。 */
export function isUniqueError(err: unknown): boolean {
  const e = err as Errish | null | undefined;
  const code = Number(e && e.errcode);
  if (code === SQLITE.CONSTRAINT_UNIQUE || code === SQLITE.CONSTRAINT_PRIMARYKEY) return true;
  return /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(String((e && e.message) || ''));
}

/** 这个错误是不是外键约束。 */
export function isForeignKeyError(err: unknown): boolean {
  const e = err as Errish | null | undefined;
  if (Number(e && e.errcode) === SQLITE.CONSTRAINT_FOREIGNKEY) return true;
  return /FOREIGN KEY constraint failed/i.test(String((e && e.message) || ''));
}

/** 把 node:sqlite 抛出的错误映射成业务错误；认不出来的一律原样返回。 */
export function mapSqliteError(err: unknown): unknown {
  if (!err) return err;
  if (err instanceof AppError) return err;
  const e = err as Errish;
  if (isBusyError(err)) {
    // errcode 必须留在**顶层**：tx.ts 的重试判据读的是 err.errcode。
    const mapped = blocked('存储忙，请重试（另一个进程正在写这个库）', { errcode: e.errcode }) as AppError & { errcode?: number };
    mapped.errcode = Number(e.errcode) || SQLITE.BUSY;
    return mapped;
  }
  if (isUniqueError(err)) return conflict('记录已存在（唯一约束冲突）', { message: String(e.message || '') });
  if (isForeignKeyError(err)) return badInput('引用的记录不存在（外键约束）', { message: String(e.message || '') });
  return err;
}

/**
 * 迁移失败（事务回滚、legacy JSON 一字节不动）。
 * 统一成这一个类型：调用方只需认一个错，退出码由 CODES 决定。
 */
export class StoreMigrationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(CODES.INTERNAL, message, details);
    this.name = 'StoreMigrationError';
  }
}

/**
 * 库比程序新（`meta.schema_version > CURRENT`）：**绝不降级写**。
 * 降级写的后果是新版本写过的行被旧代码当垃圾覆盖，而且不报错。
 */
export class StoreTooNewError extends AppError {
  constructor(found: number, current: number) {
    super(
      CODES.CONFLICT,
      `存储版本 ${found} 比当前程序支持的 ${current} 新，请升级 nx-sk（本次不做任何写入）`,
      { found, current },
    );
    this.name = 'StoreTooNewError';
  }
}

/**
 * 有表但没有 `meta.store_kind`：这不是 nx-sk 的存储文件
 * （典型场景：用户把别的 SQLite 文件改名成 nxsk.db）。
 * **绝不自动建表 / 自动认领** —— 那会把别人的库就地改成我们的结构。
 */
export class NotNxSkStoreError extends AppError {
  constructor(path: string) {
    super(
      CODES.CONFLICT,
      `这不是 nx-sk 的存储文件（缺 meta.store_kind）: ${path}\n` +
        '请改用 NX_SK_STORE_DB 指定别的路径，或先把它移开再重试（不会自动建表）。',
      { path },
    );
    this.name = 'NotNxSkStoreError';
  }
}
