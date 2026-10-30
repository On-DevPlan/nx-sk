// store 版本 v4：条目多了块正文（entry.body）。
//
// 这里钉的是**兼容方向**，不是实现细节：
//   - 往上涨版本（v3 → v4）是**只加可选键**：老条目没有 body 就是没有，不迁移、不补空数组
//   - 往下降版本（用户拿老代码读新 store）是**破坏性**的：白名单 normalize 会把 body 丢掉
//     → 所以 v4 必须**拒绝老代码写**，否则用户降级跑一次保存一次，块正文就永久没了
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

const dir = await useTempHome('nx-sk-store-version-');

const { loadStore, mutateStore, normalize, STORE_VERSION, diskVersion } = await import('../../src/core/store.js');

test('当前版本是 4', () => {
  assert.equal(STORE_VERSION, 4);
});

test('v3 老 store 读上来：版本落到 4，老条目**没有** body（不凭空补一个空数组）', async () => {
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(dir, 'store.json');
  await fsp.writeFile(p, JSON.stringify({
    version: 3,
    settings: {},
    sections: [{ id: 'demo', title: '字段样例', fields: [], groups: [] }],
    entries: [{ id: 'e_1', section: 'demo', title: '老条目', values: {} }],
    files: [],
  }), 'utf8');

  const s = await loadStore(p);
  assert.equal(s.version, 4);
  assert.equal(s.entries[0].body, undefined, '老条目不该凭空多出 body');
});

test('v4 的 body 读上来还在；非法块在读的时候被丢掉', async () => {
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(dir, 'store.json');
  await fsp.writeFile(p, JSON.stringify({
    version: 4,
    settings: {},
    sections: [{ id: 'demo', title: '字段样例', fields: [], groups: [] }],
    entries: [{
      id: 'e_1', section: 'demo', title: '新条目', values: {},
      body: [
        { id: 'b_1', type: 'paragraph', text: '好' },
        { id: 'b_2', type: 'bogus' },
        { type: 'paragraph', text: '缺 id' },
      ],
    }],
    files: [],
  }), 'utf8');

  const s = await loadStore(p);
  assert.equal(s.version, 4);
  assert.equal(s.entries[0].body.length, 1, '只有合法的块留下');
  assert.equal(s.entries[0].body[0].id, 'b_1');
});

test('降级守卫：磁盘版本比当前新时，**拒绝写入**（BLOCKED），当前数据保持不变', async () => {
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(dir, 'store.json');
  // 假装磁盘上的是更新版本写的（v99）
  await fsp.writeFile(p, JSON.stringify({
    version: 99,
    settings: { marker: 'from-newer-version' },
    sections: [{ id: 'demo', title: '字段样例', fields: [], groups: [] }],
    entries: [{ id: 'e_1', section: 'demo', title: '新版本才有数据', values: {}, body: [{ id: 'b_1', type: 'paragraph', text: '新版本正文' }] }],
    files: [],
  }), 'utf8');

  await loadStore(p);
  assert.equal(diskVersion(), 99, '要记住磁盘版本（normalize 会把它抹成当前版本）');

  await assert.rejects(
    () => mutateStore((x) => { x.settings.touched = true; }, p),
    (e) => e.code === 'BLOCKED' && /99/.test(e.message),
    '写入必须被拒：老代码的白名单 normalize 会把新版本才有的键静默丢掉',
  );

  const onDisk = JSON.parse(await fsp.readFile(p, 'utf8'));
  assert.equal(onDisk.version, 99, '磁盘内容一个字节都不能变');
  assert.equal(onDisk.entries[0].body[0].text, '新版本正文', '新版本的块正文还在');
});

test('降级守卫解除后恢复正常写入', async () => {
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(dir, 'store.json');
  await fsp.writeFile(p, JSON.stringify({
    version: 4, settings: {}, sections: [], entries: [], files: [],
  }), 'utf8');
  await loadStore(p);
  await mutateStore((x) => { x.settings.ok = true; }, p);
  const onDisk = JSON.parse(await fsp.readFile(p, 'utf8'));
  assert.equal(onDisk.settings.ok, true);
});

test('normalize 不动 body 以外的东西（老字段照旧）', () => {
  const s = normalize({
    version: 4,
    settings: { defaultSection: 'demo' },
    sections: [{ id: 'demo', title: 'x', fields: [], groups: [] }],
    entries: [{ id: 'e_1', section: 'demo', title: 'T', values: { a: 1 }, body: [{ id: 'b_1', type: 'paragraph', text: 'x' }] }],
  });
  assert.equal(s.entries[0].values.a, 1);
  assert.equal(s.entries[0].body[0].text, 'x');
  assert.equal(s.settings.defaultSection, 'demo');
});
