// 从 shared/table.ts 拆出：列 / 统计行 / 表定义的类型与归一、校验。

import { FormulaError, compileFormula, evalFormula, isPlainRow, looseValue, rowVars, totalsVars } from './formula.ts';
import type { JsonRow } from './formula.ts';

export const TABLE_CELL_TYPES = ['text', 'textarea', 'number', 'bool', 'select', 'date', 'month', 'tags'];

/** 计算列：列上有 `formula` 就是计算列，值不落盘、读的时候现算。 */
export const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'countTrue', 'countFalse', 'distinct', 'median', 'first', 'last'];

/** 列上 `total` 可取值：表尾这一格怎么算。`none` = 这一列不统计。 */
export const COL_TOTALS = [...AGG_FNS, 'none'];

export const AGG_LABELS = {
  sum: '求和', avg: '平均', min: '最小', max: '最大', count: '计数（非空）',
  countTrue: '计数（是）', countFalse: '计数（否）', distinct: '去重计数',
  median: '中位数', first: '第一条', last: '最后一条', none: '不统计',
};

/** 归一后的列：normalizeColumns / sanitizeColumns 的产物。 */
export interface NormColumn {
  key: string;
  label: string;
  type: string;
  formula: string;
  computed: boolean;
  options: string[];
  sensitive: boolean;
  total: string;
  width: number | null;
  align: string;
  precision: number | null;
  unit: string;
  hint: string;
  default: unknown;
}

/** 归一后的统计行：buildTotals 的产物。 */
export interface NormTotal {
  key: string;
  label: string;
  agg: Record<string, string> | null;
  expr: string;
  cell: string;
  unit: string;
  precision: number | null;
}

/** normalizeSpec 的返回值（自描述表定义）。 */
export interface TableSpec {
  v: number;
  columns: NormColumn[];
  rows: JsonRow[];
  totals: JsonRow[] | undefined;
  summary: boolean | undefined;
  maxRows: number | null;
}

// —— 列定义 ——

const KEY_MAX = 48;

/** 列 key 的规则与字段 key 同一口径（中文也行，但不许空白、路径分隔符、'..'）。 */
function checkColumnKey(key: unknown): string {
  const s = String(key ?? '').trim();
  if (!s) throw new FormulaError('列 key 不能为空');
  if (s.length > KEY_MAX) throw new FormulaError(`列 key 过长（${s.length} > ${KEY_MAX}）: ${s}`);
  if (/[\s/\\]/.test(s) || s.includes('..')) {
    throw new FormulaError(`列 key 非法: ${JSON.stringify(key)}（不允许空白、路径分隔符或 '..'；中文可以）`);
  }
  return s;
}

/** 列定义归一（宽松）：把任何来源（数据 / 字段默认列 / 行推断）整理成内核认的形状。 */
export function normalizeColumns(src: unknown): NormColumn[] {
  const raw = Array.isArray(src) ? src : (isPlainRow(src) && Array.isArray(src.columns) ? src.columns : []);
  const seen = new Set<string>();
  const out: NormColumn[] = [];
  for (const c of raw) {
    if (!isPlainRow(c)) continue;
    const key = String(c.key ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const formula = c.formula ? String(c.formula) : '';
    const type = c.type || (formula ? 'number' : 'text');
    out.push({
      key,
      label: String(c.label || key),
      type,
      formula,
      computed: !!formula,
      options: Array.isArray(c.options) ? c.options.map(String) : [],
      sensitive: c.sensitive === true,
      total: c.total && COL_TOTALS.includes(String(c.total)) ? String(c.total) : '',
      width: Number.isFinite(Number(c.width)) && Number(c.width) > 0 ? Number(c.width) : null,
      align: c.align || (type === 'number' ? 'right' : (type === 'bool' ? 'center' : 'left')),
      precision: c.precision === null || c.precision === undefined || c.precision === '' ? null : Number(c.precision),
      unit: c.unit ? String(c.unit) : '',
      hint: c.hint ? String(c.hint) : '',
      // 默认值只在「新增行」时用；`0` 与 `false` 都是合法默认值，所以判据是「有没有这个键」，
      // 不是真值判断（`if (c.default)` 会把 0 当成没写）。
      default: Object.prototype.hasOwnProperty.call(c, 'default') ? c.default : undefined,
    });
  }
  return out;
}

/** 从行数据推断列（只为「随手写了几行」的入口服务：类型按第一个非空值猜）。 */
export function inferColumns(rows: unknown): JsonRow[] {
  const keys: string[] = [];
  const kinds = new Map<string, string>();
  for (const row of ((rows ?? []) as unknown[])) {
    if (!isPlainRow(row)) continue;
    for (const [k, v] of Object.entries(row)) {
      if (!keys.includes(k)) { keys.push(k); kinds.set(k, ''); }
      const kind = kinds.get(k);
      if (kind || v === null || v === undefined || v === '') continue;
      if (typeof v === 'boolean') kinds.set(k, 'bool');
      else if (typeof v === 'number') kinds.set(k, 'number');
      else kinds.set(k, 'text');
    }
  }
  return keys.map((k) => ({ key: k, label: k, type: kinds.get(k) || 'text' }));
}

/** 归一后的列 → 可落盘的紧凑定义（不写空值，读的人一眼看清哪些是「有内容」的）。 */
export function columnToDef(col: JsonRow): JsonRow {
  const out: JsonRow = { key: col.key, label: col.label, type: col.type };
  if (col.formula) out.formula = col.formula;
  if (col.options?.length) out.options = [...col.options];
  if (col.sensitive) out.sensitive = true;
  if (col.total) out.total = col.total;
  if (col.width) out.width = col.width;
  if (col.precision !== null && col.precision !== undefined) out.precision = col.precision;
  if (col.unit) out.unit = col.unit;
  if (col.align && col.align !== (col.type === 'number' ? 'right' : (col.type === 'bool' ? 'center' : 'left'))) out.align = col.align;
  if (col.hint) out.hint = col.hint;
  if (col.default !== undefined && col.default !== null && col.default !== '') out.default = col.default;
  return out;
}

/**
 * 列的**严格**校验（写入路径用）：key 唯一、类型合法、下拉必须给选项、
 * 计算列必须有能编译的公式、密文列不能是计算列。
 *
 * 同一份判定服务两个入口：字段定义里的「初始列」，和条目数据里的「这张表自己的列」。
 * 两处各写一份校验，迟早出现「面板能存的列，CLI 存不进去」。
 */
export function sanitizeColumns(input: unknown, { where = '表格' }: { where?: string } = {}): NormColumn[] {
  if (!Array.isArray(input)) throw new FormulaError(`${where}的 columns 必须是数组`);
  const seen = new Set<string>();
  const out: NormColumn[] = input.map((c, i) => {
    if (!isPlainRow(c)) throw new FormulaError(`${where}的第 ${i + 1} 列必须是对象，收到 ${JSON.stringify(c)}`);
    const key = checkColumnKey(c.key);
    if (seen.has(key)) throw new FormulaError(`${where}的列 key 重复: ${key}`);
    seen.add(key);

    const formulaSrc = c.formula === undefined || c.formula === null ? '' : String(c.formula).trim();
    const normType = String(c.type || (formulaSrc ? 'number' : 'text')).trim();
    const type = normType === 'formula' ? 'number' : normType;
    if (!TABLE_CELL_TYPES.includes(type)) {
      throw new FormulaError(`${where}的列「${c.label || key}」type 非法: ${normType}（可用: ${TABLE_CELL_TYPES.join(' / ')}，或给 formula 变成计算列）`);
    }
    if (normType === 'formula' && !formulaSrc) {
      throw new FormulaError(`${where}的列「${c.label || key}」声明成计算列（type: formula），但没给 formula`);
    }

    const out: NormColumn = {
      key,
      label: String(c.label || key),
      type,
      formula: formulaSrc,
      computed: !!formulaSrc,
      options: [],
      sensitive: false,
      total: '',
      width: null,
      align: type === 'number' ? 'right' : (type === 'bool' ? 'center' : 'left'),
      precision: null,
      unit: '',
      hint: '',
      default: undefined,
    };
    if (formulaSrc) {
      if (c.sensitive === true) throw new FormulaError(`${where}的列「${out.label}」既是密文列又是计算列——计算列不落盘，加密没有意义`);
      const chk = compileFormula(formulaSrc);
      if (chk.error) throw new FormulaError(`${where}的列「${out.label}」公式有问题：${chk.error}`);
    }
    if (type === 'select') {
      const opts = Array.isArray(c.options) ? c.options.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!opts.length) {
        throw new FormulaError(`${where}的列「${out.label}」是下拉框（select），必须给 options，例如 "options":["未开始","进行中","已完成"]`);
      }
      out.options = opts;
    } else if (Array.isArray(c.options) && c.options.length) {
      throw new FormulaError(`${where}的列「${out.label}」不是 select，写 options 没用——删掉它，或把 type 改成 select`);
    }
    if (c.sensitive === true) out.sensitive = true;
    if (c.total !== undefined && c.total !== null && c.total !== '') {
      if (!COL_TOTALS.includes(String(c.total))) {
        throw new FormulaError(`${where}的列「${out.label}」total 非法: ${JSON.stringify(c.total)}（可用: ${COL_TOTALS.join(' / ')}）`);
      }
      out.total = String(c.total);
    }
    if (c.width !== undefined && c.width !== null) {
      const w = Number(c.width);
      if (!Number.isFinite(w) || w <= 0) throw new FormulaError(`${where}的列「${out.label}」width 要是正数（像素）`);
      out.width = Math.round(w);
    }
    if (c.precision !== undefined && c.precision !== null && c.precision !== '') {
      const p = Number(c.precision);
      if (!Number.isFinite(p) || p < 0 || p > 8) throw new FormulaError(`${where}的列「${out.label}」precision 要在 0-8 之间`);
      out.precision = Math.round(p);
    }
    if (c.unit) out.unit = String(c.unit);
    if (c.align) {
      if (!['left', 'center', 'right'].includes(c.align)) throw new FormulaError(`${where}的列「${out.label}」align 只能是 left / center / right`);
      out.align = c.align;
    }
    if (c.hint) out.hint = String(c.hint);
    // 默认值：新增行时的初值。按列类型强转一遍——否则「默认 false」写成了字符串 "false"，
    // 新行里就是一个看起来像布尔、其实不是的东西。
    if (c.default !== undefined && c.default !== null && c.default !== '') {
      const cell = coerceCell(out, c.default);
      if (cell.error) throw new FormulaError(`${where}的列「${out.label}」默认值不对：${cell.error}`);
      if (cell.value !== null && cell.value !== undefined) out.default = cell.value;
    }
    return out;
  });

  // 第二遍：把每条公式**当探针跑一次**，跑不起来就不许保存。
  // 放在第二遍是因为要拿到完整列名单（公式可能引用排在它后面的列，那种要报「只能引用前面的列」）。
  for (const col of out) {
    if (!col.formula) continue;
    const bad = checkFormulaNames(col.formula, out, { selfKey: col.key });
    if (bad) throw new FormulaError(`${where}的列「${col.label}」公式有问题：${bad}`);
  }
  return out;
}

/**
 * 统计行的严格校验。
 * 两种写法：`agg` = 「列 → 统计函数」，`expr` + 可选 `cell` = 整表表达式。
 */
export function sanitizeTotals(input: unknown, columns: JsonRow[], { where = '表格' }: { where?: string } = {}): JsonRow[] {
  if (!Array.isArray(input)) throw new FormulaError(`${where}的 totals 必须是数组`);
  const findCol = (ref: unknown) => columns.find((c) => c.key === ref) || columns.find((c) => c.label === ref) || null;
  return input.map((t, i) => {
    if (!isPlainRow(t)) throw new FormulaError(`${where}的第 ${i + 1} 个统计行必须是对象`);
    const label = String(t.label || `统计${i + 1}`);
    const out: JsonRow = { label };
    if (t.agg !== undefined) {
      if (!isPlainRow(t.agg)) throw new FormulaError(`${where}的统计行「${label}」的 agg 要写成 {列: 函数}，例如 {"hours":"sum"}`);
      out.agg = {};
      for (const [ref, fnName] of Object.entries(t.agg)) {
        const col = findCol(String(ref));
        if (!col) throw new FormulaError(`${where}的统计行「${label}」引用了不存在的列「${ref}」（现有列：${columns.map((c) => c.label).join('、')}）`);
        if (!AGG_FNS.includes(String(fnName))) {
          throw new FormulaError(`${where}的统计行「${label}」的列「${ref}」用了未知统计函数「${fnName}」（可用: ${AGG_FNS.join(' / ')}）`);
        }
        out.agg[col.key] = String(fnName);
      }
    }
    if (t.expr !== undefined && t.expr !== null && String(t.expr).trim()) {
      const chk = compileFormula(String(t.expr));
      if (chk.error) throw new FormulaError(`${where}的统计行「${label}」公式有问题：${chk.error}`);
      out.expr = String(t.expr);
      if (t.cell) {
        const col = findCol(String(t.cell));
        if (!col) throw new FormulaError(`${where}的统计行「${label}」的 cell 指向不存在的列「${t.cell}」`);
        out.cell = col.key;
      }
    }
    if (!out.agg && !out.expr) throw new FormulaError(`${where}的统计行「${label}」既没有 agg 也没有 expr——它算不出任何东西`);
    if (out.expr) {
      const bad = checkFormulaNames(out.expr, columns, { scope: 'totals' });
      if (bad) throw new FormulaError(`${where}的统计行「${label}」公式有问题：${bad}`);
    }
    if (t.unit) out.unit = String(t.unit);
    if (t.precision !== undefined && t.precision !== null && Number.isFinite(Number(t.precision))) out.precision = Number(t.precision);
    return out;
  });
}

/**
 * 把「字段定义 + 条目里的值」合成一份自描述的表定义。
 *
 * 合并顺序（后者优先）：行推断 < 字段定义里的初始列 < 数据里自己的列。
 * 数据里的 columns 一旦存在就是**权威**的：栏目 schema 是给所有条目共用的，
 * 而一张表的列常常只对这条有意义 —— 拿 schema 去覆盖数据，等于每次编辑都被打回去。
 */
export function normalizeSpec(def: JsonRow | null | undefined, value: unknown): TableSpec {
  let rawRows: unknown[] = [];
  let declaredColumns: unknown = null;
  let declaredTotals;
  let declaredSummary;
  let v = 1;

  if (Array.isArray(value)) {
    rawRows = value;
  } else if (isPlainRow(value)) {
    // 显式给了 columns（哪怕是空数组）就是权威：空数组 = 「这张表没有列」，
    // 不能因为它是空的就退回字段默认列 —— 那会让「删掉最后一列」看起来像没生效。
    if (Array.isArray(value.columns)) declaredColumns = value.columns;
    rawRows = Array.isArray(value.rows) ? value.rows : [];
    if (value.totals !== undefined) declaredTotals = value.totals;
    if (value.summary !== undefined) declaredSummary = value.summary;
    if (Number.isFinite(Number(value.v))) v = Number(value.v);
  }
  const rows = rawRows.filter(isPlainRow);

  let columns;
  if (declaredColumns) {
    columns = normalizeColumns(declaredColumns);
  } else {
    const fromDef = normalizeColumns(Array.isArray(def?.columns) ? def.columns : []);
    columns = fromDef.length ? fromDef : normalizeColumns(inferColumns(rows));
  }

  const totals = declaredTotals !== undefined ? declaredTotals : def?.totals;
  const summary = declaredSummary !== undefined ? declaredSummary : def?.summary;
  return {
    v,
    columns,
    rows,
    totals,
    summary,
    maxRows: Number.isFinite(Number(def?.maxRows)) ? Number(def?.maxRows) : null,
  };
}

/**
 * 表尾统计行。三种来源，优先级从高到低：
 *   1. 显式 `totals` 里带 `agg` 的行（= 完全自定义，接管整块表尾）
 *   2. 每列自己的 `total`（一个属性和一个统计方式，最贴近「统计列」的直觉）
 *   3. 按类型自动：数字求和、勾选计是
 *
 * 只有 `expr` 的 totals 行（如「完成率」）**不接管**表尾：它和逐列统计是两个轴，
 * 一条「完成率」不该把「合计」挤掉。`totals: []` 与 `summary: false` 都是「不要表尾」。
 */
export function buildTotals(spec: TableSpec, columns: NormColumn[]): NormTotal[] {
  if (spec.summary === false) return [];
  const declared = Array.isArray(spec.totals) ? spec.totals.filter(isPlainRow) : [];
  if (Array.isArray(spec.totals) && !declared.length) return [];

  const asRow = (t: JsonRow, i: number): NormTotal => ({
    key: String(t.key || `t${i + 1}`),
    label: String(t.label || '统计'),
    agg: isPlainRow(t.agg) ? t.agg : null,
    expr: t.expr ? String(t.expr) : '',
    cell: t.cell ? String(t.cell) : '',
    unit: t.unit ? String(t.unit) : '',
    precision: t.precision === undefined || t.precision === null ? null : Number(t.precision),
  });

  // 有 agg 的显式行 = 用户自己定义了整块表尾，不再叠自动行
  if (declared.some((t) => isPlainRow(t.agg))) return declared.map(asRow);

  const rows: NormTotal[] = [];
  // 按「统计方式」分组出多行：求和与计是都属于「合计」，平均/最大/中位数各自成行。
  // 混在一行里会出现「合计 15」这种看不懂的格子（那其实是平均值）。
  const groups = new Map<string, Record<string, string>>();
  for (const c of columns) {
    if (c.total === 'none') continue;
    const fn = c.total || (c.type === 'number' ? 'sum' : (c.type === 'bool' ? 'countTrue' : ''));
    if (!fn) continue;
    const label = fn === 'sum' || fn === 'countTrue' ? '合计' : (AGG_LABELS[fn as keyof typeof AGG_LABELS] || fn);
    if (!groups.has(label)) groups.set(label, {});
    groups.get(label)![c.key] = fn;
  }
  let i = 0;
  for (const [label, agg] of groups) {
    i += 1;
    rows.push({ key: `auto-${i}`, label, agg, expr: '', cell: '', unit: '', precision: null });
  }
  for (const [k, t] of declared.entries()) rows.push(asRow(t, i + k + 1));
  return rows;
}

/**
 * 单元格强转。**永不抛**，用 `{ value }` / `{ error }` 把问题带回去 ——
 * 求值路径（读）要能算出「哪一格坏了」，写入路径（存）再把 error 变成异常。
 */
export function coerceCell(col: JsonRow | null | undefined, raw: unknown): { value?: unknown; error?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const type = col?.type || 'text';
  if (type === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { value: null };
    const s = String(raw).trim();
    if (!s) return { value: null };
    const direct = Number(s);
    if (Number.isFinite(direct)) return { value: direct };
    // 「1,200」「1 200」这类带千分位的写法也认（表格里的数字常常是粘进来的）
    const stripped = Number(s.replace(/[,，\s]/g, ''));
    if (Number.isFinite(stripped)) return { value: stripped };
    return { error: `需要数字，收到「${s}」` };
  }
  if (type === 'bool') {
    if (typeof raw === 'boolean') return { value: raw };
    if (typeof raw === 'number') return { value: raw !== 0 };
    const s = String(raw).trim().toLowerCase();
    if (['是', 'true', '1', 'yes', 'y', '对', '有'].includes(s)) return { value: true };
    if (['否', 'false', '0', 'no', 'n', '错', '无'].includes(s)) return { value: false };
    return { error: `需要是/否，收到「${s}」` };
  }
  if (type === 'tags') {
    const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,，、;；\s]+/);
    const out = list.map((x) => x.trim()).filter(Boolean);
    return { value: out.length ? out : null };
  }
  if (type === 'select') {
    const s = String(raw).trim();
    if (!s) return { value: null };
    if (col?.options?.length && !col.options.includes(s)) {
      return { value: s, error: `不在候选里（可选：${col.options.join(' / ')}）` };
    }
    return { value: s };
  }
  if (type === 'date' || type === 'month') {
    const s = String(raw).trim();
    if (!s) return { value: null };
    const re = type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
    if (!re.test(s)) return { value: s, error: type === 'date' ? '日期要写成 2026-10-29' : '月份要写成 2026-10' };
    return { value: s };
  }
  const s = String(raw);
  return { value: s.trim() === '' ? null : s };
}

/**
 * 公式「能不能跑起来」的**静态体检**：用一行的空值当探针跑一遍。
 *
 * 为什么不在写入时逐行试算：那一行的数据恰好除以 0，就会把一条好公式误判成坏公式。
 * 所以只用探针判**与数据无关**的三类错：
 *   - 语法错（SYNTAX）：`hours *`
 *   - 名字解析不到（UNKNOWN_NAME）：列名打错，或引用了排在自己后面的计算列
 *   - 结果不是单值（NOT_SCALAR）：返回了数组/对象
 * 其余（除零、对空格子做字符串操作）属于「这条数据不巧」，留到渲染时逐格报。
 *
 * @returns {string|null} 有错就给能照着改的话，没问题给 null
 */
export function checkFormulaNames(
  expr: unknown,
  columns: JsonRow[],
  { selfKey, scope = 'row' }: { selfKey?: unknown; scope?: string } = {},
): string | null {
  const at = selfKey ? columns.findIndex((c) => c.key === selfKey) : columns.length - 1;
  const values: JsonRow = {};
  for (let i = 0; i < columns.length; i += 1) {
    const c = columns[i];
    // 只注入「此刻已经能算出来」的列：非计算列 + 它前面的计算列。
    // 后面的计算列不注入，才会命中「未定义的名字」并带上「它是排在后面的计算列」那句提示。
    if (c.formula && i >= at) continue;
    values[c.key] = looseValue(c, c.default === undefined ? null : c.default);
  }
  // 统计行与计算列是两个作用域：统计行没有 i / row（有 rows / n / col）
  const { vars, names } = scope === 'totals'
    ? totalsVars(columns, [values])
    : rowVars(columns, values, 0, [values]);
  const late = columns.slice(at).filter((c) => c.formula).map((c) => c.key);
  const r = evalFormula(expr, vars, { names, late });
  if (r.ok) return null;
  return ['SYNTAX', 'UNKNOWN_NAME', 'UNKNOWN_COL', 'NOT_SCALAR'].includes(r.code) ? r.error : null;
}
