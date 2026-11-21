// v7 迁移：旧「条目模板容器」变成一个空 folder 条目，旧条目挂到它下面。
// 这里用真 v6 schema + 裸 SQL 造数据，跑一遍 6→7，钉住「不丢条目、不丢结构行」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openRaw } from '../../src/core/db/driver.ts';
import { migrate, setMeta } from '../../src/core/db/migrator.ts';

const AT = '2026-01-01T00:00:00.000Z';

function buildV6() {
  const db = openRaw(':memory:');
  migrate(db, { to: 6 });
  setMeta(db, 'store_kind', 'sqlite');
  setMeta(db, 'schema_version', '6');
  db.run(`INSERT INTO sections (id, title, description, "order", template, kv, title_label, layout, created_at, updated_at)
    VALUES ('s', '旧条目模板', '', 10, NULL, 0, '名称', '{}', :at, :at)`, { at: AT });
  db.run(`INSERT INTO fields (section_id, key, label, type, fill, hint, sensitive, sort, spec, default_value)
    VALUES ('s', 'a', 'A', 'text', 'normal', '', 0, 0, '{"key":"a","label":"A","type":"text"}', '默认A')`);
  db.run(`INSERT INTO entries (id, section_id, title, tags, created_at, updated_at)
    VALUES ('e1', 's', '旧条目', '["x"]', :at, :at)`, { at: AT });
  db.run(`INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
    VALUES ('ef1', 'e1', 's:a', 'a', 'A', 'text', '', '{"key":"a","label":"A","type":"text"}', 'normal', 0, '{}')`);
  db.run(`INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at)
    VALUES ('fd1', 'ef1', '"1"', :at, :at)`, { at: AT });
  return db;
}

test('6→7：旧条目模板变根 folder 条目，旧条目挂下面，模板/结构行保留', () => {
  const db = buildV6();
  const applied = migrate(db, { to: 7 });
  assert.deepEqual(applied, [7]);

  const templates = db.all('SELECT id, title, blank FROM templates ORDER BY "order"');
  assert.deepEqual(templates.map((x) => x.id), ['__blank__', 's']);
  assert.equal(templates.find((x) => x.id === '__blank__').blank, 1);
  assert.equal(db.all('SELECT * FROM template_fields').length, 1);

  const entries = db.all('SELECT id, template_id, title FROM entries ORDER BY rowid');
  const folder = entries.find((e) => e.title === '旧条目模板');
  assert.ok(folder, '旧条目模板要变成一条 folder 条目');
  assert.equal(folder.template_id, '__blank__');
  const old = entries.find((e) => e.id === 'e1');
  assert.ok(old, '旧条目不能丢');
  assert.equal(old.template_id, 's');

  const folders = db.all('SELECT entry_id, parent_id, sort FROM folders');
  assert.equal(folders.length, 2);
  assert.equal(folders.find((f) => f.entry_id === folder.id).parent_id, null);
  assert.equal(folders.find((f) => f.entry_id === 'e1').parent_id, folder.id);

  // 结构行与值原样
  const ef = db.get("SELECT template_field_id, key FROM entry_fields WHERE id='ef1'");
  assert.equal(ef.template_field_id, 's:a');
  assert.equal(db.get("SELECT value FROM field_data WHERE id='fd1'").value, '"1"');

  db.close();
});
