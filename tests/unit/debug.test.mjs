// debug（资源引用）字段：coerce / 空值 / seal 形状 / 台账显示 / 写入-读回全链路。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-debug-');

const { debugBehavior } = await import('../../src/core/fields/behaviors/debug.ts');
const { isBlank, isStoredEmpty } = await import('../../src/core/values.ts');
const store = await import('../../src/core/store.ts');
const sections = await import('../../src/modules/sections/service.ts');
const entries = await import('../../src/modules/entries/service.ts');

const def = { key: 'refs', label: '引用', type: 'debug', group: 'g' };

test('coerce：数组 / JSON 串 / 单个 locator / 文档形状都认，非法的丢弃并计入 warnings（不炸）', () => {
  const ok = debugBehavior.coerce(def, ['nx-sk://section/demo', 'nx-sk://entry/e_1']);
  assert.deepEqual(ok, { v: 1, refs: ['nx-sk://section/demo', 'nx-sk://entry/e_1'] });

  const fromJson = debugBehavior.coerce(def, '["nx-sk://file/f_1"]');
  assert.deepEqual(fromJson, { v: 1, refs: ['nx-sk://file/f_1'] });

  const single = debugBehavior.coerce(def, 'nx-sk://section/demo');
  assert.deepEqual(single, { v: 1, refs: ['nx-sk://section/demo'] });

  const doc = debugBehavior.coerce(def, { v: 1, refs: ['nx-sk://entry/e_2'] });
  assert.deepEqual(doc, { v: 1, refs: ['nx-sk://entry/e_2'] });

  const dirty = debugBehavior.coerce(def, ['nx-sk://section/demo', '不是locator', 'demo:name', '']);
  assert.deepEqual(dirty.refs, ['nx-sk://section/demo'], '只留合法 locator');
  assert.deepEqual(dirty.warnings, ['不是locator', 'demo:name'], '非法项进 warnings（含旧复合串：写入点只收规范形态）');

  const dup = debugBehavior.coerce(def, ['nx-sk://entry/e_1', 'nx-sk://entry/e_1']);
  assert.deepEqual(dup.refs, ['nx-sk://entry/e_1'], '去重');
});

test('空值：{refs:[]} 与空串都算「没填」；isStoredEmpty/isBlank 兼容文档形状', () => {
  assert.deepEqual(debugBehavior.coerce(def, ''), { v: 1, refs: [] });
  assert.equal(isStoredEmpty({ v: 1, refs: [] }), true);
  assert.equal(isBlank({ v: 1, refs: [] }), true, '空引用不计完整度分子');
  assert.equal(isBlank({ v: 1, refs: ['nx-sk://section/demo'] }), false);
  assert.equal(isStoredEmpty({ v: 1, refs: ['nx-sk://section/demo'] }), false);
});

test('形状钩子：sensitive 恒 false、subFields 空、reveal 原样、refs 只认 file locator', () => {
  assert.equal(debugBehavior.sensitive({ ...def, sensitive: true }), false, '引用本身不敏感');
  assert.deepEqual(debugBehavior.subFields(def), []);
  const doc = { v: 1, refs: ['nx-sk://file/f_1', 'nx-sk://entry/e_1'] };
  assert.deepEqual(debugBehavior.reveal(def, doc, {}), doc);
  assert.deepEqual(debugBehavior.refs(def, doc), ['f_1'], '附件引用只从 file locator 取');
  assert.deepEqual(debugBehavior.refs(def, null), []);
  assert.deepEqual(debugBehavior.remap(def, doc, new Map([['f_1', 'f_2']])), doc, 'remap 原样（locator 里的 id 重映射不在本期）');
});

test('format：计数 + locator 列表，不展开被引用内容', () => {
  const lines = debugBehavior.format(def, { v: 1, refs: ['nx-sk://section/demo', 'nx-sk://entry/e_1'] }, {});
  assert.equal(lines[0], '引用 2 个资源');
  assert.ok(lines.some((l) => l.includes('nx-sk://section/demo')) && lines.some((l) => l.includes('nx-sk://entry/e_1')));
  assert.equal(debugBehavior.format(def, null, {})[0], '引用 0 个资源');
});

test('全链路：add-field --type debug 建扩展字段 → --set 写 locator → entry get / dump 台账', async () => {
  await store.saveStore(await store.loadStore());
  await sections.addSection({
    id: 'dbgsec', title: '引用栏目',
    fields: [
      { key: 'name', label: '名称', type: 'text', group: 'g' },
      { key: 'refs', label: '引用', type: 'debug', group: 'g', fill: 'optional' },
    ],
    groups: [{ id: 'g', title: 'G' }],
  });
  const created = await entries.addEntry({ section: 'dbgsec', title: '宿主', set: { name: '宿主' } });

  // 条目内 add-field 也认 debug（扩展行走同一条 coerce）
  const af = await entries.addEntryField(created.id, { section: 'dbgsec', key: 'extrefs', label: '扩展引用', type: 'debug', group: 'g' });
  assert.equal(af.addedField.type, 'debug');

  const upd = await entries.updateEntry('宿主', {
    section: 'dbgsec',
    set: {
      refs: JSON.stringify([`nx-sk://entry/${created.id}`, 'nx-sk://section/dbgsec', 'garbage']),
      extrefs: 'nx-sk://section/dbgsec',
    },
  });
  assert.equal(upd.status, 'ok');

  const got = await entries.getEntry('宿主', { section: 'dbgsec' });
  assert.equal(got.fieldTypes.refs, 'debug');
  assert.deepEqual(got.values.refs.refs, [`nx-sk://entry/${created.id}`, 'nx-sk://section/dbgsec']);
  assert.deepEqual(got.values.refs.warnings, ['garbage']);
  assert.deepEqual(got.values.extrefs.refs, ['nx-sk://section/dbgsec'], '扩展 debug 行同样可写');
  // 空引用不算「已填」：refs 是 optional 字段，不进完整度分母
  assert.ok(!got.missing.some((m) => m.key === 'refs'));

  // CLI 台账：计数 + locator 列表（不展开内容）
  const text = entries.renderEntryGet(got);
  assert.ok(text.includes('引用 2 个资源'), text);
  assert.ok(text.includes(`nx-sk://entry/${created.id}`));

  // section dump 的 formatValue 路径：计数 + 列表
  const d = await sections.dump('dbgsec');
  const dumpText = sections.renderSectionDump(d);
  assert.ok(dumpText.includes('引用 2 个：'), dumpText.slice(0, 400));
});
