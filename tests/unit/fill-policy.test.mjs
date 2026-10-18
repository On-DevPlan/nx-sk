import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { FILL_LABELS, FILL_POLICIES, fillPolicy, isExcludedField } = await import('../../src/core/fields.js');
const { completeness, dumpSection, serializeEntry } = await import('../../src/core/render.js');
const { validateFieldDef } = await import('../../src/modules/sections/service.js');

/** 三个照常填 + 一个 optional + 一个 avoid。 */
const mkSection = () => ({
  id: 'job',
  title: '求职',
  description: '',
  order: 10,
  template: 'job',
  titleField: 'name',
  titleLabel: '档案名',
  groups: [{ id: 'basic', title: '基本信息' }],
  fields: [
    { key: 'name', label: '姓名', type: 'text', group: 'basic' },
    { key: 'phone', label: '电话', type: 'text', group: 'basic' },
    { key: 'email', label: '邮箱', type: 'text', group: 'basic' },
    { key: 'lastCompany', label: '上一家公司', type: 'text', group: 'basic', fill: 'avoid' },
    { key: 'hobbies', label: '兴趣爱好', type: 'textarea', group: 'basic', fill: 'optional' },
  ],
});

const mkEntry = (values) => ({
  id: 'e_1', section: 'job', title: '张三', tags: [], createdAt: null, updatedAt: null, values,
});

test('fillPolicy：缺省与非法值都归到 normal（旧数据不用迁移）', () => {
  assert.deepEqual(FILL_POLICIES, ['normal', 'optional', 'avoid']);
  assert.equal(fillPolicy(undefined), 'normal');
  assert.equal(fillPolicy({}), 'normal');
  assert.equal(fillPolicy({ fill: 'normal' }), 'normal');
  assert.equal(fillPolicy({ fill: 'whatever' }), 'normal');
  assert.equal(fillPolicy({ fill: 'avoid' }), 'avoid');
  assert.equal(isExcludedField({ fill: 'optional' }), true);
  assert.equal(isExcludedField({ fill: 'avoid' }), true);
  assert.equal(isExcludedField({}), false);
});

test('完整度：分母只数照常填的字段', () => {
  const s = mkSection();
  const c = completeness(s, mkEntry({ name: '张三', phone: '13800000000' }));
  assert.equal(c.total, 3, 'total 只算 3 个 normal 字段');
  assert.equal(c.filled, 2);
  assert.equal(c.ratio, 67);
});

test('完整度：不填项不进 missing，单独进 excluded', () => {
  const c = completeness(mkSection(), mkEntry({ name: '张三' }));
  assert.deepEqual(c.missing.map((x) => x.key), ['phone', 'email']);
  assert.deepEqual(c.excluded.map((x) => x.key), ['lastCompany', 'hobbies']);
  assert.equal(c.excluded.find((x) => x.key === 'lastCompany').fillLabel, FILL_LABELS.avoid);
  assert.equal(c.excludedFilled, 0);
});

test('完整度：不填项即使填了也不计入分子（否则会超过 100%）', () => {
  const c = completeness(mkSection(), mkEntry({
    name: '张三', phone: '13800000000', email: 'a@b.c',
    lastCompany: '成都晓多', hobbies: '象棋',
  }));
  assert.equal(c.filled, 3);
  assert.equal(c.total, 3);
  assert.equal(c.ratio, 100);
  assert.equal(c.excludedFilled, 2, '填了的不填项单独计数，提示策略该更新了');
});

test('完整度：来回切策略，分子分母都跟着走', () => {
  const s = mkSection();
  const e = mkEntry({ name: '张三', phone: '13800000000' });
  assert.equal(completeness(s, e).ratio, 67);
  s.fields[1].fill = 'optional'; // phone 改成不必填
  const c = completeness(s, e);
  assert.equal(c.total, 2);
  assert.equal(c.filled, 1);
  assert.equal(c.ratio, 50);
  delete s.fields[1].fill; // 改回照常填
  assert.equal(completeness(s, e).total, 3);
});

test('完整度：一个字段都没有时 ratio 是 0，不是 NaN', () => {
  const c = completeness({ fields: [] }, mkEntry({}));
  assert.deepEqual([c.filled, c.total, c.ratio], [0, 0, 0]);
});

test('没有 fill 的旧栏目行为完全不变（向后兼容）', () => {
  const s = mkSection();
  s.fields = s.fields.slice(0, 3);
  const c = completeness(s, mkEntry({ name: '张三' }));
  assert.equal(c.total, 3);
  assert.equal(c.filled, 1);
  assert.equal(c.excluded.length, 0);
});

test('serializeEntry：excluded 与 missing 并列，不混在一起', () => {
  const out = serializeEntry(mkSection(), mkEntry({ name: '张三' }));
  assert.deepEqual(out.missing.map((x) => x.key), ['phone', 'email']);
  assert.deepEqual(out.excluded.map((x) => x.key), ['lastCompany', 'hobbies']);
  assert.equal(out.completeness.excluded, 2);
  assert.equal(out.completeness.excludedFilled, 0);
  assert.equal(out.completeness.total, 3);
});

test('dumpSection：字段字典带上 fill 与 fillLabel，面板才知道哪个格子不用填', () => {
  const d = dumpSection(mkSection(), [mkEntry({ name: 'x' })]);
  const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]));
  assert.equal(byKey.lastCompany.fill, 'avoid');
  assert.equal(byKey.lastCompany.fillLabel, '不填');
  assert.equal(byKey.hobbies.fill, 'optional');
  assert.equal(byKey.name.fill, 'normal');
  assert.equal(byKey.name.fillLabel, '照常填');
});

test('validateFieldDef 放行 fill —— 白名单漏了它就会静默丢失', () => {
  assert.equal(validateFieldDef({ key: 'a', fill: 'avoid' }).fill, 'avoid');
  assert.equal(validateFieldDef({ key: 'b', fill: 'optional' }).fill, 'optional');
});

test('validateFieldDef：normal 不落盘（它是缺省，写上去只是噪音）', () => {
  assert.equal('fill' in validateFieldDef({ key: 'c', fill: 'normal' }), false);
  assert.equal('fill' in validateFieldDef({ key: 'd' }), false);
});

test('validateFieldDef：非法策略报错，不静默忽略', () => {
  assert.throws(() => validateFieldDef({ key: 'e', fill: 'nope' }), /fill 非法/);
});

// —— 渲染层：「不填」不等于「空着」 ——
// `excluded` 是**策略标记**：字段被标成 optional/avoid，就永远是 excluded。
// 但它可能已经被填上值。渲染时若照单全列，一份填满的资料会被报成
// 「另有 7 项已标不填」，自相矛盾（这个 bug 是「容器平台」条目暴露的）。
const { renderEntryGet, renderEntryList } = await import('../../src/modules/entries/service.js');

test('渲染：「不填」只列真的空着的可选字段', () => {
  const s = mkSection();
  const blank = serializeEntry(s, mkEntry({ name: '张三' }));
  const filled = serializeEntry(s, mkEntry({ name: '张三', lastCompany: '某公司', hobbies: '象棋' }));

  assert.match(renderEntryGet(blank), /不填（2）/);
  const filledGet = renderEntryGet(filled);
  assert.ok(!filledGet.includes('不填'), filledGet);
  assert.ok(!filledGet.includes('另有'), filledGet);

  const filledList = renderEntryList({ count: 1, total: 1, entries: [filled] });
  assert.ok(!filledList.includes('不填'), filledList);
});
