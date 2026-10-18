// 图文字段（`type: 'md'`）的**只读**行内解析：数图片、数链接。
//
// 正文渲染已经交给 react-markdown + remark-gfm（见 `components/mdView.jsx`），
// 这里只剩两件解析器管不了的事：
//   1. 下方图库要列出正文引用到的图片（`imageRefs`）—— 渲染出来的 DOM 不好反查 id；
//   2. 工具栏要显示「几张图 / 几个链接」（`linkCount`）—— 只是提示，不该为它多渲染一遍。
//
// 剩下的坑仍然是「看着差不多、其实错」的那类，所以照旧留纯函数 + 单测：
// 链接末尾的中文句号被吞进 href、`![x](f_1)` 里的 id 被当成网址、
// `[说明](f_1)` 这种指向附件的写法被误当外链……这些都不报错，只是点了没用。
//
// `splitTail` 现在还被渲染层复用：GFM 的自动链接会把 `https://a.com。` 的句号
// 一并吃进 href（浏览器打开就是 404），在 `<a>` 组件里再剥一次。
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
export function splitTail(url) {
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
 * 中文标点：**解码后**出现在网址里，就说明链接到头了。
 *
 * 起因是 GFM 自动链接的一条硬规则：它一直吃到空白为止。中文句子不用空格，
 * `见 https://a.com。另见这里` 会被整段吞进 href（`%E3%80%82%E5%8F%A6%E8%A7%81`），
 * 点开必然 404。而合法的中文路径在 URL 里一定是百分号编码的，
 * 所以「解码后出现中文标点」是个可靠的断点。
 */
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d\u2026\u2014]/;

/** 解析器给出的 href 是百分号编码过的；解码失败就按原样用（坏编码不该让整段正文渲染不出来）。 */
export function decodeUrl(value) {
  const s = String(value ?? '');
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/**
 * 编码回 href。不能直接 `encodeURI`：它会连已有的 `%XX` 里的 `%` 一起转义（`%20` → `%2520`），
 * 链接就坏了。所以编码后把 `%25XX` 还原成 `%XX` —— 只影响「本来就是转义序列」的那部分。
 */
export function encodeUrl(value) {
  return encodeURI(String(value ?? '')).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
}

/** 从第一个中文标点处断开：`https://a.com。另见` → `{ head: 'https://a.com', rest: '。另见' }` */
export function cutAtCjkPunct(value) {
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (CJK_PUNCT.test(s[i])) return { head: s.slice(0, i), rest: s.slice(i) };
  }
  return { head: s, rest: '' };
}

/**
 * 把一个 http(s) 地址收拾成「能点的 href」：剥掉被解析器吃进来的尾巴，再编码回去。
 * 渲染层（`components/mdView.jsx`）在 `urlTransform` 里用它 —— 那里拿到的是原始地址，
 * 一旦放过去，react-markdown 就会把带中文的 href 原样输出。
 */
export function cleanHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!isHttpUrl(raw)) return raw;
  const { href } = splitTail(decodeUrl(raw));
  return encodeUrl(cutAtCjkPunct(href).head);
}

/**
 * 链接的**显示文字**要跟 href 一起断：自动链接的文字就是那条地址，
 * 被吞进来的 `。另见` 得回到正文里，不能留在一个指向 404 的下划线里。
 * 返回 `{ text, tail }`：`tail` 由调用方渲染成普通文字。
 */
export function linkTextParts(text, href) {
  const s = String(text ?? '');
  const decoded = decodeUrl(String(href ?? '')).trim();
  // 只有「文字本身就是那条地址」时才按 href 切；`[控制台](…)` 的文字与地址无关，不能动
  if (decoded && s.startsWith(decoded)) return { text: decoded, tail: s.slice(decoded.length) };
  const { href: head, tail } = splitTail(s);
  return { text: head, tail };
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
