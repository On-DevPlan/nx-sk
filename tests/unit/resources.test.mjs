// resource.search / resource.resolve：debug 字段与前端搜索面板的共用后端。
// 四类资源的命中与过滤、resolve 的存在性/摘要/密文打码、坏链 NOT_FOUND 不静默。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-res-');

const store = await import('../../src/core/store.ts');
const sections = await import('../../src/modules/sections/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const res = await import('../../src/modules/resources/service.ts');

await store.saveStore(await store.loadStore());

await sections.addSection({
  id: 'ressec', title: '资源栏目',
  fields: [
    { key: 'title2', label: '标题', type: 'text', group: 'g' },
    { key: 'pw', label: '口令', type: 'secret', group: 'g' },
  ],
  groups: [{ id: 'g', title: 'G' }],
});
const e1 = await entries.addEntry({ section: 'ressec', title: '甲条目', set: { title2: '甲条目', pw: 's3cret-口令' } });
await entries.addEntry({ section: 'ressec', title: '乙条目', set: { title2: '乙条目' } });
// 扩展字段（不在字典的行）
await entries.addEntryField(e1.id, { section: 'ressec', key: 'extra', label: '扩展键', type: 'text', group: 'g' });
// 附件记录（没有物理文件也要能 resolve 出「记录在、文件丢」）
await store.mutateStore((s) => {
  s.files.push({ id: 'f_res', category: 'document', name: 'res.pdf', rel: 'document/res.pdf',
    originalName: 'res.pdf', ext: '.pdf', bytes: 3, sha256: 'sha-res', sourcePath: '', mode: 'copy',
    tags: ['样例'], note: '资源检索用', createdAt: null, updatedAt: null });
});

test('search：四类都能命中，locator 可再被 parse 回去', async () => {
  const all = await res.searchResources({});
  assert.ok(all.count >= 8, `全量检索应覆盖四类：${all.count}`);
  for (const item of all.items) {
    const parts = (await import('../../src/shared/locator.ts')).parseLocator(item.locator);
    assert.ok(parts, `命中项的 locator 必须可解析: ${item.locator}`);
    assert.equal(parts.kind, item.kind);
  }

  const byQ = await res.searchResources({ q: '甲' });
  assert.ok(byQ.items.some((x) => x.kind === 'entry' && x.title === '甲条目'));

  const byKind = await res.searchResources({ kind: 'file' });
  assert.ok(byKind.items.every((x) => x.kind === 'file') && byKind.items.some((x) => x.title === 'res.pdf'));

  const bySection = await res.searchResources({ section: 'ressec', kind: 'field' });
  const keys = bySection.items.map((x) => x.key);
  assert.ok(keys.includes('title2') && keys.includes('pw'), `字典字段要能搜到：${keys}`);
  assert.ok(keys.includes('extra'), '条目扩展行也要能搜到');
  assert.ok(bySection.items.every((x) => x.sectionId === 'ressec'), '--section 限定生效');

  const notFoundSec = await res.searchResources({ section: 'nope' }).catch((e) => e);
  assert.equal(notFoundSec.code, 'NOT_FOUND');
});

test('resolve：section / entry / file 的摘要与存在性', async () => {
  const sec = await res.resolveLocator('nx-sk://section/ressec');
  assert.equal(sec.kind, 'section');
  assert.equal(sec.exists, true);
  assert.equal(sec.entryCount, 2);
  assert.deepEqual(sec.aliases, ['ressec']);

  const ent = await res.resolveLocator(`nx-sk://entry/${e1.id}`);
  assert.equal(ent.title, '甲条目');
  assert.equal(ent.sectionTitle, '资源栏目');
  assert.ok(ent.completeness && typeof ent.completeness.ratio === 'number');

  const file = await res.resolveLocator('nx-sk://file/f_res');
  assert.equal(file.name, 'res.pdf');
  assert.equal(file.physicalExists, false, '台账在、物理文件不在要如实报告');

  await assert.rejects(res.resolveLocator('nx-sk://section/ghost'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(res.resolveLocator('nx-sk://entry/e_ghost'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(res.resolveLocator('乱七八糟'), (e) => e.code === 'INVALID_INPUT');
});

test('resolve：field 三类形态——条目行值（密文默认打码）、模板字段、坏链', async () => {
  const row = await res.resolveLocator(`nx-sk://field/${e1.id}/pw`);
  assert.equal(row.kind, 'field');
  assert.equal(row.sensitive, true);
  assert.equal(row.masked, true, '默认打码');
  assert.notEqual(String(row.value).includes('s3cret'), '打码后看不到原文');

  const revealed = await res.resolveLocator(`nx-sk://field/${e1.id}/pw`, { reveal: true });
  assert.equal(revealed.masked, false);
  assert.equal(revealed.value, 's3cret-口令');

  const tpl = await res.resolveLocator('nx-sk://field/ressec/title2');
  assert.equal(tpl.entryId, null);
  assert.ok(/模板字段/.test(String(tpl.note)));
  assert.deepEqual(tpl.aliases, ['ressec:title2', 'nx-sk://field/ressec/title2'], '等价旧写法 = 复合串');

  // 旧复合串直接进 resolve 也认（兼容读旧格式，不改磁盘）
  const legacy = await res.resolveLocator('ressec:title2');
  assert.equal(legacy.exists, true);
  assert.equal(legacy.key, 'title2');

  const plain = await res.resolveLocator(`nx-sk://field/${e1.id}/extra`);
  assert.equal(plain.sensitive, false);

  await assert.rejects(res.resolveLocator('nx-sk://field/ressec/ghostkey'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(res.resolveLocator(`nx-sk://field/${e1.id}/ghostkey`), (e) => e.code === 'NOT_FOUND');
});

test('CLI 渲染不炸且带 locator', async () => {
  const s = await res.searchResources({ q: '甲' });
  const text = res.renderResourceSearch(s);
  assert.ok(text.includes('nx-sk://entry/'), text);
  const r = await res.resolveLocator('nx-sk://section/ressec');
  assert.ok(res.renderResourceResolve(r).includes('资源栏目'));
});
