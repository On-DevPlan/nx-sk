// attachments 对齐 nx-kv v2 的三条纪律：身份规则收敛、删除钩子软删、漂移可检。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-att-');

const store = await import('../../src/core/store.ts');
const identity = await import('../../src/core/db/identity.ts');
const { openRaw } = await import('../../src/core/db/driver.ts');
const { findDriftedPointers } = await import('../../src/core/db/repo.ts');
const { readMigrationSql } = await import('../../src/core/db/migrations/index.ts');
const { FIELD_TYPES } = await import('../../src/shared/fields/types.ts');

// 先触发 bootstrap（建库 + 播种 demo），后面的裸 SQL 用例才有表可写。
await store.loadStore();

const dbFile = () => store.storePathInUse();
const withDb = (fn) => {
  const db = openRaw(dbFile());
  try { return fn(db); } finally { db.close(); }
};

test('身份规则：url 大小写不敏感、内部指针 id 确定性、前缀与长度形状', () => {
  assert.match(identity.attIdForUrl('https://x.dev/a'), /^att_url_[0-9a-f]{16}$/);
  assert.equal(identity.attIdForUrl('HTTPS://X.dev/a'), identity.attIdForUrl('https://x.dev/a'), '小写归一');
  assert.equal(identity.attIdForSection('demo'), identity.attIdForSection('demo'));
  assert.match(identity.attIdForEntry('e_1'), /^att_entry_[0-9a-f]{16}$/);
  // v3：条目结构行 / 值行都是确定性派生；field 指针挂在结构行 id 上
  assert.match(identity.entryFieldId('e_1', 'att'), /^ef_[0-9a-f]{16}$/);
  assert.equal(identity.entryFieldId('e_1', 'att'), identity.entryFieldId('e_1', 'att'), '同一 (条目,键) 永远同一行');
  assert.match(identity.fieldDataId(identity.entryFieldId('e_1', 'att')), /^d_[0-9a-f]{16}$/);
  const ef = identity.entryFieldId('e_1', 'att');
  assert.match(identity.attIdForField(ef), /^att_field_[0-9a-f]{16}$/);
  assert.equal(identity.fieldTargetKey('demo', 'att'), 'demo:att', 'template_field_id 的复合串口径');
  const p = identity.pointerIdentity('field', { entryFieldId: ef });
  assert.deepEqual(p, { id: identity.attIdForField(ef), targetKind: 'field', targetKey: ef });
  assert.throws(() => identity.pointerIdentity('file', {}), /只认内部种类/);
});

test('v1.sql 的 type CHECK 钉住 v1 时代清单（历史快照永不改）；v4 起新表不再有 type CHECK', () => {
  const sql = readMigrationSql('v1.sql');
  const m = /type\s+TEXT NOT NULL CHECK \(type IN \(([^)]*)\)\)/is.exec(sql.replace(/\s+/g, ' '));
  assert.ok(m, 'v1.sql 里找不到 fields.type 的 CHECK 清单');
  const listed = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  // v4 裁决：类型清单的唯一权威是 shared/fields/types.ts 的 FIELD_TYPES（运行时判），
  // v1.sql 里的 CHECK 只是**历史快照**——它必须等于 v1 时代的 15 种，且不含后加的类型。
  assert.ok(listed.length === 15 && !listed.includes('debug'), `v1 清单应钉在 15 种（实际 ${listed.length}）`);
  assert.deepEqual(listed, [...listed].sort((a, b) => FIELD_TYPES.indexOf(a) - FIELD_TYPES.indexOf(b)), 'v1 清单必须是 FIELD_TYPES 的前缀');
  for (const f of ['v4.sql']) {
    const v4 = readMigrationSql(f);
    assert.ok(!/CHECK\s*\(\s*type\s+IN/i.test(v4), `${f} 不该再抄 type 枚举`);
  }
  // kinds 清单同理（附件 kind 仍被 CHECK 钉着——它不是这次裁决的对象）
  const k = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/is.exec(sql.replace(/\s+/g, ' '));
  const kinds = k[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(kinds, [...identity.ATTACHMENT_KINDS]);
});

test('v4：未知类型不再被 DB 拒绝，但运行时 validateFieldDef 在写入点当场报错', async () => {
  const { validateFieldDef } = await import('../../src/modules/sections/service.ts');
  // DB 层：v4 起 fields/entry_fields 没有 type CHECK，裸 SQL 写未知类型能落进去
  //（这正是「加类型不改库」的含义；清理掉，别毒化后面的用例）
  withDb((db) => {
    db.run("INSERT INTO fields (section_id, key, type, spec) VALUES ('demo', 'bad', 'no_such_type', '{}')");
    db.run("DELETE FROM fields WHERE section_id = 'demo' AND key = 'bad'");
  });
  // 运行时层：唯一清单 FIELD_TYPES 仍是关卡——未知类型在写入点报错，不静默
  assert.throws(() => validateFieldDef({ key: 'bad', type: 'no_such_type' }), /type 非法/);
  // debug 是新加的第一种类型：定义合法、行为分派到位（不再需要 schema 迁移）
  const def = validateFieldDef({ key: 'refs', type: 'debug', label: '引用' });
  assert.equal(def.type, 'debug');
});

test('删除钩子：删栏目/条目后，指向它们的内部指针行被软删（deleted_at），行还在', async () => {
  await store.mutateStore((s) => {
    s.sections.push({ id: 'tmpsec', title: '临时', description: '', order: 90, template: null, kv: false,
      titleField: null, titleLabel: '名称', groups: [], fields: [], layout: null, createdAt: null, updatedAt: null });
    s.entries.push({ id: 'tmpentry', section: 'tmpsec', title: 'T', tags: [], values: {}, createdAt: null, updatedAt: null });
  });
  // 手工登记两个内部指针（未来的显式挂载命令会做同样的事）
  const secPtr = identity.attIdForSection('tmpsec');
  const entPtr = identity.attIdForEntry('tmpentry');
  withDb((db) => {
    for (const [id, kind, target] of [[secPtr, 'section', 'tmpsec'], [entPtr, 'entry', 'tmpentry']]) {
      db.run(`INSERT INTO attachments (id, kind, target_kind, target_key, created_at, updated_at)
              VALUES (:id, :kind, :kind, :target, :at, :at)`,
        { id, kind, target, at: new Date().toISOString() });
    }
  });

  await store.mutateStore((s) => {
    s.sections = s.sections.filter((x) => x.id !== 'tmpsec');
    s.entries = s.entries.filter((e) => e.section !== 'tmpsec');
  });

  const rows = withDb((db) => db.all('SELECT id, deleted_at FROM attachments WHERE id IN (:a, :b)', { a: secPtr, b: entPtr }));
  assert.equal(rows.length, 2, '指针行**不能物理删**（软删留证）');
  for (const r of rows) assert.ok(r.deleted_at, `指向已删资源的指针应被软删：${r.id}`);
  assert.deepEqual(withDb((db) => findDriftedPointers(db)), [], '删除钩子跑过后不该再有漂移');
});

test('一致性检查：绕过 facade 直接删行 → findDriftedPointers 报漂移', async () => {
  const ptr = identity.attIdForSection('ghostsec');
  withDb((db) => {
    db.run(`INSERT INTO attachments (id, kind, target_kind, target_key, created_at, updated_at)
            VALUES (:id, 'section', 'section', 'ghostsec', :at, :at)`,
      { id: ptr, at: new Date().toISOString() });
  });
  const drift = withDb((db) => findDriftedPointers(db));
  assert.ok(drift.some((r) => r.id === ptr), '指向不存在栏目的活指针必须被报出来');
  // 清理：软删掉，别毒化后续用例
  withDb((db) => db.run('UPDATE attachments SET deleted_at = :at WHERE id = :id', { id: ptr, at: new Date().toISOString() }));
  assert.deepEqual(withDb((db) => findDriftedPointers(db)), []);
});

test('FileRecord → kind=file 行：id 原样、列镜像与 meta 保真源一致', async () => {
  await store.mutateStore((s) => {
    s.files.push({ id: 'f_map', category: 'document', name: 'm.pdf', rel: 'document/m.pdf',
      originalName: 'm.pdf', ext: '.pdf', bytes: 7, sha256: 'sha-map', sourcePath: '', mode: 'copy',
      tags: [], note: '', createdAt: null, updatedAt: null });
  });
  const row = withDb((db) => db.get("SELECT * FROM attachments WHERE id = 'f_map'"));
  assert.equal(row.kind, 'file');
  assert.equal(row.local_path, 'document/m.pdf');
  assert.equal(row.size, 7);
  assert.equal(row.hash, 'sha-map');
  assert.equal(row.storage, 'local');
  assert.equal(row.mime, 'application/pdf', 'mime 列按 ext 推导（查询便利，真相在 meta）');
  assert.equal(row.dedupe_key, 'sha-map');
  const meta = JSON.parse(row.meta);
  assert.equal(meta.id, 'f_map');
  assert.equal(meta.mode, 'copy');
});

test('dedupe 唯一部分索引：同 dedupe_key 的活行只能有一条，软删后可重新登记', () => {
  withDb((db) => {
    const at = new Date().toISOString();
    db.run(`INSERT INTO attachments (id, kind, url, dedupe_key, created_at, updated_at)
            VALUES ('att_url_probe', 'url', 'https://x/1', 'https://x/1', :at, :at)`, { at });
    assert.throws(() => db.run(
      `INSERT INTO attachments (id, kind, url, dedupe_key, created_at, updated_at)
       VALUES ('att_url_probe2', 'url', 'https://x/1', 'https://x/1', :at, :at)`, { at }),
    /唯一约束|UNIQUE|constraint/);
    // 软删第一行 → 同键可再登记（dedupe 只管「活着的同一资源」）
    db.run('UPDATE attachments SET deleted_at = :at WHERE id = :id', { at, id: 'att_url_probe' });
    db.run(`INSERT INTO attachments (id, kind, url, dedupe_key, created_at, updated_at)
            VALUES ('att_url_probe2', 'url', 'https://x/1', 'https://x/1', :at, :at)`, { at });
    db.run("DELETE FROM attachments WHERE id IN ('att_url_probe', 'att_url_probe2')");
  });
});
