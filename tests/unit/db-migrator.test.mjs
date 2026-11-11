// 迁移 runner：版本号单向组合、每步一个事务、失败回滚、缺边明确报错。
// （机制钉的是 nx-kv 同款的「加 v2 只追加脚本、不改旧脚本」的地基。）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-dbmig-');

const { openRaw } = await import('../../src/core/db/driver.ts');
const { migrate, schemaVersion, countTables, getMeta, userVersion } = await import('../../src/core/db/migrator.ts');
const { planMigrationPath, DIRECT_EDGES } = await import('../../src/core/db/migrations/index.ts');
const { CURRENT_SCHEMA_VERSION } = await import('../../src/core/db/version.ts');
const { tx } = await import('../../src/core/db/tx.ts');

test('空库 → 当前版本：建齐表并走完 v1+v2，版本写进 meta.schema_version 与 PRAGMA user_version', () => {
  const db = openRaw(':memory:');
  assert.equal(countTables(db), 0);
  const applied = migrate(db, { from: 0 });
  assert.deepEqual(applied, [1, 2]);
  assert.equal(schemaVersion(db), CURRENT_SCHEMA_VERSION);
  assert.equal(userVersion(db), CURRENT_SCHEMA_VERSION);
  assert.equal(getMeta(db, 'schema_version'), String(CURRENT_SCHEMA_VERSION));
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['meta', 'settings', 'ui_state', 'sections', 'groups', 'fields', 'entries',
    'attachments', 'entry_attach']) {
    assert.ok(names.includes(t), `缺表 ${t}`);
  }
  // v2 裁决：结构级边表必须已退役，role=source 必须被 CHECK 拒绝
  for (const gone of ['section_attach', 'field_attach']) {
    assert.ok(!names.includes(gone), `${gone} 应已被 v2 删除`);
  }
  db.exec("INSERT INTO sections (id, title, description, \"order\", kv, title_label, created_at, updated_at) VALUES ('s','S','',50,0,'名称','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  db.exec("INSERT INTO entries (id, section_id, title, tags, \"values\", created_at, updated_at) VALUES ('e1','s','t','[]','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  db.exec("INSERT INTO attachments (id, kind, name, created_at, updated_at) VALUES ('f_x','file','x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  assert.throws(() => db.exec("INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at) VALUES ('e1','f_x','x','source',0,'','2026-01-01T00:00:00.000Z')"), /CHECK/, 'role=source 必须被 CHECK 拒绝');
  db.exec("INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at) VALUES ('e1','f_x','x','attach',0,'','2026-01-01T00:00:00.000Z')");
  db.close();
});

test('migrate 幂等：已到当前版本的库重跑等于空转', () => {
  const db = openRaw(':memory:');
  migrate(db, { from: 0 });
  assert.deepEqual(migrate(db), [], '第二次不该再执行任何步骤');
  assert.equal(schemaVersion(db), CURRENT_SCHEMA_VERSION);
  assert.equal(countTables(db), 9);
  db.close();
});

test('坏脚本回滚：一步中途失败整步撤销，库停在上一版可用状态', () => {
  const db = openRaw(':memory:');
  // 造一份「错形状」的 meta（缺 value/updated_at 列）：v1.sql 的 IF NOT EXISTS 会跳过它，
  // 随后步骤里的 setMeta 写入失败 → 整步必须回滚，不能留下「半套 v1」。
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY)');
  assert.throws(() => migrate(db, { from: 0 }));
  assert.equal(schemaVersion(db), 0, '版本不能漂');
  assert.equal(userVersion(db), 0);
  const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  assert.deepEqual(names, ['meta'], 'v1.sql 建的其它表必须随步骤一起回滚');
  db.close();
});

test('缺边与降级：明确报错，不静默跳过、不回写旧结构', () => {
  assert.throws(() => planMigrationPath(0, 99), /缺少迁移边/);
  assert.throws(() => planMigrationPath(2, 1), /不支持降级/);
  // 直接边必须从 0 连到 CURRENT（断链的话首启库永远建不出来，这里提前红）
  let cur = 0;
  for (const e of [...DIRECT_EDGES].sort((a, b) => a.to - b.to)) {
    assert.equal(e.from, cur, `直接边不连续：期望 from=${cur}`);
    cur = e.to;
  }
  assert.equal(cur, CURRENT_SCHEMA_VERSION);
});

test('tx 堵死 async 事务体：返回 Promise 立即抛 TypeError，且不留半成品写入', () => {
  const db = openRaw(':memory:');
  migrate(db, { from: 0 });
  assert.throws(() => tx(async () => { db.exec('CREATE TABLE bad(x)'); }, { db }), TypeError);
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'bad'"), null, '回滚必须带走事务体内的写');
  db.close();
});
