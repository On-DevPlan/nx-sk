// 首启导入：db 不存在时 store.json「有 version / 没 version / 根本没有」三分支，
// 以及 corrupt 降级与失败回滚（store.json 一字节不动）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每条用例切一个全新临时 home：facade 按 dbFile() 路径变化自动重开（bootstrap 幂等）。
async function freshHome(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  process.env.NX_SK_HOME = dir;
  process.env.NX_SK_STORE = join(dir, 'store.json');
  process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');
  return dir;
}

const { loadStore, corruptNote, migrationNote } = await import('../../src/core/store.ts');

async function listDir(dir) { return (await fsp.readdir(dir)).sort(); }
const hasImported = (files) => files.filter((f) => f.startsWith('store.json.imported-'));

test('带 version 的 store.json：导入 + 改名留证，无数据迁移记录', async () => {
  const dir = await freshHome('nx-sk-imp-v3-');
  const legacy = {
    version: 3,
    settings: { defaultSection: 'demo', navGroups: [] },
    sections: [{ id: 'demo', title: 'D', description: '', order: 10, template: null, kv: false,
      titleField: 'a', titleLabel: '名称',
      groups: [{ id: 'main', title: '基本' }],
      fields: [{ key: 'a', label: 'A', type: 'text', group: 'main' }] }],
    entries: [{ id: 'e1', section: 'demo', title: 'T', tags: [], values: { a: '1' } }],
    files: [],
  };
  await fsp.writeFile(process.env.NX_SK_STORE, JSON.stringify(legacy), 'utf8');

  const store = await loadStore();
  assert.equal(store.sections.length, 1);
  assert.equal(store.entries[0].values.a, '1');
  assert.equal(store.sections[0].fields.some((f) => f.key === 'source'), true, '读边界仍会补 source 袋');

  const files = await listDir(dir);
  assert.ok(!files.includes('store.json'), 'store.json 应从原位置挪走');
  assert.equal(hasImported(files).length, 1, `应留一份 imported 证据：${files.join(', ')}`);
  assert.equal(migrationNote(), null, 'v3 数据没有形状迁移，不该出迁移记录');
  assert.equal(corruptNote(), null);

  // 第二次读：走 DB，不再导入、不再多留证据
  await loadStore();
  assert.equal(hasImported(await listDir(dir)).length, 1, '重复读不该再导入一次');
});

test('不带 version 的 store.json：按 v1 处理，过 normalize 迁移并留 from→to 记录', async () => {
  const dir = await freshHome('nx-sk-imp-v0-');
  // 旧「密钥」栏目：8 字段模板形状（v1→v2 的迁移对象）
  const legacy = {
    settings: {},
    sections: [{
      id: 'secret', title: '密钥', description: 'old', order: 20, template: 'secret',
      titleField: 'provider', titleLabel: '密钥名',
      groups: [{ id: 'key', title: '密钥信息' }],
      fields: [
        { key: 'provider', label: '服务商', type: 'select', group: 'key' },
        { key: 'keyValue', label: '密钥值', type: 'secret', group: 'key' },
      ],
    }],
    entries: [{ id: 'e_old', section: 'secret', title: 'OpenAI', tags: [], values: { provider: 'OpenAI', keyValue: 'sk-old' } }],
    files: [],
  };
  await fsp.writeFile(process.env.NX_SK_STORE, JSON.stringify(legacy), 'utf8');

  const store = await loadStore();
  const sec = store.sections.find((x) => x.id === 'secret');
  assert.deepEqual(sec.fields.map((f) => f.key).filter((k) => k !== 'source'), ['value'], '旧字典应被搬成单字段 KV');
  assert.equal(store.entries[0].values.value, 'sk-old');

  const note = migrationNote();
  assert.ok(note && note.from === 1 && note.to === 3, '没有 version 就当 v1 迁：from→to 都要有');
  const files = await listDir(dir);
  const ev = hasImported(files);
  assert.equal(ev.length, 1);
  assert.equal(note.snapshotRaw, join(dir, ev[0]));
  assert.equal(JSON.parse(await fsp.readFile(note.snapshotRaw, 'utf8')).settings !== undefined, true,
    '留证文件必须是迁移前的原始 JSON');
});

test('没有 store.json：建库 + 播种（demo 栏目 + 示例条目），不留 imported 证据', async () => {
  const dir = await freshHome('nx-sk-imp-seed-');
  const store = await loadStore();
  assert.deepEqual(store.sections.map((s) => s.id), ['demo']);
  assert.equal(store.entries.length, 1);
  const files = await listDir(dir);
  assert.ok(files.includes('nxsk.db'), '播种必须落盘（id 跨读取稳定）');
  assert.equal(hasImported(files).length, 0);
});

test('损坏的 store.json：挪走留证（.corrupt-）后播种，而不是被下次写入覆盖', async () => {
  const dir = await freshHome('nx-sk-imp-corrupt-');
  await fsp.writeFile(process.env.NX_SK_STORE, '{ 这不是合法 JSON', 'utf8');
  const store = await loadStore();
  assert.equal(store.entries.length, 1, '恢复 = 重新播种');
  const files = await listDir(dir);
  assert.ok(files.some((f) => f.includes('.corrupt-')), `损坏文件应被保留一份：${files.join(', ')}`);
  assert.ok(!files.includes('store.json'));
  assert.ok(corruptNote(), 'corruptNote 要能展示');
});

test('导入失败（孤儿条目）：整体回滚，store.json 一字节不动、半成品库不留下', async () => {
  const dir = await freshHome('nx-sk-imp-fail-');
  const legacy = {
    version: 3, settings: {},
    sections: [{ id: 'demo', title: 'D', groups: [], fields: [] }],
    entries: [{ id: 'e_ghost', section: 'no_such', title: 'G', tags: [], values: {} }],
    files: [],
  };
  const raw = JSON.stringify(legacy, null, 2);
  await fsp.writeFile(process.env.NX_SK_STORE, raw, 'utf8');

  await assert.rejects(() => loadStore(), (e) => /指向不存在的栏目/.test(e.message));
  assert.equal(await fsp.readFile(process.env.NX_SK_STORE, 'utf8'), raw, '失败时 JSON 必须原样');
  const files = await listDir(dir);
  assert.ok(!files.includes('nxsk.db'), `半成品库必须被清掉：${files.join(', ')}`);
  assert.equal(hasImported(files).length, 0);

  // 修好后重试：同一目录、同一 store.json 能正常导入（回滚没留下任何毒）
  const fixed = JSON.parse(raw);
  fixed.entries[0].section = 'demo';
  await fsp.writeFile(process.env.NX_SK_STORE, JSON.stringify(fixed), 'utf8');
  const store = await loadStore();
  assert.equal(store.entries.length, 1);
});
