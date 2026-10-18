// 图文字段（type: 'md'）：正文是标准 markdown，图片引用指向附件库的 id。
//
// 这里钉三件事：
//   1. 解析/重写的边界（普通 markdown 链接、缺失附件都不能被瞎改写）；
//   2. 写入 → 读回 → CLI 渲染这条链上，`f_xxx` 要变成「哪个文件、在磁盘哪」；
//   3. 部署配置模板确实带这个字段（不然写了类型也没地方用）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { mdImageIds, parseMdImages, rewriteMdImages } = await import('../../src/core/mdimages.js');
const { FIELD_TYPES, FIELD_TYPE_LABELS, getTemplate } = await import('../../src/core/fields.js');
const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const files = await import('../../src/modules/files/service.js');

test('parseMdImages：只认 ![](…) 图片语法，普通链接不动', () => {
  const text = '看这里 ![第一步](f_abc123) 还有 [普通链接](https://example.com/a.png)';
  const imgs = parseMdImages(text);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].id, 'f_abc123');
  assert.equal(imgs[0].alt, '第一步');
  // 不带 ! 的链接不是图片
  assert.ok(!JSON.stringify(imgs).includes('example.com'));
});

test('mdImageIds：去重且保序（同一张图出现两次只算一次）', () => {
  assert.deepEqual(
    mdImageIds('![a](f_1) x ![b](f_2) y ![c](f_1)'),
    ['f_1', 'f_2'],
  );
  assert.deepEqual(mdImageIds('没有图片'), []);
  assert.deepEqual(mdImageIds(null), []);
});

test('rewriteMdImages：换成「[图片: 说明] 本地路径」，缺附件时留下醒目提示', () => {
  const table = { f_1: { name: '第一步.png', path: '/home/me/第一步.png' } };
  const out = rewriteMdImages('先 ![截图一](f_1) 再 ![x](f_gone)', (id) => table[id] || null);
  assert.match(out, /\[图片: 截图一\] \/home\/me\/第一步\.png/);
  assert.match(out, /\[图片缺失: f_gone\]/);
  // 不带图片语法的链接原样保留
  const link = '[文档](f_1)';
  assert.equal(rewriteMdImages(link, (id) => table[id] || null), link);
});

test('md 是注册在案的类型，且有中文标签（面板下拉框要用）', () => {
  assert.ok(FIELD_TYPES.includes('md'));
  assert.ok(FIELD_TYPE_LABELS.md);
});

test('deploy 模板带「操作步骤（图文）」字段', () => {
  const t = getTemplate('deploy');
  const sop = t.fields.find((f) => f.key === 'sop');
  assert.ok(sop, 'deploy 模板应有 sop 字段');
  assert.equal(sop.type, 'md');
  assert.equal(sop.fill, 'optional', 'SOP 不是必填项，不该压着完整度');
});

test('写入含图正文 → entry get 能解析出附件路径，而不是吐一串 id', async () => {
  const up = await files.addFile({
    content: Buffer.from('fake-png-bytes').toString('base64'),
    name: '第一步-点开设置.png',
  });
  assert.ok(up.id, JSON.stringify(up));

  await sections.addSection({
    id: 'sopmd',
    title: '图文试验',
    fields: [
      { key: 'name', label: '名称', type: 'text' },
      { key: 'sop', label: '步骤', type: 'md' },
    ],
  });
  const text = `先打开设置 ![第一步](${up.id}) 然后保存`;
  await entries.addEntry({ section: 'sopmd', title: '有图的一条', set: { name: 'x', sop: text } });

  const got = await entries.getEntry('有图的一条', { section: 'sopmd' });
  // 原值必须原样保存（面板要能继续编辑这段 markdown）
  assert.equal(got.values.sop, text);
  // 附件表里要有它：这是 CLI 能把 id 还原成文件的前提
  assert.ok(got.files[up.id], JSON.stringify(got.files));
  assert.equal(got.fieldTypes.sop, 'md');

  const out = entries.renderEntryGet(got);
  assert.match(out, /\[图片: 第一步\]/);
  assert.ok(!out.includes(`![](${up.id})`), '不该把 markdown 原样吐给终端');
});

// 外链图片（`![说明](https://…)`）不是附件库里的东西。
// 之前一律按 id 去查台账，于是「图明明在，只是要联网」被报成「图片缺失」——
// 这种误报最坏的地方是让人怀疑附件被删了，然后去重新上传一遍。
test('外链图片：不进附件台账、不误报缺失，CLI 给的是可点的地址', () => {
  const url = 'https://cdn.example.com/arch.png';
  assert.deepEqual(mdImageIds(`![外链](${url}) ![本地](f_1)`), ['f_1']);

  const out = rewriteMdImages(`前 ![架构图](${url}) 后`, () => null);
  assert.ok(out.includes('[外链图片: 架构图]'), out);
  assert.ok(out.includes(url), out);
  assert.ok(!out.includes('图片缺失'));
});
