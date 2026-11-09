import { badInput } from '../../errors.ts';
import {
  coerceCell, columnToDef, normalizeSpec, renderTableText, sanitizeColumns, sanitizeTotals,
} from '../../../shared/table.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { displayRow, identityRemap, isSensitiveDef } from './common.ts';

/**
 * 表格的写入归一：把「字段定义 + 传进来的值」合成一份**自描述的表格文档**：
 *
 *   { v: 1, columns: [...], rows: [...], totals?: [...], summary?: false }
 *
 * 三种输入都认（都落成上面那一份）：
 *   - 行数组 `[{...}, {...}]`     ← CLI / 手写最省事，列取字段默认列或从行推断
 *   - 文档 `{columns, rows, …}`   ← 面板保存的形状，列以**数据里的**为准
 *   - 上面两者的 JSON 串          ← `--set 表='…'`
 *
 * 强转失败**不许静默兜底**：`工时: "两小时"` 存成 null 的话，合计会悄悄少一截。
 * 收集完所有格子的问题再一次性报，比逐条报更容易一次改对。
 */
export function normalizeTable(def: any, input: any): any {
  const spec = normalizeSpec(def, input);
  let columns;
  try {
    columns = sanitizeColumns(spec.columns, { where: `字段「${def.label}」` });
  } catch (e) {
    throw badInput((e as Error).message);
  }
  if (!columns.length) {
    // **空表是合法的**：没列也没数据就是「还没开始」。存成 null（= 这个字段空着），
    // 让 `--set 表=`、`[]`、`{}` 这几条「清空」的路都走得通，而不是被「必须给列」挡回来。
    if (!spec.rows.length) return null;
    throw badInput(`字段「${def.label}」有 ${spec.rows.length} 行数据却没有任何列 —— `
      + '把 columns 一起写进值里，或在面板的「列设置」里加列');
  }

  const given = Array.isArray(input) ? null : (input && typeof input === 'object' ? input : null);
  const problems: string[] = [];
  const rows: Record<string, unknown>[] = [];
  spec.rows.forEach((item: any, i: number) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      const col: any = columns.find((c: any) => c.key === k) || columns.find((c: any) => c.label === k);
      if (!col) {
        throw badInput(`字段「${def.label}」没有列「${k}」（现有列: ${columns.map((c: any) => c.label).join('、')}）。`
          + '表格的列也存在数据里：加列用面板的「列设置」，或把 columns 一起写进值里');
      }
      // 计算列由公式算，传进来的值不落盘（注意这里用 formula 判定：sanitizeColumns
      // 返回的是**可落盘的紧凑定义**，不带 computed 这种运行时字段）
      if (col.formula) continue;
      // 密文对象原样保留：导入/还原会把已经加密的格子原样送回来
      if (v && typeof v === 'object' && col.sensitive) { row[col.key] = v; continue; }
      const cell = coerceCell(col, v);
      if (cell.error) { problems.push(`第 ${i + 1} 行「${col.label}」${cell.error}`); continue; }
      if (cell.value === null || cell.value === undefined) continue;
      if (Array.isArray(cell.value) && !cell.value.length) continue;
      row[col.key] = cell.value;
    }
    if (Object.keys(row).length) rows.push(row);
  });
  if (problems.length) {
    throw badInput(`字段「${def.label}」有填错的值：${problems.slice(0, 4).join('；')}`
      + (problems.length > 4 ? `；等 ${problems.length} 处` : ''));
  }
  if (def.maxRows && rows.length > def.maxRows) {
    throw badInput(`字段「${def.label}」最多 ${def.maxRows} 行，收到 ${rows.length} 行`);
  }

  const doc: any = { v: 1, columns: columns.map((c: any) => columnToDef(c)), rows };
  // 统计行：数据里显式写了就校验后存下；没写就用字段定义的（都没写则渲染时按类型自动）
  if (given && given.totals !== undefined) {
    try {
      doc.totals = sanitizeTotals(given.totals, columns, { where: `字段「${def.label}」` });
    } catch (e) {
      throw badInput((e as Error).message);
    }
  }
  if (given && given.summary === false) doc.summary = false;
  else if (!given && def.summary === false) doc.summary = false;
  return doc;
}

export const tableBehavior: FieldBehavior = {
  cell: false,
  normalizeDef(raw, def) {
    // 表格：**结构归数据**。字段定义里只放「初始列」（新建条目时表格长什么样），
    // 条目自己的 columns 才是权威 —— 编辑时加一列不必回去改所有条目共用的 schema。
    // 所以 columns 在这里是**可选**的；给了就要合法（key 唯一、下拉有选项、公式能编译）。
    const cols = Array.isArray(raw.columns) ? raw.columns : raw.fields;
    if (raw.fields !== undefined && raw.columns !== undefined) {
      throw badInput(`字段 ${def.key}：columns 与 fields 是同一个东西的两种写法，只留一个。`);
    }
    if (cols !== undefined) {
      if (!Array.isArray(cols)) throw badInput(`字段 ${def.key} 的 columns 必须是数组`);
      // 空数组 = 不设初始列（表格完全由数据自己定义）。不落盘，免得字典里多一个空键。
      if (cols.length) {
        try {
          def.columns = sanitizeColumns(cols, { where: `字段 ${def.key}` });
        } catch (e) {
          throw badInput((e as Error).message);
        }
      }
    }
    if (raw.totals !== undefined) {
      // 没有初始列时没法核对 agg 里的列名（列在数据里）；这时先原样存下，
      // 渲染时对不上的格子会自己报「没有这一列」，不会静默算错。
      if (!Array.isArray(raw.totals)) throw badInput(`字段 ${def.key} 的 totals 必须是数组`);
      if (def.columns?.length) {
        try {
          def.totals = sanitizeTotals(raw.totals, def.columns, { where: `字段 ${def.key}` });
        } catch (e) {
          throw badInput((e as Error).message);
        }
      } else {
        def.totals = raw.totals.map((t: any) => ({ ...t }));
      }
    }
    if (raw.summary === false) def.summary = false;
    if (raw.maxRows !== undefined) {
      const n = Number(raw.maxRows);
      if (!Number.isFinite(n) || n <= 0) throw badInput(`字段 ${def.key} 的 maxRows 要是正数`);
      def.maxRows = Math.floor(n);
    }
  },
  coerce(def, raw) {
    // 形状与 entrylist 一样是「行对象数组」，区别在列有类型、还能有计算列。
    // 入口也一致：--data 给数组，--set 给 JSON 串。
    let list = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) return null;
      try { list = JSON.parse(raw); } catch { list = null; }
      if (!Array.isArray(list)) {
        throw badInput(`字段「${def.label}」是表格（table），值要是行数组的 JSON，`
          + `例如 '[{"任务":"写文档","已办":true,"工时":2}]'`);
      }
    }
    if (!Array.isArray(list)) {
      throw badInput(`字段「${def.label}」是表格（table），值要是行数组（JSON），收到 ${JSON.stringify(raw).slice(0, 80)}`);
    }
    return normalizeTable(def, list);
  },
  reveal: (def, raw, opts) => {
    // 表格读出去永远是**自描述的完整文档**：columns / rows / 可选 totals。
    const spec: any = normalizeSpec(def, raw);
    const subs = spec.columns;
    return {
      v: spec.v,
      columns: spec.columns.map((c: any) => columnToDef(c)),
      rows: spec.rows.map((row: any) => displayRow(subs, row, opts)),
      ...(Array.isArray(spec.totals) ? { totals: spec.totals } : {}),
      ...(spec.summary === false ? { summary: false } : {}),
    };
  },
  refs: () => [],
  remap: identityRemap,
  format: (def, _value, ctx) => {
    const table = ctx.tables?.[def.key];
    if (!table) return null;
    return renderTableText(table, { indent: '' }).split('\n');
  },
  sensitive: isSensitiveDef,
  subFields: (def) => def?.columns || [],
};
