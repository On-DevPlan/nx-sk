// entry.remove-field（任务 #20）：条目级字段移除——v3 写时复制模型上的三种语义。
// 钉住：扩展行硬删（行+值都没了）、模板行脱离（字典与他条不受影响、
// 序列化/完整度/entryFields 都不含它）、**detach 后连续 updateEntry 不复活**
// （writeStore「values 缺行补模板/占位行」必须跳过 detached 行——本轮最大的坑）、
// restore 值原样回来、内置 source 拒绝、NOT_FOUND、dry-run。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-removefield-');

const store = await import('../../src/core/store.ts');
const entries = await import('../../src/modules/entries/service.ts');

// 播种先落盘一次，条目 id 才稳定（同 contract.test 的口径）。
await store.saveStore(await store.loadStore());

const e1 = await entries.addEntry({ section: 'demo', title: 'rf1', set: { desc: 'hello desc', count: 1 } });
const e2 = await entries.addEntry({ section: 'demo', title: 'rf2', set: { desc: 'other desc' } });

const rowsOf = async (entryId) => {
  const s = await store.loadStore();
  return store.entryStructures(s).get(entryId) || [];
};

test('模板字段移除 = 脱离：行保留 meta 记 detached；序列化/完整度/entryFields 都不含它；字典与他条不受影响', async () => {
  const before = await entries.getEntry('rf1', { section: 'demo' });
  assert.equal(before.values.desc, 'hello desc');
  const totalBefore = before.completeness.total;

  const r = await entries.removeEntryField('rf1', { section: 'demo', key: 'desc' });
  assert.equal(r.detached, true, '返回 detached 标记');
  assert.deepEqual(r.field, { key: 'desc', label: '描述', kind: 'template' });

  // 值不再输出；脱离清单输出它
  assert.equal('desc' in r.values, false, 'values 里不再出现脱离键');
  assert.deepEqual(r.detachedFields, [{ key: 'desc', label: '描述' }]);
  // entryFields 数组出口（listEntries/dump 共用 serializeEntry 输出）不含它，且出身标记在
  const listed = await entries.listEntries({ section: 'demo' });
  const item = listed.entries.find((x) => x.id === e1.id);
  assert.equal(item.entryFields.some((f) => f.key === 'desc'), false, 'entryFields 过滤脱离行');
  const countDef = item.entryFields.find((f) => f.key === 'count');
  assert.equal(countDef.template, true, '模板行带 template=true');
  // 完整度不再统计它（desc 是 normal 策略的模板字段）
  assert.equal(r.completeness.total, totalBefore - 1, '脱离行不计完整度');
  assert.equal(r.missing.some((m) => m.key === 'desc'), false, '不再欠一个「未填」');

  // 行真的还在（restore 的依据），meta 打了标记
  const rows = await rowsOf(e1.id);
  const row = rows.find((x) => x.key === 'desc');
  assert.ok(row, '脱离 = 行保留，不是删行');
  assert.equal(row.meta.detached, 1);

  // 栏目字典与其他条目不受影响
  const dict = await entries.fieldDictionary({ section: 'demo' });
  assert.ok(dict.sections[0].fields.some((f) => f.key === 'desc'), '字典仍声明该模板字段');
  const other = await entries.getEntry(e2.id, { section: 'demo' });
  assert.equal(other.values.desc, 'other desc', '另一条目不受影响');
  assert.deepEqual(other.detachedFields, []);
});

test('detach 后连续两次 updateEntry 不复活（钉 writeStore 跳过逻辑）', async () => {
  await entries.updateEntry('rf1', { section: 'demo', set: { count: 5 } });
  await entries.updateEntry('rf1', { section: 'demo', set: { day: '2026-01-05' } });

  const rows = await rowsOf(e1.id);
  const row = rows.find((x) => x.key === 'desc');
  assert.ok(row, '全量重写后脱离行仍在');
  assert.equal(row.meta.detached, 1, '脱离标记跨重写存活（没被复活成可见行）');
  assert.equal(row.templateFieldId, 'demo:desc', '出身模板不变');

  const got = await entries.getEntry('rf1', { section: 'demo' });
  assert.equal('desc' in got.values, false, '两次保存后 values 仍不含脱离键');
  assert.deepEqual(got.detachedFields, [{ key: 'desc', label: '描述' }]);
  assert.equal(got.values.count, 5, '正常字段照常写');
});

test('已脱离再删报 CONFLICT；--restore 值原样回来（期间经历过全量重写）', async () => {
  await assert.rejects(
    () => entries.removeEntryField('rf1', { section: 'demo', key: 'desc' }),
    /已从本条目移除/,
  );

  const r = await entries.removeEntryField('rf1', { section: 'demo', key: 'desc', restore: true });
  assert.equal(r.restored, true);
  assert.equal(r.values.desc, 'hello desc', 'detach 不动 field_data：恢复即原样回来');
  assert.deepEqual(r.detachedFields, [], '恢复后脱离清单为空');
  const rows = await rowsOf(e1.id);
  assert.equal(rows.find((x) => x.key === 'desc').meta.detached, undefined, 'meta 标记已去掉');

  await assert.rejects(
    () => entries.removeEntryField('rf1', { section: 'demo', key: 'desc', restore: true }),
    /没有被从本条目移除过/,
  );
});

test('扩展字段删除 = 硬删：行与值一起没了，不可恢复', async () => {
  await entries.addEntryField('rf1', { section: 'demo', key: 'tmpx', label: '临时', type: 'text', value: '42' });
  const withExt = await entries.getEntry('rf1', { section: 'demo' });
  assert.equal(withExt.values.tmpx, '42');
  const listedExt = await entries.listEntries({ section: 'demo' });
  const extDef = listedExt.entries.find((x) => x.id === e1.id).entryFields.find((f) => f.key === 'tmpx');
  assert.equal(extDef.template, false, '扩展行带 template=false');

  const r = await entries.removeEntryField('rf1', { section: 'demo', key: 'tmpx' });
  assert.equal(r.removed, true, '返回 removed 标记');
  assert.equal(r.field.kind, 'extension');
  assert.equal('tmpx' in r.values, false, '值没了');
  const listedGone = await entries.listEntries({ section: 'demo' });
  assert.equal(listedGone.entries.find((x) => x.id === e1.id).entryFields.some((f) => f.key === 'tmpx'), false);

  const rows = await rowsOf(e1.id);
  assert.equal(rows.some((x) => x.key === 'tmpx'), false, 'entry_fields 行已硬删');

  await assert.rejects(
    () => entries.removeEntryField('rf1', { section: 'demo', key: 'tmpx', restore: true }),
    /没有字段: tmpx/,
  );
});

test('内置 source 字段（原始资料袋）不许删；未知键 NOT_FOUND', async () => {
  await assert.rejects(
    () => entries.removeEntryField('rf1', { section: 'demo', key: 'source' }),
    /内置字段/,
  );
  await assert.rejects(
    () => entries.removeEntryField('rf1', { section: 'demo', key: 'nosuch' }),
    /没有字段: nosuch/,
  );
});

test('dry-run 三种形态都不落盘；label 也能定位（与 resolveOwnRow 同一口径）', async () => {
  // 模板字段 dry-run：不脱离
  const p1 = await entries.removeEntryField('rf1', { section: 'demo', key: '数量', 'dry-run': true });
  assert.equal(p1.status, 'skipped');
  assert.deepEqual(p1.wouldRemove, { key: 'count', label: '数量', kind: 'template' });
  let got = await entries.getEntry('rf1', { section: 'demo' });
  assert.equal(got.values.count, 5, 'dry-run 没动数据');
  assert.deepEqual(got.detachedFields, []);

  // 脱离 count 后：restore 的 dry-run 也不落盘
  await entries.removeEntryField('rf1', { section: 'demo', key: 'count' });
  const p2 = await entries.removeEntryField('rf1', { section: 'demo', key: 'count', restore: true, 'dry-run': true });
  assert.equal(p2.status, 'skipped');
  assert.equal(p2.wouldRestore.key, 'count');
  got = await entries.getEntry('rf1', { section: 'demo' });
  assert.deepEqual(got.detachedFields, [{ key: 'count', label: '数量' }], '仍处脱离态');

  // 收尾：恢复干净状态，别影响后续断言（本文件内没有后续，纯纪律）
  await entries.removeEntryField('rf1', { section: 'demo', key: 'count', restore: true });
});

test('台账（entry fields）不含已脱离的扩展出身键；list 序列化同样过滤', async () => {
  await entries.addEntryField('rf1', { section: 'demo', key: 'ledgerx', label: '台账键', type: 'text' });
  const dict1 = await entries.fieldDictionary({ section: 'demo' });
  assert.ok(dict1.sections[0].fields.some((f) => f.key === 'ledgerx'), '扩展行进台账');
  await entries.removeEntryField('rf1', { section: 'demo', key: 'ledgerx' });
  const dict2 = await entries.fieldDictionary({ section: 'demo' });
  assert.equal(dict2.sections[0].fields.some((f) => f.key === 'ledgerx'), false, '硬删后退出台账');

  const list = await entries.listEntries({ section: 'demo' });
  const item = list.entries.find((x) => x.id === e1.id);
  assert.ok(Array.isArray(item.detachedFields), 'list 出口同样带 detachedFields（恒输出）');
});
