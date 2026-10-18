// 图文（`md`）预览的行内解析：图片 + http(s) 链接。
//
// 这里钉的都是「不报错、只是点上去没用」的错：
//   - 中文句号/全角括号被吃进 href（点了 404）
//   - `![x](f_1)` 的 id 被当成网址
//   - `![x](https://…png)` 被拆成「图片缺失」+ 一条链接
//   - `www.` / `ftp://` 被自动识别（文件名、包名从此满屏可点）
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { tokenizeMd, imageRefs, linkCount, isHttpUrl } = await import('../../src/web/frontend/mdInline.js');

const kinds = (text) => tokenizeMd(text).map((t) => t.type);

test('裸网址：识别成链接，前后文字原样保留', () => {
  const t = tokenizeMd('看 https://example.com/a?b=1 这里');
  assert.deepEqual(t.map((x) => x.type), ['text', 'link', 'text']);
  assert.equal(t[0].text, '看 ');
  assert.equal(t[1].href, 'https://example.com/a?b=1');
  assert.equal(t[1].bare, true);
  assert.equal(t[2].text, ' 这里');
});

test('裸网址尾巴上的中文标点不算网址', () => {
  const t = tokenizeMd('详见 https://example.com/a。');
  const link = t.find((x) => x.type === 'link');
  assert.equal(link.href, 'https://example.com/a');
  // 句号必须回到正文里，不能被吞掉
  assert.equal(tokenizeMd('详见 https://example.com/a。').at(-1).text, '。');
});

test('括号成对判断：网址里的右括号保留，包裹用的右括号剥掉', () => {
  assert.equal(
    tokenizeMd('https://en.wikipedia.org/wiki/Foo_(bar)').find((x) => x.type === 'link').href,
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  );
  const wrapped = tokenizeMd('（见 https://a.com/x）');
  assert.equal(wrapped.find((x) => x.type === 'link').href, 'https://a.com/x');
  assert.equal(wrapped.at(-1).text, '）');
});

test('markdown 链接：文字与地址分开，且网址不会被再识别一次', () => {
  const t = tokenizeMd('打开 [控制台](https://console.example.com/x) 看看');
  assert.deepEqual(t.map((x) => x.type), ['text', 'link', 'text']);
  assert.equal(t[1].text, '控制台');
  assert.equal(t[1].href, 'https://console.example.com/x');
  assert.equal(t[1].bare, false);
});

test('图片：附件 id 不是链接；外链地址标成 remote', () => {
  const local = tokenizeMd('![第一步](f_lq3k2j9a1b2c3d4)');
  assert.deepEqual(local.map((x) => x.type), ['image']);
  assert.equal(local[0].src, 'f_lq3k2j9a1b2c3d4');
  assert.equal(local[0].remote, false);

  const remote = tokenizeMd('![架构图](https://cdn.example.com/a.png)');
  assert.deepEqual(remote.map((x) => x.type), ['image'], '外链图片不该被拆成链接');
  assert.equal(remote[0].remote, true);
  assert.equal(remote[0].src, 'https://cdn.example.com/a.png');
});

test('只认 http/https：ftp、www、mailto、纯路径都按原文', () => {
  for (const s of ['ftp://a.com/x', 'www.example.com', 'mailto:a@b.com', './a/b.md', '/etc/hosts']) {
    assert.deepEqual(kinds(`看 ${s} 完`), ['text'], s);
  }
  assert.deepEqual(kinds('看 http://a.com 完'), ['text', 'link', 'text']);
  assert.ok(isHttpUrl('HTTPS://A.COM'));
  assert.ok(!isHttpUrl('javascript:alert(1)'));
});

test('一行里多个链接按出现顺序切开', () => {
  const t = tokenizeMd('A https://a.com B [c](https://c.com) D');
  assert.deepEqual(t.map((x) => (x.type === 'link' ? x.href : x.text)), [
    'A ', 'https://a.com', ' B ', 'https://c.com', ' D',
  ]);
  assert.equal(linkCount('A https://a.com B [c](https://c.com) D'), 2);
});

test('imageRefs：保留说明与 remote 标记，空正文返回空数组', () => {
  const refs = imageRefs('![本地](f_1) ![外链](https://a.com/b.png)');
  assert.deepEqual(refs, [
    { alt: '本地', id: 'f_1', remote: false },
    { alt: '外链', id: 'https://a.com/b.png', remote: true },
  ]);
  assert.deepEqual(imageRefs(null), []);
});

test('空串与无标记文本不产生 token 空洞', () => {
  assert.deepEqual(tokenizeMd(''), []);
  assert.deepEqual(tokenizeMd('一段普通说明'), [{ type: 'text', text: '一段普通说明' }]);
});

// 渲染层靠 token.id 去附件表里查记录（见 fieldEditor 的 recordOf）。
// 只有 src 的话查表键是 undefined —— 图在库里也会整篇显示「图片缺失」，
// 而图库缩略图走的是 imageRefs（有 id），于是出现「下面有图、正文说没有」的怪象。
test('image token 必须同时带 id 与 src（渲染层按 id 查表）', () => {
  const [img] = tokenizeMd('![第一步](f_lq3k2j9a1b2c3d4)');
  assert.equal(img.type, 'image');
  assert.equal(img.id, 'f_lq3k2j9a1b2c3d4');
  assert.equal(img.src, img.id);

  const [remote] = tokenizeMd('![架构](https://cdn.example.com/a.png)');
  assert.equal(remote.id, 'https://cdn.example.com/a.png');
  assert.equal(remote.remote, true);
});
