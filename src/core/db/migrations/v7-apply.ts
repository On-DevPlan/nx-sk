// v6 → v7 的数据搬运（DDL 见 v7.sql；runner 在同一事务里先执行 DDL 再调这里）。
//
// 任务 #45 的落地：条目模板容器退役，模板只保留字段结构；旧条目模板各生成一个空条目
// （folder 节点），旧条目挂到该节点下。folder 不是新实体，父子关系进 folders 表。
//
// 顺序是硬约束（DROP entries 的 CASCADE 会带走 entry_fields / field_data /
// entry_attach）：先把五张表全行捕获，建好新 entries/folders，再换表，最后原样放回。
// 列名全部显式写出：SELECT * 的位置耦合会在将来加列时静默错位。
import { newId, nowIso } from '../../ids.ts';
import type { Conn, Row } from '../driver.ts';

const BLANK_TEMPLATE_ID = '__blank__';
const BLANK_TEMPLATE_AT = '1970-01-01T00:00:00.000Z';

function writeMeta(conn: Conn, key: string, value: string, at: string): void {
  conn.run(
    `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, at },
  );
}

const SECTION_COLS = 'id, title, description, "order", template, kv, title_field, title_label, layout, created_at, updated_at';
const FIELD_COLS = 'section_id, key, label, type, fill, hint, sensitive, sort, spec, default_value';
const ENTRY_COLS = 'id, section_id, title, tags, created_at, updated_at';
const ENTRY_FIELD_COLS = 'id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta';
const FIELD_DATA_COLS = 'id, entry_field_id, value, created_at, updated_at';
const EDGE_COLS = 'entry_field_id, attachment_id, role, position, note, created_at';

interface LegacySection {
  id: string;
  title: string;
  order: number;
  kv: number;
  source: string | null;
  titleField: string | null;
  titleLabel: string;
  layout: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export function applyV7(db: Conn): void {
  const at = nowIso();

  // ── 1. 捕获 ──
  const sectionRows = db.all(`SELECT ${SECTION_COLS} FROM sections ORDER BY rowid`) as Row[];
  const fieldRows = db.all(`SELECT ${FIELD_COLS} FROM fields ORDER BY section_id, sort, rowid`) as Row[];
  const entryRows = db.all(`SELECT ${ENTRY_COLS} FROM entries ORDER BY rowid`) as Row[];
  const entryFieldRows = db.all(`SELECT ${ENTRY_FIELD_COLS} FROM entry_fields ORDER BY rowid`) as Row[];
  const fieldDataRows = db.all(`SELECT ${FIELD_DATA_COLS} FROM field_data ORDER BY rowid`) as Row[];
  const edgeRows = db.all(`SELECT ${EDGE_COLS} FROM entry_attach ORDER BY rowid`) as Row[];

  const sections: LegacySection[] = sectionRows.map((s) => ({
    id: String(s.id),
    title: String(s.title ?? s.id),
    order: Number(s.order) || 0,
    kv: Number(s.kv) === 1 ? 1 : 0,
    source: s.template == null ? null : String(s.template),
    titleField: s.title_field == null ? null : String(s.title_field),
    titleLabel: String(s.title_label ?? '名称'),
    layout: String(s.layout ?? 'null'),
    createdAt: s.created_at == null ? null : String(s.created_at),
    updatedAt: s.updated_at == null ? null : String(s.updated_at),
  }));

  // ── 2. 空白模板 + 旧条目模板 → 模板 ──
  db.run(
    `INSERT INTO templates (id, title, description, "order", source, kv, blank, title_field, title_label, layout, created_at, updated_at)
     VALUES (:id, :title, '', -1, NULL, 0, 1, NULL, '名称', 'null', :at, :at)`,
    { id: BLANK_TEMPLATE_ID, title: '无模板', at: BLANK_TEMPLATE_AT },
  );
  for (const s of sections) {
    db.run(
      `INSERT INTO templates (id, title, description, "order", source, kv, blank, title_field, title_label, layout, created_at, updated_at)
       VALUES (:id, :title, :description, :order, :source, :kv, 0, :titleField, :titleLabel, :layout, :createdAt, :updatedAt)`,
      {
        id: s.id, title: s.title, description: String(sectionRows.find((x) => String(x.id) === s.id)?.description ?? ''),
        order: s.order, source: s.source, kv: s.kv, titleField: s.titleField, titleLabel: s.titleLabel,
        layout: s.layout, createdAt: s.createdAt, updatedAt: s.updatedAt,
      },
    );
  }
  for (const f of fieldRows) {
    db.run(
      `INSERT INTO template_fields (template_id, key, label, type, fill, hint, sensitive, sort, spec, default_value)
       VALUES (:templateId, :key, :label, :type, :fill, :hint, :sensitive, :sort, :spec, :defaultValue)`,
      {
        templateId: String(f.section_id), key: String(f.key), label: String(f.label ?? ''),
        type: String(f.type), fill: String(f.fill || 'normal'), hint: String(f.hint ?? ''),
        sensitive: Number(f.sensitive) || 0, sort: Number(f.sort) || 0,
        spec: String(f.spec ?? '{}'), defaultValue: f.default_value ?? null,
      },
    );
  }

  // ── 3. 旧条目模板 → 空 folder 条目；旧条目挂到它下面 ──
  // 每个旧条目模板一个 folder 条目，title = 条目模板标题；folder 本身没有字段（blank 模板）。
  // 旧条目的 template_id 仍指向旧条目模板 id——模板只记录出身，后续完全可以无关。
  const folderBySection = new Map<string, string>();
  for (const s of sections) {
    const folderId = newId('e');
    folderBySection.set(s.id, folderId);
    db.run(
      `INSERT INTO entries_new (id, template_id, title, tags, created_at, updated_at)
       VALUES (:id, '__blank__', :title, '[]', :createdAt, :updatedAt)`,
      { id: folderId, title: s.title, createdAt: s.createdAt || at, updatedAt: s.updatedAt || at },
    );
    db.run(
      `INSERT INTO folders (entry_id, parent_id, sort, created_at) VALUES (:id, NULL, :sort, :at)`,
      { id: folderId, sort: s.order, at },
    );
  }

  const sortBySection = new Map<string, number>();
  for (const e of entryRows) {
    const eid = String(e.id);
    const sid = String(e.section_id);
    const parent = folderBySection.get(sid) || null;
    const sort = (sortBySection.get(sid) || 0);
    sortBySection.set(sid, sort + 1);
    db.run(
      `INSERT INTO entries_new (id, template_id, title, tags, created_at, updated_at)
       VALUES (:id, :templateId, :title, :tags, :createdAt, :updatedAt)`,
      {
        id: eid, templateId: sections.some((s) => s.id === sid) ? sid : BLANK_TEMPLATE_ID,
        title: String(e.title ?? ''), tags: String(e.tags ?? '[]'),
        createdAt: e.created_at == null ? null : String(e.created_at),
        updatedAt: e.updated_at == null ? null : String(e.updated_at),
      },
    );
    db.run(
      `INSERT INTO folders (entry_id, parent_id, sort, created_at) VALUES (:id, :parent, :sort, :at)`,
      { id: eid, parent, sort, at },
    );
  }

  // ── 4. 换表：DROP entries 会清空 entry_fields / field_data / entry_attach ──
  db.exec('DROP TABLE entries');
  db.exec('DROP TABLE fields');
  db.exec('DROP TABLE sections');
  db.exec('ALTER TABLE entries_new RENAME TO entries');

  // ── 5. 原样放回子表（id / 值 / 时间戳一字不改）──
  for (const r of entryFieldRows) {
    db.run(`INSERT INTO entry_fields (${ENTRY_FIELD_COLS}) VALUES (:id, :entry_id, :template_field_id, :key, :label, :type, :hint, :spec, :fill, :position, :meta)`, r);
  }
  for (const r of fieldDataRows) {
    db.run(`INSERT INTO field_data (${FIELD_DATA_COLS}) VALUES (:id, :entry_field_id, :value, :created_at, :updated_at)`, r);
  }
  for (const r of edgeRows) {
    db.run(`INSERT INTO entry_attach (${EDGE_COLS}) VALUES (:entry_field_id, :attachment_id, :role, :position, :note, :created_at)`, r);
  }

  writeMeta(db, 'migrate_v7', JSON.stringify({
    templates: sections.length + 1,
    folders: folderBySection.size + entryRows.length,
    entries: entryRows.length + folderBySection.size,
    templateFields: fieldRows.length,
    entryFields: entryFieldRows.length,
    fieldData: fieldDataRows.length,
    edges: edgeRows.length,
  }), at);
}
