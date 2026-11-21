// grill（Grill & Ack）字段契约测试：值形状、补全规则、ack 不可伪造、CLI 渲染。
//
// 这些断言故意从**最小 AI 输入**出发：agent 经常只写 `{questions:[…]}`，
// 面板必须能把它稳定成完整的 GrillDoc，而不是要求它记住所有可选键。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRILL_SCHEMA,
  formatGrill,
  grillProgress,
  grillSummary,
  parseGrill,
} from '../../src/shared/grill.ts';
import { FIELD_BEHAVIOR } from '../../src/core/fields/registry.ts';
import { inferFieldType } from '../../src/core/fields/policy.ts';

const def = { key: 'grill', label: '对齐确认', type: 'grill', group: 'rich' };

test('最小输入：问题数组 / JSON 串都归一成 GrillDoc，kind 别名与推荐项都接住', () => {
  const fromArray = parseGrill([
    {
      id: 'scope',
      type: 'radio',
      title: '留在服务里还是拆工作流？',
      options: [
        { value: 'inside', label: '留在服务里' },
        { value: 'workflow', label: '独立工作流', recommended: true },
      ],
      answer: 'inside',
    },
    { type: 'textarea', title: '补充', answer: '先留服务内' },
  ]);
  assert.equal(fromArray.schema, GRILL_SCHEMA);
  assert.equal(fromArray.questions[0].kind, 'single');
  assert.equal(fromArray.questions[0].required, true);
  assert.equal(fromArray.questions[0].options[1].recommended, true);
  assert.equal(fromArray.questions[1].kind, 'text');
  assert.equal(fromArray.questions[1].required, true);

  const fromString = parseGrill(JSON.stringify({ questions: [{ type: 'bool', title: '继续？', answer: '是' }] }));
  assert.equal(fromString.questions[0].kind, 'confirm');
  assert.equal(fromString.questions[0].answer, true);
});

test('问题默认必答；required:false / optional:true 才是可选；多选接受数组和顿号串', () => {
  const doc = parseGrill({
    questions: [
      { title: '默认', type: 'text' },
      { title: '可选', type: 'text', required: false },
      { title: '可选二', type: 'text', optional: true },
      { title: '多选', type: 'checkbox', options: ['A', 'B', 'C'], answer: 'A、C' },
    ],
  });
  assert.deepEqual(doc.questions.map((q) => q.required), [true, false, false, true]);
  assert.deepEqual(doc.questions[3].answer, ['A', 'C']);
  assert.equal(grillProgress(doc).total, 2);
  assert.equal(grillProgress(doc).optional, 2);
});

test('ack 不能凭 ai 自己写 status 伪造：必答没答完强制 pending', () => {
  const unanswered = parseGrill({
    questions: [{ title: '必须答', type: 'text' }],
    ack: { status: 'acknowledged', at: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(unanswered.ack.status, 'pending');
  assert.equal(unanswered.ack.at, undefined);

  const answered = parseGrill({
    questions: [{ title: '必须答', type: 'text', answer: 'OK' }],
    ack: { status: 'acknowledged', at: '2026-01-01T00:00:00.000Z', by: 'web' },
  });
  assert.equal(answered.ack.status, 'acknowledged');
  assert.equal(answered.ack.answered, 1);
  assert.equal(answered.ack.total, 1);
  assert.equal(answered.ack.at, '2026-01-01T00:00:00.000Z');
  assert.equal(answered.ack.by, 'web');
});

test('自由补充、原话与说明保留；坏 JSON / 非对象抛可读错误', () => {
  const doc = parseGrill({
    title: '对齐单',
    intro: '先确认范围',
    prompt: '原话不要丢',
    freeform: '还有日志保留',
    questions: [],
  });
  assert.equal(doc.title, '对齐单');
  assert.equal(doc.prompt, '原话不要丢');
  assert.equal(doc.freeform, '还有日志保留');
  assert.throws(() => parseGrill('{ 不是 JSON'), /JSON/);
  assert.throws(() => parseGrill(42), /JSON 对象/);
});

test('behavior：coerce 空值落 null、坏值报字段名；format / refs / cell 口径固定', () => {
  assert.equal(FIELD_BEHAVIOR.grill.coerce(def, ''), null);
  assert.equal(FIELD_BEHAVIOR.grill.coerce(def, {}), null);
  assert.throws(() => FIELD_BEHAVIOR.grill.coerce(def, '{ 不是 JSON'), /字段「对齐确认」/);
  const value = FIELD_BEHAVIOR.grill.coerce(def, {
    questions: [
      { title: '范围', type: 'single', options: ['保留', '拆分'], answer: '拆分', note: '先留一条路' },
      { title: '验收', type: 'text', answer: '全链路通过' },
    ],
    freeform: '日志保留 7 天',
    ack: { status: 'acknowledged', at: '2026-01-01T00:00:00.000Z', by: 'web' },
  }) as any;
  assert.equal(value.ack.status, 'acknowledged');
  assert.deepEqual(FIELD_BEHAVIOR.grill.format(def, value, {}), [
    '已确认 · 必答 2/2 · 2026-01-01T00:00:00.000Z',
    '  [单选] 范围',
    '    回答: 拆分',
    '    备注: 先留一条路',
    '  [填空] 验收',
    '    回答: 全链路通过',
    '  补充: 日志保留 7 天',
  ]);
  assert.deepEqual(FIELD_BEHAVIOR.grill.refs(def, value), []);
  assert.equal(FIELD_BEHAVIOR.grill.cell, false);
  // 只有标题的文档也是合法对齐单，不能被当成「密文 blob」吞掉
  const titleOnly = FIELD_BEHAVIOR.grill.reveal(def, { title: '只有标题' }, {}) as any;
  assert.equal(titleOnly.title, '只有标题');
  assert.equal(titleOnly.ack.status, 'pending');
  assert.equal(formatGrill(parseGrill(null))[0], '待确认 · 必答 0/0');
  assert.equal(grillSummary(value), '已确认 2/2');
});

test('类型推断：带 schema 或 questions 的 JSON 串自动登记成 grill，不误伤普通文本', () => {
  assert.equal(inferFieldType(JSON.stringify({ questions: [{ title: 'x' }] })), 'grill');
  assert.equal(inferFieldType({ schema: GRILL_SCHEMA, questions: [] }), 'grill');
  assert.equal(inferFieldType('{"questions":[]}'), 'grill');
  assert.equal(inferFieldType(['标签一', '标签二']), 'tags');
  assert.equal(inferFieldType('a,b'), 'text');
  assert.equal(inferFieldType('普通文字'), 'text');
});
