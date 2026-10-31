import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reorderAt } from '../../src/web/frontend/listSort.js';

// 拖拽排序的落点是**插入位**（0 = 最前，n = 最后），不是目标下标 ——
// 这两个语义差一，而「差一」的表现是「拖到第二行结果跑到第三行」，
// 只有真跑一遍才看得出来。这里把四条边界钉死。

test('插到最后 / 最前', () => {
  assert.deepEqual(reorderAt(['a', 'b', 'c'], 0, 3), ['b', 'c', 'a'], '第一项拖到末尾');
  assert.deepEqual(reorderAt(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'], '最后一项拖到最前');
});

test('插到中间：落点在谁之后就是谁之后', () => {
  assert.deepEqual(reorderAt(['a', 'b', 'c'], 0, 2), ['b', 'a', 'c'], 'a 拖到 b 与 c 之间');
  assert.deepEqual(reorderAt(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b'], 'c 拖到 a 与 b 之间');
});

test('落回原位 = 不动，且返回同一个数组（不制造一次无意义的写）', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(reorderAt(list, 1, 1), list, 'insertAt === from');
  assert.equal(reorderAt(list, 1, 2), list, 'insertAt === from + 1');
  assert.equal(reorderAt(list, 5, 2), list, '起点越界');
  assert.equal(reorderAt(null, 0, 1), null, '不是数组');
});

test('不改原数组', () => {
  const list = ['a', 'b', 'c'];
  reorderAt(list, 0, 3);
  assert.deepEqual(list, ['a', 'b', 'c']);
});
