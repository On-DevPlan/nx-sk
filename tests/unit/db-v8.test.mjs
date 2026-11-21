// v8 迁移：templates.kv 列彻底删除；模板/条目数据原样保留。
// 用真 v7 schema 造一条模板与一条条目，跑 7→8 后逐项对账。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openRaw } from '../../src/core/db/driver.ts';
import { migrate } from '../../src/core/db/migrator.ts';

const AT = '2026-01-01T00:00:00.000Z';

function buildV7() {
  const db = openRaw(':memory:');
  migrate(db, { to: 7 });
  db.run(`INSERT INTO templates (id, title, description, "order", source, kv, blank, title_label, layout, created_at, updated_at)
    VALUES ('secret', '密钥', '旧形状', 50, 'secret', 1, 0, '条目名', '{}', :at, :at)`, { at: AT });
  db.run(`INSERT INTO template_fields (template_id, key, label, type, fill, hint, sensitive, sort, spec, default_value)
    VALUES ('secret', 'value', '密钥值', 'secret', 'normal', '', 1, 0, '{"key":"value","label":"密钥值","type":"secret","sensitive":true}', NULL)`);
  db.run(`INSERT INTO entries (id, template_id, title, tags, created_at, updated_at)
    VALUES ('e1', 'secret', 'OPENAI_KEY', '[]', :at, :at)`, { at: AT });
  db.run(`INSERT INTO folders (entry_id, parent_id, sort, created_at) VALUES ('e1', NULL, 0, :at)`, { at: AT });
  return db;
}

test('7→8：templates.kv 列被删除，模板/字段/条目原样保留', () => {
  const db = buildV7();
  const before = db.get("SELECT id, title, description, source, blank, title_label FROM templates WHERE id='secret'");
  const applied = migrate(db, { to: 8 });
  assert.deepEqual(applied, [8]);

  const cols = db.all("SELECT name FROM pragma_table_info('templates')").map((r) => r.name);
  assert.ok(!cols.includes('kv'), 'kv 列应已删除');
  assert.ok(cols.includes('title') && cols.includes('source') && cols.includes('blank'), '其余模板列不能被误删');

  assert.deepEqual(db.get("SELECT id, title, description, source, blank, title_label FROM templates WHERE id='secret'"), before);
  assert.equal(db.all('SELECT * FROM template_fields').length, 1);
  assert.equal(db.all('SELECT * FROM entries').length, 1);
  assert.equal(db.get("SELECT parent_id FROM folders WHERE entry_id='e1'").parent_id, null);
  assert.equal(db.get("SELECT json_extract(spec, '$.key') AS k FROM template_fields").k, 'value');

  db.close();
});

test('空库直接到当前版本也不再有 kv 列', () => {
  const db = openRaw(':memory:');
  migrate(db, { from: 0 });
  const cols = db.all("SELECT name FROM pragma_table_info('templates')").map((r) => r.name);
  assert.ok(!cols.includes('kv'), '全新建库不该出现已被退役的 kv 列');
  db.close();
});
