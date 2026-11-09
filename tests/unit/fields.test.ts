// P2 契约测试：钉住**字段注册表**本身，而不是某个端点的响应。
//
// 这份测试要回答三个问题：
//   1. 清单与注册表是不是同一套键（双向）—— 只查一边会漏掉「多注册了一个 type」；
//   2. 八个钩子是不是每种类型都齐全 —— Record 只管键，不管钩子；
//   3. 几个「现状就是如此、P2 明确不修」的语义有没有被顺手改掉（select 不校验、cell 文案顺序）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_TYPE_LABELS, FIELD_TYPES } from '../../src/shared/fields/types.ts';
import {
  FIELD_BEHAVIOR, FIELD_BEHAVIOR_HOOKS, assertFieldRegistry, behaviorOf,
} from '../../src/core/fields/registry.ts';
import { TABLE_CELL_TYPES } from '../../src/shared/table.ts';

test('注册表键集与 FIELD_TYPES 双向一致（多一个/少一个都红）', () => {
  assert.deepEqual(Object.keys(FIELD_BEHAVIOR).sort(), [...FIELD_TYPES].sort());
});

test('每种类型的八个钩子齐全，cell 是布尔值', () => {
  for (const type of FIELD_TYPES) {
    const behavior: any = FIELD_BEHAVIOR[type];
    for (const hook of FIELD_BEHAVIOR_HOOKS) {
      assert.equal(typeof behavior[hook], 'function', `${type}.${hook} 必须是函数`);
    }
    assert.equal(typeof behavior.cell, 'boolean', `${type}.cell 必须是布尔值`);
  }
});

test('FIELD_TYPE_LABELS 与清单一一对应（面板下拉框不会漏项）', () => {
  assert.deepEqual(Object.keys(FIELD_TYPE_LABELS).sort(), [...FIELD_TYPES].sort());
  for (const type of FIELD_TYPES) assert.equal(typeof FIELD_TYPE_LABELS[type], 'string');
});

test('assertFieldRegistry 启动自检通过（键集 + 钩子 + 空值探针）', () => {
  assert.equal(assertFieldRegistry(), true);
});

test('behaviorOf：未知类型退到 text —— 历史脏数据不该让整个面板/CLI 崩掉', () => {
  assert.equal(behaviorOf('no-such-type'), FIELD_BEHAVIOR.text);
  // 这不是「漏实现的许可」：漏实现由 Record 在 tsc 阶段拦住，这里只兜运行时的旧数据。
  assert.equal(behaviorOf('text'), FIELD_BEHAVIOR.text);
});

test('cell 标记与 TABLE_CELL_TYPES 是同一集合（顺序刻意保留：错误文案要逐字不变）', () => {
  const derived = FIELD_TYPES.filter((t) => FIELD_BEHAVIOR[t].cell).sort();
  assert.deepEqual(derived, [...TABLE_CELL_TYPES].sort());
  // 顺序是可见行为的一部分：shared/table.js 的报错会把这张表 join(' / ') 给用户看。
  assert.deepEqual(TABLE_CELL_TYPES, ['text', 'textarea', 'number', 'bool', 'select', 'date', 'month', 'tags']);
});

test('顶层 select 写入不校验候选：写错原样存下（固定现状，不是缺陷修复）', () => {
  const def = { key: 'level', label: '级别', type: 'select', group: 'other', options: ['高', '低'] };
  assert.equal(FIELD_BEHAVIOR.select.coerce(def, '中'), '中');
  assert.equal(FIELD_BEHAVIOR.select.coerce(def, '  高  '), '  高  ');
  assert.equal(FIELD_BEHAVIOR.select.coerce(def, ''), null);
});

test('coerce 抽查：bool / number / tags / file 的既有语义', () => {
  const bool = { key: 'b', label: '已办', type: 'bool', group: 'other' };
  assert.equal(FIELD_BEHAVIOR.bool.coerce(bool, 'TRUE'), true);
  assert.equal(FIELD_BEHAVIOR.bool.coerce(bool, '否'), false);
  assert.throws(() => FIELD_BEHAVIOR.bool.coerce(bool, '也许'), /需要是\/否/);

  const num = { key: 'n', label: '工时', type: 'number', group: 'other' };
  assert.equal(FIELD_BEHAVIOR.number.coerce(num, ' 2.5 '), 2.5);
  assert.throws(() => FIELD_BEHAVIOR.number.coerce(num, '两小时'), /需要数字/);

  const tags = { key: 't', label: '标签', type: 'tags', group: 'other' };
  assert.deepEqual(FIELD_BEHAVIOR.tags.coerce(tags, 'a，b、c'), ['a', 'b', 'c']);
  const limited = { ...tags, maxItems: 2 };
  assert.throws(() => FIELD_BEHAVIOR.tags.coerce(limited, 'a，b、c'), /最多 2 项/);

  const file = { key: 'f', label: '附件', type: 'file', group: 'other' };
  assert.deepEqual(FIELD_BEHAVIOR.file.coerce(file, 'f_a, f_b'), ['f_a', 'f_b']);
  assert.equal(FIELD_BEHAVIOR.file.coerce(file, '  '), null);
});

test('refs 口径固定：原始资料正文内嵌图片只在导出打包时算（附件中心不算）', () => {
  const def = { key: 'src', label: '资料', type: 'source', group: 'other' };
  const value = [{ kind: 'text', text: '![图](f_text)' }, { kind: 'file', fileId: 'f_file' }];
  // 默认（entries / 附件中心）：只看 file item
  assert.deepEqual(FIELD_BEHAVIOR.source.refs(def, value), ['f_file']);
  // 导出打包：正文里的图片也要算，否则包导出后记录成了没图的文字
  assert.deepEqual(
    FIELD_BEHAVIOR.source.refs(def, value, { sourceTextImages: true }).sort(),
    ['f_file', 'f_text'],
  );
});
