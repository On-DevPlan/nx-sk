// 正文里**裸写**的地址识别：IP（点击复制）与域名（点击打开）。
//
// 为什么需要：用户贴进来的地址往往没有协议头 —— `125.67.197.2:7443`、
// `qcloud.sicau.edu.cn/login`。GFM 的自动链接只认带协议的（`www.` 除外），
// 这两种在预览里都是一坨死文字；而它们的形态特征其实很强。
//
// 两类走**两种交互**，因为目的不同：
//   IP / host:port  → 点击**复制**。内网地址、服务端口点开也没用，复制去粘贴才是目的。
//   域名（可带路径）→ 点击**打开**，默认补 `http://`。
//
// 误判的代价不对称：把 `config.json` 认成域名，正文里多一条点不开的链接；
// 把真域名漏掉，只是少一个便捷入口。所以这里宁可**严**：TLD 黑名单 + 端口范围校验 +
// 前后必须是「词的边界」。
import { visit } from 'unist-util-visit';
import { splitTail } from './mdInline.js';

/** 单个 IPv4 段：0–255（不认前导零之外的写法，`01` 也算合法，浏览器同样接受）。 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP_SRC = `(?:${OCTET}\\.){3}${OCTET}`;
const PORT_SRC = '\\d{1,5}';
/**
 * 域名：至少两段、TLD 是 2–24 个字母。
 * 路径部分遇到空白、引号、尖括号、反引号、表格竖线、中文就结束 ——
 * 中文句子不用空格，`…/login登录` 里的「登录」绝不属于地址。
 */
const HOST_SRC = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24}';
const PATH_SRC = '(?:\\/[^\\s<>"\'`|，。；：、！？（）【】《》「」『』“”‘’\\u4e00-\\u9fff\\u3000-\\u303f\\uff01-\\uff60]*)?';

// 前置边界：前面是字母/数字/点/@/斜杠/冒号时不算起点 —— 否则 `https://a.com`
// 里的 `a.com`、邮箱里的 `b.com`、路径里的 `a/b.com` 都会被再识别一次。
const SMART_RE = new RegExp(
  `(?<![\\w.@/:])(?:`
  + `(?<ip>${IP_SRC})(?::(?<ipport>${PORT_SRC}))?(?![\\w]|\\.\\d)`
  + `|(?<local>localhost):(?<localport>${PORT_SRC})`
  + `|(?<host>${HOST_SRC})(?::(?<port>${PORT_SRC}))?${PATH_SRC}`
  + ')',
  'gi',
);

/**
 * 长得像 TLD、但在开发者的正文里几乎总是**文件扩展名**的后缀。
 * 只放常见的；判错的代价是少一个可点入口，比把 `README.md` 变成链接小得多。
 */
const NOT_TLD = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonl', 'md', 'mdx', 'txt', 'log', 'csv', 'tsv',
  'css', 'scss', 'less', 'sass', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'lock', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'sql', 'db', 'sqlite', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'rar', '7z',
  'exe', 'msi', 'dmg', 'apk', 'ipa', 'deb', 'rpm', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'map', 'bak', 'tmp', 'pid', 'dat', 'bin', 'iso', 'pyc', 'class',
  'jar', 'war', 'min', 'd', 'o', 'a', 'so', 'dll', 'lib', 'obj', 'pdb',
]);

function validPort(raw) {
  if (!raw) return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** 匹配结果 → `{ kind, text }`；不像地址就返回 null（原样留成文字）。 */
function classify(m) {
  if (m.groups.ip) {
    if (!validPort(m.groups.ipport)) return null;
    return { kind: 'copy', text: m[0] };
  }
  if (m.groups.local) {
    if (!validPort(m.groups.localport)) return null;
    return { kind: 'copy', text: m[0] };
  }
  const host = m.groups.host;
  const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
  if (NOT_TLD.has(tld)) return null;
  if (!validPort(m.groups.port)) return null;
  // 路径尾巴上的标点不属于地址（`…/login,`、`…/login。`），剥下来的留在正文里
  const { href } = splitTail(m[0]);
  return { kind: 'url', text: href };
}

/**
 * 把一段纯文字切成 `{ type: 'text' | 'copy' | 'url', text, url? }`。
 * 没有命中就返回 null（调用方据此跳过，不做无意义的节点替换）。
 */
export function splitSmart(text, scheme = 'http://') {
  const src = String(text ?? '');
  if (!src) return null;
  const out = [];
  let last = 0;
  let hit = false;
  SMART_RE.lastIndex = 0;
  let m;
  while ((m = SMART_RE.exec(src)) !== null) {
    const token = classify(m);
    if (!token) continue;
    hit = true;
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    if (token.kind === 'url') out.push({ type: 'url', text: token.text, url: `${scheme}${token.text}` });
    else out.push({ type: 'copy', text: token.text });
    last = m.index + token.text.length;
  }
  if (!hit) return null;
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

/**
 * 只用于工具栏那句统计：正文里有几个「点击复制」的 IP、几个自动补协议的网址。
 * 先剥掉代码块与行内代码 —— 那里的地址不会变成可点，算进去就成了虚报。
 */
export function smartStats(text) {
  const src = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
  let copy = 0;
  let url = 0;
  SMART_RE.lastIndex = 0;
  let m;
  while ((m = SMART_RE.exec(src)) !== null) {
    const token = classify(m);
    if (!token) continue;
    if (token.kind === 'url') url += 1;
    else copy += 1;
  }
  return { copy, url };
}

/** 命中 → mdast 节点。IP 用 `hName` 直接变成 `<button data-copy>`，由容器代理点击。 */function toNode(part) {
  if (part.type === 'copy') {
    return {
      type: 'text',
      value: part.text,
      data: {
        hName: 'button',
        hProperties: { type: 'button', className: 'md-copy', 'data-copy': part.text, title: '点击复制' },
      },
    };
  }
  if (part.type === 'url') {
    return { type: 'link', url: part.url, title: null, children: [{ type: 'text', value: part.text }] };
  }
  return { type: 'text', value: part.text };
}

/**
 * remark 插件：只动**纯文字节点**。代码块/行内代码本来就没有文字子节点，
 * 已经在链接里的文字也不碰（否则会出现链接套链接）。
 *
 * 必须排在 `remark-gfm` 之后：先让 GFM 把 `https://…` 与 `www.…` 收走，
 * 这里只处理它剩下的裸 IP / 裸域名。
 */
export function remarkSmartLinks(options = {}) {
  const scheme = options.scheme || 'http://';
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      if (parent.type === 'link' || parent.type === 'linkReference') return;
      const parts = splitSmart(node.value, scheme);
      if (!parts) return;
      parent.children.splice(index, 1, ...parts.map(toNode));
      // 告诉遍历器跳过刚插进去的节点，否则会对着新链接的文字再来一遍
      return index + parts.length;
    });
  };
}
