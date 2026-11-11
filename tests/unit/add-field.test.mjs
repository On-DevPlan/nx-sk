// entry.add-field：条目内扩展字段（显式类型/分组）——v3 写时复制的正门入口。
// 钉住：只落条目行、字典零污染、初值走同一条封装链、重复/未知类型/未知分组的拒绝语义。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-addfield-');

const store = await import('../../src/core/store.ts');
const entries = await import('../../src/modules/entries/service.ts');

const created = await entries.addEntry({ section: 'demo', title: 'af1' });

test('add-field 只落条目行：扩展行 template_field_id=NULL，type/group 进 spec，字典不被污染', async () => {
  const got = await entries.addEntryField('af1', { section: 'demo', key: 'budget', label: '预算', type: 'number', group: 'basic' });
  assert.equal(got.addedField.type, 'number');
  assert.equal(got.addedField.group, 'basic');
  assert.equal(got.valueSet, false, '没给初值');

  const s = await store.loadStore();
  const rows = store.entryStructures(s).get(created.id);
  const row = rows.find((r) => r.key === 'budget');
  assert.ok(row, '条目行建出来了');
  assert.equal(row.templateFieldId, null, '扩展字段没有模板出身');
  assert.equal(row.spec.type, 'number');
  assert.equal(row.spec.group, 'basic');
  assert.equal(row.position, rows.length - 1, '追加在页面尾部');

  const demo = s.sections.find((x) => x.id === 'demo');
  assert.equal(demo.fields.some((f) => f.key === 'budget'), false, '栏目字典不被 add-field 污染');
});

test('初值顺手给：number 归真、读回即得', async () => {
  const got = await entries.addEntryField('af1', { section: 'demo', key: 'target', label: '目标额', type: 'number', value: '3000' });
  assert.equal(got.valueSet, true);
  assert.equal(got.values.target, 3000, 'number 类型把 "3000" 归成数字');
});

test('重复键报冲突并指路写值', async () => {
  await assert.rejects(
    () => entries.addEntryField('af1', { section: 'demo', key: 'target' }),
    /条目已有字段「target」.*entry update .* --set target=值/s,
  );
});

test('未知类型/未知分组：写盘前就报掉', async () => {
  await assert.rejects(
    () => entries.addEntryField('af1', { section: 'demo', key: 'x1', type: 'weird' }),
    /未知字段类型/,
  );
  await assert.rejects(
    () => entries.addEntryField('af1', { section: 'demo', key: 'x2', group: 'nogroup' }),
    /没有分组/,
  );
});

test('缺省分组落首个分组；dry-run 不落盘', async () => {
  const preview = await entries.addEntryField('af1', { section: 'demo', key: 'ghost', label: '影子', 'dry-run': true });
  assert.equal(preview.status, 'skipped');
  assert.equal(preview.wouldAddField.group, 'basic', '缺省 = 首个分组');
  const s = await store.loadStore();
  const rows = store.entryStructures(s).get(created.id);
  assert.equal(rows.some((r) => r.key === 'ghost'), false, 'dry-run 没建行');

  const real = await entries.addEntryField('af1', { section: 'demo', key: 'plain' });
  assert.equal(real.addedField.type, 'text', '缺省类型 text');
  assert.equal(real.addedField.label, 'plain', '标签缺省同 key');
});

test('显式 secret 类型：初值落盘即密文（读回原文）', async () => {
  const got = await entries.addEntryField('af1', { section: 'demo', key: 'afToken', label: '令牌', type: 'secret', value: 'abc123' });
  assert.equal(got.values.afToken, 'abc123', 'getEntry 默认解密');
  assert.equal(got.fieldTypes.afToken, 'secret');
  const masked = await entries.getEntry('af1', { section: 'demo', mask: true });
  assert.notEqual(masked.values.afToken, 'abc123', '--mask 下不是明文');
});
