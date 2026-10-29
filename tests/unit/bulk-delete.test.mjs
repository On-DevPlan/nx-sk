// 栏目树 + 批量删除：面板「栏目管理」的后端。
//
// 这里钉的是**批量语义**（单个删除的行为在 sections/entries 各自的测试里）：
//   - 树一次给齐「栏目 + 它的条目索引」（面板据此渲染一层树，不必逐个 dump）
//   - 删栏目 = 删文件夹：非空必须显式 force，整批要么全删要么全不动
//   - 找不到的跳过并报告（partial），不因为「另一个标签页刚删掉」而整批失败
//   - 勾选去重：同一条既给 id 又给标题时只删一次
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { loadStore } = await import('../../src/core/store.js');

// 注意 id 不能撞上**首次运行播种**的那 6 个栏目（job / projects / …）：
// 撞了就是「栏目已存在」，测试会在准备阶段挂掉，看起来像是树的问题。
const F = [{ key: 'name', label: '名称', type: 'text', group: 'main' }];

async function seed() {
  await sections.addSection({ id: 'bulk-a', title: '批量A', fields: F.map((x) => ({ ...x })) });
  await sections.addSection({ id: 'bulk-b', title: '批量B', fields: F.map((x) => ({ ...x })) });
  await sections.addSection({ id: 'bulk-empty', title: '批量空', fields: F.map((x) => ({ ...x })) });
  await entries.addEntry({ section: 'bulk-a', title: '条目甲', data: { name: '甲' } });
  await entries.addEntry({ section: 'bulk-a', title: '条目乙', data: { name: '乙' } });
  await entries.addEntry({ section: 'bulk-b', title: '项目丙', data: { name: '丙' } });
}

test('tree：一次给齐栏目与其条目索引（名称 / 完整度），顺序与 store 一致', async () => {
  await seed();
  const t = await sections.tree();
  const a = t.sections.find((s) => s.id === 'bulk-a');
  assert.ok(a, '新栏目要在树里');
  assert.equal(a.entries, 2, 'entries 是**数量**（与 entryList 的命名分工）');
  assert.deepEqual(a.entryList.map((e) => e.title), ['条目甲', '条目乙']);
  const first = a.entryList[0];
  assert.ok(first.id.startsWith('e_'));
  assert.equal(first.ratio, 100, '一个字段都填了 → 100%');
  assert.equal(first.total, 1);
  assert.equal(first.values, undefined, '树里每条只带 id/名称/完整度，不带字段值');
  assert.ok(t.totalEntries >= 3);
});

test('删栏目 = 删文件夹：非空必须 force，且整批要么全删要么全不动', async () => {
  await sections.addSection({ id: 'tmp1', title: '临时1', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.addSection({ id: 'tmp2', title: '临时2', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await entries.addEntry({ section: 'tmp1', title: 'a', data: { name: 'a' } });

  // 有非空栏目、没给 force → 整批拒绝（不能「删掉空的那个，留下非空的」）
  await assert.rejects(() => sections.removeMany('tmp1,tmp2'), /非空|force/);
  const store = await loadStore();
  assert.ok(store.sections.some((s) => s.id === 'tmp1'), '拒绝时什么都没删');
  assert.ok(store.sections.some((s) => s.id === 'tmp2'));

  const dry = await sections.removeMany(['tmp1', 'tmp2'], { force: true, 'dry-run': true });
  assert.equal(dry.status, 'skipped');
  assert.equal(dry.count, 2);
  assert.equal(dry.wouldRemove.find((x) => x.id === 'tmp1').entries, 1);

  const r = await sections.removeMany(['tmp1', 'tmp2'], { force: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 2);
  assert.equal(r.removedEntries, 1, '连带删掉的条目数要报出来');
  const after = await loadStore();
  assert.equal(after.sections.some((s) => s.id === 'tmp1'), false);
  assert.equal(after.entries.some((e) => e.section === 'tmp1'), false, '连带条目一起没了');
});

test('删栏目：id 与标题混着给、重复给，都只删一次；找不到的报在 missing 里', async () => {
  await sections.addSection({ id: 'dup', title: '重复', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  const r = await sections.removeMany(['dup', '重复', 'dup', '根本没有'], { force: true });
  assert.equal(r.count, 1, '同一条只删一次');
  assert.deepEqual(r.missing, ['根本没有']);
  assert.equal(r.status, 'partial', '有找不到的 → partial，但删成功的照删');
});

test('删栏目：一个都不存在才是错（NOT_FOUND），不是静默成功', async () => {
  await assert.rejects(() => sections.removeMany(['nope1', 'nope2'], { force: true }), /都不存在/);
});

test('批量删条目：勾几条删几条，跨栏目也行；找不到的跳过并报 partial', async () => {
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
  assert.ok(after.sections.some((s) => s.id === 'bulk-a'), '条目删空不等于删栏目');
});

test('批量删条目：一个都找不到 → NOT_FOUND；空列表 → INVALID_INPUT', async () => {
  await assert.rejects(() => entries.removeMany(['e_不存在']), /都不存在/);
  await assert.rejects(() => entries.removeMany(''), /没有要删的条目/);
});

test('两个批量删除的 CLI 都能跑通（含 --dry-run 的试运行输出）', async () => {
  const { ACTIONS } = await import('../../src/runtime/registry.js');
  const sec = ACTIONS.find((a) => a.id === 'section.remove-many');
  const ent = ACTIONS.find((a) => a.id === 'entry.remove-many');
  assert.ok(sec && ent);
  assert.deepEqual(sec.cli, ['section', 'remove-many']);
  assert.deepEqual(ent.cli, ['entry', 'remove-many']);
  assert.ok(sec.flags.force, '删栏目必须有 force 这个显式确认');
  assert.equal(typeof sec.render, 'function');
  assert.equal(typeof ent.render, 'function');

  const store = await loadStore();
  const li = store.entries.find((e) => e.title === '条目乙');
  const text = ent.render(await entries.removeMany([li.id], { 'dry-run': true }));
  assert.match(text, /试运行/);
  assert.match(text, /条目乙/);
  assert.ok((await loadStore()).entries.some((e) => e.id === li.id), '试运行不能真删');
});
