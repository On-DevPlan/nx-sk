// 目录树（settings.navTree）的纯函数单测。
//
// 钉四件事，每件都对应一种「用户的显示配置被吃掉」的真风险：
//   ① 从老三套推断的顺序与老实现一致（分组在后、navOrder 优先、隐藏只认现存栏目）；
//   ② 树操作是**纯函数**（不改入参）—— 面板与 CLI 都要能安全地拿旧树算新树；
//   ③ moveNode 的下标语义是 arrayMove（拖到第几位就是第几位），且拒绝自嵌套；
//   ④ 栏目被删 → 节点自动略过、空分组不显示（优雅降级，不是报错）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findNode, inferNavTree, insertNode, moveNode, normalizeNavTree, pruneNavTree, removeNode,
  resolveNavTree, sectionNodes, toggleExpanded,
} from '../../src/shared/navTree.js';

const sec = (id, order = 50) => ({ id, title: id.toUpperCase(), order });

test('推断：平铺在前、分组在后；组内顺序听配置，平铺区 navOrder 优先', () => {
  const sections = [sec('a', 1), sec('b', 2), sec('c', 3), sec('d', 4)];
  const { tree, hidden } = inferNavTree(sections, {
    navGroups: [{ title: '工作', sections: ['d', 'b'] }],
    navOrder: ['c'],
    navHidden: [],
  });
  assert.deepEqual(tree.map((n) => n.id), ['c', 'a', 'group:工作#0'], 'navOrder 里的 c 排最前，分组在最后');
  const g = tree[2];
  assert.deepEqual(g.children.map((n) => n.id), ['d', 'b'], '组内按配置列出的顺序');
  assert.deepEqual(sectionNodes(tree).map((n) => n.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(hidden, []);
});

test('推断：隐藏与不存在的栏目都优雅略过（配置留着，渲染不炸）', () => {
  const sections = [sec('a'), sec('b')];
  const { tree, hidden } = inferNavTree(sections, {
    navHidden: ['b', 'ghost'],
    navGroups: [{ title: '空组', sections: ['ghost'] }, { title: '真组', sections: ['b'] }],
  });
  assert.deepEqual(hidden, ['b'], '不存在的栏目不进 hidden 输出（它本来就不在）');
  assert.deepEqual(tree.map((n) => n.id), ['a'], '只含幽灵成员的组不显示；b 被隐藏');
});

test('显式树优先，并且剪掉已删栏目；空数组 = 没配过 → 回到推断', () => {
  const sections = [sec('a'), sec('b')];
  const explicit = [{ kind: 'group', id: 'group:g', title: 'G', children: [
    { kind: 'section', id: 'b' }, { kind: 'section', id: 'gone' },
  ] }];
  const r = resolveNavTree(sections, { navTree: explicit, navHidden: [] });
  assert.equal(r.source, 'explicit');
  assert.deepEqual(sectionNodes(r.tree).map((n) => n.id), ['b'], 'gone 被剪掉，组还在');

  const r2 = resolveNavTree(sections, { navTree: [] });
  assert.equal(r2.source, 'inferred', '空数组按「没配过」处理');
});

test('归一：非法 kind / 重复 id / 无标题分组 / 非对象一律丢（不静默改写成别的形状）', () => {
  const tree = normalizeNavTree([
    { kind: 'section', id: 'a' },
    { kind: 'section', id: 'a' }, // 重复
    { kind: 'nope', id: 'x' },
    { kind: 'group', id: 'group:g', title: '   ' }, // 无标题
    { kind: 'group', id: 'group:h', title: 'H', children: [{ kind: 'section', id: 'b' }] },
    null,
  ]);
  assert.deepEqual(tree.map((n) => n.id), ['a', 'group:h']);
  assert.deepEqual(tree[1].children.map((n) => n.id), ['b']);
});

test('树操作是纯函数：入参不被改写', () => {
  const tree = [{ kind: 'section', id: 'a' }, { kind: 'section', id: 'b' }];
  const snapshot = JSON.stringify(tree);
  removeNode(tree, 'a');
  insertNode(tree, '', { kind: 'section', id: 'z' }, 0);
  toggleExpanded(tree, 'b', true);
  moveNode(tree, 'a', '', 1);
  assert.equal(JSON.stringify(tree), snapshot, '四个操作都不许改入参');
});

test('moveNode：同父重排按 arrayMove 语义（拖到第几位就是第几位）', () => {
  const tree = ['a', 'b', 'c'].map((id) => ({ kind: 'section', id }));
  const next = moveNode(tree, 'a', '', 2);
  assert.deepEqual(next.map((n) => n.id), ['b', 'c', 'a'], '把 a 拖到下标 2');
  assert.deepEqual(moveNode(tree, 'c', '', 0).map((n) => n.id), ['c', 'a', 'b']);
});

test('moveNode：跨父嵌套；拒绝自嵌套与不存在的目标', () => {
  const tree = [
    { kind: 'section', id: 'a' },
    { kind: 'group', id: 'group:g', title: 'G', children: [{ kind: 'section', id: 'b' }] },
  ];
  const nested = moveNode(tree, 'a', 'group:g', 0);
  assert.deepEqual(nested.map((n) => n.id), ['group:g']);
  assert.deepEqual(nested[0].children.map((n) => n.id), ['a', 'b'], '插到组内第 0 位');

  assert.deepEqual(moveNode(tree, 'group:g', 'group:g', 0).map((n) => n.id), ['a', 'group:g'], '不能挂自己身上');
  assert.deepEqual(moveNode(tree, 'group:g', 'ghost', 0).map((n) => n.id), ['a', 'group:g'], '目标不存在 → 原树');
  assert.equal(findNode(moveNode(tree, 'nope', '', 0), 'nope'), null, '来源不存在 → 原树');
});

test('moveNode：不能把分组拖进自己的子树（会成环）', () => {
  const tree = [{
    kind: 'group', id: 'group:outer', title: 'O', children: [
      { kind: 'group', id: 'group:inner', title: 'I', children: [{ kind: 'section', id: 'a' }] },
    ],
  }];
  const next = moveNode(tree, 'group:outer', 'group:inner', 0);
  assert.equal(findNode(next, 'group:outer').id, 'group:outer', '原树不变');
  assert.ok(findNode(next, 'group:inner'), 'inner 仍在原位');
});

test('pruneNavTree：栏目删掉后节点消失；分组被剪空则整组不显示', () => {
  const tree = normalizeNavTree([
    { kind: 'section', id: 'a' },
    { kind: 'group', id: 'group:g', title: 'G', children: [{ kind: 'section', id: 'gone' }] },
    { kind: 'group', id: 'group:h', title: 'H', children: [{ kind: 'section', id: 'b' }] },
  ]);
  const pruned = pruneNavTree(tree, ['a', 'b']);
  assert.deepEqual(pruned.map((n) => n.id), ['a', 'group:h']);
});
