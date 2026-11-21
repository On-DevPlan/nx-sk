// 模板默认 tag → 条目继承、tag 检索、快速搜索 API（任务 #51）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-tags-');

const templates = await import('../../src/modules/templates/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const { searchEntries, entryMatchesTags } = await import('../../src/modules/entries/search.ts');

const FIELDS = [
  { key: 'name', label: '名称', type: 'text', group: 'main' },
  { key: 'memo', label: '备注', type: 'text', group: 'main' },
];

test('模板默认 tag [id, 标题]；条目 add 继承并追加自己的 tag', async () => {
  await templates.addTemplate({ id: 'tagtpl', title: '标签模板', groups: [{ id: 'main', title: '基本' }], fields: FIELDS });
  const t = await templates.getTemplate('tagtpl');
  assert.deepEqual(t.tags, ['tagtpl', '标签模板']);

  const a = await entries.addEntry({ template: 'tagtpl', title: '甲', tags: ['alpha'], data: { name: '甲' } });
  const b = await entries.addEntry({ template: 'tagtpl', title: '乙', tags: ['beta'], data: { name: '乙' } });
  assert.deepEqual((await entries.getEntry(a.id)).tags, ['tagtpl', '标签模板', 'alpha']);
  assert.deepEqual((await entries.getEntry(b.id)).tags, ['tagtpl', '标签模板', 'beta']);
});

test('entry list / search 按 tag 精确过滤；多 tag 默认任一，tag-mode=all 全中', async () => {
  assert.equal(entryMatchesTags({ tags: ['a', 'b'] }, 'a,b', 'any'), true);
  assert.equal(entryMatchesTags({ tags: ['a'] }, 'a,b', 'all'), false);
  assert.equal(entryMatchesTags({ tags: ['a', 'b'] }, 'a,b', 'all'), true);

  const list = await entries.listEntries({ template: 'tagtpl', tag: 'alpha' });
  assert.deepEqual(list.entries.map((e) => e.title), ['甲']);
  const none = await entries.listEntries({ template: 'tagtpl', tag: 'alpha,beta', 'tag-mode': 'all' });
  assert.equal(none.count, 0);
});

test('快速搜索：标题 / tag / 字段值都能命中，且不返回完整 values', async () => {
  const hitTitle = await searchEntries({ q: '甲' });
  assert.equal(hitTitle.hits[0].id.startsWith('e_'), true);
  assert.equal(hitTitle.hits[0].values, undefined);
  assert.equal(hitTitle.hits[0].fields.includes('name'), true);

  const hitTag = await searchEntries({ tag: '标签模板' });
  assert.equal(hitTag.total, 2);
  assert.equal(hitTag.hits.every((h) => h.templateTags.includes('标签模板')), true);

  const hitValue = await searchEntries({ q: '另一个值' });
  assert.equal(hitValue.total, 0);
  await entries.addEntry({ template: 'tagtpl', title: '丙', data: { name: '丙', memo: '另一个值' } });
  const after = await searchEntries({ q: '另一个值' });
  assert.equal(after.hits.some((h) => h.title === '丙'), true);
});

test('条目 tags 被整体替换后：q 仍可命中模板 tag，list --tag 不再命中条目', async () => {
  const a = (await entries.listEntries({ template: 'tagtpl' })).entries.find((e) => e.title === '甲');
  assert.ok(a, '找不到用于替换 tags 的条目');
  await entries.updateEntry(a.id, { tags: ['  只留自定义 ', '只留自定义', ''] });
  assert.deepEqual((await entries.getEntry(a.id)).tags, ['只留自定义'], '替换时 trim、去空、去重');

  const hit = await searchEntries({ q: '标签模板' });
  assert.equal(hit.hits.some((h) => h.id === a.id && h.templateTags.includes('标签模板')), true,
    '搜索要能通过模板元信息命中已丢继承 tag 的条目');

  const list = await entries.listEntries({ template: 'tagtpl', tag: '标签模板' });
  assert.equal(list.entries.some((e) => e.id === a.id), false,
    'list --tag 只按条目标签筛，不该把模板 tag 当成条目标签');
});

test('模板 update --tags 整体替换；条目后续创建继承新默认值', async () => {
  await templates.updateTemplate('tagtpl', { tags: ['新版', 'shared'] });
  const t = await templates.getTemplate('tagtpl');
  assert.deepEqual(t.tags, ['新版', 'shared']);
  const d = await entries.addEntry({ template: 'tagtpl', title: '丁', data: { name: '丁' } });
  assert.deepEqual((await entries.getEntry(d.id)).tags, ['新版', 'shared']);
});
