// 图文字段（`type: 'md'`）预览的**行内解析**：图片 + http(s) 链接。
//
// 单独抽成纯函数，是因为这里最容易出「看着差不多、其实错」的问题：
// 链接末尾的中文句号被吞进 href、`![x](f_1)` 里的 id 被当成网址、
// `[说明](f_1)` 这种指向附件的写法被误当外链……这些都不报错，只是点了没用。
//
// 前端不能 import `src/core`，所以图片正则与 `core/mdimages.js` 同口径复制一份
// （与 `toIds` 复制 `fileIdsOf` 是同一类取舍：两处必须一起改）。
//
// 扫描顺序即优先级，**不能随意调换**：
//   1. `![说明](地址)`  图片（含外链图片）
//   2. `[文字](http…)`  markdown 链接
//   3. `http://…`       裸链接
// 图片排在裸链接前，`![x](https://a.png)` 才不会被拆成「图片缺失 + 一条网址」。

const IMAGE_SRC = String.raw`!\[(?<ialt>[^\]]*)\]\(\s*(?<isrc>[^)\s]+)\s*\)`;
const MDLINK_SRC = String.raw`\[(?<ltext>[^\]]+)\]\(\s*(?<lhref>https?:\/\/[^)\s]+)\s*\)`;
// 裸链接遇到空白、尖括号、引号、全角空格就结束；结尾的标点交给 splitTail 再收
const URL_SRC = String.raw`https?:\/\/[^\s<>"'\u3000]+`;

const RE = new RegExp(
  `(?<img>${IMAGE_SRC})|(?<mdlink>${MDLINK_SRC})|(?<url>${URL_SRC})`,
  'gi',
);

/** 网址尾巴上**不属于网址**的标点。中文标点必须列进来：`见 https://a.com。` 很常见。 */
const TRAIL_PUNCT = /[.,;:!?'"，。、；：！？…）】》」』”’]/;
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

function countOf(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/**
 * 剥掉网址尾巴上的标点，剥下来的部分原样留在正文里。
 *
 * 括号要**成对判断**：`https://en.wikipedia.org/wiki/Foo_(bar)` 的右括号是网址的一部分，
 * 而 `（见 https://a.com/x）` 的那个不是。判据只有一条：闭括号比开括号多，才算标点。
 */
function splitTail(url) {
  let href = url;
  let tail = '';
  for (;;) {
    const ch = href[href.length - 1];
    if (ch && TRAIL_PUNCT.test(ch)) {
      tail = ch + tail;
      href = href.slice(0, -1);
      continue;
    }
    if (ch && CLOSERS[ch] && countOf(href, ch) > countOf(href, CLOSERS[ch])) {
      tail = ch + tail;
      href = href.slice(0, -1);
      continue;
    }
    break;
  }
  return { href, tail };
}

/**
 * 把一段正文切成 token：
 *   `{ type: 'text', text }`
 *   `{ type: 'image', alt, src, remote }`   remote = src 是 http(s) 外链（不在附件库）
 *   `{ type: 'link', text, href, bare }`    bare = 正文里直接写的网址
 *
 * 只有 http/https 才算链接。`ftp://`、`www.example.com`、`mailto:` 一律按原文渲染 ——
 * 自动识别一旦放宽，文件名、包名、路径都会被误当成可点链接。
 */
export function tokenizeMd(text) {
  const src = String(text ?? '');
  const out = [];
  if (!src) return out;

  RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = RE.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    const g = m.groups;
    if (g.img !== undefined) {
      const imageSrc = g.isrc.trim();
      // `id` 与 `src` 同值：渲染层按 id 去附件表里查记录（recordOf），
      // 只有 src 的话查表会用 undefined 当键 —— 图明明在库里也会显示「缺失」。
      out.push({ type: 'image', alt: g.ialt, id: imageSrc, src: imageSrc, remote: isHttpUrl(imageSrc) });
    } else if (g.mdlink !== undefined) {
      out.push({ type: 'link', text: g.ltext, href: g.lhref, bare: false });
    } else {
      const { href, tail } = splitTail(g.url);
      out.push({ type: 'link', text: href, href, bare: true });
      if (tail) out.push({ type: 'text', text: tail });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

/** 正文里引用到的图片（保序、含重复）—— 编辑器据此做「图片统一列在下方」。 */
export function imageRefs(text) {
  return tokenizeMd(text)
    .filter((t) => t.type === 'image')
    .map((t) => ({ alt: t.alt, id: t.id, remote: t.remote }));
}

/** 正文里的链接数（含 markdown 链接与裸网址）—— 只用于给用户一个「这行里点了几个」的提示。 */
export function linkCount(text) {
  return tokenizeMd(text).filter((t) => t.type === 'link').length;
}
