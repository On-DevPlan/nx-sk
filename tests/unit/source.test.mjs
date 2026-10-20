import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { normalizeSourceItems, sourceItemSummary } = await import('../../src/core/source.js');
const { getTemplate, instantiateTemplate } = await import('../../src/core/fields.js');
const { applySpec } = await import('../../src/runtime/spec.js');

// source 字段 = 每个栏目的「原始资料袋」：杂乱资料先原样收下，之后再按字段字典整理。

test('每个模板实例化后都自带「原始资料」袋（KV 表除外）', () => {
  for (const id of ['job', 'projects', 'internships', 'campus', 'deploy']) {
    const t = getTemplate(id);
    assert.ok(t, `${id} 模板应存在`);
    const inst = instantiateTemplate(id, { id: 'x' });
    const src = inst.fields.find((f) => f.type === 'source');
    assert.ok(src, `${id} 应有 source 字段`);
    assert.equal(src.key, 'source');
    assert.equal(src.fill, 'optional', '暂存区不该计入完整度');
    assert.ok(inst.groups.some((g) => g.id === 'source'), `${id} 应有 source 分组`);
  }
  // KV 栏目是「一行一个键值对」，加字段就散了
  const kv = instantiateTemplate('secret', { id: 'k' });
  assert.ok(!kv.fields.some((f) => f.type === 'source'));
});

test('归一：三种入口都认，空壳丢掉，id/时间自动补', () => {
  const fromArray = normalizeSourceItems([{ kind: 'text', text: '第一段' }, { kind: 'text', text: '   ' }]);
  assert.equal(fromArray.length, 1, '空 item 丢掉');
  assert.ok(fromArray[0].id, 'id 自动生成');
  assert.ok(fromArray[0].addedAt, '时间自动补');
  assert.equal(fromArray[0].name, '第一段', '名字缺省按内容推断');

  const fromJson = normalizeSourceItems('[{"kind":"url","url":"https://a.example"}]');
  assert.equal(fromJson[0].kind, 'url');

  const fromText = normalizeSourceItems('随手记一句');
  assert.equal(fromText.length, 1);
  assert.equal(fromText[0].kind, 'text');
  assert.equal(fromText[0].text, '随手记一句');

  assert.equal(normalizeSourceItems(null), null);
  assert.equal(normalizeSourceItems('  '), null);
  assert.equal(sourceItemSummary(fromText[0]), '随手记一句');
});

test('写入读回：文字 / 网址 / 标记锚点 / 移除', async () => {
  await sections.addSection({ id: 'src1', title: '资料段', template: 'projects' });
  await entries.addEntry({ section: 'src1', title: '样例', set: { name: '样例' } });

  const a = await entries.addSourceItem('样例', { section: 'src1', text: '邮件原文\n第二行', name: '分配邮件' });
  assert.equal(a.added.kind, 'text');
  const b = await entries.addSourceItem('样例', { section: 'src1', url: 'https://example.com/x' });
  assert.equal(b.added.kind, 'url');

  let got = await entries.getSource('样例', { section: 'src1' });
  assert.equal(got.count, 2);
  assert.equal(got.items[0].text, '邮件原文\n第二行', '原文一字不改');

  // 标锚点：这条资料已经整理到哪些字段
  const u = await entries.updateSourceItem('样例', { section: 'src1', id: a.added.id, mapped: ['phone', 'email'] });
  assert.deepEqual(u.updated.mapped, ['phone', 'email']);
  got = await entries.getSource('样例', { section: 'src1' });
  assert.deepEqual(got.items[0].mapped, ['phone', 'email']);

  await entries.removeSourceItem('样例', { section: 'src1', id: b.added.id });
  got = await entries.getSource('样例', { section: 'src1' });
  assert.equal(got.count, 1);
  assert.equal(got.items[0].id, a.added.id);
});

test('文件进袋：先进附件库，袋里只留引用；原件不搬走', async () => {
  await sections.addSection({ id: 'src2', title: '文件段', template: 'projects' });
  await entries.addEntry({ section: 'src2', title: '带文件', set: { name: '带文件' } });
  const dir = await mkdtemp(join(tmpdir(), 'nx-sk-src-'));
  const p = join(dir, '截图.png');
  await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const r = await entries.addSourceItem('带文件', { section: 'src2', file: p, name: '控制台截图' });
  assert.equal(r.added.kind, 'file');
  assert.ok(r.added.fileId, '袋里留附件 id');

  const got = await entries.getSource('带文件', { section: 'src2' });
  assert.equal(got.items[0].fileId, r.added.fileId);
  assert.ok(got.files[r.added.fileId], '附件信息要解析出来（名字/路径），否则只剩一串 id');
  assert.equal(got.files[r.added.fileId].name, '截图.png');
});

test('source ensure：给缺 source 字段的栏目补上，KV 表不加', async () => {
  await sections.addSection({ id: 'nosrc', title: '老栏目', fields: [{ key: 'a', label: 'A', type: 'text' }] });
  const before = await sections.getSection('nosrc');
  assert.ok(!before.fieldList.some((f) => f.type === 'source'), '造数据：老栏目没有 source 字段');

  const r = await entries.ensureSourceFields();
  assert.ok(r.added.includes('nosrc'));
  const after = await sections.getSection('nosrc');
  const src = after.fieldList.find((f) => f.type === 'source');
  assert.ok(src, '补上了');
  assert.equal(src.fill, 'optional');
  assert.ok(after.groupList.some((g) => g.id === 'source'), '分组也补上');

  // 幂等：再跑一次没有可补的
  const again = await entries.ensureSourceFields();
  assert.deepEqual(again.added, []);
});

test('CLI 渲染：source get 一条一行，带类型与整理去向', async () => {
  const got = await entries.getSource('样例', { section: 'src1' });
  const out = entries.renderSourceGet(got);
  assert.match(out, /原始资料 1 条/, out);
  assert.match(out, /\[文字\] 分配邮件/, out);
  assert.match(out, /已整理到 phone、email/, out);
  assert.match(out, /邮件原文/, out);
});

test('数组型 flag 的逗号要真的切（--unset a,b / --mapped a,b）', () => {
  const action = { id: 'x', flags: { unset: { type: 'array' }, mapped: { type: 'array' } } };
  assert.deepEqual(applySpec(action, { unset: 'a,b' }).unset, ['a', 'b']);
  assert.deepEqual(applySpec(action, { unset: ['a,b'] }).unset, ['a', 'b']);
  assert.deepEqual(applySpec(action, { unset: ['a', 'b'] }).unset, ['a', 'b']);
  assert.deepEqual(applySpec(action, { unset: 'a' }).unset, ['a']);
  assert.deepEqual(applySpec(action, { mapped: 'phone,email' }).mapped, ['phone', 'email']);
});

// —— 冲突以新的为准、旧的留痕 ——
// 同名即冲突（同一件事有了新版本）：时间新的那条是「当前版本」，
// 旧的**不删**（原始证据要留痕），只被标成 superseded 并指到取代它的那条。

test('同名冲突：新的胜出，旧的留痕（不删）', async () => {
  await sections.addSection({ id: 'src3', title: '冲突段', template: 'projects' });
  await entries.addEntry({ section: 'src3', title: '冲突样例', set: { name: '冲突样例' } });

  const old1 = await entries.addSourceItem('冲突样例', {
    section: 'src3', text: '密码是 OldPass1', name: '分配邮件', at: '2026-10-01',
  });
  const new1 = await entries.addSourceItem('冲突样例', {
    section: 'src3', text: '密码是 NewPass2', name: '分配邮件', at: '2026-10-19',
  });

  const got = await entries.getSource('冲突样例', { section: 'src3' });
  assert.equal(got.count, 2, '旧的一条不删');
  assert.equal(got.current, 1, '当前版本只有一条');
  assert.equal(got.superseded, 1);
  const old = got.items.find((i) => i.id === old1.added.id);
  const cur = got.items.find((i) => i.id === new1.added.id);
  assert.equal(old.superseded, true, '旧的被标为已取代');
  assert.equal(old.supersededBy, cur.id, '旧的指到取代它的那条');
  assert.equal(cur.superseded, undefined, '新的不被标取代');
  assert.equal(old.text, '密码是 OldPass1', '旧的原文一字不改（留痕）');
});

test('时间说了算：--at 决定谁是新的（入袋时间不同不算数）', async () => {
  const a = await entries.addSourceItem('冲突样例', {
    section: 'src3', text: '后加的但更旧', name: '同名字', at: '2026-01-01',
  });
  const b = await entries.addSourceItem('冲突样例', {
    section: 'src3', text: '先加的但更新', name: '同名字', at: '2026-10-19',
  });
  const got = await entries.getSource('冲突样例', { section: 'src3' });
  const older = got.items.find((i) => i.id === a.added.id);
  const newer = got.items.find((i) => i.id === b.added.id);
  assert.equal(older.superseded, true, '资料时间更旧的被取代（哪怕它后入袋）');
  assert.equal(newer.superseded, undefined);
  assert.equal(older.supersededBy, newer.id);
});

test('显式取代：--supersedes 把旧条标为留痕（名字不同也能用）', async () => {
  const x = await entries.addSourceItem('冲突样例', { section: 'src3', text: '原始密码', name: '旧记录' });
  await entries.addSourceItem('冲突样例', {
    section: 'src3', text: '新密码', name: '新记录', supersedes: x.added.id,
  });
  const got = await entries.getSource('冲突样例', { section: 'src3' });
  const old = got.items.find((i) => i.id === x.added.id);
  assert.equal(old.superseded, true, '被显式取代的旧条留痕');
  assert.equal(got.items.find((i) => i.name === '新记录').superseded, undefined);
});

test('CLI 渲染：旧的标「已被取代，留痕」，并报当前/留痕条数', async () => {
  const got = await entries.getSource('冲突样例', { section: 'src3' });
  const out = entries.renderSourceGet(got);
  assert.match(out, /已被取代，留痕/, out);
  assert.match(out, /留痕可查/, out);
});
