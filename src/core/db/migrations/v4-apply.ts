// v3 → v4 的数据搬运（DDL 见 v4.sql；runner 在同一事务里先执行 DDL 再调这里）。
//
// 顺序是硬约束（DROP 的 CASCADE 会带走子表）：
//   1. 先捕获 fields / entry_fields / field_data / entry_attach 四张表全行——
//      DROP TABLE entry_fields 会经 field_data / entry_attach 的 ON DELETE CASCADE
//      清空两张子表（driver 每个连接都开 foreign_keys），先捞出来才有得搬；
//   2. fields 重建：无子表引用它（v2 已删 field_attach），直接搬 → DROP → RENAME → 补索引；
//   3. entry_fields 重建：搬 → DROP（子表被 CASCADE 清空）→ RENAME → 补索引；
//   4. 子表原样放回：field_data、entry_attach 逐行重插（**id / value / 时间戳一字不改**）——
//      两张子表的表与索引都没重建，CASCADE 只清了行；
//   5. meta.migrate_v4 计数留档。
//
// 列名全部显式写出：SELECT * 的位置耦合会在将来加列时静默错位。
import { nowIso } from '../../ids.ts';
import type { Conn, Row } from '../driver.ts';

/** 搬运计数写进 meta.migrate_v4（裸 SQL：这里 import migrator 会形成循环依赖）。 */
function writeMeta(conn: Conn, key: string, value: string, at: string): void {
  conn.run(
    `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, at },
  );
}

const FIELD_COLS = 'section_id, key, label, type, group_id, fill, hint, sensitive, sort, spec, default_value';
const ENTRY_FIELD_COLS = 'id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta';
const FIELD_DATA_COLS = 'id, entry_field_id, value, created_at, updated_at';
const EDGE_COLS = 'entry_field_id, attachment_id, role, position, note, created_at';

export function applyV4(db: Conn): void {
  const at = nowIso();

  // ── 1. 捕获 ──
  const fieldRows = db.all(`SELECT ${FIELD_COLS} FROM fields ORDER BY rowid`) as Row[];
  const entryFieldRows = db.all(`SELECT ${ENTRY_FIELD_COLS} FROM entry_fields ORDER BY rowid`) as Row[];
  const fieldDataRows = db.all(`SELECT ${FIELD_DATA_COLS} FROM field_data ORDER BY rowid`) as Row[];
  const edgeRows = db.all(`SELECT ${EDGE_COLS} FROM entry_attach ORDER BY rowid`) as Row[];

  // ── 2. fields 重建（去 type CHECK）──
  db.exec(`INSERT INTO fields_new (${FIELD_COLS}) SELECT ${FIELD_COLS} FROM fields`);
  db.exec('DROP TABLE fields');
  db.exec('ALTER TABLE fields_new RENAME TO fields');
  db.exec('CREATE INDEX ix_fields_section ON fields (section_id, sort)');
  db.exec('CREATE INDEX ix_fields_group ON fields (section_id, group_id)');

  // ── 3. entry_fields 重建（DROP 的 CASCADE 会清空 field_data / entry_attach）──
  db.exec(`INSERT INTO entry_fields_new (${ENTRY_FIELD_COLS}) SELECT ${ENTRY_FIELD_COLS} FROM entry_fields`);
  db.exec('DROP TABLE entry_fields');
  db.exec('ALTER TABLE entry_fields_new RENAME TO entry_fields');
  db.exec('CREATE INDEX ix_entry_fields_entry ON entry_fields (entry_id, position)');

  // ── 4. 子表原样放回（id/值/时间戳逐列搬运，不做任何加工）──
  // field_data / entry_attach 的**表与索引**都没动过（CASCADE 只清行），
  // 所以这里只重插行，不再 CREATE INDEX（重复建会炸，实测 0→4 全链必现）。
  for (const r of fieldDataRows) {
    db.run(`INSERT INTO field_data (${FIELD_DATA_COLS}) VALUES (:id, :entry_field_id, :value, :created_at, :updated_at)`, r);
  }
  for (const r of edgeRows) {
    db.run(`INSERT INTO entry_attach (${EDGE_COLS}) VALUES (:entry_field_id, :attachment_id, :role, :position, :note, :created_at)`, r);
  }

  writeMeta(db, 'migrate_v4', JSON.stringify({
    fields: fieldRows.length,
    entryFields: entryFieldRows.length,
    fieldData: fieldDataRows.length,
    edges: edgeRows.length,
  }), at);
}
