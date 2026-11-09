// 正文块布局（section.layout）：**版式是显示关系，单独存**，字段增删后要能自愈。
//
// 这里钉的是语义，不是像素：
//   - 默认版式：宽字段整行、窄字段半列，窄屏一律单列（响应式不靠媒体查询手写）
//   - 版式 JSON 只认自己的结构：脏数据夹到合法范围、未知断点丢掉，绝不抛错让面板白屏
//   - 字段被删 → 它的块消失；新字段 → 接到组尾（不插队打散已有版式）
//   - 对齐是幂等的：读一次、写一次，结果一模一样
//   - 版式能经 CLI 整体读写（面板上没有 CLI 做不到的事）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const L = await import('../../src/shared/blockLayout.ts');
const sections = await import('../../src/modules/sections/service.ts');
const { loadStore } = await import('../../src/core/store.ts');

const F = (key, type = 'text', group = 'main') => ({ key, label: key.toUpperCase(), type, group });
// 高度是**行数**（一档 8px + 10px 间距）：默认值由「期望像素」推出，测试跟着同一套换算
const R = L.rowsForPx;
const TEXT_H = R(58);
const MD_H = R(180);
const TA_H = R(76);

test('默认块宽：窄字段半列、宽字段整行，窄屏一律整行', () => {
  assert.deepEqual(L.defaultBlockSize(F('name'), 12), { w: 6, h: TEXT_H });
  assert.deepEqual(L.defaultBlockSize(F('bio', 'md'), 12), { w: 12, h: MD_H });
  assert.deepEqual(L.defaultBlockSize(F('note', 'textarea'), 10), { w: 10, h: TA_H });
  // xs/xxs（4 / 2 列）上一律整行：两列并排在手机上每块只剩几十像素，谁也填不了
  assert.equal(L.defaultBlockSize(F('name'), 4).w, 4);
  assert.equal(L.defaultBlockSize(F('name'), 2).w, 2);
});

test('默认铺法：放不下就换行，行高按本行最高的块算', () => {
  const items = L.packBlocks([F('a'), F('b'), F('c'), F('d')], 12);
  assert.deepEqual(items.map((x) => [x.i, x.x, x.y]), [['a', 0, 0], ['b', 6, 0], ['c', 0, TEXT_H], ['d', 6, TEXT_H]]);
  // 宽字段独占一行，后面的块从下一行接着摆
  const mixed = L.packBlocks([F('a'), F('bio', 'md'), F('c')], 12);
  assert.deepEqual(mixed.map((x) => [x.i, x.x, x.y]), [['a', 0, 0], ['bio', 0, TEXT_H], ['c', 0, TEXT_H + MD_H]]);
});

test('每个断点各铺一份（列数不同，不能把 lg 的坐标直接缩放过去）', () => {
  const layouts = L.defaultLayouts([F('a'), F('b')]);
  assert.deepEqual(Object.keys(layouts).sort(), ['lg', 'md', 'sm', 'xs', 'xxs']);
  assert.equal(layouts.lg[0].w, 6);
  assert.equal(layouts.xs[0].w, 4);
  assert.equal(layouts.xxs[0].w, 2);
});

test('sanitizeLayout：不是对象返回 null；脏数据夹到合法范围；未知断点丢掉', () => {
  assert.equal(L.sanitizeLayout(null), null);
  assert.equal(L.sanitizeLayout('x'), null);
  assert.equal(L.sanitizeLayout([]), null);

  const out = L.sanitizeLayout({
    mode: '别的东西',
    panels: ['a', 'a', ''],
    groups: {
      a: {
        collapsed: 'yes',
        layouts: {
          lg: [{ i: 'name', x: 99, y: -3, w: 99, h: 0 }, { i: 'name', x: 0, y: 0, w: 6, h: 2 }, { i: '' }],
          nonsense: [{ i: 'x' }],
        },
      },
    },
  });
  assert.equal(out.mode, 'grid'); // 不认识的 mode 回落 grid，不是抛错
  assert.deepEqual(out.panels, ['a']); // 去重 + 去空
  assert.equal(out.groups.a.collapsed, false);
  assert.deepEqual(out.groups.a.layouts.lg, [{ i: 'name', x: 0, y: 0, w: 12, h: L.MIN_H }]); // w/h 夹到合法值、同 key 只留第一个
  assert.equal(out.groups.a.layouts.nonsense, undefined); // 未知断点不留
});

test('reconcileLayout：删掉的字段不留空块，新字段接到组尾，已有位置不动', () => {
  const layout = {
    v: 1,
    mode: 'grid',
    panels: ['main'],
    groups: { main: { collapsed: false, layouts: { lg: [{ i: 'a', x: 0, y: 0, w: 6, h: 2 }, { i: 'gone', x: 6, y: 0, w: 6, h: 2 }] } } },
  };
  const out = L.reconcileLayout(layout, [{ id: 'main', fields: [F('a'), F('b')] }]);
  const lg = out.groups.main.layouts.lg;
  assert.deepEqual(lg.map((x) => x.i), ['a', 'b'], '已删字段的块不再出现');
  assert.deepEqual(lg[0], { i: 'a', x: 0, y: 0, w: 6, h: L.MIN_H }, '已有块的位置原样保留（h=2 低于最小高，被夹到 MIN_H）');
  assert.equal(lg[1].y, L.MIN_H, '新字段接在最底部，不插队');
});

test('reconcileLayout：分组增删跟着走，空分组不占位', () => {
  const layout = { v: 1, mode: 'grid', panels: ['b', 'a'], groups: {} };
  const groups = [
    { id: 'a', fields: [F('a1', 'text', 'a')] },
    { id: 'b', fields: [F('b1', 'text', 'b')] },
    { id: 'c', fields: [F('c1', 'text', 'c')] },
    { id: 'empty', fields: [] },
  ];
  const out = L.reconcileLayout(layout, L.groupsForLayout({ groups, fields: groups.flatMap((g) => g.fields) }));
  assert.deepEqual(out.panels, ['b', 'a', 'c'], '存的顺序优先，新组接尾，空组不出现');
  assert.ok(out.groups.b.layouts.lg.length === 1);
});

test('落位吸附：半宽的块吸到 0 / 6，自由宽度（5 列）保持原样', () => {
  const snapped = L.snapItems([
    { i: 'a', x: 3, y: 0, w: 6, h: 2 },
    { i: 'b', x: 1, y: 2, w: 5, h: 2 },
    { i: 'c', x: 8, y: 4, w: 4, h: 2 },
    { i: 'd', x: 5, y: 6, w: 12, h: 2 },
  ], 12);
  assert.equal(snapped[0].x, 6, 'x=3 吸到最近的整数倍档位（6）');
  assert.equal(snapped[1].x, 1, '宽 5 除不尽 12 —— 是用户特意的自由宽度，不摆正');
  assert.equal(snapped[2].x, 8);
  assert.equal(snapped[3].x, 0, '整行的块只能在 0');
  // 拖动距离不足半档时原地不动：吸附不该把「轻微挪动」变成跳一格
  assert.equal(L.snapItems([{ i: 'a', x: 1, y: 0, w: 6, h: 2 }], 12)[0].x, 0);
  assert.equal(L.snapItems([{ i: 'a', x: 2, y: 0, w: 6, h: 2 }], 12)[0].x, 0);
  assert.equal(L.snapItems([{ i: 'a', x: 4, y: 0, w: 6, h: 2 }], 12)[0].x, 6);
});

test('snapLayout 幂等，且只动 x', () => {
  const layout = L.reconcileLayout(null, [{ id: 'main', fields: [F('a'), F('b')] }]);
  layout.groups.main.layouts.lg[1].x = 3;
  const once = L.snapLayout(layout);
  const twice = L.snapLayout(once);
  assert.ok(L.sameLayout(once, twice));
  const [a1, b1] = once.groups.main.layouts.lg;
  assert.deepEqual([a1.x, a1.y, a1.w, a1.h], [0, 0, 6, TEXT_H]);
  assert.equal(b1.x, 6);
  assert.equal(b1.y, layout.groups.main.layouts.lg[1].y, 'y 一个都不动（纵向由引擎压实）');
});

test('插入式排序：按新顺序重新铺格，**保留原宽度**、行高按本行最高的块算', () => {
  const layout = L.reconcileLayout(null, [{ id: 'main', fields: [F('a'), F('b'), F('md1', 'md'), F('c')] }]);
  const items = layout.groups.main.layouts.lg;
  const w = (k) => items.find((x) => x.i === k).w;
  // 把最后一个（半宽）挪到最前：顺序变了，宽度不变，位置重算
  const next = L.repackBlocks([
    { i: 'c', w: w('c'), h: 4 },
    { i: 'a', w: w('a'), h: 4 },
    { i: 'b', w: w('b'), h: 4 },
    { i: 'md1', w: w('md1'), h: 4 },
  ], 12);
  assert.deepEqual(next.map((x) => [x.i, x.x, x.y, x.w]), [
    ['c', 0, 0, 6], ['a', 6, 0, 6], ['b', 0, 4, 6], ['md1', 0, 8, 12],
  ]);
  // 宽度是独立自由度：满宽块后面的半宽块只能从新的一行开始
  assert.ok(next.every((it) => it.x + it.w <= 12));
});

test('插入式排序：块宽度不变（不因为重排把满宽块压成半宽）', () => {
  const items = [{ i: 'full', w: 12, h: 5 }, { i: 'half', w: 6, h: 4 }];
  const swapped = L.repackBlocks([items[1], items[0]], 12);
  assert.equal(swapped[0].w, 6);
  assert.equal(swapped[1].w, 12);
  assert.deepEqual(swapped.map((x) => [x.i, x.x, x.y]), [['half', 0, 0], ['full', 0, 4]]);
});

test('对齐是幂等的：再跑一次结果不变', () => {
  const groups = [{ id: 'main', fields: [F('a'), F('b', 'md'), F('c')] }];
  const once = L.reconcileLayout(null, groups);
  const twice = L.reconcileLayout(once, groups);
  assert.ok(L.sameLayout(once, twice));
});

test('sameLayout：顺序/写法不同但等价 → 相同；挪一格 → 不同', () => {
  const a = { v: 1, mode: 'grid', panels: ['m'], groups: { m: { layouts: { lg: [{ i: 'a', x: 0, y: 0, w: 6, h: 2 }, { i: 'b', x: 6, y: 0, w: 6, h: 2 }] } } } };
  const b = { v: 1, mode: 'grid', panels: ['m'], groups: { m: { layouts: { lg: [{ i: 'b', x: 6, y: 0, w: 6, h: 2 }, { i: 'a', x: 0, y: 0, w: 6, h: 2 }] } } } };
  const c = { v: 1, mode: 'grid', panels: ['m'], groups: { m: { layouts: { lg: [{ i: 'a', x: 0, y: 0, w: 12, h: 2 }, { i: 'b', x: 6, y: 0, w: 6, h: 2 }] } } } };
  assert.ok(L.sameLayout(a, b));
  assert.ok(!L.sameLayout(a, c));
});

test('服务端：--layout 整体写入并回读；脏值报 INVALID_INPUT 而不是落盘', async () => {
  await sections.addSection({
    id: 'blocks',
    title: '块布局验证',
    fields: [F('a'), F('b'), F('md1', 'md')],
    groups: [{ id: 'main', title: '主' }],
  });
  const layout = {
    mode: 'grid',
    panels: ['main'],
    groups: { main: { layouts: { lg: [{ i: 'a', x: 0, y: 0, w: 4, h: 2 }, { i: 'b', x: 4, y: 0, w: 4, h: 2 }, { i: 'md1', x: 0, y: 2, w: 12, h: 9 }] } } },
  };
  await sections.updateSection('blocks', { layout });
  const got = await sections.getSection('blocks');
  const lg = got.layout.groups.main.layouts.lg;
  assert.deepEqual(lg.map((x) => [x.i, x.x, x.w]), [['a', 0, 4], ['b', 4, 4], ['md1', 0, 12]]);

  await assert.rejects(() => sections.updateSection('blocks', { layout: 'not-json-object' }), /--layout/);
  // 报错不落盘：版式还是上一步那份
  const again = await sections.getSection('blocks');
  assert.ok(L.sameLayout(got.layout, again.layout));
});

test('服务端：删字段 / 加字段后版式自动对齐（旧版式不留孤儿块）', async () => {
  await sections.updateSection('blocks', { 'remove-field': ['b'] });
  let got = await sections.getSection('blocks');
  assert.deepEqual(got.layout.groups.main.layouts.lg.map((x) => x.i), ['a', 'md1']);

  await sections.updateSection('blocks', { 'add-field': { key: 'c', label: 'C', type: 'text', group: 'main' } });
  got = await sections.getSection('blocks');
  const lg = got.layout.groups.main.layouts.lg;
  assert.deepEqual(lg.map((x) => x.i), ['a', 'md1', 'c']);
  assert.ok(lg[2].y >= lg[1].y + lg[1].h, '新字段落在已有块下面');
});

test('服务端：--clear-layout 回到默认编排（不是把配置删成 null）', async () => {
  await sections.updateSection('blocks', { 'clear-layout': true });
  const got = await sections.getSection('blocks');
  const lg = got.layout.groups.main.layouts.lg;
  assert.deepEqual(lg.map((x) => x.i), ['a', 'md1', 'c']);
  assert.equal(lg[0].x, 0);
  assert.equal(lg[0].y, 0);
  const store = await loadStore();
  const sec = store.sections.find((s) => s.id === 'blocks');
  assert.ok(sec.layout && sec.layout.mode === 'grid', '默认版式要落盘，读出来立刻能渲染');
});

test('store：脏版式在归一化时被夹干净，不会让面板白屏', async () => {
  const store = await loadStore();
  const sec = store.sections.find((s) => s.id === 'blocks');
  const { normalize } = await import('../../src/core/store.ts');
  const out = normalize({ ...store, sections: [{ ...sec, layout: { groups: { main: { layouts: { lg: 'x' } } } } }] });
  // 「lg 是个字符串」这种脏值既不能留着（面板会崩），也不该让整份版式丢掉——
  // 结果是一个结构合法、但这个断点没有块的版式，面板会按默认编排铺一遍。
  assert.equal(out.sections[0].layout.mode, 'grid');
  assert.deepEqual(out.sections[0].layout.groups.main.layouts, {});
});

