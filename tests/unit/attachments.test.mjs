// 附件库测试：本机路径移动/复制导入、去重、Web 上传、改分类、还原（可逆）、
// 以及简历（job）栏目的 file 字段读写 + 附件中心「由栏目驱动」的分组。
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

const home = await useTempHome();

const svc = await import('../../src/modules/files/service.js');
const core = await import('../../src/core/attachments.js');
const { filesDir } = await import('../../src/core/paths.js');
const entries = await import('../../src/modules/entries/service.js');

async function makeSource(dir, name, content) {
  await fsp.mkdir(join(home, dir), { recursive: true });
  const p = join(home, dir, name);
  await fsp.writeFile(p, content);
  return p;
}

test('本机路径导入默认移动原件，台账记录物理路径与链接', async () => {
  const src = await makeSource('incoming', '张三-简历.pdf', 'resume-pdf-bytes');
  const r = await svc.addFile({ path: src, category: 'resume' });
  assert.equal(r.status, 'ok');
  assert.equal(r.created, true);
  assert.equal(r.moved, true);
  assert.equal(r.category, 'resume');
  // 原件已不在原位
  await assert.rejects(fsp.access(src), /ENOENT/);
  // 库内物理文件存在
  const stored = join(filesDir(), ...r.rel.split('/'));
  assert.equal(await fsp.readFile(stored, 'utf8'), 'resume-pdf-bytes');
  assert.equal(r.url, `/api/files/${r.id}/content`);
  assert.equal(r.downloadUrl, `${r.url}?download=1`);
  assert.equal(r.sourceDisplay.includes('张三-简历.pdf'), true);
});

test('相同内容再次导入自动去重，不重复存储', async () => {
  const src = await makeSource('incoming2', 'copy.pdf', 'resume-pdf-bytes');
  const r = await svc.addFile({ path: src });
  assert.equal(r.duplicated, true);
  // 去重时原件保留在原位（不擅自删用户文件）
  await fsp.access(src);
  const list = await svc.listFiles({});
  assert.equal(list.total, 1);
});

test('--copy 只复制、保留原件', async () => {
  const src = await makeSource('incoming3', '成绩单.png', 'transcript-image');
  const r = await svc.addFile({ path: src, copy: true, category: 'transcript' });
  assert.equal(r.moved, false);
  await fsp.access(src); // 原件仍在
  assert.equal(r.category, 'transcript');
});

test('Web 上传（base64 / data URL）写入附件库', async () => {
  const b64 = Buffer.from('avatar-binary', 'utf8').toString('base64');
  const r = await svc.addFile({ content: `data:image/png;base64,${b64}`, name: '头像.png', category: 'avatar' });
  assert.equal(r.created, true);
  assert.equal(r.isImage, true);
  assert.equal(r.mode, 'upload');
  const stored = join(filesDir(), ...r.rel.split('/'));
  assert.equal(await fsp.readFile(stored, 'utf8'), 'avatar-binary');
});

test('分类与名称过滤、搜索生效', async () => {
  const byCat = await svc.listFiles({ category: 'avatar' });
  assert.equal(byCat.count, 1);
  const byQ = await svc.listFiles({ q: '头像' });
  assert.equal(byQ.count, 1);
  const none = await svc.listFiles({ q: '不存在的关键字xyz' });
  assert.equal(none.count, 0);
});

test('改分类会把物理文件搬到新目录', async () => {
  const list = await svc.listFiles({ q: '成绩单' });
  const target = list.files[0];
  const oldAbs = join(filesDir(), ...target.rel.split('/'));
  const r = await svc.updateFile(target.id, { category: 'certificate' });
  assert.equal(r.category, 'certificate');
  await assert.rejects(fsp.access(oldAbs), /ENOENT/);
  const newAbs = join(filesDir(), ...r.rel.split('/'));
  await fsp.access(newAbs);
});

test('file restore 把移动导入的附件还原回原始位置并撤销台账', async () => {
  // 第一个用例移动导入的简历，原始位置是 incoming/
  const list = await svc.listFiles({ q: '张三-简历' });
  const f = list.files[0];
  const r = await svc.restoreFileAction(f.id, {});
  assert.equal(r.status, 'ok');
  const after = await svc.listFiles({});
  assert.equal(after.files.some((x) => x.id === f.id), false);
  await fsp.access(join(home, 'incoming', '张三-简历.pdf'));
});

test('Web 上传件无原始位置时，restore 要求 --to；给目录后导出并撤销', async () => {
  const list = await svc.listFiles({ category: 'avatar' });
  const f = list.files[0];
  await assert.rejects(svc.restoreFileAction(f.id, {}), /原始位置/);
  const outDir = join(home, 'restored');
  const r = await svc.restoreFileAction(f.id, { to: outDir });
  assert.equal(r.displayPath.includes('头像.png'), true);
  await fsp.access(join(outDir, '头像.png'));
});

test('restore --copy 只导出副本，库中保留', async () => {
  const src = await makeSource('incoming4', 'note.txt', 'keep-me');
  const added = await svc.addFile({ path: src, copy: true, category: 'document' });
  const outDir = join(home, 'exported-copy');
  const r = await svc.restoreFileAction(added.id, { to: outDir, copy: true });
  assert.equal(r.exported, true);
  const stillThere = await svc.getFile(added.id);
  assert.equal(stillThere.id, added.id);
  await fsp.access(join(outDir, 'note.txt'));
});

test('删除附件连物理原件一起删除', async () => {
  const list0 = await svc.listFiles({ q: 'note.txt' });
  const f = list0.files[0];
  const abs = join(filesDir(), ...f.rel.split('/'));
  await svc.removeFile(f.id, {});
  await assert.rejects(fsp.access(abs), /ENOENT/);
});

test('dry-run 不移动、不写台账', async () => {
  const src = await makeSource('incoming5', 'dry.pdf', 'dry-content');
  const r = await svc.addFile({ path: src, 'dry-run': true });
  assert.equal(r.status, 'skipped');
  await fsp.access(src); // 原件仍在
  const list = await svc.listFiles({});
  assert.equal(list.files.some((x) => x.name === 'dry.pdf'), false);
});

test('简历（job）的 file 字段：值=附件 id，在条目的字段里选/传即建立链接', async () => {
  // 在附件库里准备一个原件（等价于在栏目 file 字段里「上传」后拿到的 id）
  const src = await makeSource('incoming6', '求职简历.pdf', 'job-resume');
  const added = await svc.addFile({ path: src, category: 'resume' });

  const created = await entries.addEntry({
    section: 'job', title: '张三',
    set: { name: '张三', resumeFile: added.id },
  });
  assert.equal(created.status, 'ok');

  const got = await entries.getEntry('张三', { section: 'job' });
  // 新写入统一存**数组**（哪怕只有一个附件）——形状一致，下游不必判「是串还是表」
  assert.deepEqual(got.values.resumeFile, [added.id]);
  assert.equal(got.files[added.id].name, '求职简历.pdf');
  assert.equal(got.files[added.id].url, `/api/files/${added.id}/content`);

  // 反查：附件知道被哪个栏目的哪个条目哪个字段引用
  const detail = await svc.getFile(added.id);
  assert.equal(
    detail.usedBy.some((u) => u.sectionId === 'job' && u.entryId === created.id && u.fieldKey === 'resumeFile'),
    true,
  );

  // 按附件名能搜到条目（file 字段值是 id，靠解析出的文件名命中）
  const searched = await entries.listEntries({ q: '求职简历' });
  assert.equal(searched.entries.some((e) => e.id === created.id), true);

  // 清空字段 → 条目不再引用，附件变成「未被引用」
  const updated = await entries.updateEntry('张三', { section: 'job', unset: ['resumeFile'] });
  assert.equal(updated.status, 'ok');
  const after = await entries.getEntry('张三', { section: 'job' });
  assert.equal(after.values.resumeFile, null);
  assert.equal((await svc.getFile(added.id)).usedBy.length, 0);
});

test('同一份原件可被多条条目引用（去重后同 id，各条目互不串台）', async () => {
  const src = await makeSource('incoming7', '共用头像.png', 'shared-avatar');
  const added = await svc.addFile({ path: src, copy: true, category: 'avatar' });

  // 相同内容再导入 → 去重，拿到同一个 id（不是两份原件）
  const src2 = await makeSource('incoming8', '共用头像2.png', 'shared-avatar');
  const again = await svc.addFile({ path: src2, copy: true });
  assert.equal(again.duplicated, true);
  assert.equal(again.id, added.id);

  await entries.addEntry({ section: 'job', title: '甲', set: { name: '甲', avatar: added.id } });
  await entries.addEntry({ section: 'job', title: '乙', set: { name: '乙', avatar: added.id } });

  const detail = await svc.getFile(added.id);
  assert.equal(detail.usedBy.length, 2);
});

test('listFiles 由栏目驱动：sections 汇总 + unlinked 计数 + 按栏目/未引用过滤', async () => {
  const d = await svc.listFiles({});
  assert.ok(Array.isArray(d.sections));
  const job = d.sections.find((s) => s.id === 'job');
  assert.ok(job, '带 file 字段的栏目应出现在分组里');
  assert.ok(job.count >= 1);
  assert.equal(typeof d.unlinked, 'number');

  const onlyJob = await svc.listFiles({ section: 'job' });
  assert.ok(onlyJob.files.length >= 1);
  assert.equal(onlyJob.files.every((f) => f.usedBy.some((u) => u.sectionId === 'job')), true);

  const unlinked = await svc.listFiles({ section: 'none' });
  assert.equal(unlinked.files.every((f) => !f.usedBy.length), true);
});

test('附件目录不可重复导入自身目录内的文件', async () => {
  const list = await svc.listFiles({});
  const f = list.files[0];
  const abs = join(filesDir(), ...f.rel.split('/'));
  await assert.rejects(svc.addFile({ path: abs }), /已经在附件库/);
});

test('分类台账与标签体系完整', () => {
  assert.deepEqual(core.CATEGORY_IDS, ['resume', 'avatar', 'transcript', 'certificate', 'document', 'other']);
  assert.equal(core.categoryLabel('resume'), '简历');
  assert.equal(core.safeFileName('a/b:c?.pdf'), 'a_b_c_.pdf');
});

// ── 一个 file 字段挂多个附件 ──────────────────────────────

test('fileIdsOf：字符串 / 数组 / 空 / 重复 都归一成 id 数组', () => {
  assert.deepEqual(core.fileIdsOf('f_a'), ['f_a']);
  assert.deepEqual(core.fileIdsOf(['f_a', 'f_b']), ['f_a', 'f_b']);
  assert.deepEqual(core.fileIdsOf(['f_a', 'f_a', ' f_b ', '']), ['f_a', 'f_b']);
  assert.deepEqual(core.fileIdsOf(null), []);
  assert.deepEqual(core.fileIdsOf(undefined), []);
  assert.deepEqual(core.fileIdsOf([]), []);
});

test('一个 file 字段挂多个附件：值 = 数组，反查/搜索/渲染都按列表走', async () => {
  const a = await svc.addFile({ path: await makeSource('multi', '简历-前端.pdf', 'resume-fe') });
  const b = await svc.addFile({ path: await makeSource('multi', '简历-后端.pdf', 'resume-be') });

  // 逗号分隔的写法也认（CLI 手感）；存下来仍是数组
  await entries.addEntry({
    section: 'job', title: '多附件条目',
    set: { name: '多附件条目', resumeFile: `${a.id},${b.id}` },
  });
  const got = await entries.getEntry('多附件条目', { section: 'job' });
  assert.deepEqual(got.values.resumeFile, [a.id, b.id]);
  assert.equal(got.files[a.id].name, '简历-前端.pdf');
  assert.equal(got.files[b.id].name, '简历-后端.pdf');

  // 反查：两个附件都指向同一条目同一字段
  for (const f of [a, b]) {
    const detail = await svc.getFile(f.id);
    assert.equal(
      detail.usedBy.filter((u) => u.entryId === got.id && u.fieldKey === 'resumeFile').length,
      1,
      '同一（条目,字段）只出一条引用',
    );
  }

  // 按**第二个**附件的名字也能搜到条目
  const searched = await entries.listEntries({ q: '简历-后端' });
  assert.equal(searched.entries.some((e) => e.id === got.id), true);

  // 数组去重：同一 id 写两遍只留一个
  await entries.updateEntry('多附件条目', { section: 'job', set: { resumeFile: [a.id, a.id, b.id] } });
  const after = await entries.getEntry('多附件条目', { section: 'job' });
  assert.deepEqual(after.values.resumeFile, [a.id, b.id]);
});

test('file 字段超 maxItems 报 INVALID_INPUT（与 tags 同一口径）', async () => {
  const sections = await import('../../src/modules/sections/service.js');
  await sections.addSection({
    id: 'cv_files', title: '附件测试', fields: [
      { key: 'docs', label: '资料', type: 'file', group: 'main', maxItems: 2 },
    ],
  });
  await assert.rejects(
    entries.addEntry({ section: 'cv_files', title: '超限', set: { docs: 'f_a,f_b,f_c' } }),
    (e) => e.code === 'INVALID_INPUT' && /最多 2 项，收到 3 项/.test(e.message),
  );
  // 上限之内正常写入
  const ok = await entries.addEntry({ section: 'cv_files', title: '未超限', set: { docs: 'f_a,f_b' } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual((await entries.getEntry('未超限', { section: 'cv_files' })).values.docs, ['f_a', 'f_b']);
});

test('兼容历史单值：字符串仍是单元素列表（读命令不炸、反查/搜索照常）', async () => {
  const c = await svc.addFile({ path: await makeSource('legacy', '老简历.pdf', 'legacy-bytes') });
  const { loadStore, mutateStore } = await import('../../src/core/store.js');
  // 直接写一个「老形态」的字符串单值（模拟 0.7.x 及更早存下来的数据）
  const created = await entries.addEntry({ section: 'job', title: '老数据', set: { name: '老数据' } });
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === created.id);
    e.values.resumeFile = c.id;
  });

  const got = await entries.getEntry('老数据', { section: 'job' });
  assert.equal(got.values.resumeFile, c.id, '老值原样读出来，不做迁移');
  assert.equal(got.files[c.id].name, '老简历.pdf', '单值同样能解析出附件名');
  assert.equal((await svc.getFile(c.id)).usedBy.some((u) => u.entryId === created.id), true);

  // 渲染成一行、不炸
  const dumped = await entries.getEntry('老数据', { section: 'job' });
  assert.ok(dumped.values.resumeFile);
  assert.ok((await loadStore()).entries.some((x) => x.id === created.id));
});

test('未知键写 f_ 形态的值 → 登记成附件字段（不是 tags/text）', async () => {
  const a = await svc.addFile({ path: await makeSource('infer', '推断.pdf', 'infer-bytes') });
  const r = await entries.updateEntry('多附件条目', { section: 'job', set: { 备用附件: `${a.id}` } });
  assert.equal(r.status, 'ok');
  const store = await loadStoreSafe();
  const job = store.sections.find((s) => s.id === 'job');
  const def = job.fields.find((f) => f.key === '备用附件');
  assert.equal(def.type, 'file', '按 f_ 前缀推断成附件字段');
  const got = await entries.getEntry('多附件条目', { section: 'job' });
  assert.deepEqual(got.values['备用附件'], [a.id]);
});

async function loadStoreSafe() {
  const { loadStore } = await import('../../src/core/store.js');
  return loadStore();
}

test('fileIdsOf：历史连写串（"f_a,f_b"）也拆开归一', () => {
  assert.deepEqual(core.fileIdsOf('f_a,f_b'), ['f_a', 'f_b']);
  assert.deepEqual(core.fileIdsOf(['f_a,f_b', 'f_c']), ['f_a', 'f_b', 'f_c']);
  assert.deepEqual(core.fileIdsOf('f_a，f_b、f_c；f_d'), ['f_a', 'f_b', 'f_c', 'f_d']);
});

test('file update 改名不带扩展名时，物理文件自动接回原扩展名', async () => {
  const src = await makeSource('rename-ext', 'rename-me.png', 'png-bytes');
  const added = await svc.addFile({ path: src, category: 'avatar' });
  const r = await svc.updateFile(added.id, { name: '证件照-干净版' });
  assert.equal(r.ext, '.png', '台账 ext 不变');
  assert.equal(r.rel, 'avatar/证件照-干净版.png', 'rel 带回原扩展名');
  const abs = join(filesDir(), ...r.rel.split('/'));
  assert.equal(await fsp.readFile(abs, 'utf8'), 'png-bytes', '内容跟着走');
  // 名字自带扩展名时不会被重复追加
  const r2 = await svc.updateFile(added.id, { name: '证件照-最终版.png' });
  assert.equal(r2.rel, 'avatar/证件照-最终版.png');
  await fsp.access(join(filesDir(), ...r2.rel.split('/')));
});

// 附件库分页：面板一次只渲染 24 张卡片，避免把整库图片都拉进内存。
// limit=0（CLI 默认）仍是全量，不能因为加参数改变旧行为。
test('listFiles 分页：limit/offset 只切过滤后的列表，默认仍全量', async () => {
  for (let i = 1; i <= 3; i += 1) {
    await svc.addFile({ content: Buffer.from(`page-${i}`).toString('base64'), name: `分页-${i}.txt` });
  }
  const all = await svc.listFiles({ q: '分页-' });
  assert.equal(all.count, 3);
  assert.equal(all.files.length, 3, '不传 limit 时保持全量（CLI 行为不变）');

  const p1 = await svc.listFiles({ q: '分页-', limit: 2 });
  assert.equal(p1.files.length, 2);
  assert.deepEqual(p1.page, { limit: 2, offset: 0, count: 2, total: 3, hasMore: true });

  const p2 = await svc.listFiles({ q: '分页-', limit: 2, offset: 2 });
  assert.equal(p2.files.length, 1);
  assert.equal(p2.page.hasMore, false);
});
