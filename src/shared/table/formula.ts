// 从 shared/table.ts 拆出：公式引擎——编译 / 求值 / 内置函数 / 错误类型与求值作用域。

// 合法标识符：中文、字母、下划线开头。列名要能当变量用，才谈得上「结构映射」。
export const IDENT_RE = /^[A-Za-z_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5]*$/;

// 求值时 `this` 指向它：空原型 + 冻结，`this.constructor` 拿不到 Function。
const SAFE_THIS = Object.freeze(Object.create(null));

// 表格内核的工作对象是「用户数据里的任意 JSON」（行 / 列 / 统计 / 字段定义）。
// TODO(P4): 逐字段收窄会引入数百处与行为无关的断言，先在这一层放宽；收窄需要同时改 core 与前端调用点。
export type JsonRow = Record<string, any>;

/** compileFormula 的缓存项。 */
export interface CompiledEntry {
  fn?: Function;
  error?: string;
  code?: string;
}

export class FormulaError extends Error {
  code: string;

  /**
   * `code` 是给**写入路径**用的：只有「定义/数据写错了」才该拦下保存，
   * 「这条数据恰好除以 0」「空格子做了运算」这类**看数据**的错误不该拦 —— 换个数据就没事了。
   * 所以错误要能分类，不能靠 message 字符串去猜。
   */
  constructor(message: string, code = '') {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
  }
}

export const isPlainRow = (x: unknown): x is JsonRow => !!x && typeof x === 'object' && !Array.isArray(x);

/** 抹掉浮点毛刺：0.1 + 0.2 -> 0.3。只在**显示**时用，计算仍用原值。 */
export function roundTo(n: unknown, digits = 6): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/** 把 variadic 参数摊平：sum(1, [2, 3], 4) === 10。写公式时不必先想「该传数组还是值」。 */
function flatten(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    out.push(x);
  };
  for (const a of args) walk(a);
  return out;
}

const isFilled = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));

function numbersOf(args: unknown[]): number[] {
  return flatten(args).map(Number).filter(Number.isFinite);
}

// —— 公式里能用的函数 ——
//
// 原则：**能一眼看懂、能不做二次转换**。
//   - 聚合类（sum/avg/max…）既能吃数组也能吃散值：`sum(col('fee'))` 与 `sum(a, b)` 都成立。
//   - 数值类给 round/floor/ceil/abs/pct，避免每写一次都敲 `Math.xxx`。
//   - 判断类给 isBlank / ifEmpty / toNum：表格里最高的成本是「空格子」，这三个函数就是为它准备的。
//
// `...Math` 必须放在**最前面**：它带进来的 min/max/round/abs 是「一次只吃一个值」的版本，
// 会把下面这些变参版本盖掉（`min(col('x'))` 就成了 NaN）——顺序写反是静默的错算，不是报错。
//
// TODO(P4): HELPERS 需要承载 `...Math` 与 70 余个异质函数，统一为具体类型要逐项声明，
// 这里先按 `any` 放宽；调用点只经 `typeof fn === 'function'` 校验后调用。
export const HELPERS: Record<string, any> = {
  ...Math,
  // 聚合
  sum: (...a: unknown[]) => numbersOf(a).reduce((s, x) => s + x, 0),
  avg: (...a: unknown[]) => { const l = numbersOf(a); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : 0; },
  min: (...a: unknown[]) => { const l = numbersOf(a); return l.length ? Math.min(...l) : null; },
  max: (...a: unknown[]) => { const l = numbersOf(a); return l.length ? Math.max(...l) : null; },
  count: (...a: unknown[]) => flatten(a).filter(isFilled).length,
  countTrue: (...a: unknown[]) => flatten(a).filter((v) => !!v).length,
  countFalse: (...a: unknown[]) => flatten(a).filter((v) => v === false || v === 0 || v === 'false' || v === '否').length,
  distinct: (...a: unknown[]) => new Set(flatten(a).filter(isFilled).map((v) => String(v))).size,
  uniq: (...a: unknown[]) => [...new Set(flatten(a).filter(isFilled).map((v) => String(v)))],
  median: (...a: unknown[]) => {
    const l = numbersOf(a).slice().sort((x, y) => x - y);
    if (!l.length) return null;
    const mid = Math.floor(l.length / 2);
    return l.length % 2 ? l[mid] : (l[mid - 1] + l[mid]) / 2;
  },
  first: (...a: unknown[]) => flatten(a).find(isFilled) ?? null,
  last: (...a: unknown[]) => { const l = flatten(a).filter(isFilled); return l.length ? l[l.length - 1] : null; },
  join: (sep: unknown, ...a: unknown[]) => flatten(a).filter(isFilled).join(sep === undefined ? '、' : String(sep)),

  // 数值
  round: (x: unknown, n: unknown = 0) => { const p = 10 ** Number(n || 0); return Math.round(Number(x) * p) / p; },
  floor: (x: unknown) => Math.floor(Number(x)),
  ceil: (x: unknown) => Math.ceil(Number(x)),
  abs: (x: unknown) => Math.abs(Number(x)),
  pct: (a: unknown, b: unknown) => (Number(b) ? roundTo((Number(a) / Number(b)) * 100, 1) : 0),
  ratio: (a: unknown, b: unknown) => (Number(b) ? roundTo(Number(a) / Number(b), 4) : 0),
  clamp: (x: unknown, lo: unknown, hi: unknown) => Math.min(Math.max(Number(x), Number(lo)), Number(hi)),

  // 判断 / 转换
  toNum: (x: unknown) => { const n = Number(String(x ?? '').replace(/[,，\s]/g, '')); return Number.isFinite(n) ? n : 0; },
  isBlank: (x: unknown) => !isFilled(x),
  ifEmpty: (x: unknown, alt: unknown) => (isFilled(x) ? x : alt),
  fixed: (x: unknown, n: unknown = 2) => { const v = Number(x); return Number.isFinite(v) ? v.toFixed(Number(n)) : ''; },

  // 常用内建（`Math.xxx` 整个对象也给，习惯这么写的人不必改）
  Math, Number, String, Boolean, Array, Object, JSON, Date, RegExp, Map, Set,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  undefined, NaN, Infinity,
};

/** 给「不存在的名字」写一条能直接改的报错：列出可用的列，并点出常见的循环引用。 */
function unknownNameMessage(name: unknown, names: string[] | null | undefined, late: unknown): string {
  const head = `公式里用了不存在的名字「${name}」`;
  if (Array.isArray(late) && late.includes(String(name))) {
    return `${head} ——「${name}」是计算列（可能就是这一列自己，也可能排在后面）。`
      + '计算列只能引用排在它**前面**的列：引用自己或后面的列都会成环，把那一列往前挪即可。';
  }
  const list = (names || []).slice(0, 12).join('、');
  const total = (names || []).length;
  const more = total > 12 ? ` 等 ${total} 个` : '';
  return `${head}。这个表格可用的名字：${list || '（还没有列）'}${more}；`
    + '也可以用 row.列key 取原值、rows 取整张表、col("列名") 取一列。';
}

/**
 * 受控作用域：`with` + Proxy 把**每一个标识符**都拦下来。
 *
 * `has: () => true` 是这里的全部机关 —— 只要它为真，`with` 就不会再去外层找，
 * 于是 window / document / process 这些全局名字根本不可达（未定义的名字会走 get 报错，
 * 而不是悄悄取到全局）。`get` 对不存在的名字**抛错**而不是返回 undefined：
 * 公式里最常见的错就是列名打错，返回 undefined 只会让错误跑到下游变成 NaN。
 */
function scopedProxy(vars: JsonRow, names: string[] | null | undefined, late: unknown) {
  return new Proxy(vars, {
    has: () => true,
    get(target: JsonRow, key: string | symbol) {
      if (typeof key === 'symbol') return (target as unknown as Record<string | symbol, unknown>)[key];
      if (key === 'then') return undefined; // 别让求值结果被当成 thenable 探一次
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      throw new FormulaError(unknownNameMessage(key, names, late), 'UNKNOWN_NAME');
    },
  });
}

// 编译缓存：同一列的公式在整张表上要跑 N 次，`new Function` 只该发生一次。
const COMPILED = new Map<string, CompiledEntry>();

export function compileFormula(expr: unknown): CompiledEntry {
  const src = String(expr ?? '').trim();
  if (!src) return { error: '公式是空的', code: 'SYNTAX' };
  const hit = COMPILED.get(src);
  if (hit) return hit;
  let entry: CompiledEntry;
  try {
    // 包成 `return ( … )`：只接受表达式。`for` / `var` 这类语句在这里就是语法错，
    // 而不是「算出来一个 undefined」——错误必须停在能看懂的那一层。
    const fn = new Function('__scope', `with (__scope) {\n  return (\n${src}\n  );\n}`);
    entry = { fn };
  } catch (e) {
    entry = { error: `公式语法错误：${String((e as Error).message || e).replace(/^[^:]*:\s*/, '')}`, code: 'SYNTAX' };
  }
  if (COMPILED.size > 800) COMPILED.clear();
  COMPILED.set(src, entry);
  return entry;
}

/**
 * 求值。返回 `{ ok, value }` 或 `{ ok: false, error, code }` —— 永远不抛，调用方不必包 try。
 * @param {string} expr 公式
 * @param {object} vars 作用域（列值 + 函数）
 * @param {{names?: string[], late?: string[]}} [extra] 报错时用的「可用列 / 后面的列」
 */
export function evalFormula(
  expr: unknown,
  vars: JsonRow,
  extra: { names?: string[]; late?: string[] } = {},
): JsonRow {
  const compiled = compileFormula(expr);
  if (compiled.error) return { ok: false, error: compiled.error, code: compiled.code };
  try {
    const v = compiled.fn!.call(SAFE_THIS, scopedProxy(vars, extra.names, extra.late));
    if (v === undefined) return { ok: true, value: null };
    if (typeof v === 'number' && !Number.isFinite(v)) {
      return { ok: false, code: 'NOT_FINITE', error: '结果不是有限数字（多半是除以 0，或对空值做了运算）' };
    }
    if (v !== null && typeof v === 'object') {
      return { ok: false, code: 'NOT_SCALAR', error: '公式结果是对象或数组，单元格只能显示单值（要拼接请用 join）' };
    }
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e.message, code: e.code };
    return { ok: false, code: 'RUNTIME', error: `公式运行出错：${(e as Error).message || e}` };
  }
}

/** 短名字的「宽松值」：空格子当 0 / false / ''，让 `hours * rate` 不会因为空格子变 NaN。 */
export function looseValue(col: JsonRow, v: unknown): unknown {
  if (col.type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (col.type === 'bool') return v === true;
  if (col.type === 'tags') return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [String(v)]);
  if (v === null || v === undefined) return '';
  return v;
}

export function columnNames(columns: JsonRow[]): string[] {
  const names: string[] = [];
  for (const c of columns) {
    names.push(c.key);
    if (c.label !== c.key && IDENT_RE.test(c.label)) names.push(c.label);
  }
  return names;
}

export function findColumn(columns: JsonRow[], ref: unknown): JsonRow | null {
  const s = String(ref ?? '').trim();
  return columns.find((c) => c.key === s) || columns.find((c) => c.label === s) || null;
}

export function columnValues(columns: JsonRow[], rows: JsonRow[], ref: unknown): unknown[] {
  const col = findColumn(columns, ref);
  if (!col) {
    throw new FormulaError(
      `没有叫「${ref}」的列（现有列：${columns.map((c) => c.label).join('、') || '无'}）`,
      'UNKNOWN_COL',
    );
  }
  return rows.map((r) => r[col.key] ?? null);
}

/**
 * 一行的作用域：列值（key 与中文列名都能当变量）+ row / rows / i / n + 函数。
 *
 * 赋值顺序有讲究：**列最后写**，所以列名能盖掉同名的系统变量（真有一列叫 `n` 时，
 * 公式里写 `n` 当然是想要那一列的值，不是行数——行数用 `rows.length`）。
 */
export function rowVars(columns: JsonRow[], values: JsonRow, i: number, plainRows: JsonRow[]): { vars: JsonRow; names: string[] } {
  const vars: JsonRow = { ...HELPERS };
  const names = columnNames(columns);
  vars.i = i;
  vars.idx = i;
  vars.n = plainRows.length;
  for (const c of columns) {
    if (!Object.prototype.hasOwnProperty.call(values, c.key)) continue; // 还没算出来的计算列不注入
    const v = looseValue(c, values[c.key]);
    vars[c.key] = v;
    if (c.label !== c.key && IDENT_RE.test(c.label) && !Object.prototype.hasOwnProperty.call(vars, c.label)) {
      vars[c.label] = v;
    }
  }
  vars.row = values;
  vars['行'] = values;
  vars.rows = plainRows;
  vars['表'] = plainRows;
  vars.col = (ref: unknown) => columnValues(columns, plainRows, ref);
  return { vars, names };
}

/** 统计行的作用域：整张表（含计算列）+ col / n / 函数。 */
export function totalsVars(columns: JsonRow[], rows: JsonRow[]): { vars: JsonRow; names: string[] } {
  const vars: JsonRow = { ...HELPERS };
  vars.rows = rows;
  vars['表'] = rows;
  vars.col = (ref: unknown) => columnValues(columns, rows, ref);
  vars.n = rows.length;
  return { vars, names: columnNames(columns) };
}
