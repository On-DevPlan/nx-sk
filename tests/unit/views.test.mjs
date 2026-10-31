// 数据库视图（section.views）的单测。
//
// 钉三件事（每件都对应一个「静默丢配置」的真风险）：
//   ① 缺省推断的形状与「不落盘」语义 —— 只读路径推断，落过盘就听用户的；
//   ② 投影降级 —— 字段被删，列还在（不炸、也不静默消失）；
//   ③ store 的白名单归一必须**显式收 views / defaultView**，否则写一次就丢。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UNGROUPED, bucketByGroup, effectiveDefaultViewId, effectiveViews, inferViews,
  normalizeViewConfig, normalizeViews, resolveViewColumns,
} from '../../src/shared/views.js';
import { useTempHome } from '../helpers.mjs';

const jobSection = {
  id: 'job',
  title: '求职',
  kv: false,
  titleField: 'company',
  fields: [
    { key: 'company', label: '公司', type: 'text', group: 'basic' },
    { key: 'jobStatus', label: '求职状态', type: 'select', group: 'basic', options: ['进行中', '已结束'] },
    { key: 'salary', label: '薪资', type: 'number', group: 'basic' },
    { key: 'apiKey', label: '密钥', type: 'secret', group: 'basic', sensitive: true },
    { key: 'source', label: '原始资料', type: 'source', group: 'source' },
  ],
};

test('缺省推断：非 KV 栏目给 表格 / 精简 / 看板 三条，且都不落盘（provisional）', () => {
  const views = inferViews(jobSection);
  assert.deepEqual(views.map((v) => v.id), ['table-default', 'compact-default', 'board-by-jobStatus']);
  assert.ok(views.every((v) => v.provisional === true));

  // 表格：除 source 外全部字段（密文列也在——值打码，列本身不是秘密）
  const table = views[0];
  assert.ok(!table.columns.some((c) => c.key === 'source'), 'source 是资料袋，不是一列数据');
  assert.ok(table.columns.some((c) => c.key === 'apiKey'), '密文字段照常进列');

  // 精简 = 标题字段 + 第一个 select
  assert.deepEqual(views[1].columns.map((c) => c.key), ['company', 'jobStatus']);

  // 看板 = 第一个 select 分组
  assert.equal(views[2].groupBy, 'jobStatus');
});

test('缺省推断：没有 select 字段就没有看板；只有一列时不给「精简」', () => {
  const bare = { id: 'x', title: 'X', fields: [{ key: 'name', label: '名称', type: 'text' }], titleField: 'name' };
  const views = inferViews(bare);
  assert.deepEqual(views.map((v) => v.id), ['table-default']);
});

test('缺省推断：KV 栏目只有一条 kv 视图', () => {
  const views = inferViews({ id: 'secret', kv: true, fields: [] });
  assert.equal(views.length, 1);
  assert.equal(views[0].type, 'kv');
});

test('落过盘就用落盘的：provisional 变为 false', () => {
  const stored = { ...jobSection, views: [{ id: 'my-view', type: 'table', title: '我的', columns: [{ key: 'company' }] }] };
  const eff = effectiveViews(stored);
  assert.equal(eff.provisional, false);
  assert.deepEqual(eff.views.map((v) => v.id), ['my-view']);
});

test('views 为空数组 = 没配过：回到推断（两种「空」行为必须一样）', () => {
  const eff = effectiveViews({ ...jobSection, views: [] });
  assert.equal(eff.provisional, true);
  assert.equal(eff.views.length, 3);
});

test('defaultView 指向不存在的视图时退回第一个（不留悬空引用）', () => {
  const stored = { ...jobSection, views: [{ id: 'a', type: 'table', title: 'A' }], defaultView: 'gone' };
  const { views } = effectiveViews(stored);
  assert.equal(effectiveDefaultViewId(stored, views), 'a');
  assert.equal(effectiveDefaultViewId({ ...stored, defaultView: 'a' }, views), 'a');
});

test('投影降级：字段被删 → 列还在，标 missing；hidden 列不渲染', () => {
  const view = {
    id: 'v1', type: 'table', title: 'T',
    columns: [{ key: 'company' }, { key: 'deletedField' }, { key: 'salary', hidden: true }],
  };
  const cols = resolveViewColumns(jobSection, view);
  assert.deepEqual(cols.map((c) => c.key), ['company', 'deletedField'], 'hidden 的列被过滤');
  assert.equal(cols[0].label, '公司');
  assert.equal(cols[1].missing, true);
  assert.equal(cols[1].label, '已删字段');
});

test('投影归一：id / type 不合法直接丢；width 夹到 40–800；groupBy 只对看板生效', () => {
  assert.equal(normalizeViewConfig({ id: '中文 id', type: 'table' }), null, 'id 只收 ASCII');
  assert.equal(normalizeViewConfig({ id: 'v1', type: 'gallery' }), null, '未实现的类型不收');
  const v = normalizeViewConfig({ id: 'v1', type: 'table', columns: [{ key: 'a', width: 9999 }, { key: 'a' }, { key: '' }], groupBy: 'x' });
  assert.equal(v.columns.length, 1, '同 key 去重、空 key 丢弃');
  assert.equal(v.columns[0].width, 800);
  assert.equal(v.groupBy, undefined, 'table 上留着 groupBy 会让人以为表格也能分组');
  assert.equal(normalizeViews([{ id: 'v1', type: 'table' }, { id: 'v1', type: 'board' }]).length, 1, 'id 去重');
});

test('store 白名单收 views / defaultView；悬空的 defaultView 读上来就丢', async () => {
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = await useTempHome('nx-sk-views-');
  const { loadStore } = await import('../../src/core/store.js');
  const p = join(dir, 'store.json');
  await fsp.writeFile(p, JSON.stringify({
    version: 4,
    settings: {},
    sections: [{
      id: 'job', title: '求职', fields: [], groups: [],
      views: [
        { id: 'table-default', type: 'table', title: '表格', columns: [{ key: 'company', width: 120 }] },
        { id: 'bad', type: 'nope' },
      ],
      defaultView: 'missing-view',
    }],
    entries: [],
    files: [],
  }), 'utf8');

  const s = await loadStore(p);
  const sec = s.sections.find((x) => x.id === 'job');
  assert.equal(sec.views.length, 1, '非法视图在读路径被丢掉');
  assert.equal(sec.views[0].columns[0].width, 120, 'views 通过了白名单（没被静默抹掉）');
  assert.equal(sec.defaultView, undefined, '指向不存在视图的 defaultView 不能留');

  // 写回一次仍然在 —— 这是「白名单重建」那条腐蚀点的回归断言
  const { mutateStore } = await import('../../src/core/store.js');
  await mutateStore((st) => { st.sections.find((x) => x.id === 'job').title = '求职2'; }, p);
  const after = JSON.parse(await fsp.readFile(p, 'utf8'));
  assert.equal(after.sections[0].views[0].id, 'table-default', '写一次不能把 views 丢掉');
});

// —— 看板分桶（S3）：拖卡的落点语义全靠这一层，错了就是「拖一下改了别人的字段」——

test('看板分桶：列序 = 候选值顺序；空值和脏值都进「未分组」，不静默丢', () => {
  const entries = [
    { id: 'a', values: { jobStatus: '已结束' } },
    { id: 'b', values: { jobStatus: '进行中' } },
    { id: 'c', values: {} },
    { id: 'd', values: { jobStatus: '' } },
    { id: 'e', values: { jobStatus: '已放弃' } }, // 历史脏值：候选里没有
    { id: 'f', values: { jobStatus: null } },
  ];
  const { buckets, ungrouped } = bucketByGroup(entries, 'jobStatus', ['进行中', '已结束']);
  assert.deepEqual([...buckets.keys()], ['进行中', '已结束'], '列序听字段定义，不听数据出现顺序');
  assert.deepEqual(buckets.get('进行中').map((e) => e.id), ['b']);
  assert.deepEqual(buckets.get('已结束').map((e) => e.id), ['a']);
  assert.deepEqual(ungrouped.map((e) => e.id), ['c', 'd', 'e', 'f'], '空值 + 候选外的值都留下');
});

test('看板分桶：没有候选值时不炸，全部落「未分组」；入参垃圾也不炸', () => {
  const { buckets, ungrouped } = bucketByGroup([{ id: 'a', values: { x: '1' } }], 'x', null);
  assert.equal(buckets.size, 0);
  assert.equal(ungrouped.length, 1, '没候选值 → 没有可落的列，但数据不消失');
  assert.deepEqual(bucketByGroup(undefined, 'x', undefined), { buckets: new Map(), ungrouped: [] });
  assert.equal(UNGROUPED, '__ungrouped__', '占位列 id 是跨端约定，不能随手改');
});
