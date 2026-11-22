// 默认条目（任务 #63）：settings.defaultEntry + entryScopeLimit + `status` 上下文 + desc。
//
// 钉住三件事：
//   ① 「省略 <ref> = 默认条目」只发生在读 / 改内容的命令上，删除类动作必须显式给 id
//      （一次手滑不该删掉默认条目整棵子树）；
//   ② status 的条目按**广度优先**截断（先带全直接子条目，再往孙条目走），
//      且「共 N 条 / 本次 M 条」的口径来自设置而不是硬编码；
//   ③ desc 是条目属性（entries.description），不是字段——写进去、读出来、被 status 带出去。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-status-');

const store = await import('../../src/core/store.ts');
const entries = await import('../../src/modules/entries/service.ts');
const settings = await import('../../src/modules/settings/service.ts');
const system = await import('../../src/modules/system/service.ts');
const { defaultEntryOf, scopeLimitOf } = await import('../../src/core/default-entry.ts');

const root = await entries.addEntry({ title: '工作', desc: '长期工作的根' });
const a = await entries.addEntry({ title: '子A', parent: root.id, desc: '子条目 A' });
const b = await entries.addEntry({ title: '子B', parent: root.id, desc: '子条目 B' });
const c = await entries.addEntry({ title: '孙C', parent: a.id, desc: '孙条目 C' });

test('默认设置：defaultEntry 为空、entryScopeLimit = 5；老 store 读一次自动补上', async () => {
  assert.equal(store.defaultSettings().defaultEntry, '');
  assert.equal(store.defaultSettings().entryScopeLimit, 5);
  const s = await store.loadStore();
  assert.equal(s.settings.defaultEntry, '');
  assert.equal(s.settings.entryScopeLimit, 5);
  assert.equal(scopeLimitOf(s), 5);
});

test('desc 往返：add / load / get / update / 清空，且不进字段（完整度与 values 都不受影响）', async () => {
  const s = await store.loadStore();
  const row = s.entries.find((e) => e.id === root.id);
  assert.equal(row.desc, '长期工作的根', 'desc 落在 entries.description');

  const got = await entries.getEntry(root.id);
  assert.equal(got.desc, '长期工作的根');
  assert.equal(got.values.desc, undefined, 'desc 不是字段值');
  assert.equal(got.completeness.total, 0, 'desc 不进完整度');

  const upd = await entries.updateEntry(root.id, { desc: '改过的说明' });
  assert.equal(upd.desc, '改过的说明');
  assert.equal((await entries.getEntry(root.id)).desc, '改过的说明');

  await entries.updateEntry(root.id, { desc: '' });
  assert.equal((await entries.getEntry(root.id)).desc, '', '空串 = 清空');

  const list = await entries.listEntries({});
  const item = list.entries.find((e) => e.id === root.id);
  assert.ok(item && 'desc' in item, 'entry list 也要带 desc');
});

test('未设默认条目：status 不抛错，给出候选与设置指引', async () => {
  const st = await system.statusInfo();
  assert.equal(st.status, 'ok');
  assert.equal(st.defaultEntry, null);
  assert.equal(st.scope.root, 'root');
  assert.match(st.prompt, /未设置/);
  assert.match(st.prompt, /defaultEntry=/);
  assert.ok(st.entries.length >= 1, '未设默认条目时给出根条目候选');
  assert.equal(st.entries[0].depth, 0);
});

test('设置默认条目：标题归一成 id；不存在的条目 / 歧义标题拒绝落盘', async () => {
  const r = await settings.updateSettings({ set: { defaultEntry: '工作' } });
  assert.equal(r.set.defaultEntry, root.id, '写标题也认，存 id');

  await assert.rejects(
    settings.updateSettings({ set: { defaultEntry: '不存在的条目' } }),
    (e) => e.code === 'INVALID_INPUT' && /默认条目不存在/.test(e.message),
  );
});

test('entryScopeLimit：1–50，CLI 字符串写法也认', async () => {
  const r = await settings.updateSettings({ key: 'entryScopeLimit', value: '3' });
  assert.equal(r.set.entryScopeLimit, 3);
  await assert.rejects(
    settings.updateSettings({ set: { entryScopeLimit: 0 } }),
    (e) => e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    settings.updateSettings({ set: { entryScopeLimit: 51 } }),
    (e) => e.code === 'INVALID_INPUT',
  );
  const s = await store.loadStore();
  assert.equal(scopeLimitOf(s), 3);
  assert.equal(scopeLimitOf(s, 1), 1, '单次 --limit 覆盖设置');
  assert.equal(scopeLimitOf(s, 999), 50, '覆盖值也夹在上限内');
});

test('status 默认条目上下文：默认条目 + 广度优先子条目，按设置截断并说明还剩多少', async () => {
  const st = await system.statusInfo();
  assert.equal(st.defaultEntry.id, root.id);
  assert.equal(st.scope.root, 'default');
  assert.equal(st.scope.limit, 3);
  assert.equal(st.scope.count, 3);
  assert.equal(st.scope.total, 4, '整棵子树 4 条（含默认条目自身）');
  assert.equal(st.scope.truncated, true);
  assert.deepEqual(st.entries.map((e) => e.id), [root.id, a.id, b.id], '广度优先：直接子条目先于孙条目');
  assert.deepEqual(st.entries.map((e) => e.depth), [0, 1, 1]);
  assert.equal(st.entries[0].isDefault, true);
  assert.equal(st.entries[1].isDefault, false);

  // 提示词就是交付正文：默认条目标题/说明、截断说明、条数上限都要在里面
  assert.match(st.prompt, /工作/);
  assert.match(st.prompt, /长期工作的根|改过的说明|（未写说明）/);
  assert.match(st.prompt, /最多 3 条/);
  assert.match(st.prompt, /还有 1 条没带出来/);

  const wider = await system.statusInfo({ limit: 10 });
  assert.equal(wider.scope.count, 4);
  assert.equal(wider.scope.truncated, false);
  assert.ok(wider.entries.some((e) => e.id === c.id), '放大上限后孙条目也进来');
});

test('省略 <ref> 的命令用默认条目；删除类动作仍然要求显式 id', async () => {
  const got = await entries.getEntry(undefined);
  assert.equal(got.id, root.id);

  // 改内容：省略 ref 落到默认条目
  await entries.updateEntry(undefined, { desc: '从默认条目写进去的' });
  assert.equal((await entries.getEntry(root.id)).desc, '从默认条目写进去的');

  // 破坏性动作：ref 为空不该被解析成默认条目（CLI 的 ref 也仍是必填）
  await assert.rejects(
    () => entries.removeEntry(undefined),
    (e) => e.code === 'INVALID_INPUT' && /缺少条目定位/.test(e.message),
  );
  const s = await store.loadStore();
  assert.ok(s.entries.some((e) => e.id === root.id), '默认条目不能被误删');
});

test('默认条目被删：status 仍然可用，并明确指出设置已失效', async () => {
  await entries.removeEntry(a.id); // 连带孙C
  await entries.removeEntry(root.id);
  const s = await store.loadStore();
  assert.equal(defaultEntryOf(s), null);
  assert.equal(s.settings.defaultEntry, root.id, '设置保留原值（由人决定改成什么，不静默改）');

  const st = await system.statusInfo();
  assert.equal(st.defaultEntry, null);
  assert.match(st.prompt, /默认条目不在了/);
  assert.match(st.prompt, new RegExp(root.id));
});
