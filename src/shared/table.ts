// 表格字段（`type: 'table'`）的内核：结构映射 + JS 表达式求值 + 统计。
//
// **表格是自描述的**：列定义、行数据、公式、统计配置**全在数据里**，不在栏目字典里。
// 字段定义（section.fields 里那一条）只留 `type: 'table'` 和可选的**初始列**，
// 用它给新建的表格起个头；一旦条目里有了自己的 columns，就以数据里的为准。
// 这样「编辑时临时加一列」「这一条想多算一个字段」都不必回去改栏目 schema ——
// 栏目 schema 是**所有条目共用**的，而一张表的列往往只对这条有意义。
//
// 为什么放在 `src/shared/` 而不是 `src/core/`：
//   面板**不许 import core**（eslint 的前后端边界规则，见 eslint.config.js 末段），
//   而「这张表怎么算」只允许有一份实现 —— CLI 印出的合计与面板上看到的合计对不上，
//   比根本不给合计更糟。所以它必须落在两边都能 import、且不依赖任何 Node 内置模块的位置。
//   本文件必须保持**纯函数 + 零依赖**：一旦它 import 了 fs/crypto，浏览器就打包不出来了。
//
// 设计取舍（对齐 Notion / 飞书的表格，但保留 JS 本体）：
//   - 不发明公式语法。单元格公式就是一个 JS **表达式**（`qty * price`），
//     可用列 key、可用中文列名、可用 `row` 取原值、可用 `rows` 取整张表。
//   - 求值只包成 `return (表达式)`，语句（`for` / `var`）写不进来 ——
//     这不是安全沙箱（公式是数据所有者自己写的），而是**把写错的边界前移**：
//     语句在这里就是语法错，而不是悄悄算出个 undefined。
//   - 空白单元格在短名字里当 0 / false / ''（`hours * rate` 不该因为空格子变 NaN），
//     需要判断「到底填没填」时用 `row.hours === null` 或 `isBlank(row.hours)`。

export type { CompiledEntry } from './table/formula.ts';
export type { NormColumn, NormTotal, TableSpec } from './table/schema.ts';
export type { ComputedRow, ComputedTotal, ComputedTable } from './table/compute.ts';

export { FormulaError, compileFormula, evalFormula, roundTo } from './table/formula.ts';
export {
  TABLE_CELL_TYPES, AGG_FNS, COL_TOTALS, AGG_LABELS,
  normalizeColumns, inferColumns, columnToDef,
  sanitizeColumns, sanitizeTotals, normalizeSpec, buildTotals, coerceCell, checkFormulaNames,
} from './table/schema.ts';
export { computeTable } from './table/compute.ts';
export { formatNumber, formatCellValue, renderTableText } from './table/text.ts';
