// 栏目 ZIP 导出 / 导入：往返、冲突策略、附件去重、凭据打码。
//
// 这里走的是真实 store（临时目录）与真实附件文件，不打桩——
// 这条链最容易错的地方都在「引用重映射」和「密文再加密」，打桩会把这些掩盖掉。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { readZip } = await import('../../src/core/zip.js');
const { isEncryptedPackage } = await import('../../src/core/securezip.js');
const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const files = await import('../../src/modules/files/service.js');
const transfer = await import('../../src/modules/transfer/service.js');

const SRC = 'srcsec';
const FIELDS = [
  { key: 'name', label: '名称', type: 'text', group: 'main' },
  { key: 'token', label: '令牌', type: 'text', group: 'main', sensitive: true },
  { key: 'doc', label: '附件', type: 'file', group: 'main' },
  { key: 'sop', label: '步骤', type: 'md', group: 'main' },
];
const GROUPS = [{ id: 'main', title: '主要' }];

const manifestOf = (buffer) => JSON.parse(
  readZip(buffer).find((f) => f.name === 'manifest.json').data.toString('utf8'),
);

test('导出 → 导入到新栏目：条目、附件、图文引用、密文都能过去', async () => {
  await sections.addSection({ id: SRC, title: '源栏目', groups: GROUPS, fields: FIELDS });
  const up = await files.addFile({ content: Buffer.from('fake-png-bytes').toString('base64'), name: '步骤图.png' });
  await entries.addEntry({
    section: SRC,
    title: '部署教程',
    set: { name: '部署教程', token: 'S3cret!', doc: [up.id], sop: `第一步 ![图](${up.id}) 完成` },
  });

  const zip = await transfer.buildSectionZip(SRC, { withSecrets: true });
  assert.ok(zip.buffer.length > 0);
  assert.match(zip.fileName, /^srcsec-.*\.zip$/);
  const man = manifestOf(zip.buffer);
  assert.equal(man.withSecrets, true);
  assert.equal(man.entries[0].values.token, 'S3cret!', '导出包里的凭据应是明文，跨机器才能用');
  assert.ok(readZip(zip.buffer).some((f) => f.name.startsWith('attachments/')), '附件原件应进包');

  const prev = await transfer.previewImport('dstsec', zip.buffer, { fileName: 'x.zip' });
  assert.equal(prev.section.willCreate, true);
  assert.equal(prev.entries.total, 1);
  assert.equal(prev.files.total, 1);

  const r = await transfer.applyImport('dstsec', zip.buffer, { fileName: 'x.zip', onConflict: 'skip' });
  assert.equal(r.section.created, true);
  assert.equal(r.entries.added, 1);
  assert.equal(r.files.reused, 1, '同一台机器上 sha 相同，应复用附件而不是再存一份');

  const got = await entries.getEntry('部署教程', { section: 'dstsec' });
  assert.equal(got.values.token, 'S3cret!', '导入后应用本机 vaultKey 重新加密，读出来仍是明文');
  const docId = got.values.doc[0];
  assert.equal(got.files[docId].name, '步骤图.png');
  assert.ok(got.values.sop.includes(docId), '正文里的图片 id 必须重映射到新附件');
  assert.ok(!got.values.sop.includes(up.id) || docId === up.id);
});

test('冲突策略：skip 不重复、copy 另存、overwrite 覆盖', async () => {
  const zip = await transfer.buildSectionZip(SRC, { withSecrets: true });
  const before = (await entries.listEntries({ section: SRC })).total;

  const p = await transfer.previewImport(SRC, zip.buffer, { fileName: 'x.zip' });
  assert.equal(p.entries.conflicts.length, 1);
  assert.equal(p.entries.conflicts[0].reason, 'id');

  const skipped = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'skip' });
  assert.equal(skipped.entries.skipped, 1);
  assert.equal(skipped.entries.added, 0);
  assert.equal((await entries.listEntries({ section: SRC })).total, before);

  const copied = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'copy' });
  assert.equal(copied.entries.copied, 1);
  const titles = (await entries.listEntries({ section: SRC })).entries.map((e) => e.title);
  assert.ok(titles.includes('部署教程（导入）'), titles.join(','));

  await entries.updateEntry('部署教程', { section: SRC, set: { name: '被改坏了' } });
  const overwritten = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'overwrite' });
  assert.equal(overwritten.entries.overwritten, 1);
  const restored = await entries.getEntry('部署教程', { section: SRC });
  assert.equal(restored.values.name, '部署教程');
});

test('打码导出：密码不进包；导入时跳过而不是把 ****** 当新密码', async () => {
  const zip = await transfer.buildSectionZip(SRC, { withSecrets: false });
  const man = manifestOf(zip.buffer);
  assert.equal(man.withSecrets, false);
  assert.ok(!JSON.stringify(man).includes('S3cret!'), '打码导出不能出现明文密码');
  assert.ok(man.entries[0].values.token.includes('******'));

  const r = await transfer.applyImport('maskdst', zip.buffer, { onConflict: 'skip' });
  assert.equal(r.section.created, true);
  assert.ok(r.maskedSkipped >= 1, '打码字段应被跳过并计数');
  const got = await entries.getEntry('部署教程', { section: 'maskdst' });
  assert.equal(got.values.token, null, '打码占位不能被当成新密码存进去');
});

test('预览不落盘：previewImport 前后条目数不变', async () => {
  const zip = await transfer.buildSectionZip(SRC);
  const before = (await entries.listEntries({ section: SRC })).total;
  await transfer.previewImport('previewonly', zip.buffer, { fileName: 'x.zip' });
  assert.equal((await entries.listEntries({ section: SRC })).total, before);
  const all = await sections.listSections?.();
  assert.ok(!(all?.sections || []).some((s) => s.id === 'previewonly'), '预览不应创建栏目');
});

// —— 精确导出 / 零配置导入 / KV 结构 ——

test('精确导出：只带走选中的条目与它们引用的附件', async () => {
  await sections.addSection({
    id: 'picksec', title: '选择性导出',
    groups: GROUPS, fields: [
      { key: 'name', label: '名称', type: 'text', group: 'main' },
      { key: 'doc', label: '附件', type: 'file', group: 'main' },
    ],
  });
  const a = await files.addFile({ content: Buffer.from('aaa').toString('base64'), name: 'a.txt' });
  const b = await files.addFile({ content: Buffer.from('bbb').toString('base64'), name: 'b.txt' });
  await entries.addEntry({ section: 'picksec', title: '条目A', set: { name: 'A', doc: [a.id] } });
  await entries.addEntry({ section: 'picksec', title: '条目B', set: { name: 'B', doc: [b.id] } });

  const zip = await transfer.buildSectionZip('picksec', { entryIds: ['条目A'] });
  const man = manifestOf(zip.buffer);
  assert.equal(man.entries.length, 1);
  assert.equal(man.entries[0].title, '条目A');
  assert.equal(man.files.length, 1, '只应打包被选条目引用的附件');
  assert.equal(man.selection.partial, true);

  await transfer.applyImport('pickcopy', zip.buffer, { onConflict: 'skip' });
  const list = await entries.listEntries({ section: 'pickcopy' });
  assert.deepEqual(list.entries.map((e) => e.title), ['条目A']);
  const got = await entries.getEntry('条目A', { section: 'pickcopy' });
  assert.equal(got.files[got.values.doc[0]].name, 'a.txt');
});

test('零配置导入：不指定栏目，按包内结构新建；重复导入自动加序号', async () => {
  const zip = await transfer.buildSectionZip('picksec');
  const first = await transfer.previewImport(null, zip.buffer, { fileName: 'x.zip' });
  assert.equal(first.section.willCreate, true);

  const r1 = await transfer.applyImport(null, zip.buffer, {});
  assert.notEqual(r1.section.id, 'picksec', 'id 已存在时必须另存，不能静默合并');
  assert.equal(r1.section.created, true);
  assert.match((await sections.getSection(r1.section.id)).title, /（导入）/);

  const r2 = await transfer.applyImport(null, zip.buffer, {});
  assert.notEqual(r2.section.id, r1.section.id, '每次零配置导入都应是独立栏目');
  assert.equal((await entries.listEntries({ section: r2.section.id })).count, 2);
});

test('结构随包：kv 栏目导入后仍是 KV 表', async () => {
  await sections.addSection({
    id: 'kvsrc', title: 'KV 源', groups: [{ id: 'main', title: '主' }],
    fields: [{ key: 'k', label: '键', type: 'text', group: 'main' }],
  });
  await sections.updateSection('kvsrc', { kv: true });
  await entries.addEntry({ section: 'kvsrc', title: 'row1', set: { k: 'v1' } });

  const zip = await transfer.buildSectionZip('kvsrc');
  assert.equal(manifestOf(zip.buffer).section.kv, true);
  const r = await transfer.applyImport('kvdst', zip.buffer, {});
  assert.equal(r.section.created, true);
  const sec = await sections.getSection('kvdst');
  assert.equal(sec.kv, true, 'KV 标记必须随结构一起恢复');
  assert.equal((await entries.listEntries({ section: 'kvdst' })).count, 1);
});

// —— 全局多栏目包 ——

test('bundle：多栏目 + 按条目选择，预览汇总、导入按策略聚合', async () => {
  for (const id of ['g1', 'g2']) {
    await sections.addSection({
      id, title: `栏目${id}`,
      groups: [{ id: 'main', title: '主' }],
      fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }],
    });
  }
  const a = await entries.addEntry({ section: 'g1', title: 'g1-a', set: { name: 'a' } });
  await entries.addEntry({ section: 'g1', title: 'g1-b', set: { name: 'b' } });
  await entries.addEntry({ section: 'g2', title: 'g2-a', set: { name: 'c' } });

  const { buffer } = await transfer.buildBundleZip({
    sections: [{ id: 'g1', entries: [a.id] }, { id: 'g2' }],
    withSecrets: false,
  });
  const names = readZip(buffer).map((f) => f.name);
  assert.ok(names.includes('bundle.json'));
  assert.ok(names.includes('sections/g1.zip') && names.includes('sections/g2.zip'), names.join(','));

  const p = await transfer.previewBundle(buffer, { fileName: 'b.zip' });
  assert.equal(p.totals.sections, 2);
  assert.equal(p.totals.entries, 2, 'g1 只选了 1 条 + g2 全部 1 条');
  assert.equal(p.totals.conflicts, 2, '同库导入必然冲突');

  const r = await transfer.applyBundle(buffer, { onConflict: 'copy' });
  assert.equal(r.totals.sections, 2);
  assert.equal(r.totals.copied, 2);
  assert.equal((await entries.listEntries({ section: 'g1' })).count, 3);
  assert.equal((await entries.listEntries({ section: 'g2' })).count, 2);
});

// —— 口令加密的导出 / 导入 ——
// 口令只作用在最外层；导入同一个入口要吃明文与加密两种包。

test('加密导出：单栏目包带 magic，缺口令 / 错口令都进不去', async () => {
  const zip = await transfer.buildSectionZip(SRC, { passphrase: 'S1cau!@#' });
  assert.equal(zip.stats.encrypted, true);
  assert.equal(isEncryptedPackage(zip.buffer), true);
  // 加密包不再是 zip：直接 readZip 应该失败（否则说明信封没生效）
  assert.throws(() => readZip(zip.buffer));

  await assert.rejects(
    () => transfer.previewImport('encdst', zip.buffer, {}),
    (e) => e.code === 'BLOCKED' && /口令/.test(e.message),
  );
  await assert.rejects(
    () => transfer.previewImport('encdst', zip.buffer, { passphrase: 'wrong' }),
    (e) => e.code === 'BLOCKED',
  );

  const ok = await transfer.previewImport('encdst', zip.buffer, { passphrase: 'S1cau!@#' });
  assert.equal(ok.encrypted, true);
  assert.equal(ok.entries.total, (await entries.listEntries({ section: SRC })).count);

  const srcList = await entries.listEntries({ section: SRC });
  const r = await transfer.applyImport('encdst', zip.buffer, { passphrase: 'S1cau!@#' });
  assert.equal(r.encrypted, true);
  assert.equal(r.entries.added, ok.entries.total);
  const got = await entries.getEntry(srcList.entries[0].title, { section: 'encdst' });
  assert.ok(got, '加密包导入后条目应可读');
});

test('明文包不受影响：不带口令时预览照旧，encrypted=false', async () => {
  const zip = await transfer.buildSectionZip(SRC);
  assert.equal(zip.stats.encrypted, false);
  assert.equal(isEncryptedPackage(zip.buffer), false);
  const p = await transfer.previewImport('plaindst', zip.buffer, {});
  assert.equal(p.encrypted, false);
});

test('加密 bundle：外层加密、内层仍复用单栏目逻辑；导入后结构一致', async () => {
  const { buffer, stats } = await transfer.buildBundleZip({ sections: [{ id: SRC }], passphrase: 'bundle-pw' });
  assert.equal(stats.encrypted, true);
  assert.equal(isEncryptedPackage(buffer), true);

  await assert.rejects(() => transfer.previewBundle(buffer, {}), (e) => e.code === 'BLOCKED');
  const p = await transfer.previewBundle(buffer, { passphrase: 'bundle-pw' });
  assert.equal(p.encrypted, true);
  assert.equal(p.totals.sections, 1);

  const r = await transfer.applyBundle(buffer, { passphrase: 'bundle-pw', onConflict: 'skip' });
  assert.equal(r.totals.sections, 1);
});

// —— 冲突明细 ——
// 「有 3 处冲突」不够：用户要知道是哪条撞了哪条、按什么规则撞的、另存会变成什么名字。

test('预览冲突明细：区分同 id / 同标题，并给出另存后的新标题', async () => {
  await sections.addSection({ id: 'conf', title: '冲突栏目', groups: GROUPS, fields: FIELDS });
  await entries.addEntry({ section: 'conf', title: '甲', set: { name: 'local' } });
  await entries.addEntry({ section: 'conf', title: '乙', set: { name: 'local2' } });

  const zip = await transfer.buildSectionZip('conf');
  // 导入到同一个栏目 → 两条都撞（同 id）
  const p = await transfer.previewImport('conf', zip.buffer, {});
  assert.equal(p.entries.conflicts.length, 2);
  for (const c of p.entries.conflicts) {
    assert.equal(c.reason, 'id');
    assert.equal(c.existingTitle, c.title, '同 id 时现有标题应与来源一致');
    assert.match(c.copyTitle, /^甲（导入）$|^乙（导入）$/);
  }

  // 同名不同 id：靠标题判定（copyTitle 也要能算出来）
  await entries.addEntry({ section: 'conf', title: '丙', set: { name: 'x' } });
  const zip2 = await transfer.buildSectionZip('conf', { entryIds: ['丙'] });
  const p2 = await transfer.previewImport('conf', zip2.buffer, {});
  assert.equal(p2.entries.conflicts.length, 1);
  assert.equal(p2.entries.conflicts[0].reason, 'id', '丙的 id 也在本地，按 id 撞');
  assert.equal(p2.entries.conflicts[0].copyTitle, '丙（导入）');

  // 导入到空栏目：一条冲突都没有
  const p3 = await transfer.previewImport('conf-fresh', zip.buffer, {});
  assert.equal(p3.entries.conflicts.length, 0);
  assert.equal(p3.entries.fresh, p3.entries.total);
});
