// 工作区布局剪枝：空 tabset 不许进布局（进去了会在界面上渲染成一块白板）。
//
// 背景：FlexLayout 的 toJson 把 children 为空的 tabset 原样写盘——拖动/关闭面板的
// 某些路径会留下空面板组，恢复后就是一块空白。剪枝在存盘与恢复两端都过：
// 恢复端剪 = 老坏布局自愈；存盘端剪 = 不再产生新的。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { pruneEmptyTabsets } = await import('../../src/web/frontend/workspace.js');

const ts = (id, n = 1) => ({
  type: 'tabset', id, weight: 50,
  children: Array.from({ length: n }, (_, i) => ({ type: 'tab', id: `${id}_t${i}`, name: `面板${i}`, component: 'database' })),
});
const row = (children, weight) => ({ type: 'row', weight, children });

test('空 tabset 被剪掉，兄弟面板组原样保留（顺序 / 权重 / 选中态不动）', () => {
  const json = {
    type: 'row', weight: 100,
    children: [
      ts('ts_a', 2),
      { type: 'tabset', id: 'ts_empty', weight: 30, children: [] },
      ts('ts_b', 1),
    ],
  };
  const out = pruneEmptyTabsets(json);
  assert.ok(out, '布局还有活面板组，不该返回 null');
  assert.deepEqual(out.children.map((c) => c.id), ['ts_a', 'ts_b']);
  assert.equal(out.children[0].children.length, 2);
  assert.equal(out.children[0].weight, 50, '权重不动');
});

test('嵌套 row 里的空 tabset 被剪；剪空的嵌套 row 一并移除', () => {
  const json = {
    type: 'row', weight: 100,
    children: [
      row([ts('ts_inner', 1), { type: 'tabset', id: 'ts_e1', weight: 10, children: [] }], 40),
      row([{ type: 'tabset', id: 'ts_e2', weight: 60, children: [] }], 60),
    ],
  };
  const out = pruneEmptyTabsets(json);
  assert.ok(out);
  assert.equal(out.children.length, 1, '第二个嵌套 row 剪空后整个移除');
  assert.deepEqual(out.children[0].children.map((c) => c.id), ['ts_inner']);
});

test('根被剪空（一个面板组都不剩）→ 返回 null，调用方回退初始布局', () => {
  const json = row([{ type: 'tabset', id: 'ts_only', weight: 100, children: [] }]);
  assert.equal(pruneEmptyTabsets(json), null);
});

test('健康布局原样通过（深相等，不误伤）', () => {
  const json = {
    global: { tabEnableClose: true },
    layout: { type: 'row', weight: 100, children: [ts('ts_a', 1), ts('ts_b', 3)] },
    borders: [],
  };
  const snapshot = JSON.parse(JSON.stringify(json));
  const out = pruneEmptyTabsets(json);
  assert.deepEqual(out, snapshot);
});

test('非 row 根 / 缺 children 的怪形状：不动它（交给 Model.fromJson 的校验与 try/catch）', () => {
  assert.deepEqual(pruneEmptyTabsets(null), null);
  assert.deepEqual(pruneEmptyTabsets({ type: 'tabset', id: 'x' }), { type: 'tabset', id: 'x' });
  assert.deepEqual(pruneEmptyTabsets({ type: 'row' }), { type: 'row' });
});
