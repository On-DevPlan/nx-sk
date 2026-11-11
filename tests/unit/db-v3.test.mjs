// schema v3（动态结构/写时复制）的专项测试：
//   ① 真 v2 库 2→3 的搬运保真（拆行 / 确定性 id / 边重映射 / unmapped / meta 计数）
//   ② facade 写入：新条目实例化全部模板行 + defaultValue 落数据行
//   ③ sync 只增不改：字典改 label 不回刷存量行；sync 补缺行且默认值只给新行
//   ④ quickAdd 不污染字典：bool/secretish 推断落条目扩展行，台账可读
//   ⑤ 完整度按条目自身行：add-field 后 total 不变，sync 后才变
//   ⑥ --set 走 service 与直接写 store 等价（行/值/读回三方一致）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-v3-');

const { openRaw } = await import('../../src/core/db/driver.ts');
const { migrate, setMeta, getMeta } = await import('../../src/core/db/migrator.ts');
const { readStore } = await import('../../src/core/db/repo.ts');
const identity = await import('../../src/core/db/identity.ts');
const store = await import('../../src/core/store.ts');
const sections = await import('../../src/modules/sections/service.ts');
const entries = await import('../../src/modules/entries/service.ts');

const CIPHER = { v: 1, alg: 'aes-256-gcm', kid: 'aabbccddeeff', iv: '0123456789abcdef', tag: 'fedcba9876543210', ct: 'ZmFrZS1jdA==' };

/** 用裸 SQL 造一份真 v2 库（内存连接）：字典 a/b + 条目带密文/引用/字典外键 + 三种边。 */
function buildV2MemoryDb() {
  const db = openRaw(':memory:');
  migrate(db, { to: 2 });
  setMeta(db, 'store_kind', 'sqlite');
  setMeta(db, 'schema_version', '2');
  db.run(`INSERT INTO sections (id, title, description, "order", kv, title_label, layout, created_at, updated_at)
    VALUES ('s', 'S', '', 50, 0, '名称', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  db.run(`INSERT INTO fields (section_id, key, label, type, sort, spec)
    VALUES ('s', 'a', 'A', 'text', 0, '{"key":"a","label":"A","type":"text"}')`);
  db.run(`INSERT INTO fields (section_id, key, label, type, sort, spec)
    VALUES ('s', 'b', 'B', 'file', 1, '{"key":"b","label":"B","type":"file"}')`);
  const values = { a: '1', b: 'f_x', ghost: '3', cipher: CIPHER };
  db.run(`INSERT INTO entries (id, section_id, title, tags, "values", created_at, updated_at)
    VALUES ('e1', 's', 'T', '[]', ?, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`, [JSON.stringify(values)]);
  db.run(`INSERT INTO attachments (id, kind, name, created_at, updated_at)
    VALUES ('f_x', 'file', 'x', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`);
  // inline 边（b）、显式 attach 边（a）、指向不存在键的边（gone → 应 unmapped）
  db.run(`INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at)
    VALUES ('e1', 'f_x', 'b', 'inline', 0, '', '2026-02-01T00:00:00.000Z')`);
  db.run(`INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at)
    VALUES ('e1', 'f_x', 'a', 'attach', 0, 'note-a', '2026-02-01T00:00:00.000Z')`);
  db.run(`INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at)
    VALUES ('e1', 'f_x', 'gone', 'inline', 0, '', '2026-02-01T00:00:00.000Z')`);
  return { db, values };
}

test('① 真 v2 库 2→3：拆行保真、确定性 id、边重映射、unmapped 被丢、meta 计数', () => {
  const { db, values } = buildV2MemoryDb();
  const applied = migrate(db, { to: 3 });
  assert.deepEqual(applied, [3]);

  const { raw, structures } = readStore(db);
  const e1 = raw.entries.find((x) => x.id === 'e1');
  assert.deepEqual(e1.values, values, '逐键搬运：密文对象/引用/字典外键原样');

  const rows = structures.get('e1');
  assert.equal(rows.length, 4, '模板行 a/b + 扩展行 ghost/cipher');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  assert.equal(byKey.get('a').templateFieldId, 's:a', '出身模板 = 复合串');
  assert.equal(byKey.get('b').templateFieldId, 's:b');
  assert.equal(byKey.get('ghost').templateFieldId, null, '字典外的键 = 扩展行');
  assert.equal(byKey.get('ghost').spec.type, 'text');
  assert.equal(byKey.get('a').id, identity.entryFieldId('e1', 'a'), '行 id 确定性');
  assert.deepEqual(byKey.get('a').spec, { key: 'a', label: 'A', type: 'text' }, 'spec 从字典行复制');
  assert.deepEqual(byKey.get('cipher').spec, { key: 'cipher', label: 'cipher', type: 'text' }, '扩展行占位形状');

  // 值行 id 确定性 + 逐键存在
  const data = db.all('SELECT entry_field_id, value FROM field_data');
  assert.equal(data.length, 4, '四个键都有数据行');
  const aData = db.get('SELECT fd.value FROM field_data fd JOIN entry_fields ef ON ef.id = fd.entry_field_id WHERE ef.id = :id', { id: byKey.get('a').id });
  assert.equal(aData.value, '"1"', 'value 是 JSON 文本');
  assert.equal(db.get('SELECT id FROM field_data WHERE entry_field_id = :ef', { ef: byKey.get('a').id }).id, identity.fieldDataId(byKey.get('a').id));

  // 边重映射：inline(b) 与 attach(a) 找回行；gone 被丢
  const edges = db.all(`SELECT ea.entry_field_id, ea.attachment_id, ea.role, ef.key
    FROM entry_attach ea JOIN entry_fields ef ON ef.id = ea.entry_field_id ORDER BY ef.key`);
  assert.deepEqual(edges.map((x) => `${x.key}:${x.role}`), ['a:attach', 'b:inline'], '找不回的边必须被丢弃');
  assert.equal(edges.find((x) => x.key === 'a').entry_field_id, byKey.get('a').id);

  // meta 计数
  const mig = JSON.parse(getMeta(db, 'migrate_v3'));
  assert.deepEqual(mig, { entries: 1, entryFields: 4, fieldData: 4, unmappedEdges: 1 }, JSON.stringify(mig));
  db.close();
});

test('② facade：addEntry 实例化全部模板行，defaultValue 落数据行', async () => {
  await sections.addSection({
    id: 'v3def', title: '默认值',
    fields: [
      { key: 'a', label: 'A', type: 'text', group: 'g' },
      { key: 'b', label: 'B', type: 'text', group: 'g', defaultValue: '默认B' },
    ],
    groups: [{ id: 'g', title: 'G' }],
  });
  const created = await entries.addEntry({ section: 'v3def', title: '一条', set: { a: '1' } });
  assert.equal(created.status, 'ok');

  const st = await store.loadStore();
  const rows = store.entryStructures(st).get(created.id) || [];
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('a') && keys.includes('b') && keys.includes('source'), `模板行全实例化：${keys}`);
  assert.ok(rows.every((r) => r.templateFieldId != null), '没有扩展行');

  const got = await entries.getEntry('一条', { section: 'v3def' });
  assert.equal(got.values.a, '1');
  assert.equal(got.values.b, '默认B', 'defaultValue 没给值也要落');
});

test('③ sync 只增不改：字典改 label 不回刷存量行；补缺行且默认值只给新行', async () => {
  await sections.addSection({
    id: 'v3sync', title: '同步',
    fields: [{ key: 'a', label: 'A', type: 'text', group: 'g' }],
    groups: [{ id: 'g', title: 'G' }],
  });
  const created = await entries.addEntry({ section: 'v3sync', title: '一条', set: { a: '1' } });

  // 字典改 label → 条目自身行不回刷
  await sections.updateSection('v3sync', { 'set-field': { key: 'a', label: 'A改' } });
  let st = await store.loadStore();
  let rowA = (store.entryStructures(st).get(created.id) || []).find((r) => r.key === 'a');
  assert.equal(rowA.spec.label, 'A', '存量行属性不动');
  // 行没缺：sync 报 upToDate
  const r0 = await sections.syncSection('v3sync');
  assert.equal(r0.upToDate, true, '只改 label 不产生缺口');
  assert.equal(rowA.spec.label, 'A', 'sync 也不回刷');

  // 加带默认值的字段 → sync 补缺行，默认值只给**新行**
  await sections.updateSection('v3sync', { 'add-field': { key: 'b', label: 'B', type: 'text', group: 'g', defaultValue: '默认B' } });
  const r1 = await sections.syncSection('v3sync');
  assert.equal(r1.upToDate, false);
  assert.equal(r1.fieldsAdded, 1, '每个条目补一行 b');
  assert.equal(r1.defaultsFilled, 1, '新行落默认值');

  st = await store.loadStore();
  const rows = store.entryStructures(st).get(created.id) || [];
  rowA = rows.find((r) => r.key === 'a');
  const rowB = rows.find((r) => r.key === 'b');
  assert.equal(rowA.spec.label, 'A', '老行仍不回刷');
  assert.equal(rowB.spec.label, 'B');
  assert.equal(rowB.templateFieldId, 'v3sync:b');
  const got = await entries.getEntry('一条', { section: 'v3sync' });
  assert.equal(got.values.a, '1', '老值不动');
  assert.equal(got.values.b, '默认B', '新行有默认值');
});

test('④ quickAdd 不污染字典：bool/secretish 推断落扩展行，台账可读', async () => {
  await sections.addSection({
    id: 'v3quick', title: '大胆写',
    fields: [{ key: 'name', label: '名称', type: 'text', group: 'g' }],
    groups: [{ id: 'g', title: 'G' }],
  });
  const created = await entries.addEntry({ section: 'v3quick', title: '一条', set: { name: 'X' } });
  const upd = await entries.updateEntry('一条', {
    section: 'v3quick',
    set: { 是否有offer: '否', 密码: 'P@ss-秘密' },
  });
  assert.equal(upd.status, 'ok');
  assert.deepEqual(upd.newFields.sort(), ['密码', '是否有offer']);

  const st = await store.loadStore();
  const sec = st.sections.find((s) => s.id === 'v3quick');
  assert.equal(sec.fields.some((f) => f.key === '是否有offer' || f.key === '密码'), false, '字典不被污染');

  const rows = store.entryStructures(st).get(created.id) || [];
  const boolRow = rows.find((r) => r.key === '是否有offer');
  const secretRow = rows.find((r) => r.key === '密码');
  assert.equal(boolRow?.spec.type, 'bool', '是/否 推断成 bool');
  assert.equal(secretRow?.spec.type, 'secret', 'secretish 键推断成密文');
  assert.equal(boolRow?.templateFieldId, null);

  // 值与类型：bool 读出是 false；密码读出是原文（密文在存储层）
  const got = await entries.getEntry('一条', { section: 'v3quick' });
  assert.equal(got.values['是否有offer'], false);
  assert.equal(got.values['密码'], 'P@ss-秘密');
  assert.equal(got.fieldTypes['是否有offer'], 'bool');
  assert.equal(got.fieldTypes['密码'], 'secret');

  // 台账（entry fields）含扩展键
  const ledger = await entries.fieldDictionary({ section: 'v3quick' });
  const ledgerKeys = new Set(ledger.sections[0].fields.map((f) => f.key));
  assert.ok(ledgerKeys.has('是否有offer') && ledgerKeys.has('密码'), '扩展行进台账');

  // 密文真的落盘（field_data 里是 JSON 密文对象）
  const { openRaw: open2 } = await import('../../src/core/db/driver.ts');
  const db = open2(store.storePathInUse(), { readOnly: true });
  try {
    const v = db.get(`SELECT fd.value FROM entry_fields ef JOIN field_data fd ON fd.entry_field_id = ef.id
      WHERE ef.entry_id = :e AND ef.key = '密码'`, { e: created.id }).value;
    assert.match(v, /aes-256-gcm/, '密码落盘是密文对象');
  } finally { db.close(); }
});

test('⑤ 完整度按条目自身行：add-field 后 total 不变，sync 后才变', async () => {
  await sections.addSection({
    id: 'v3comp', title: '完整度',
    fields: [{ key: 'a', label: 'A', type: 'text', group: 'g' }, { key: 'b', label: 'B', type: 'text', group: 'g' }],
    groups: [{ id: 'g', title: 'G' }],
  });
  await entries.addEntry({ section: 'v3comp', title: '一条', set: { a: '1' } });

  let got = await entries.getEntry('一条', { section: 'v3comp' });
  assert.equal(got.completeness.total, 2, '两个模板行（source 是 optional 不计）');

  await sections.updateSection('v3comp', { 'add-field': { key: 'c', label: 'C', type: 'text', group: 'g' } });
  got = await entries.getEntry('一条', { section: 'v3comp' });
  assert.equal(got.completeness.total, 2, 'add-field 不动存量条目 → total 不变');

  await sections.syncSection('v3comp');
  got = await entries.getEntry('一条', { section: 'v3comp' });
  assert.equal(got.completeness.total, 3, 'sync 补行后 total 才变');
  assert.ok(got.missing.some((m) => m.key === 'c'));
});

test('⑥ --set 走 service 与直接写 store 等价（行/值/读回一致）', async () => {
  await sections.addSection({
    id: 'v3equiv', title: '等价',
    fields: [{ key: 'a', label: 'A', type: 'text', group: 'g' }],
    groups: [{ id: 'g', title: 'G' }],
  });
  const viaService = await entries.addEntry({ section: 'v3equiv', title: '走服务', set: { a: '1' } });

  // 直接 mutateStore 写同形状条目（面板/导入的旁路写法）
  const { newId, nowIso } = await import('../../src/core/ids.ts');
  const at = nowIso();
  const direct = { id: newId('e'), section: 'v3equiv', title: '直接写', tags: [], values: { a: '2' }, createdAt: at, updatedAt: at };
  await store.mutateStore((s) => { s.entries.push(direct); });

  const st = await store.loadStore();
  const rowsA = store.entryStructures(st).get(viaService.id) || [];
  const rowsB = store.entryStructures(st).get(direct.id) || [];
  assert.deepEqual(rowsA.map((r) => r.key).sort(), rowsB.map((r) => r.key).sort(), '两条目的结构行键集一致');
  assert.ok(rowsA.every((r) => r.templateFieldId != null), '都是模板行');

  const gA = await entries.getEntry('走服务', { section: 'v3equiv' });
  const gB = await entries.getEntry('直接写', { section: 'v3equiv' });
  assert.equal(gA.values.a, '1');
  assert.equal(gB.values.a, '2');
  assert.deepEqual(Object.keys(gA.values).sort(), Object.keys(gB.values).sort(), '读回形状一致');
});
