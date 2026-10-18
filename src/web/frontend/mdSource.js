// md 正文的**源码级**编辑：任务列表勾选（在预览里点一下 = 改正文里的 `[ ]`）。
//
// 为什么单独一个文件：`mdInline.js` 是**只读**解析（数图片、数链接，不改原文），
// 这里会**改写用户原文**，边界要窄得多 —— 只认行首的列表标记 + 复选框，
// 别处的 `[x]`（正文里的方括号、代码块里的示例）一律不碰。
//
// 勾选状态不存在别的地方：正文就是唯一真相。否则「预览里勾了、导出还是空的」
// 会变成一类查不出来的错。

/** 行首任务项：`- [ ]` / `* [x]` / `+ [X]` / `1. [ ]`，允许缩进（嵌套列表）。 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/** 待办统计（总数 / 已完成）—— 只用于给用户一行提示，不参与渲染。 */
export function taskStats(text) {
  let total = 0;
  let done = 0;
  for (const line of String(text ?? '').split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    total += 1;
    if (m[2] !== ' ') done += 1;
  }
  return { total, done };
}

/**
 * 把第 `line` 行（**1 起算**，与 markdown 解析器给的 position 同口径）的复选框取反。
 * 行号越界、或那一行不是任务项时**原样返回**：宁可什么都不发生，
 * 也不要因为行号对不上把用户别处的文字改坏。
 */
export function toggleTaskAtLine(text, line) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const i = Number(line) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) return src;
  const m = TASK_LINE.exec(lines[i]);
  if (!m) return src;
  const mark = m[2] === ' ' ? 'x' : ' ';
  lines[i] = `${m[1]}${mark}${m[3]}${lines[i].slice(m[0].length)}`;
  return lines.join('\n');
}
