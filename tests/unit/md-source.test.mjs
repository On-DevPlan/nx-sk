// 待办的**写回**：预览里点勾选框 = 改正文那一行。
//
// 这里钉的是「改错地方」这类错——它不会报错，只会让用户某天发现自己别处的文字被动了：
//   - 行号差一（解析器给的是 1 起算）
//   - 嵌套 / 有序列表的缩进与标记被吃掉
//   - 正文里普通的 `[x]`（不在行首列表里）被当成复选框
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { toggleTaskAtLine, taskStats } = await import('../../src/web/frontend/mdSource.js');

test('只翻转指定那一行，其余行原样', () => {
  const text = ['- [ ] 一', '- [ ] 二', '- [ ] 三'].join('\n');
  assert.equal(
    toggleTaskAtLine(text, 2),
    ['- [ ] 一', '- [x] 二', '- [ ] 三'].join('\n'),
  );
});

test('已完成再点一下回到未完成（大写 X 也认）', () => {
  assert.equal(toggleTaskAtLine('- [x] 完事', 1), '- [ ] 完事');
  assert.equal(toggleTaskAtLine('- [X] 完事', 1), '- [ ] 完事');
});

test('嵌套与有序列表：缩进、序号、标记都不动', () => {
  const text = ['  * [ ] 子项', '1. [ ] 第一步', '+ [x] 已做'].join('\n');
  assert.equal(toggleTaskAtLine(text, 1), ['  * [x] 子项', '1. [ ] 第一步', '+ [x] 已做'].join('\n'));
  assert.equal(toggleTaskAtLine(text, 2), ['  * [ ] 子项', '1. [x] 第一步', '+ [x] 已做'].join('\n'));
  assert.equal(toggleTaskAtLine(text, 3), ['  * [ ] 子项', '1. [ ] 第一步', '+ [ ] 已做'].join('\n'));
});

test('不是任务项的行、越界行号：原样返回（宁可什么都不发生）', () => {
  const text = ['## 标题 [x] 不是复选框', '- 普通列表', '- [ ] 真的待办'].join('\n');
  assert.equal(toggleTaskAtLine(text, 1), text, '行首不是列表标记，不能动');
  assert.equal(toggleTaskAtLine(text, 2), text);
  assert.equal(toggleTaskAtLine(text, 0), text, '行号 0 是无效值');
  assert.equal(toggleTaskAtLine(text, 99), text);
  assert.equal(toggleTaskAtLine('', 1), '');
  assert.equal(toggleTaskAtLine(null, 1), '');
});

test('CRLF 的行尾不被改写吞掉', () => {
  assert.equal(toggleTaskAtLine('- [ ] a\r\n- [ ] b', 1), '- [x] a\r\n- [ ] b');
});

test('taskStats：总数与已完成数', () => {
  const text = ['# 标题', '- [ ] 一', '  - [x] 二', '1. [X] 三', '- 普通项'].join('\n');
  assert.deepEqual(taskStats(text), { total: 3, done: 2 });
  assert.deepEqual(taskStats('没有待办'), { total: 0, done: 0 });
  assert.deepEqual(taskStats(null), { total: 0, done: 0 });
});
