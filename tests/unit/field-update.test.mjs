// entry.field-update：条目内字段属性（显示名 / 描述）的就地更新——任务 #24 验收反馈。
// 钉住写时复制纪律：只打条目自己的结构行（label/hint/spec 同步），
// 栏目字典、其他条目、字段值都不许动；相同值不写盘，dry-run 不落盘。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-fieldupdate-');

const store = await import('../../src/core/store.ts');
const entries = await import('../../src/modules/entries/service.ts');

const e1 = await entries.addEntry({ section: 'demo', title: 'fu1' });
const e2 = await entries.addEntry({ section: 'demo', title: 'fu2' });
await entries.addEntryField('fu1', { section: 'demo', key: 'budget', label: '预算', type: 'number', value: '3000' });
await entries.addEntryField('fu2', { section: 'demo', key: 'budget', label: '预算', type: 'number', value: '99' });

async function row(entryId, key) {
  const s = await store.loadStore();
  return (store.entryStructures(s).get(entryId) || []).find((r) => r.key === key);
}

test('扩展字段：改显示名只落本条目的结构行（label + spec 同步），值不动', async () => {
  const got = await entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'budget', label: '预算（万元）', hint: '税后口径' });
  assert.equal(got.updated, true);
  assert.equal(got.field.label, '预算（万元）');
  assert.equal(got.values.budget, 3000, '值原样');

  const r1 = await row(e1.id, 'budget');
  assert.equal(r1.label, '预算（万元）', '镜像列更新');
  assert.equal(r1.spec.label, '预算（万元）', 'spec 是 FieldDef 保真源，必须同步');
  assert.equal(r1.spec.hint, '税后口径');

  const r2 = await row(e2.id, 'budget');
  assert.equal(r2.label, '预算', '同栏目其他条目不受影响');

  const s = await store.loadStore();
  const demo = s.sections.find((x) => x.id === 'demo');
  assert.equal(demo.fields.some((f) => f.key === 'budget'), false, '栏目字典不被污染');
});

test('模板字段：条目级改名不影响字典与其他条目（写时复制）', async () => {
  const s0 = await store.loadStore();
  const sec = s0.sections.find((x) => x.id === 'demo');
  const tpl = sec.fields[0];
  assert.ok(tpl, '样例栏目有模板字段');
  const other = s0.entries.find((e) => e.id === e2.id);
  assert.ok((store.entryStructures(s0).get(other.id) || []).some((r) => r.key === tpl.key), '模板行已实例化');

  await entries.updateEntryFieldDef('fu1', { section: 'demo', key: tpl.key, label: '只属于 fu1 的名字' });
  const r1 = await row(e1.id, tpl.key);
  const r2 = await row(e2.id, tpl.key);
  assert.equal(r1.label, '只属于 fu1 的名字');
  assert.equal(r2.label, tpl.label, '别的条目还是模板名');

  const s1 = await store.loadStore();
  assert.equal(s1.sections.find((x) => x.id === 'demo').fields.find((f) => f.key === tpl.key).label, tpl.label, '字典不跟着改');
});

test('resolve 读到新名字：spec 与镜像列没分叉', async () => {
  const resources = await import('../../src/modules/resources/service.ts');
  const loc = `nx-sk://field/${e1.id}/budget`;
  const info = await resources.resolveLocator(loc);
  assert.equal(info.title, '预算（万元）', '资源定位读的是 spec.label');
});

test('校验：未知字段 NOT_FOUND、空 label、没给属性、内置 source 都拒绝', async () => {
  await assert.rejects(
    () => entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'nope', label: 'x' }),
    /没有字段/,
  );
  await assert.rejects(() => entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'budget', label: '  ' }), /不能为空/);
  await assert.rejects(() => entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'budget' }), /没有要改的属性/);
  await assert.rejects(
    () => entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'source', label: 'x' }),
    /内置字段/,
  );
});

test('值没变 → skipped unchanged，不写盘；dry-run 不落盘', async () => {
  const same = await entries.updateEntryFieldDef('fu1', { section: 'demo', key: 'budget', label: '预算（万元）', hint: '税后口径' });
  assert.equal(same.status, 'skipped');
  assert.equal(same.reason, 'unchanged');

  const preview = await entries.updateEntryFieldDef('fu2', { section: 'demo', key: 'budget', label: '影子名', 'dry-run': true });
  assert.equal(preview.status, 'skipped');
  assert.equal(preview.wouldUpdate.label, '影子名');
  assert.equal((await row(e2.id, 'budget')).label, '预算', 'dry-run 没写');
});
