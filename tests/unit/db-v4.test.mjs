// schema v4（字段类型去 DB CHECK）的保真测试：
//   ① 真 v3 库 3→4：fields / entry_fields / field_data / entry_attach 逐行逐列不变
//      （行、值、边、id 全部深比较），读路径往返一致；
//   ② 迁移后未知类型不再被 DB 拒绝（「加类型不改库」的正向证明）；
//   ③ 幂等：已到 v4 的库重跑等于空转；
//   ④ 坏脚本回滚：apply 中途失败整步撤销，库停在 v3 可用状态。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-v4-');

const { openRaw } = await import('../../src/core/db/driver.ts');
const { migrate, setMeta, getMeta, schemaVersion } = await import('../../src/core/db/migrator.ts');
const { readStore } = await import('../../src/core/db/repo.ts');
const identity = await import('../../src/core/db/identity.ts');

const CIPHER = { v: 1, alg: 'aes-256-gcm', kid: 'aabbccddeeff', iv: '0123456789abcdef', tag: 'fedcba9876543210', ct: 'ZmFrZS1jdA==' };

/** 用裸 SQL 造一份真 v3 库（内存连接）：字典（含 file/secret/debug 形状行）+ 条目结构行 + 值 + 边。 */
function buildV3MemoryDb() {
  const db = openRaw(':memory:');
  migrate(db, { to: 3 });
  setMeta(db, 'store_kind', 'sqlite');
  setMeta(db, 'schema_version', '3');
  db.run(`INSERT INTO sections (id, title, description, "order", kv, title_label, layout, created_at, updated_at)
    VALUES ('s', 'S', '', 50, 0, '名称', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  const insField = `INSERT INTO fields (section_id, key, label, type, group_id, fill, hint, sensitive, sort, spec, default_value)
    VALUES (:s, :key, :label, :type, :g, :fill, :hint, :sens, :sort, :spec, :dv)`;
  db.run(insField, { s: 's', key: 'a', label: 'A', type: 'text', g: 'g', fill: 'normal', hint: '', sens: 0, sort: 0, spec: '{"key":"a","label":"A","type":"text","group":"g"}', dv: null });
  db.run(insField, { s: 's', key: 'b', label: 'B', type: 'file', g: null, fill: 'optional', hint: '附件', sens: 0, sort: 1, spec: '{"key":"b","label":"B","type":"file","fill":"optional"}', dv: null });
  db.run(insField, { s: 's', key: 'pw', label: '口令', type: 'secret', g: null, fill: 'normal', hint: '', sens: 1, sort: 2, spec: '{"key":"pw","label":"口令","type":"secret"}', dv: '"默认"' });
  const ef = (id, entryId, tfid, key, type, spec, fill, pos) =>
    db.run(`INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
      VALUES (:id, :e, :tf, :k, :k, :type, '', :spec, :fill, :pos, '{}')`,
    { id, e: entryId, tf: tfid, k: key, type, spec, fill, pos });
  const fd = (efId, value, created, updated) =>
    db.run('INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at) VALUES (:id, :ef, :v, :c, :u)',
      { id: identity.fieldDataId(efId), ef: efId, v: value, c: created, u: updated });
  db.run(`INSERT INTO entries (id, section_id, title, tags, created_at, updated_at)
    VALUES ('e1', 's', 'T', '["x"]', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`);
  const efA = identity.entryFieldId('e1', 'a');
  const efB = identity.entryFieldId('e1', 'b');
  const efPw = identity.entryFieldId('e1', 'pw');
  const efGhost = identity.entryFieldId('e1', 'ghost');
  ef(efA, 'e1', 's:a', 'a', 'text', '{"key":"a","label":"A","type":"text","group":"g"}', null, 0);
  ef(efB, 'e1', 's:b', 'b', 'file', '{"key":"b","label":"B","type":"file"}', 'optional', 1);
  ef(efPw, 'e1', 's:pw', 'pw', 'secret', '{"key":"pw","label":"口令","type":"secret","sensitive":true}', null, 2);
  ef(efGhost, 'e1', null, 'ghost', 'text', '{"key":"ghost","label":"ghost","type":"text"}', null, 3);
  fd(efA, '"1"', '2026-02-01T00:00:00.000Z', '2026-02-03T00:00:00.000Z');
  fd(efB, '["f_x"]', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  fd(efPw, JSON.stringify(CIPHER), '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  fd(efGhost, 'null', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  db.run(`INSERT INTO attachments (id, kind, name, created_at, updated_at)
    VALUES ('f_x', 'file', 'x', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`);
  db.run(`INSERT INTO entry_attach (entry_field_id, attachment_id, role, position, note, created_at)
    VALUES (:ef, 'f_x', 'inline', 0, '', '2026-02-01T00:00:00.000Z')`, { ef: efB });
  db.run(`INSERT INTO entry_attach (entry_field_id, attachment_id, role, position, note, created_at)
    VALUES (:ef, 'f_x', 'attach', 5, 'note', '2026-02-01T00:00:00.000Z')`, { ef: efA });
  return { db, efA, efB, efPw, efGhost };
}

const dumpAll = (db, sql) => db.all(`${sql} ORDER BY rowid`);

test('① 真 v3 库 3→4：四张表逐行逐列不变，读路径往返一致', () => {
  const { db } = buildV3MemoryDb();
  const before = {
    fields: dumpAll(db, 'SELECT * FROM fields'),
    entryFields: dumpAll(db, 'SELECT * FROM entry_fields'),
    fieldData: dumpAll(db, 'SELECT * FROM field_data'),
    edges: dumpAll(db, 'SELECT * FROM entry_attach'),
  };
  const { raw: rawBefore, structures: stBefore } = readStore(db);

  const applied = migrate(db, { to: 4 });
  assert.deepEqual(applied, [4]);
  assert.equal(schemaVersion(db), 4);

  const after = {
    fields: dumpAll(db, 'SELECT * FROM fields'),
    entryFields: dumpAll(db, 'SELECT * FROM entry_fields'),
    fieldData: dumpAll(db, 'SELECT * FROM field_data'),
    edges: dumpAll(db, 'SELECT * FROM entry_attach'),
  };
  // 行、值、边、id 全部不变（深比较；顺序按 rowid，搬运按捕获序重插）
  assert.deepEqual(after.fields, before.fields, 'fields 逐行逐列不变');
  assert.deepEqual(after.entryFields, before.entryFields, 'entry_fields 逐行逐列不变');
  assert.deepEqual(after.fieldData, before.fieldData, 'field_data 逐行逐列不变（密文 blob 原样）');
  assert.deepEqual(after.edges, before.edges, 'entry_attach 边原样（role/note/position/created_at）');

  // 读路径往返：与迁移前组装出的对象深比较
  const { raw: rawAfter, structures: stAfter } = readStore(db);
  assert.deepEqual(rawAfter, rawBefore, 'readStore 组装结果不变');
  assert.deepEqual([...stAfter.get('e1')], [...stBefore.get('e1')], '条目结构行视图不变');
  assert.equal(stAfter.get('e1').find((r) => r.key === 'a').templateFieldId, 's:a', '复合串一字不改');
  assert.equal(stAfter.get('e1').find((r) => r.key === 'ghost').templateFieldId, null);
  assert.equal(rawAfter.entries[0].values.pw && typeof rawAfter.entries[0].values.pw, 'object');
  assert.equal(JSON.stringify(rawAfter.entries[0].values.pw), JSON.stringify(CIPHER), '密文值原样');

  // meta 计数留档
  const mig = JSON.parse(getMeta(db, 'migrate_v4'));
  assert.deepEqual(mig, { fields: 3, entryFields: 4, fieldData: 4, edges: 2 }, JSON.stringify(mig));
  db.close();
});

test('② 迁移后未知类型不再被 DB 拒绝（加类型不改库的正向证明）', () => {
  const { db } = buildV3MemoryDb();
  migrate(db, { to: 4 });
  // v3 时这行会被 CHECK 拦下；v4 起 DB 放行，合法性由运行时清单判
  db.run(`INSERT INTO fields (section_id, key, label, type, sort, spec)
    VALUES ('s', 'future', 'F', 'not_a_type_yet', 9, '{"key":"future","type":"not_a_type_yet"}')`);
  assert.ok(db.get("SELECT 1 AS x FROM fields WHERE key = 'future'"));
  db.run('DELETE FROM fields WHERE key = \'future\'');
  db.run(`INSERT INTO entry_fields (id, entry_id, key, label, type, spec, position)
    VALUES ('ef_future', 'e1', 'future', 'F', 'not_a_type_yet', '{}', 99)`);
  assert.ok(db.get("SELECT 1 AS x FROM entry_fields WHERE id = 'ef_future'"));
  db.close();
});

test('③ 幂等：已到 v4 的库重跑等于空转', () => {
  const { db } = buildV3MemoryDb();
  migrate(db, { to: 4 });
  assert.deepEqual(migrate(db), [], '第二次不该再执行任何步骤');
  assert.equal(schemaVersion(db), 4);
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  assert.ok(!names.includes('fields_new') && !names.includes('entry_fields_new'), '重建的临时表必须已消失');
  db.close();
});

test('④ 坏脚本回滚：apply 中途失败整步撤销，库停在 v3 可用状态', () => {
  const { db } = buildV3MemoryDb();
  // 让 applyV4 的搬运必炸：把 entry_fields 的 id 列改名，SELECT id 直接失败
  db.exec('ALTER TABLE entry_fields RENAME COLUMN id to id_broken');
  assert.throws(() => migrate(db, { to: 4 }));
  assert.equal(schemaVersion(db), 3, '版本不能漂');
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  assert.ok(!names.includes('fields_new') && !names.includes('entry_fields_new'), 'DDL 建的临时表必须随事务回滚');
  assert.ok(names.includes('fields') && names.includes('entry_fields'), '原表还在（v3 可用）');
  // DDL 的 CREATE 与 apply 的写全部被撤销（entry_fields.id 是我们自己改坏的，
  // readStore 在此不可用——直接查 entries 证明 v3 数据还在）
  assert.equal(db.get("SELECT id FROM entries WHERE id = 'e1'").id, 'e1');
  assert.ok(db.get("SELECT 1 AS x FROM fields WHERE section_id = 's' AND key = 'pw'"), 'fields 行还在');
  assert.ok(db.get("SELECT 1 AS x FROM field_data WHERE value LIKE '%aes-256-gcm%'"), '密文值行还在');
  db.close();
});
