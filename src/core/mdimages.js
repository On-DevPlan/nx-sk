// 图文字段（`type: 'md'`）里图片引用的解析与重写 —— **Node 侧唯一实现**。
//
// 语法就是普通 markdown：`![说明](f_xxx)`，不加 `![[…]]` 这种方言。
// 理由：这段文字经常要原样流出去（导出成 md、贴进仓库 README、发给同事），
// 标准语法才不挑渲染器；方言只有本工具的编辑器认得。
//
// 前端不能 import core，`fieldEditor.jsx` 里自带一份同口径的正则
// （与 `toIds` 复制 `fileIdsOf` 是同一类取舍，两处必须一起改）。

// 附件 id 形如 `f_lq3k2j9a1b2c3d4`（core/ids.js 的 newId）。放宽到任意 token，
// 认不出的就当普通文字：任务正文里写 `![图](https://…)` 也不该被改写。
const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;

/** 外链图片：`![说明](https://…)` 引的是网上的图，不在附件库里。 */
export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

/** 解析出全部图片引用（保序，含重复）。 */
export function parseMdImages(text) {
  const src = String(text ?? '');
  const out = [];
  if (!src) return out;
  IMAGE_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_RE.exec(src)) !== null) {
    out.push({ alt: m[1], id: m[2].trim(), raw: m[0], index: m.index });
  }
  return out;
}

/** 正文引用到的**附件** id（去重、保序）—— 用来建 `files` 表与做完整性检查。
 *  外链图片不在附件库里，不进去：否则每张网图都要白查一次台账。 */
export function mdImageIds(text) {
  const seen = new Set();
  const out = [];
  for (const { id } of parseMdImages(text)) {
    if (isHttpUrl(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 把正文里的图片引用改写成**人能读的一行**（CLI / 导出用）：
 *   `![发票截图](f_abc)` → `[图片: 发票截图] ~/nx-sk/files/other/发票截图.png`
 *
 * `lookup(id)` 返回 `{ name, path }` 或 null。null 表示附件已不在库里 ——
 * 这时**保留**一条醒目的「图片缺失」，而不是静默删掉：删了等于让读者以为这里本来没图。
 */
export function rewriteMdImages(text, lookup) {
  const src = String(text ?? '');
  if (!src) return '';
  IMAGE_RE.lastIndex = 0;
  return src.replace(IMAGE_RE, (raw, alt, id) => {
    const ref = String(id).trim();
    // 外链图片不查附件库：查了必然是「缺失」，但图其实在（只是要联网）。
    if (isHttpUrl(ref)) return `[外链图片: ${alt || ref}] ${ref}`;
    const rec = lookup(ref);
    if (!rec) return `[图片缺失: ${ref}]`;
    const label = alt || rec.name || ref;
    return rec.path ? `[图片: ${label}] ${rec.path}` : `[图片: ${label}] ${rec.name}`;
  });
}
