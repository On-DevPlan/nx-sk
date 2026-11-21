// 条目模板树 + 批量删除：面板「条目模板管理」的后端。
//
// 这里钉的是**批量语义**（单个删除的行为在 templates/entries 各自的测试里）：
//   - 树一次给齐「条目模板 + 它的条目索引」（面板据此渲染一层树，不必逐个 dump）
//   - 删条目模板 = 删文件夹：非空必须显式 force，整批要么全删要么全不动
//   - 找不到的跳过并报告（partial），不因为「另一个标签页刚删掉」而整批失败
//   - 勾选去重：同一条既给 id 又给标题时只删一次
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const templates = await import('../../src/modules/templates/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const { loadStore } = await import('../../src/core/store.ts');

// 注意 id 不能撞上**首次运行播种**的那 6 个条目模板（job / projects / …）：
// 撞了就是「条目模板已存在」，测试会在准备阶段挂掉，看起来像是树的问题。
const F = [{ key: 'name', label: '名称', type: 'text', group: 'main' }];

async function seed() {
  await templates.addTemplate({ id: 'bulk-a', title: '批量A', fields: F.map((x) => ({ ...x })) });
  await templates.addTemplate({ id: 'bulk-b', title: '批量B', fields: F.map((x) => ({ ...x })) });
  await templates.addTemplate({ id: 'bulk-empty', title: '批量空', fields: F.map((x) => ({ ...x })) });
  await entries.addEntry({ template: 'bulk-a', title: '条目甲', data: { name: '甲' } });
  await entries.addEntry({ template: 'bulk-a', title: '条目乙', data: { name: '乙' } });
  await entries.addEntry({ template: 'bulk-b', title: '项目丙', data: { name: '丙' } });
}

test('tree：一次给齐条目模板与其条目索引（名称 / 完整度），顺序与 store 一致', async () => {
  await seed();
  const t = await templates.tree();
  const a = t.templates.find((s) => s.id === 'bulk-a');
  assert.ok(a, '新条目模板要在树里');
  assert.equal(a.entries, 2, 'entries 是**数量**（与 entryList 的命名分工）');
  assert.deepEqual(a.entryList.map((e) => e.title), ['条目甲', '条目乙']);
  const first = a.entryList[0];
  assert.ok(first.id.startsWith('e_'));
  assert.equal(first.ratio, 100, '一个字段都填了 → 100%');
  assert.equal(first.total, 1);
  assert.equal(first.values, undefined, '树里每条只带 id/名称/完整度，不带字段值');
  assert.ok(t.totalEntries >= 3);
});

test('删除条目模板：条目不跟着死，整批模板只有空白模板受保护', async () => {
  await templates.addTemplate({ id: 'tmp1', title: '临时1', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await templates.addTemplate({ id: 'tmp2', title: '临时2', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  const created = await entries.addEntry({ template: 'tmp1', title: 'a', data: { name: 'a' } });

  const dry = await templates.removeMany(['tmp1', 'tmp2'], { 'dry-run': true });
  assert.equal(dry.status, 'skipped');
  assert.equal(dry.count, 2);
  assert.equal(dry.wouldRemove.find((x) => x.id === 'tmp1').entries, 1);

  const r = await templates.removeMany(['tmp1', 'tmp2']);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 2);
  assert.equal(r.unboundEntries, 1, '落到空白模板的条目数要报出来');
  const after = await loadStore();
  assert.equal(after.templates.some((s) => s.id === 'tmp1'), false);
  assert.ok(after.entries.some((e) => e.id === created.id), '删模板不删条目');
  assert.equal(after.entries.find((e) => e.id === created.id).template, '__blank__', '条目回落到空白模板');
  assert.equal(storeTemplate(after, 'tmp2'), undefined);
});

const storeTemplate = (store, id) => store.templates.find((s) => s.id === id);

test('删条目模板：id 与标题混着给、重复给，都只删一次；找不到的报在 missing 里', async () => {
  await templates.addTemplate({ id: 'dup', title: '重复', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  const r = await templates.removeMany(['dup', '重复', 'dup', '根本没有'], { force: true });
  assert.equal(r.count, 1, '同一条只删一次');
  assert.deepEqual(r.missing, ['根本没有']);
  assert.equal(r.status, 'partial', '有找不到的 → partial，但删成功的照删');
});

test('删条目模板：一个都不存在才是错（NOT_FOUND），不是静默成功', async () => {
  await assert.rejects(() => templates.removeMany(['nope1', 'nope2'], { force: true }), /都不存在/);
});

test('批量删条目：勾几条删几条，跨条目模板也行；找不到的跳过并报 partial', async () => {
  const store = await loadStore();
  const one = store.entries.find((e) => e.title === '条目甲');
  const two = store.entries.find((e) => e.title === '项目丙');

  const r = await entries.removeMany([one.id, two.id, 'e_不存在']);
  assert.equal(r.status, 'partial');
  assert.equal(r.count, 2);
  assert.deepEqual(r.missing, ['e_不存在']);

  const after = await loadStore();
  assert.equal(after.entries.some((e) => e.id === one.id), false);
  assert.equal(after.entries.some((e) => e.id === two.id), false);
  assert.ok(after.entries.some((e) => e.title === '条目乙'), '没勾的那条不能动');
  assert.ok(after.templates.some((s) => s.id === 'bulk-a'), '条目删空不等于删条目模板');
});

test('批量删条目：一个都找不到 → NOT_FOUND；空列表 → INVALID_INPUT', async () => {
  await assert.rejects(() => entries.removeMany(['e_不存在']), /都不存在/);
  await assert.rejects(() => entries.removeMany(''), /没有要删的条目/);
});

test('两个批量删除的 CLI 都能跑通（含 --dry-run 的试运行输出）', async () => {
  const { ACTIONS } = await import('../../src/runtime/registry.ts');
  const sec = ACTIONS.find((a) => a.id === 'template.remove-many');
  const ent = ACTIONS.find((a) => a.id === 'entry.remove-many');
  assert.ok(sec && ent);
  assert.deepEqual(sec.cli, ['template', 'remove-many']);
  assert.deepEqual(ent.cli, ['entry', 'remove-many']);
  assert.ok(sec.flags.force, '删条目模板必须有 force 这个显式确认');
  assert.equal(typeof sec.render, 'function');
  assert.equal(typeof ent.render, 'function');

  const store = await loadStore();
  const li = store.entries.find((e) => e.title === '条目乙');
  const text = ent.render(await entries.removeMany([li.id], { 'dry-run': true }));
  assert.match(text, /试运行/);
  assert.match(text, /条目乙/);
  assert.ok((await loadStore()).entries.some((e) => e.id === li.id), '试运行不能真删');
});


