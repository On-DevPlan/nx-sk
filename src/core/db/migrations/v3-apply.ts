// v2 → v3 的数据搬运（DDL 见 v3.sql；runner 在同一事务里先执行 DDL 再调这里）。
//
// 顺序是硬约束：
//   1. 先捕获 entries（含 "values" 列）与旧 entry_attach 全行——后面 DROP TABLE entries
//      会经外键 CASCADE 清空边表，先捞出来才有得搬；
//   2. entries_new 整表搬运 → DROP entries → RENAME → 补索引（此时 entry_fields 还是空的，
//      CASCADE 炸不到它）；
//   3. 逐条目拆行：模板行全实例化（出身字典的行都建，值缺也留结构），
//      values 里有数据的键落 field_data；不在字典的键按插入顺序建扩展行；
//   4. 边重映射：field_key 能找回 (entry_id, key) 的行就换 entry_field_id，找不回计 unmapped；
//   5. meta.migrate_v3 计数留档（排障时知道搬了多少、丢了几条边）。
//
// id 全部走 identity.ts 的确定性派生：同一 (条目, 键) 永远算出同一行，
// 搬运与运行时写入不可能分叉。
import { entryFieldId, fieldDataId, fieldTargetKey } from '../identity.ts';
import { nowIso } from '../../ids.ts';
import type { Conn, Row } from '../driver.ts';

function parseJson(text: unknown, fallback: unknown): unknown {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 搬运计数写进 meta.migrate_v3（裸 SQL：这里 import migrator 会形成 index→apply→migrator→index 的环）。 */
function writeMeta(conn: Conn, key: string, value: string, at: string): void {
  conn.run(
    `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, at },
  );
}

export function applyV3(db: Conn): void {
  const at = nowIso();

  // ── 1. 捕获 ──
  const entryRows = db.all('SELECT * FROM entries ORDER BY rowid') as Row[];
  const oldEdges = db.all('SELECT * FROM entry_attach ORDER BY rowid') as Row[];
  const fieldsBySection = new Map<string, Row[]>();
  for (const f of db.all('SELECT * FROM fields ORDER BY section_id, sort, rowid') as Row[]) {
    const list = fieldsBySection.get(String(f.section_id)) || [];
    list.push(f);
    fieldsBySection.set(String(f.section_id), list);
  }

  // ── 2. entries 重建（values 列退役）──
  db.exec(`INSERT INTO entries_new (id, section_id, title, tags, created_at, updated_at)
    SELECT id, section_id, title, tags, created_at, updated_at FROM entries`);
  db.exec('DROP TABLE entries');
  db.exec('ALTER TABLE entries_new RENAME TO entries');
  db.exec('CREATE INDEX ix_entries_section ON entries (section_id)');

  // ── 3. 逐条目拆行 ──
  const insEntryField = `INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
    VALUES (:id, :entryId, :templateFieldId, :key, :label, :type, :hint, :spec, :fill, :position, '{}')`;
  const insFieldData = `INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at)
    VALUES (:id, :entryFieldId, :value, :createdAt, :updatedAt)`;
  let entryFieldsCount = 0;
  let fieldDataCount = 0;

  for (const e of entryRows) {
    const entryId = String(e.id);
    const values = (parseJson(e.values, {}) || {}) as Record<string, unknown>;
    const dict = fieldsBySection.get(String(e.section_id)) || [];
    const seen = new Set<string>();
    let position = 0;

    const putData = (efId: string, value: unknown): void => {
      db.run(insFieldData, {
        id: fieldDataId(efId), entryFieldId: efId, value: JSON.stringify(value === undefined ? null : value),
        createdAt: e.created_at == null ? at : String(e.created_at),
        updatedAt: e.updated_at == null ? at : String(e.updated_at),
      });
      fieldDataCount += 1;
    };

    // 模板行全实例化：出身字典的键都建行（值缺也留结构），属性从 fields 行复制。
    for (const f of dict) {
      const key = String(f.key);
      seen.add(key);
      const id = entryFieldId(entryId, key);
      db.run(insEntryField, {
        id, entryId,
        templateFieldId: fieldTargetKey(String(e.section_id), key),
        key,
        label: String(f.label ?? key),
        type: String(f.type || 'text'),
        hint: String(f.hint ?? ''),
        spec: String(f.spec ?? '{}'),
        fill: ['normal', 'optional', 'avoid'].includes(String(f.fill)) ? String(f.fill) : null,
        position: position++,
      });
      entryFieldsCount += 1;
      if (Object.prototype.hasOwnProperty.call(values, key)) putData(id, values[key]);
    }

    // 扩展行：values 里有、字典里没有的键，按 JSON 键序（= 历史插入顺序）追加。
    for (const key of Object.keys(values)) {
      if (seen.has(key)) continue;
      const id = entryFieldId(entryId, key);
      db.run(insEntryField, {
        id, entryId, templateFieldId: null, key,
        label: key, type: 'text', hint: '',
        spec: JSON.stringify({ key, label: key, type: 'text' }),
        fill: null, position: position++,
      });
      entryFieldsCount += 1;
      putData(id, values[key]);
    }
  }

  // ── 4. 边重映射 ──
  const insEdge = `INSERT INTO entry_attach_new (entry_field_id, attachment_id, role, position, note, created_at)
    VALUES (:entryFieldId, :attachmentId, :role, :position, :note, :createdAt)`;
  let unmapped = 0;
  for (const r of oldEdges) {
    const fieldKey = String(r.field_key ?? '');
    const row = fieldKey
      ? db.get('SELECT id FROM entry_fields WHERE entry_id = :entryId AND key = :key',
        { entryId: String(r.entry_id), key: fieldKey })
      : null;
    if (!row) { unmapped += 1; continue; }
    db.run(insEdge, {
      entryFieldId: String(row.id), attachmentId: String(r.attachment_id),
      role: String(r.role || 'inline'), position: Number(r.position) || 0,
      note: String(r.note ?? ''), createdAt: String(r.created_at || at),
    });
  }
  db.exec('DROP TABLE entry_attach');
  db.exec('ALTER TABLE entry_attach_new RENAME TO entry_attach');
  db.exec('CREATE INDEX ix_entry_attach_att ON entry_attach (attachment_id)');

  writeMeta(db, 'migrate_v3', JSON.stringify({
    entries: entryRows.length,
    entryFields: entryFieldsCount,
    fieldData: fieldDataCount,
    unmappedEdges: unmapped,
  }), at);
}
