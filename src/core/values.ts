// 值的「空 / 非空」判据 —— **唯一实现**。
//
// 这三条判据被完整度（render）、写入归一（字段行为）、附件引用扫描三处共用。
// 以前它们散在 core/render.js 里，字段行为要 import render 才能用，就会绕成
// 「render → 注册表 → 行为 → render」的环，所以在 P2 单独下沉到这里。
// render.js 继续 re-export，老导入点不受影响。

export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  // 表格文档：一行都没有就算没填（有列没数据不算填了内容）。
  // 密文对象没有 rows，不受这条影响。
  if (typeof v === 'object' && Array.isArray((v as { rows?: unknown }).rows)) {
    return (v as { rows: unknown[] }).rows.length === 0;
  }
  return String(v).trim() === '';
}

/**
 * 「这个字段真的没有东西可带出去」—— 与 isBlank 的区别只在表格：
 *
 *   - `isBlank` 决定**完整度**：有列没行的表算「没填」（不然一张空表就把进度撑满了）。
 *   - `isStoredEmpty` 决定**值要不要输出**：还有列就说明结构在，要带出去 ——
 *     否则面板拿不到列，用户搭好的骨架（列 + 默认值）一保存就"消失"了。
 */
export function isStoredEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const rows = (v as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const cols = (v as { columns?: unknown }).columns;
      return !rows.length && !(Array.isArray(cols) && cols.length);
    }
  }
  return String(v).trim() === '';
}

export function isPlainRow(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
