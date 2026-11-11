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

test('版本落后升级：migrate/ 里先留 pre-vX-to-vY 快照，数据完好', async () => {
  // ① homeA：正常首启（建库 + 播种）
  const homeA = await freshHome('nx-sk-upg-a-');
  const s1 = await loadStore();
  assert.equal(s1.sections.length, 1, '播种应有 demo 栏目');

  // ② checkpoint 后把库搬到 homeB，并把 schema_version 改回 0（模拟旧版库）
  {
    const ck = new DatabaseSync(join(homeA, 'nxsk.db'));
    ck.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    ck.close();
  }
  const homeB = await mkdtemp(join(tmpdir(), 'nx-sk-upg-b-'));
  await copyDb(join(homeA, 'nxsk.db'), join(homeB, 'nxsk.db'));
  {
    const tweak = new DatabaseSync(join(homeB, 'nxsk.db'));
    tweak.prepare("UPDATE meta SET value='0' WHERE key='schema_version'").run();
    tweak.close();
  }
  process.env.NX_SK_HOME = homeB;
  process.env.NX_SK_STORE = join(homeB, 'store.json');
  process.env.NX_SK_STORE_DB = join(homeB, 'nxsk.db');

  // ③ 打开：v0 < CURRENT → 必须先快照再升级；升级后数据原样
  const s2 = await loadStore();
  assert.equal(s2.sections.length, 1, '升级后数据仍在');
  const snaps = (await fsp.readdir(join(homeB, 'migrate'))).filter((f) => /-pre-v0-to-v\d+\.db$/.test(f));
  assert.equal(snaps.length, 1, `migrate/ 应有一份升级前快照：${snaps.join(', ')}`);

  // ④ 快照本身是可退回的完整库
  const probe = new DatabaseSync(join(homeB, 'migrate', snaps[0]), { readOnly: true });
  assert.equal(probe.prepare('SELECT COUNT(*) c FROM sections').get().c, 1, '快照里应有升级前的 sections');
  assert.equal(probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '0', '快照停在升级前版本');
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
