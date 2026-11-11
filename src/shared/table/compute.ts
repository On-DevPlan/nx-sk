// 从 shared/table.ts 拆出：算一张表（computeTable）与表尾统计的文本。

import { HELPERS, evalFormula, findColumn, rowVars, totalsVars } from './formula.ts';
import type { JsonRow } from './formula.ts';
import { AGG_FNS, buildTotals, coerceCell, normalizeSpec } from './schema.ts';
import type { NormColumn, TableSpec } from './schema.ts';
import { formatCellValue, formatNumber } from './text.ts';

/** 一行的计算结果。 */
export interface ComputedRow {
  raw: JsonRow;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  index: number;
}

/** 一条统计行的计算结果。 */
export interface ComputedTotal {
  key: string;
  label: string;
  values: Record<string, unknown>;
  texts: Record<string, string>;
  errors: Record<string, string>;
  value: unknown;
  text: string;
}

/** computeTable 的完整返回值。 */
export interface ComputedTable {
  v: number;
  columns: NormColumn[];
  rows: ComputedRow[];
  totals: ComputedTotal[];
  count: number;
  errorCount: number;
  errors: Array<{ row: number; column: string; message: string }>;
  summary: boolean | undefined;
  maxRows: number | null;
  declaredTotals: JsonRow[] | undefined;
}

function totalsText(fnName: string, value: unknown, list: unknown[], col: JsonRow | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (fnName === 'countTrue' && col?.type === 'bool') return `${value}/${list.length}`;
  if (typeof value === 'number') return formatNumber(value, col?.precision, col?.unit);
  return String(value);
}

/**
 * 算一张表。输入是**字段定义 + 条目里的值**（值可以是行数组，也可以是自描述对象），输出：
 *
 *   { v, columns, rows: [{ raw, values, errors }], totals: [{ label, values, texts, errors, value }],
 *     count, errorCount, errors: [{ row, column, message }] }
 *
 * `rows[].raw` 是传进来的那一行（原样，供编辑器继续改），`values` 是强转 + 计算后的值。
 * 计算列**不落盘也不回写**：再次读到时重算，所以不会出现「存的合计和现在的数据对不上」。
 */
export function computeTable(def: JsonRow | null | undefined, value: unknown): ComputedTable {
  const spec: TableSpec = normalizeSpec(def, value);
  const columns: NormColumn[] = spec.columns;
  const input: JsonRow[] = spec.rows;
  const enteredCols = columns.filter((c) => !c.computed);
  const calcCols = columns.filter((c) => c.computed);
  const errors: Array<{ row: number; column: string; message: string }> = [];

  // 第一趟：读入值 + 强转
  const out: ComputedRow[] = input.map((row, i) => {
    const values: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const c of enteredCols) {
      const cell = coerceCell(c, row[c.key]);
      if (cell.error) {
        errs[c.key] = cell.error;
        errors.push({ row: i, column: c.key, message: cell.error });
      }
      values[c.key] = cell.value ?? null;
    }
    return { raw: row, values, errors: errs, index: i };
  });
  // 行公式里的 rows 只含「填进去的值」：带上计算列会立刻成环（A 引用 B、B 引用 A）。
  const plainRows = out.map((r) => r.values);

  // 第二趟：计算列按声明顺序逐列算。只引用前面的列 = 天然的依赖顺序，不必做拓扑排序。
  for (let ci = 0; ci < calcCols.length; ci += 1) {
    const c = calcCols[ci];
    // 报错名单里带上**自己**：引用自己也是错，且要给同一句可操作的提示
    const late = calcCols.slice(ci).map((x) => x.key);
    for (const row of out) {
      const { vars, names } = rowVars(columns, row.values, row.index, plainRows);
      const r = evalFormula(c.formula, vars, { names, late });
      if (r.ok) {
        row.values[c.key] = r.value;
      } else {
        row.errors[c.key] = r.error;
        errors.push({ row: row.index, column: c.key, message: r.error });
      }
    }
  }

  const computedRows: JsonRow[] = out.map((r) => r.values as JsonRow);
  const totals: ComputedTotal[] = buildTotals(spec, columns).map((t) => {
    const values: Record<string, unknown> = {};
    const texts: Record<string, string> = {};
    const errs: Record<string, string> = {};
    if (t.agg) {
      for (const [ref, fnName] of Object.entries(t.agg) as Array<[string, string]>) {
        const col = findColumn(columns, ref);
        if (!col) { errs[String(ref)] = '没有这一列'; continue; }
        const fn = (HELPERS as unknown as JsonRow)[fnName];
        if (typeof fn !== 'function' || !AGG_FNS.includes(fnName)) {
          errs[col.key] = `未知的统计函数「${fnName}」（可用：${AGG_FNS.join(' / ')}）`;
          continue;
        }
        const list = computedRows.map((r) => r[col.key] ?? null);
        const v = fn(list);
        values[col.key] = v;
        texts[col.key] = totalsText(fnName, v, list, col);
      }
    }
    let value = null;
    let text = '';
    if (t.expr) {
      const { vars, names } = totalsVars(columns, computedRows);
      const r = evalFormula(t.expr, vars, { names });
      if (r.ok) {
        value = r.value;
        const target = t.cell ? findColumn(columns, t.cell) : null;
        if (target) {
          values[target.key] = r.value;
          texts[target.key] = formatCellValue(target, r.value);
        } else {
          text = r.value === null ? '' : (typeof r.value === 'number' ? formatNumber(r.value, t.precision, t.unit) : String(r.value));
        }
      } else {
        errs[t.cell || '__expr'] = r.error;
      }
    }
    return { key: t.key, label: t.label, values, texts, errors: errs, value, text };
  });

  return {
    v: spec.v,
    columns,
    rows: out,
    totals,
    count: out.length,
    errorCount: errors.length,
    errors,
    summary: spec.summary,
    maxRows: spec.maxRows,
    declaredTotals: spec.totals,
  };
}
