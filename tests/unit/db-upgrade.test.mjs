// 升级/导入前的库快照备份：任何「往既有库里写结构」的路径都必须先在 migrate/ 留一份可退回的库。
// 触发方式：把已建好的库复制到新 home、把 schema_version 改回 0（模拟旧版库），再走 facade。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function freshHome(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  process.env.NX_SK_HOME = dir;
  process.env.NX_SK_STORE = join(dir, 'store.json');
  process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');
  return dir;
}

const { loadStore } = await import('../../src/core/store.ts');

/** 把 src 目录的库三件套复制到 dst home（跳过不存在）。 */
async function copyDb(src, dst) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { await fsp.copyFile(src + suffix, dst + suffix); } catch { /* 附属文件可能已被 checkpoint 清掉 */ }
  }
}

test('版本落后升级：真 v2 库一路升到当前版（v5），migrate/ 里先留 pre-v2-to-v5 快照，数据完好', async () => {
  const { CURRENT_SCHEMA_VERSION } = await import('../../src/core/db/version.ts');
  // v3 起 entries 没有 values 列、边表挂 entry_field_id——「把 v3 库的版本号改回 0」
  // 不再等于「模拟旧版库」（v3.sql 的 ALTER/CREATE 会在已升级的库上炸）。
  // 所以这里用裸 SQL 造一份**真正的 v2 库**（migrate to:2 + 手写 v2 形状的行），
  // 再交给 facade 升级——钉的就是升级链本身。
  const { openRaw } = await import('../../src/core/db/driver.ts');
  const { migrate, setMeta } = await import('../../src/core/db/migrator.ts');
  const homeB = await mkdtemp(join(tmpdir(), 'nx-sk-upg-v3-'));
  const dbPath = join(homeB, 'nxsk.db');
  {
    const db = openRaw(dbPath);
    migrate(db, { to: 2 });
    setMeta(db, 'store_kind', 'sqlite');
    setMeta(db, 'schema_version', '2');
    setMeta(db, 'created_by', 'nx-sk/test-v2');
    db.run('INSERT INTO sections (id, title, description, "order", kv, title_label, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['s', 'S', '', 50, 0, '名称', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    db.run("INSERT INTO fields (section_id, key, label, type, sort, spec) VALUES ('s', 'a', 'A', 'text', 0, '{\"key\":\"a\",\"label\":\"A\",\"type\":\"text\"}')");
    db.run("INSERT INTO fields (section_id, key, label, type, sort, spec) VALUES ('s', 'b', 'B', 'text', 1, '{\"key\":\"b\",\"label\":\"B\",\"type\":\"text\"}')");
    db.run(`INSERT INTO entries (id, section_id, title, tags, "values", created_at, updated_at)
      VALUES ('e1', 's', 'T', '[]', '{"a":"1","ghost":"2"}', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`);
    db.close();
  }
  process.env.NX_SK_HOME = homeB;
  process.env.NX_SK_STORE = join(homeB, 'store.json');
  process.env.NX_SK_STORE_DB = join(homeB, 'nxsk.db');

  // 打开：v2 < CURRENT → 必须先快照再升级；升级后数据原样（含字典外的 ghost 键）
  const s2 = await loadStore();
  assert.equal(s2.sections.length, 1, '升级后数据仍在');
  assert.equal(s2.entries[0].values.a, '1');
  assert.equal(s2.entries[0].values.ghost, '2', '不在字典的键要落成扩展行并原样读回');
  const snaps = (await fsp.readdir(join(homeB, 'migrate'))).filter((f) => new RegExp(`-pre-v2-to-v${CURRENT_SCHEMA_VERSION}\\.db$`).test(f));
  assert.equal(snaps.length, 1, `migrate/ 应有一份升级前快照：${snaps.join(', ')}`);

  // 快照本身是可退回的完整 v2 库（values 列还在）
  const probe = new DatabaseSync(join(homeB, 'migrate', snaps[0]), { readOnly: true });
  assert.equal(probe.prepare('SELECT COUNT(*) c FROM sections').get().c, 1, '快照里应有升级前的 sections');
  assert.deepEqual(JSON.parse(probe.prepare(`SELECT "values" v FROM entries WHERE id='e1'`).get().v), { a: '1', ghost: '2' }, '快照停在升级前的 v2 形状');
  assert.equal(probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2', '快照停在升级前版本');
  probe.close();
});

test('既有库补导入（崩溃恢复窗口）：导入前同样先留 pre-import-json 快照', async () => {
  // ① homeA：建库播种（无 json，不写 imported 标记）
  const homeA = await freshHome('nx-sk-upg-seed-');
  await loadStore();
  {
    const ck = new DatabaseSync(join(homeA, 'nxsk.db'));
    ck.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    ck.close();
  }

  // ② 搬到 homeC，并放一份 store.json：模拟「库建好了、json 还没导入就崩了」
  const homeC = await mkdtemp(join(tmpdir(), 'nx-sk-upg-c-'));
  await copyDb(join(homeA, 'nxsk.db'), join(homeC, 'nxsk.db'));
  const legacy = {
    version: 3,
    settings: { defaultSection: 'imp', navGroups: [] },
    sections: [{ id: 'imp', title: '补导入', description: '', order: 10, template: null, kv: false,
      titleField: null, titleLabel: '名称',
      groups: [{ id: 'g1', title: '基本' }],
      fields: [{ key: 'a', label: 'A', type: 'text', group: 'g1' }] }],
    entries: [{ id: 'e_imp', section: 'imp', title: 'T', tags: [], values: { a: '1' } }],
    files: [],
  };
  await fsp.writeFile(join(homeC, 'store.json'), JSON.stringify(legacy), 'utf8');
  process.env.NX_SK_HOME = homeC;
  process.env.NX_SK_STORE = join(homeC, 'store.json');
  process.env.NX_SK_STORE_DB = join(homeC, 'nxsk.db');

  // ③ 打开：情况 D 触发导入 → 先快照
  const s = await loadStore();
  assert.ok(s.sections.some((x) => x.id === 'imp'), 'json 数据应被导入');
  const snaps = (await fsp.readdir(join(homeC, 'migrate'))).filter((f) => /-pre-import-json\.db$/.test(f));
  assert.equal(snaps.length, 1, `导入前应有库快照：${snaps.join(', ')}`);
  const probe = new DatabaseSync(join(homeC, 'migrate', snaps[0]), { readOnly: true });
  assert.equal(probe.prepare("SELECT COUNT(*) c FROM sections WHERE id='imp'").get().c, 0, '快照里还没有 json 数据（是导入前的状态）');
  probe.close();
});
