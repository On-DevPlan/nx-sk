// 从 shared/table.ts 拆出：数值 / 单元格 / 整表的文本渲染。

import { roundTo } from './formula.ts';
import type { JsonRow } from './formula.ts';

/** 数值显示：默认抹掉浮点毛刺，declared precision 才补零，unit 跟在后面。 */
export function formatNumber(n: unknown, precision: unknown, unit: unknown): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return n === null || n === undefined ? '' : String(n);
  // 注意 `Number(null) === 0`：不显式排除 null 的话，「没声明 precision」会被当成
  // 「保留 0 位小数」，2.5 在面板上变成 3 —— 静默丢精度的经典陷阱。
  const hasP = precision !== null && precision !== undefined && precision !== '';
  const p = hasP && Number.isFinite(Number(precision)) ? Number(precision) : null;
  const s = p === null ? String(roundTo(x)) : x.toFixed(p);
  if (!unit) return s;
  return unit === '%' ? `${s}%` : `${s} ${unit}`;
}

/** 一格值 → 人读文本（面板与 CLI 共用，所以「是/否」不会两边不一致）。 */
export function formatCellValue(col: JsonRow | null | undefined, value: unknown): string {
  if (value === null || value === undefined) return '';
  const type = col?.type || 'text';
  if (type === 'bool') return value === true || value === 'true' || value === 1 || value === '1' ? '是' : '否';
  if (type === 'number') return formatNumber(value, col?.precision, col?.unit);
  if (type === 'tags') return Array.isArray(value) ? value.join('、') : String(value);
  return String(value);
}

/** 一张表 → 等宽文本（CLI 用）。合计行与公式报错都在这里落地，agent 读到的就是人看到的。 */
export function renderTableText(table: JsonRow, { indent = '  ' }: { indent?: string } = {}): string {
  if (!table || !table.columns.length) return `${indent}（这张表还没有列）`;
  const cols: JsonRow[] = table.columns;
  const cellText = (row: JsonRow, c: JsonRow) => {
    if (row.errors[c.key]) return '#错误';
    return formatCellValue(c, row.values[c.key]);
  };
  const head = cols.map((c) => (c.computed ? `${c.label}(算)` : c.label));
  const body = (table.rows as JsonRow[]).map((r) => cols.map((c) => cellText(r, c)));
  // 合计行的标签固定落在第一列：第一列自己也有合计值时挤在同一格里
  // （`合计 7.5`）——宁可挤，也不能让一个算出来的数字消失。
  const totalRows = (table.totals as JsonRow[]).map((t) => {
    const cells = cols.map((c) => {
      if (t.errors[c.key]) return '#错误';
      const v = t.texts[c.key];
      return v === undefined || v === '' ? '' : v;
    });
    let first = t.label;
    if (cells[0]) first = `${t.label} ${cells[0]}`;
    if (t.text) first = `${first}　${t.text}`;
    cells[0] = first;
    return cells;
  });

  const widths = head.map((h, i) => Math.max(
    displayWidth(h),
    ...body.map((r) => displayWidth(r[i] ?? '')),
    ...totalRows.map((r) => displayWidth(r[i] ?? '')),
  ));
  const line = (cells: string[]) => {
    const parts = cells.map((x, i) => {
      const w = widths[i] ?? displayWidth(x);
      const pad = Math.max(0, w - displayWidth(x || ''));
      return cols[i]?.align === 'right' ? ' '.repeat(pad) + (x || '') : (x || '') + ' '.repeat(pad);
    });
    return `${indent}${parts.join('  ')}`.replace(/\s+$/, '');
  };

  const lines = [line(head), `${indent}${widths.map((w) => '-'.repeat(w)).join('  ')}`];
  for (const r of body) lines.push(line(r));
  for (const t of totalRows) lines.push(line(t));
  if (table.errorCount) {
    for (const e of table.errors.slice(0, 6)) {
      const col = cols.find((c) => c.key === e.column);
      lines.push(`${indent}! 第 ${e.row + 1} 行「${col?.label || e.column}」：${e.message}`);
    }
    if (table.errors.length > 6) lines.push(`${indent}! 另有 ${table.errors.length - 6} 处公式错误`);
  }
  return lines.join('\n');
}

/** 等宽宽度：CJK 占两格，否则 CLI 的表格会歪。 */
function displayWidth(s: unknown): number {
  const str = String(s ?? '');
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}
