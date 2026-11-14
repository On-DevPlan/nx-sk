// 字段值历史（schema v5）：追加、diff 判定、按字段保留策略裁剪、按版本恢复。
//
// 边界：只碰 field_history / field_data / meta.rev，不进 Store 对象。
// writeStore 是唯一的热路径调用方（全量重写后对「值真的变了」的字段追加一行）；
// 恢复是独立小事务（和 detach/remove-field 同一口径：写结构/值后 rev 前进）。
//
// 为什么没有外键：见 v5.sql 顶部注释——全量重写会 CASCADE 清空 entry_fields，
// 历史必须活过重写，所以由 writeStore 在重建后用 cleanupOrphanHistory 清掉
// 真正消失字段的历史，而不是靠 DB 级联。
import { nowIso } from '../ids.ts';
import { tx } from './tx.ts';
import { getMeta, setMeta } from './migrator.ts';
import { fieldDataId } from './identity.ts';
import type { Conn, Row } from './driver.ts';

/** 保留策略：按条数（最近 N 版）或按时间（最近 N 天）。 */
export interface HistoryRetention {
  mode: 'count' | 'time';
  count: number;
  days: number;
}

export const DEFAULT_RETENTION: HistoryRetention = { mode: 'count', count: 50, days: 90 };

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从 settings 表读保留策略（读不到 / 写坏了就用默认值）。
 * 放在 core/db 而不是 settings 模块：writeStore 在事务里就要用，不能反向上依赖 modules。
 */
export function readRetention(db: Conn): HistoryRetention {
  const out: HistoryRetention = { ...DEFAULT_RETENTION };
  let rows: Row[] = [];
  try {
    rows = db.all("SELECT key, value FROM settings WHERE key IN ('historyMode','historyCount','historyDays')");
  } catch {
    return out;
  }
  const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  const parse = (key: string): unknown => {
    const text = map.get(key);
    if (text === undefined) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  };
  const mode = String(parse('historyMode') ?? '');
  if (mode === 'time' || mode === 'count') out.mode = mode;
  const count = parse('historyCount');
  if (count !== undefined) out.count = clampInt(count, out.count, 1, 1000);
  const days = parse('historyDays');
  if (days !== undefined) out.days = clampInt(days, out.days, 1, 3650);
  return out;
}

/** 一条待记录的变化：next 为 null = 显式清空（value 落 JSON null，不复活数据行）。 */
export interface FieldValueChange {
  entryFieldId: string;
  prev: string | null;
  next: string | null;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',') + '}';
}

function canonical(text: string | null): string {
  if (text === null || text === undefined) return 'null';
  const s = String(text);
  try {
    return stableJson(JSON.parse(s));
  } catch {
    return s;
  }
}

/** 两个 JSON 文本是否表示同一个值（键序无关；解析失败退回逐字比较）。 */
export function sameStoredValue(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return canonical(a) === canonical(b);
}

const INS_HISTORY = `INSERT INTO field_history (entry_field_id, rev, value, prev_value, op, source, at)
  VALUES (:entryFieldId, :rev, :value, :prevValue, :op, :source, :at)`;

function nextRev(conn: Conn, entryFieldId: string): number {
  return Number(conn.scalar(
    'SELECT COALESCE(MAX(rev), 0) AS m FROM field_history WHERE entry_field_id = :id',
    { id: entryFieldId },
  ) ?? 0) + 1;
}

/** 按保留策略裁掉这个字段的旧版本（count = 最近 N 条；time = 最近 N 天）。 */
export function pruneFieldHistory(conn: Conn, entryFieldId: string, retention: HistoryRetention = readRetention(conn), at: Date = new Date()): void {
  if (retention.mode === 'count') {
    conn.run(
      `DELETE FROM field_history
       WHERE entry_field_id = :id
         AND rev NOT IN (
           SELECT rev FROM field_history WHERE entry_field_id = :id ORDER BY rev DESC LIMIT :keep
         )`,
      { id: entryFieldId, keep: retention.count },
    );
    return;
  }
  const cutoff = new Date(at.getTime() - retention.days * 24 * 60 * 60 * 1000).toISOString();
  conn.run('DELETE FROM field_history WHERE entry_field_id = :id AND at < :cutoff', { id: entryFieldId, cutoff });
}

/**
 * 追加一批「值真的变了」的历史（调用方已做 diff；这里再做一次同值兜底）。
 * 返回实际追加行数。
 */
export function recordFieldChanges(
  conn: Conn,
  changes: FieldValueChange[],
  { retention = readRetention(conn), at = nowIso() }: { retention?: HistoryRetention; at?: string } = {},
): number {
  let added = 0;
  for (const c of changes) {
    if (c.next === null && c.prev === null) continue;
    if (c.next !== null && sameStoredValue(c.prev, c.next)) continue;
    conn.run(INS_HISTORY, {
      entryFieldId: c.entryFieldId,
      rev: nextRev(conn, c.entryFieldId),
      value: c.next ?? 'null',
      prevValue: c.prev,
      op: c.next === null ? 'clear' : 'set',
      source: 'ui',
      at,
    });
    pruneFieldHistory(conn, c.entryFieldId, retention);
    added += 1;
  }
  return added;
}

/** writeStore 重建后：删掉「字段行已经不存在」的历史（等价于原来的 CASCADE 语义）。 */
export function cleanupOrphanHistory(conn: Conn): number {
  const before = Number(conn.scalar('SELECT COUNT(*) AS n FROM field_history') ?? 0);
  conn.run('DELETE FROM field_history WHERE entry_field_id NOT IN (SELECT id FROM entry_fields)');
  const after = Number(conn.scalar('SELECT COUNT(*) AS n FROM field_history') ?? 0);
  return Math.max(0, before - after);
}

/** 历史行（读侧，已 JOIN entry_fields 带上字段身份）。 */
export interface HistoryRow {
  rev: number;
  value: string;
  prevValue: string | null;
  op: string;
  source: string;
  at: string;
  key: string;
  label: string;
  type: string;
}

function toHistoryRow(r: Row): HistoryRow {
  return {
    rev: Number(r.rev) || 0,
    value: String(r.value ?? 'null'),
    prevValue: r.prev_value == null ? null : String(r.prev_value),
    op: String(r.op || 'set'),
    source: String(r.source || 'ui'),
    at: String(r.at || ''),
    key: String(r.key ?? ''),
    label: String(r.label ?? ''),
    type: String(r.type ?? ''),
  };
}

/** 单个字段的历史（rev 倒序）+ 当前值文本。字段不存在返回 null。 */
export function readFieldHistory(db: Conn, entryId: string, key: string, limit = 50): { field: { id: string; key: string; label: string; type: string }; current: string | null; rows: HistoryRow[] } | null {
  const ef = db.get(
    'SELECT id, key, label, type FROM entry_fields WHERE entry_id = :entryId AND key = :key',
    { entryId, key },
  );
  if (!ef) return null;
  const current = db.get('SELECT value FROM field_data WHERE entry_field_id = :id', { id: String(ef.id) });
  const rows = db.all(
    `SELECT fh.*, ef.key AS key, ef.label AS label, ef.type AS type
     FROM field_history fh JOIN entry_fields ef ON ef.id = fh.entry_field_id
     WHERE fh.entry_field_id = :id
     ORDER BY fh.rev DESC LIMIT :limit`,
    { id: String(ef.id), limit: clampInt(limit, 50, 1, 500) },
  );
  return {
    field: { id: String(ef.id), key: String(ef.key), label: String(ef.label ?? ''), type: String(ef.type ?? '') },
    current: current ? String(current.value) : null,
    rows: rows.map(toHistoryRow),
  };
}

/** 一个条目的全字段变化时间线（按时间倒序；同秒按自增 id 倒序）。 */
export function readEntryHistory(db: Conn, entryId: string, limit = 100): HistoryRow[] {
  const rows = db.all(
    `SELECT fh.*, ef.key AS key, ef.label AS label, ef.type AS type
     FROM field_history fh JOIN entry_fields ef ON ef.id = fh.entry_field_id
     WHERE ef.entry_id = :entryId
     ORDER BY fh.at DESC, fh.id DESC LIMIT :limit`,
    { entryId, limit: clampInt(limit, 100, 1, 500) },
  );
  return rows.map(toHistoryRow);
}

export type RestoreOutcome =
  | { status: 'ok'; key: string; label: string; from: string | null; to: string; rev: number; at: string; changed: boolean }
  | { status: 'missing-field' }
  | { status: 'missing-rev' };

function bumpRev(conn: Conn, at: string): void {
  const cur = Number(getMeta(conn, 'rev') || '0') || 0;
  setMeta(conn, 'rev', String(cur + 1), at);
}

/**
 * 恢复到某个版本：把历史值写回 field_data，并**追加**一条 op='restore' 的历史
 * （恢复本身可再撤销）。值已经相同则只返回 changed:false，不写盘。
 */
export function restoreFieldVersion(db: Conn, entryId: string, key: string, rev: number): RestoreOutcome {
  return tx((conn) => {
    const ef = conn.get(
      'SELECT id, key, label FROM entry_fields WHERE entry_id = :entryId AND key = :key',
      { entryId, key },
    );
    if (!ef) return { status: 'missing-field' } as const;
    const id = String(ef.id);
    const target = conn.get(
      'SELECT rev, value FROM field_history WHERE entry_field_id = :id AND rev = :rev',
      { id, rev: Math.trunc(Number(rev)) || 0 },
    );
    if (!target) return { status: 'missing-rev' } as const;

    const cur = conn.get('SELECT value, created_at FROM field_data WHERE entry_field_id = :id', { id });
    const from = cur ? String(cur.value) : null;
    const to = String(target.value);
    const at = nowIso();
    if (sameStoredValue(from, to)) {
      return {
        status: 'ok', key: String(ef.key), label: String(ef.label ?? ''),
        from, to, rev: Number(target.rev), at, changed: false,
      } as const;
    }

    if (cur) {
      conn.run('UPDATE field_data SET value = :value, updated_at = :at WHERE entry_field_id = :id', { value: to, at, id });
    } else {
      conn.run(
        'INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at) VALUES (:did, :id, :value, :at, :at)',
        { did: fieldDataId(id), id, value: to, at },
      );
    }
    const newRev = nextRev(conn, id);
    conn.run(INS_HISTORY, {
      entryFieldId: id, rev: newRev, value: to, prevValue: from,
      op: 'restore', source: 'restore', at,
    });
    pruneFieldHistory(conn, id, readRetention(conn));
    bumpRev(conn, at);
    return {
      status: 'ok', key: String(ef.key), label: String(ef.label ?? ''),
      from, to, rev: newRev, at, changed: true,
    } as const;
  }, { db, mode: 'IMMEDIATE' });
}

/** 把保留策略应用到全库（设置里改完立即生效；启动时也可调）。 */
export function pruneAllHistory(db: Conn, retention: HistoryRetention = readRetention(db)): number {
  const before = Number(db.scalar('SELECT COUNT(*) AS n FROM field_history') ?? 0);
  if (retention.mode === 'time') {
    const cutoff = new Date(Date.now() - retention.days * 24 * 60 * 60 * 1000).toISOString();
    db.run('DELETE FROM field_history WHERE at < :cutoff', { cutoff });
  } else {
    const ids = db.all('SELECT DISTINCT entry_field_id AS id FROM field_history').map((r) => String(r.id));
    for (const id of ids) pruneFieldHistory(db, id, retention);
  }
  const after = Number(db.scalar('SELECT COUNT(*) AS n FROM field_history') ?? 0);
  return Math.max(0, before - after);
}
