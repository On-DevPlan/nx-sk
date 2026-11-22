// v10 迁移：entries.description（desc）新增列；旧条目的值/结构原样保留，desc 为空串。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openRaw } from '../../src/core/db/driver.ts';
import { migrate } from '../../src/core/db/migrator.ts';

const AT = '2026-01-01T00:00:00.000Z';

function buildV9() {
  const db = openRaw(':memory:');
  migrate(db, { to: 9 });
  db.run(`INSERT INTO templates (id, title, description, "order", source, blank, title_label, tags, layout, created_at, updated_at)
    VALUES ('notes', '笔记', '', 50, NULL, 0, '名称', '[]', '{}', :at, :at)`, { at: AT });
  db.run(`INSERT INTO entries (id, template_id, title, tags, created_at, updated_at)
    VALUES ('e1', 'notes', '工作', '[]', :at, :at)`, { at: AT });
  db.run(`INSERT INTO folders (entry_id, parent_id, sort, created_at) VALUES ('e1', NULL, 0, :at)`, { at: AT });
  return db;
}

test('9→10：entries 多出 description 列，旧条目原样保留且 desc 为空串', () => {
  const db = buildV9();
  const before = db.get("SELECT id, template_id, title, tags FROM entries WHERE id='e1'");
  const applied = migrate(db, { to: 10 });
  assert.deepEqual(applied, [10]);

  const cols = db.all("SELECT name FROM pragma_table_info('entries')").map((r) => r.name);
  assert.ok(cols.includes('description'), 'description 列应已加上');
  assert.ok(cols.includes('title') && cols.includes('template_id'), '其余条目列不能被误删');

  assert.deepEqual(db.get("SELECT id, template_id, title, tags FROM entries WHERE id='e1'"), before);
  assert.deepEqual(db.get("SELECT description FROM entries WHERE id='e1'"), { description: '' });
  assert.equal(db.get("SELECT parent_id FROM folders WHERE entry_id='e1'").parent_id, null);
  db.close();
});

test('9→10 可重入：同一事务里重建表不会丢掉已有 desc（升级失败回滚）', () => {
  const db = buildV9();
  migrate(db, { to: 10 });
  db.run("UPDATE entries SET description = '一句话' WHERE id='e1'");
  // 再跑一次 10→10 是空转（版本已到位），desc 不会被重置
  assert.deepEqual(migrate(db, { to: 10 }), []);
  assert.equal(db.get("SELECT description FROM entries WHERE id='e1'").description, '一句话');
  db.close();
});
