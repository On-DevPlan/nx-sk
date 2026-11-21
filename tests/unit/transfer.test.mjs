// 条目模板 ZIP 导出 / 导入：往返、冲突策略、附件去重、凭据打码。
//
// 这里走的是真实 store（临时目录）与真实附件文件，不打桩——
// 这条链最容易错的地方都在「引用重映射」和「密文再加密」，打桩会把这些掩盖掉。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { readZip, createZip } = await import('../../src/core/zip.ts');
const { needsPassphrase } = await import('../../src/modules/transfer/service.ts');
const { loadStore } = await import('../../src/core/store.ts');
const templates = await import('../../src/modules/templates/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const files = await import('../../src/modules/files/service.ts');
const transfer = await import('../../src/modules/transfer/service.ts');

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

test('导出 → 导入到新条目模板：条目、附件、图文引用、密文都能过去', async () => {
  await templates.addTemplate({ id: SRC, title: '源条目模板', groups: GROUPS, fields: FIELDS });
  const up = await files.addFile({ content: Buffer.from('fake-png-bytes').toString('base64'), name: '步骤图.png' });
  await entries.addEntry({
    template: SRC,
    title: '部署教程',
    set: { name: '部署教程', token: 'S3cret!', doc: [up.id], sop: `第一步 ![图](${up.id}) 完成` },
  });

  const zip = await transfer.buildTemplateZip(SRC, { withSecrets: true });
  assert.ok(zip.buffer.length > 0);
  assert.match(zip.fileName, /^srcsec-.*\.zip$/);
  const man = manifestOf(zip.buffer);
  assert.equal(man.withSecrets, true);
  assert.equal(man.entries[0].values.token, 'S3cret!', '导出包里的凭据应是明文，跨机器才能用');
  assert.ok(readZip(zip.buffer).some((f) => f.name.startsWith('attachments/')), '附件原件应进包');

  const prev = await transfer.previewImport('dstsec', zip.buffer, { fileName: 'x.zip' });
  assert.equal(prev.template.willCreate, true);
  assert.equal(prev.entries.total, 1);
  assert.equal(prev.files.total, 1);

  const r = await transfer.applyImport('dstsec', zip.buffer, { fileName: 'x.zip', onConflict: 'skip' });
  assert.equal(r.template.created, true);
  assert.equal(r.entries.added, 1);
  assert.equal(r.files.reused, 1, '同一台机器上 sha 相同，应复用附件而不是再存一份');

  const got = await entries.getEntry('部署教程', { template: 'dstsec' });
  assert.equal(got.values.token, 'S3cret!', '导入后应用本机 vaultKey 重新加密，读出来仍是明文');
  const docId = got.values.doc[0];
  assert.equal(got.files[docId].name, '步骤图.png');
  assert.ok(got.values.sop.includes(docId), '正文里的图片 id 必须重映射到新附件');
  assert.ok(!got.values.sop.includes(up.id) || docId === up.id);
});

test('冲突策略：skip 不重复、copy 另存、overwrite 覆盖', async () => {
  const zip = await transfer.buildTemplateZip(SRC, { withSecrets: true });
  const before = (await entries.listEntries({ template: SRC })).total;

  const p = await transfer.previewImport(SRC, zip.buffer, { fileName: 'x.zip' });
  assert.equal(p.entries.conflicts.length, 1);
  assert.equal(p.entries.conflicts[0].reason, 'id');

  const skipped = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'skip' });
  assert.equal(skipped.entries.skipped, 1);
  assert.equal(skipped.entries.added, 0);
  assert.equal((await entries.listEntries({ template: SRC })).total, before);

  const copied = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'copy' });
  assert.equal(copied.entries.copied, 1);
  const titles = (await entries.listEntries({ template: SRC })).entries.map((e) => e.title);
  assert.ok(titles.includes('部署教程（导入）'), titles.join(','));

  await entries.updateEntry('部署教程', { template: SRC, set: { name: '被改坏了' } });
  const overwritten = await transfer.applyImport(SRC, zip.buffer, { onConflict: 'overwrite' });
  assert.equal(overwritten.entries.overwritten, 1);
  const restored = await entries.getEntry('部署教程', { template: SRC });
  assert.equal(restored.values.name, '部署教程');
});

test('包里恒为明文：不再有打码选项，保护靠口令', async () => {
  const zip = await transfer.buildTemplateZip(SRC);
  const man = manifestOf(zip.buffer);
  assert.equal(man.withSecrets, true, '写出的包固定标记为含明文');
  assert.ok(JSON.stringify(man).includes('S3cret!'), '口令加密之前，包内就是明文');
});

test('旧版打码包仍被正确跳过：不会把 ****** 当新密码', async () => {
  // 0.11.0 及更早可以导出打码包；那条读取侧兼容要一直有效
  const zip = await transfer.buildTemplateZip(SRC);
  const man = JSON.parse(readZip(zip.buffer).find((f) => f.name === 'manifest.json').data.toString('utf8'));
  man.withSecrets = false;
  man.entries[0].values.token = '******';
  const old = createZip([
    { name: 'manifest.json', data: JSON.stringify(man) },
    { name: 'README.txt', data: 'legacy' },
  ]);
  const r = await transfer.applyImport('maskdst', old, { onConflict: 'skip' });
  assert.equal(r.template.created, true);
  assert.ok(r.maskedSkipped >= 1, '打码字段应被跳过并计数');
  const got = await entries.getEntry('部署教程', { template: 'maskdst' });
  assert.equal(got.values.token, null, '打码占位不能被当成新密码存进去');
});

test('预览不落盘：previewImport 前后条目数不变', async () => {
  const zip = await transfer.buildTemplateZip(SRC);
  const before = (await entries.listEntries({ template: SRC })).total;
  await transfer.previewImport('previewonly', zip.buffer, { fileName: 'x.zip' });
  assert.equal((await entries.listEntries({ template: SRC })).total, before);
  const all = await templates.listTemplates?.();
  assert.ok(!(all?.templates || []).some((s) => s.id === 'previewonly'), '预览不应创建条目模板');
});

// —— 精确导出 / 零配置导入 / KV 结构 ——

test('精确导出：只带走选中的条目与它们引用的附件', async () => {
  await templates.addTemplate({
    id: 'picksec', title: '选择性导出',
    groups: GROUPS, fields: [
      { key: 'name', label: '名称', type: 'text', group: 'main' },
      { key: 'doc', label: '附件', type: 'file', group: 'main' },
    ],
  });
  const a = await files.addFile({ content: Buffer.from('aaa').toString('base64'), name: 'a.txt' });
  const b = await files.addFile({ content: Buffer.from('bbb').toString('base64'), name: 'b.txt' });
  await entries.addEntry({ template: 'picksec', title: '条目A', set: { name: 'A', doc: [a.id] } });
  await entries.addEntry({ template: 'picksec', title: '条目B', set: { name: 'B', doc: [b.id] } });

  const zip = await transfer.buildTemplateZip('picksec', { entryIds: ['条目A'] });
  const man = manifestOf(zip.buffer);
  assert.equal(man.entries.length, 1);
  assert.equal(man.entries[0].title, '条目A');
  assert.equal(man.files.length, 1, '只应打包被选条目引用的附件');
  assert.equal(man.selection.partial, true);

  await transfer.applyImport('pickcopy', zip.buffer, { onConflict: 'skip' });
  const list = await entries.listEntries({ template: 'pickcopy' });
  assert.deepEqual(list.entries.map((e) => e.title), ['条目A']);
  const got = await entries.getEntry('条目A', { template: 'pickcopy' });
  assert.equal(got.files[got.values.doc[0]].name, 'a.txt');
});

// —— 资料袋里的附件也要随包 ——
// 真实问题：袋里的 file item（kind='file'）不在 file/md 字段扫描范围里，
// 导出的包看起来正常、附件清单却是空的——溯源用的原件在包里丢了。
test('导出带上资料袋里的原件，导入后 fileId 重映射到新库', async () => {
  await templates.addTemplate({ id: 'bagsec', title: '袋导出', template: 'projects' });
  await entries.addEntry({ template: 'bagsec', title: '袋条目', set: { name: '袋条目' } });
  // 造一个袋内附件：file add（Web 上传口）+ 直写 values（--set source=… 是程序入口）
  const up = await files.addFile({
    content: Buffer.from(`bag-export-${Date.now()}-${Math.random()}`).toString('base64'),
    name: '袋内原件.png',
  });
  await entries.updateEntry('袋条目', {
    template: 'bagsec',
    data: { source: [{ kind: 'file', fileId: up.id, name: '发来的截图', addedAt: new Date().toISOString() }] },
  });

  const zip = await transfer.buildTemplateZip('bagsec', {});
  const man = manifestOf(zip.buffer);
  assert.equal(man.files.length, 1, '袋里的原件必须随包');
  assert.ok(readZip(zip.buffer).some((f) => f.name.startsWith('attachments/')), '原件应进包');

  const r = await transfer.applyImport('bagdst', zip.buffer, { onConflict: 'skip' });
  assert.equal(r.files.reused, 1, '同机 sha 相同应复用');
  const got = await entries.getEntry('袋条目', { template: 'bagdst' });
  const bag = got.values.source || [];
  assert.equal(bag.length, 1);
  assert.equal(bag[0].kind, 'file');
  assert.equal(got.files[bag[0].fileId]?.name, '袋内原件.png', '袋里 item 的 fileId 应重映射到可解析的附件');
});

// text 的底层是 markdown：正文里内嵌的 `![x](f_xxx)` 也是正式引用——
// 聊天记录图文混排，漏了正文里的图，导出的记录就成了没图的文字。
test('导出带上资料袋正文内嵌的图片，导入后正文里的 id 也重映射', async () => {
  await templates.addTemplate({ id: 'mdsec', title: '图文袋', template: 'projects' });
  await entries.addEntry({ template: 'mdsec', title: '图文条目', set: { name: '图文条目' } });
  const img = await files.addFile({
    content: Buffer.from(`bag-md-${Date.now()}-${Math.random()}`).toString('base64'),
    name: '聊天截图.png',
  });
  const local = `f_local_${Date.now().toString(36)}`;
  await entries.updateEntry('图文条目', {
    template: 'mdsec',
    data: { source: [
      { kind: 'text', name: '带图聊天', text: `今天聊了这些\n\n![聊天截图](${img.id})\n\n![外链图](https://example.com/x.png) 这条是网图`, addedAt: new Date().toISOString() },
      { kind: 'text', text: `纯文字一条，引用不存在也不会炸：![丢](f_丢了)` },
    ] },
  });

  const zip = await transfer.buildTemplateZip('mdsec', {});
  const man = manifestOf(zip.buffer);
  assert.equal(man.files.length, 1, '只有正文内嵌的那张随包（外链与不存在的 id 不进包）');

  await transfer.applyImport('mddst', zip.buffer, { onConflict: 'skip' });
  // 读袋子要用 source get：它的 files 表会把 **text 正文里内嵌的** 图片引用也解析出来
  const got = await entries.getSource('图文条目', { template: 'mddst' });
  const bag = got.items;
  const withImg = bag.find((x) => x.name === '带图聊天');
  assert.ok(withImg, '条目要在');
  // 正文里的引用要能解析（同机导入 sha 相同会复用同 id；跨库时 remapValues 会换成新 id，
  // 两条路最终契约一致：**正文里引用的 id 在目标库可解析**）
  const refId = withImg.text.match(/!\[聊天截图\]\(([^)]+)\)/)[1];
  assert.equal(got.files[refId]?.name, '聊天截图.png', '正文内嵌的引用必须可解析');
  assert.ok(withImg.text.includes('https://example.com/x.png'), '外链图原样保留');

  // 纯文字那条：引用的附件不存在时不报错也不伪造，原样保留
  const plain = bag.find((x) => x.kind === 'text' && x.text.includes('纯文字'));
  assert.ok(plain.text.includes('f_丢了'));
  void local;
});

test('零配置导入：不指定条目模板，按包内结构新建；重复导入自动加序号', async () => {
  const zip = await transfer.buildTemplateZip('picksec');
  const first = await transfer.previewImport(null, zip.buffer, { fileName: 'x.zip' });
  assert.equal(first.template.willCreate, true);

  const r1 = await transfer.applyImport(null, zip.buffer, {});
  assert.notEqual(r1.template.id, 'picksec', 'id 已存在时必须另存，不能静默合并');
  assert.equal(r1.template.created, true);
  assert.match((await templates.getTemplate(r1.template.id)).title, /（导入）/);

  const r2 = await transfer.applyImport(null, zip.buffer, {});
  assert.notEqual(r2.template.id, r1.template.id, '每次零配置导入都应是独立条目模板');
  assert.equal((await entries.listEntries({ template: r2.template.id })).count, 2);
});

test('结构随包：普通条目模板的结构原样导入（没有 KV 特殊形态）', async () => {
  await templates.addTemplate({
    id: 'kvsrc', title: '源模板', groups: [{ id: 'main', title: '主' }],
    fields: [{ key: 'k', label: '键', type: 'text', group: 'main' }],
  });
  await entries.addEntry({ template: 'kvsrc', title: 'row1', set: { k: 'v1' } });

  const zip = await transfer.buildTemplateZip('kvsrc');
  assert.equal(manifestOf(zip.buffer).template.kv, undefined, '导出不再写 kv 标记');
  const r = await transfer.applyImport('kvdst', zip.buffer, {});
  assert.equal(r.template.created, true);
  const sec = await templates.getTemplate('kvdst');
  assert.equal(sec.fieldList.some((f) => f.key === 'k'), true, '字段结构随包恢复');
  assert.equal((await entries.listEntries({ template: 'kvdst' })).count, 1);
});

// —— 全局多条目模板包 ——

test('bundle：多条目模板 + 按条目选择，预览汇总、导入按策略聚合', async () => {
  for (const id of ['g1', 'g2']) {
    await templates.addTemplate({
      id, title: `条目模板${id}`,
      groups: [{ id: 'main', title: '主' }],
      fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }],
    });
  }
  const a = await entries.addEntry({ template: 'g1', title: 'g1-a', set: { name: 'a' } });
  await entries.addEntry({ template: 'g1', title: 'g1-b', set: { name: 'b' } });
  await entries.addEntry({ template: 'g2', title: 'g2-a', set: { name: 'c' } });

  const { buffer } = await transfer.buildBundleZip({
    templates: [{ id: 'g1', entries: [a.id] }, { id: 'g2' }],
  });
  const names = readZip(buffer).map((f) => f.name);
  assert.ok(names.includes('bundle.json'));
  assert.ok(names.includes('templates/g1.zip') && names.includes('templates/g2.zip'), names.join(','));

  const p = await transfer.previewBundle(buffer, { fileName: 'b.zip' });
  assert.equal(p.totals.templates, 2);
  assert.equal(p.totals.entries, 2, 'g1 只选了 1 条 + g2 全部 1 条');
  assert.equal(p.totals.conflicts, 2, '同库导入必然冲突');

  const r = await transfer.applyBundle(buffer, { onConflict: 'copy' });
  assert.equal(r.totals.templates, 2);
  assert.equal(r.totals.copied, 2);
  assert.equal((await entries.listEntries({ template: 'g1' })).count, 3);
  assert.equal((await entries.listEntries({ template: 'g2' })).count, 2);
});

test('单模板嵌套：导出的 parent/sort 随包，导入后子树层级保留', async () => {
  await templates.addTemplate({
    id: 'nest', title: '嵌套树',
    groups: [{ id: 'main', title: '主' }],
    fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }],
  });
  const folder = await entries.addEntry({ template: 'nest', title: '文件夹', set: { name: '文件夹' } });
  const child = await entries.addEntry({ template: 'nest', parent: folder.id, title: '子条目', set: { name: '子' } });
  await entries.addEntry({ template: 'nest', parent: child.id, title: '孙条目', set: { name: '孙' } });

  const man = manifestOf((await transfer.buildTemplateZip('nest')).buffer);
  assert.equal(man.entries.find((e) => e.id === child.id).parent, folder.id, '同包父引用应写进 manifest');
  assert.ok(man.entries.every((e) => typeof e.sort === 'number'), '排序也要随包');

  await transfer.applyImport('nest-dst', (await transfer.buildTemplateZip('nest')).buffer, { onConflict: 'skip' });
  const rows = (await loadStore()).entries.filter((e) => e.template === 'nest-dst');
  const dstFolder = rows.find((e) => e.title === '文件夹');
  const dstChild = rows.find((e) => e.title === '子条目');
  const dstGrand = rows.find((e) => e.title === '孙条目');
  assert.equal(dstChild.parent, dstFolder.id, '导入后子条目应挂回父');
  assert.equal(dstGrand.parent, dstChild.id, '嵌套两层的孙条目也要挂回中间层');
});

test('bundle 跨模板：文件夹在 __blank__、子条目在别的模板，导入后仍是一棵树', async () => {
  const folder = await entries.addEntry({ title: '跨模板树根' });
  const child = await entries.addEntry({ template: 'g1', parent: folder.id, title: 'g1-子', set: { name: '子' } });
  const grand = await entries.addEntry({ template: 'g2', parent: child.id, title: 'g2-孙', set: { name: '孙' } });

  const { buffer } = await transfer.buildBundleZip({
    templates: [
      { id: '__blank__', entries: [folder.id] },
      { id: 'g1', entries: [child.id] },
      { id: 'g2', entries: [grand.id] },
    ],
  });
  const bundle = JSON.parse(readZip(buffer).find((f) => f.name === 'bundle.json').data.toString('utf8'));
  assert.equal(bundle.tree.find((n) => n.id === child.id).parent, folder.id, 'bundle 顶层要记跨模板边');
  assert.equal(bundle.tree.find((n) => n.id === grand.id).parent, child.id);

  const r = await transfer.applyBundle(buffer, { onConflict: 'copy' });
  assert.equal(r.totals.copied, 3);
  const rows = (await loadStore()).entries;
  const dstFolder = rows.find((e) => e.title === '跨模板树根（导入）');
  const dstChild = rows.find((e) => e.title === 'g1-子（导入）');
  const dstGrand = rows.find((e) => e.title === 'g2-孙（导入）');
  assert.ok(dstFolder && dstChild && dstGrand, '三层的另存副本都应在');
  assert.equal(dstChild.parent, dstFolder.id, '子条目要挂到 __blank__ 里的文件夹副本');
  assert.equal(dstGrand.parent, dstChild.id, '跨模板的孙条目要挂回子条目副本');
});

// —— 口令加密的导出 / 导入 ——
// 口令只作用在最外层；导入同一个入口要吃明文与加密两种包。

test('加密导出：外层仍是合法 ZIP（系统压缩文件夹能打开），缺口令 / 错口令都进不去', async () => {
  const zip = await transfer.buildTemplateZip(SRC, { passphrase: 'S1cau!@#' });
  assert.equal(zip.stats.encrypted, true);
  assert.equal(needsPassphrase(zip.buffer), true);
  // 外层必须还是合法 ZIP：系统的「压缩文件夹」能打开（里面只有 payload.enc）
  const outer = readZip(zip.buffer).map((f) => f.name).sort();
  assert.deepEqual(outer, ['README.txt', 'payload.enc']);
  // 而且 manifest 不能以明文出现在外层
  assert.ok(!outer.includes('manifest.json'));

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
  assert.equal(ok.entries.total, (await entries.listEntries({ template: SRC })).count);

  const srcList = await entries.listEntries({ template: SRC });
  const r = await transfer.applyImport('encdst', zip.buffer, { passphrase: 'S1cau!@#' });
  assert.equal(r.encrypted, true);
  assert.equal(r.entries.added, ok.entries.total);
  const got = await entries.getEntry(srcList.entries[0].title, { template: 'encdst' });
  assert.ok(got, '加密包导入后条目应可读');
});

test('明文包不受影响：不带口令时预览照旧，encrypted=false', async () => {
  const zip = await transfer.buildTemplateZip(SRC);
  assert.equal(zip.stats.encrypted, false);
  assert.equal(needsPassphrase(zip.buffer), false);
  assert.ok(readZip(zip.buffer).some((f) => f.name === 'manifest.json'));
  const p = await transfer.previewImport('plaindst', zip.buffer, {});
  assert.equal(p.encrypted, false);
});

test('加密 bundle：外层加密、内层仍复用单条目模板逻辑；导入后结构一致', async () => {
  const { buffer, stats } = await transfer.buildBundleZip({ templates: [{ id: SRC }], passphrase: 'bundle-pw' });
  assert.equal(stats.encrypted, true);
  assert.equal(needsPassphrase(buffer), true);
  // 外层仍是合法 ZIP，且不泄露「里面有哪些条目模板」
  assert.deepEqual(readZip(buffer).map((f) => f.name).sort(), ['README.txt', 'payload.enc']);

  await assert.rejects(() => transfer.previewBundle(buffer, {}), (e) => e.code === 'BLOCKED');
  const p = await transfer.previewBundle(buffer, { passphrase: 'bundle-pw' });
  assert.equal(p.encrypted, true);
  assert.equal(p.totals.templates, 1);

  const r = await transfer.applyBundle(buffer, { passphrase: 'bundle-pw', onConflict: 'skip' });
  assert.equal(r.totals.templates, 1);
});

// —— 冲突明细 ——
// 「有 3 处冲突」不够：用户要知道是哪条撞了哪条、按什么规则撞的、另存会变成什么名字。

test('预览冲突明细：区分同 id / 同标题，并给出另存后的新标题', async () => {
  await templates.addTemplate({ id: 'conf', title: '冲突条目模板', groups: GROUPS, fields: FIELDS });
  await entries.addEntry({ template: 'conf', title: '甲', set: { name: 'local' } });
  await entries.addEntry({ template: 'conf', title: '乙', set: { name: 'local2' } });

  const zip = await transfer.buildTemplateZip('conf');
  // 导入到同一个条目模板 → 两条都撞（同 id）
  const p = await transfer.previewImport('conf', zip.buffer, {});
  assert.equal(p.entries.conflicts.length, 2);
  for (const c of p.entries.conflicts) {
    assert.equal(c.reason, 'id');
    assert.equal(c.existingTitle, c.title, '同 id 时现有标题应与来源一致');
    assert.match(c.copyTitle, /^甲（导入）$|^乙（导入）$/);
  }

  // 同名不同 id：靠标题判定（copyTitle 也要能算出来）
  await entries.addEntry({ template: 'conf', title: '丙', set: { name: 'x' } });
  const zip2 = await transfer.buildTemplateZip('conf', { entryIds: ['丙'] });
  const p2 = await transfer.previewImport('conf', zip2.buffer, {});
  assert.equal(p2.entries.conflicts.length, 1);
  assert.equal(p2.entries.conflicts[0].reason, 'id', '丙的 id 也在本地，按 id 撞');
  assert.equal(p2.entries.conflicts[0].copyTitle, '丙（导入）');

  // 导入到空条目模板：一条冲突都没有
  const p3 = await transfer.previewImport('conf-fresh', zip.buffer, {});
  assert.equal(p3.entries.conflicts.length, 0);
  assert.equal(p3.entries.fresh, p3.entries.total);
});

test('表格的敏感列在导出包里是明文（与顶层密文字段同一口径）', async () => {
  const { isCipherBlob } = await import('../../src/core/crypto.ts');
  const { loadStore } = await import('../../src/core/store.ts');
  const id = 'tblsec';
  await templates.addTemplate({
    id,
    title: '表格密文',
    groups: GROUPS,
    fields: [
      { key: 'name', label: '名称', type: 'text', group: 'main' },
      {
        key: 'rows',
        label: '账号表',
        type: 'table',
        group: 'main',
        columns: [
          { key: 'site', label: '站点', type: 'text' },
          { key: 'pass', label: '密码', type: 'text', sensitive: true },
        ],
      },
    ],
  });
  await entries.addEntry({
    template: id,
    title: '账号',
    set: {
      name: '账号',
      rows: [{ site: 'a.test', pass: 'P@ss1' }, { site: 'b.test', pass: 'P@ss2' }],
    },
  });

  // 前提校验：落盘确实是密文，否则「包里是明文」这条断言会假通过
  const db = await loadStore();
  const rec = db.entries.find((e) => e.template === id && e.title === '账号');
  assert.ok(isCipherBlob(rec.values.rows.rows[0].pass), '表格敏感列落盘应为密文');

  const zip = await transfer.buildTemplateZip(id, { withSecrets: true });
  const man = manifestOf(zip.buffer);
  assert.deepEqual(
    man.entries[0].values.rows.rows,
    [{ site: 'a.test', pass: 'P@ss1' }, { site: 'b.test', pass: 'P@ss2' }],
    '导出包里的表格敏感列应是明文，跨机器导入才能用',
  );
});


