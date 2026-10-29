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

export const TABLE_CELL_TYPES = ['text', 'textarea', 'number', 'bool', 'select', 'date', 'month', 'tags'];

/** 计算列：列上有 `formula` 就是计算列，值不落盘、读的时候现算。 */
export const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'countTrue', 'countFalse', 'distinct', 'median', 'first', 'last'];

/** 列上 `total` 可取值：表尾这一格怎么算。`none` = 这一列不统计。 */
export const COL_TOTALS = [...AGG_FNS, 'none'];

const AGG_LABELS = {
  sum: '求和', avg: '平均', min: '最小', max: '最大', count: '计数（非空）',
  countTrue: '计数（是）', countFalse: '计数（否）', distinct: '去重计数',
  median: '中位数', first: '第一条', last: '最后一条', none: '不统计',
};

// 合法标识符：中文、字母、下划线开头。列名要能当变量用，才谈得上「结构映射」。
const IDENT_RE = /^[A-Za-z_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5]*$/;

// 求值时 `this` 指向它：空原型 + 冻结，`this.constructor` 拿不到 Function。
const SAFE_THIS = Object.freeze(Object.create(null));

export class FormulaError extends Error {
  /**
   * `code` 是给**写入路径**用的：只有「定义/数据写错了」才该拦下保存，
   * 「这条数据恰好除以 0」「空格子做了运算」这类**看数据**的错误不该拦 —— 换个数据就没事了。
   * 所以错误要能分类，不能靠 message 字符串去猜。
   */
  constructor(message, code = '') {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
  }
}

const isPlainRow = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** 抹掉浮点毛刺：0.1 + 0.2 -> 0.3。只在**显示**时用，计算仍用原值。 */
export function roundTo(n, digits = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/** 把 variadic 参数摊平：sum(1, [2, 3], 4) === 10。写公式时不必先想「该传数组还是值」。 */
function flatten(args) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    out.push(x);
  };
  for (const a of args) walk(a);
  return out;
}

const isFilled = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));

function numbersOf(args) {
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
const HELPERS = {
  ...Math,
  // 聚合
  sum: (...a) => numbersOf(a).reduce((s, x) => s + x, 0),
  avg: (...a) => { const l = numbersOf(a); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : 0; },
  min: (...a) => { const l = numbersOf(a); return l.length ? Math.min(...l) : null; },
  max: (...a) => { const l = numbersOf(a); return l.length ? Math.max(...l) : null; },
  count: (...a) => flatten(a).filter(isFilled).length,
  countTrue: (...a) => flatten(a).filter((v) => !!v).length,
  countFalse: (...a) => flatten(a).filter((v) => v === false || v === 0 || v === 'false' || v === '否').length,
  distinct: (...a) => new Set(flatten(a).filter(isFilled).map((v) => String(v))).size,
  uniq: (...a) => [...new Set(flatten(a).filter(isFilled).map((v) => String(v)))],
  median: (...a) => {
    const l = numbersOf(a).slice().sort((x, y) => x - y);
    if (!l.length) return null;
    const mid = Math.floor(l.length / 2);
    return l.length % 2 ? l[mid] : (l[mid - 1] + l[mid]) / 2;
  },
  first: (...a) => flatten(a).find(isFilled) ?? null,
  last: (...a) => { const l = flatten(a).filter(isFilled); return l.length ? l[l.length - 1] : null; },
  join: (sep, ...a) => flatten(a).filter(isFilled).join(sep === undefined ? '、' : String(sep)),

  // 数值
  round: (x, n = 0) => { const p = 10 ** Number(n || 0); return Math.round(Number(x) * p) / p; },
  floor: (x) => Math.floor(Number(x)),
  ceil: (x) => Math.ceil(Number(x)),
  abs: (x) => Math.abs(Number(x)),
  pct: (a, b) => (Number(b) ? roundTo((Number(a) / Number(b)) * 100, 1) : 0),
  ratio: (a, b) => (Number(b) ? roundTo(Number(a) / Number(b), 4) : 0),
  clamp: (x, lo, hi) => Math.min(Math.max(Number(x), Number(lo)), Number(hi)),

  // 判断 / 转换
  toNum: (x) => { const n = Number(String(x ?? '').replace(/[,，\s]/g, '')); return Number.isFinite(n) ? n : 0; },
  isBlank: (x) => !isFilled(x),
  ifEmpty: (x, alt) => (isFilled(x) ? x : alt),
  fixed: (x, n = 2) => { const v = Number(x); return Number.isFinite(v) ? v.toFixed(Number(n)) : ''; },

  // 常用内建（`Math.xxx` 整个对象也给，习惯这么写的人不必改）
  Math, Number, String, Boolean, Array, Object, JSON, Date, RegExp, Map, Set,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  undefined, NaN, Infinity,
};

/** 给「不存在的名字」写一条能直接改的报错：列出可用的列，并点出常见的循环引用。 */
function unknownNameMessage(name, names, late) {
  const head = `公式里用了不存在的名字「${name}」`;
  if (Array.isArray(late) && late.includes(String(name))) {
    return `${head} ——「${name}」是计算列（可能就是这一列自己，也可能排在后面）。`
      + '计算列只能引用排在它**前面**的列：引用自己或后面的列都会成环，把那一列往前挪即可。';
  }
  const list = (names || []).slice(0, 12).join('、');
  const more = (names || []).length > 12 ? ` 等 ${names.length} 个` : '';
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
function scopedProxy(vars, names, late) {
  return new Proxy(vars, {
    has: () => true,
    get(target, key) {
      if (typeof key === 'symbol') return target[key];
      if (key === 'then') return undefined; // 别让求值结果被当成 thenable 探一次
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      throw new FormulaError(unknownNameMessage(key, names, late), 'UNKNOWN_NAME');
    },
  });
}

// 编译缓存：同一列的公式在整张表上要跑 N 次，`new Function` 只该发生一次。
const COMPILED = new Map();

export function compileFormula(expr) {
  const src = String(expr ?? '').trim();
  if (!src) return { error: '公式是空的', code: 'SYNTAX' };
  const hit = COMPILED.get(src);
  if (hit) return hit;
  let entry;
  try {
    // 包成 `return ( … )`：只接受表达式。`for` / `var` 这类语句在这里就是语法错，
    // 而不是「算出来一个 undefined」——错误必须停在能看懂的那一层。
    const fn = new Function('__scope', `with (__scope) {\n  return (\n${src}\n  );\n}`);
    entry = { fn };
  } catch (e) {
    entry = { error: `公式语法错误：${String(e.message || e).replace(/^[^:]*:\s*/, '')}`, code: 'SYNTAX' };
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
export function evalFormula(expr, vars, extra = {}) {
  const compiled = compileFormula(expr);
  if (compiled.error) return { ok: false, error: compiled.error, code: compiled.code };
  try {
    const v = compiled.fn.call(SAFE_THIS, scopedProxy(vars, extra.names, extra.late));
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
    return { ok: false, code: 'RUNTIME', error: `公式运行出错：${e.message || e}` };
  }
}

// —— 列定义 ——

const KEY_MAX = 48;

/** 列 key 的规则与字段 key 同一口径（中文也行，但不许空白、路径分隔符、'..'）。 */
function checkColumnKey(key) {
  const s = String(key ?? '').trim();
  if (!s) throw new FormulaError('列 key 不能为空');
  if (s.length > KEY_MAX) throw new FormulaError(`列 key 过长（${s.length} > ${KEY_MAX}）: ${s}`);
  if (/[\s/\\]/.test(s) || s.includes('..')) {
    throw new FormulaError(`列 key 非法: ${JSON.stringify(key)}（不允许空白、路径分隔符或 '..'；中文可以）`);
  }
  return s;
}

/** 列定义归一（宽松）：把任何来源（数据 / 字段默认列 / 行推断）整理成内核认的形状。 */
export function normalizeColumns(src) {
  const raw = Array.isArray(src) ? src : (Array.isArray(src?.columns) ? src.columns : []);
  const seen = new Set();
  const out = [];
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
export function inferColumns(rows) {
  const keys = [];
  const kinds = new Map();
  for (const row of rows || []) {
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
export function columnToDef(col) {
  const out = { key: col.key, label: col.label, type: col.type };
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
export function sanitizeColumns(input, { where = '表格' } = {}) {
  if (!Array.isArray(input)) throw new FormulaError(`${where}的 columns 必须是数组`);
  const seen = new Set();
  const out = input.map((c, i) => {
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

    const out = { key, label: String(c.label || key), type };
    if (formulaSrc) {
      if (c.sensitive === true) throw new FormulaError(`${where}的列「${out.label}」既是密文列又是计算列——计算列不落盘，加密没有意义`);
      const chk = compileFormula(formulaSrc);
      if (chk.error) throw new FormulaError(`${where}的列「${out.label}」公式有问题：${chk.error}`);
      out.formula = formulaSrc;
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
export function sanitizeTotals(input, columns, { where = '表格' } = {}) {
  if (!Array.isArray(input)) throw new FormulaError(`${where}的 totals 必须是数组`);
  const findCol = (ref) => columns.find((c) => c.key === ref) || columns.find((c) => c.label === ref) || null;
  return input.map((t, i) => {
    if (!isPlainRow(t)) throw new FormulaError(`${where}的第 ${i + 1} 个统计行必须是对象`);
    const label = String(t.label || `统计${i + 1}`);
    const out = { label };
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
export function normalizeSpec(def, value) {
  let rawRows = [];
  let declaredColumns = null;
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
    maxRows: Number.isFinite(Number(def?.maxRows)) ? Number(def.maxRows) : null,
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
export function buildTotals(spec, columns) {
  if (spec.summary === false) return [];
  const declared = Array.isArray(spec.totals) ? spec.totals.filter(isPlainRow) : [];
  if (Array.isArray(spec.totals) && !declared.length) return [];

  const asRow = (t, i) => ({
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

  const rows = [];
  // 按「统计方式」分组出多行：求和与计是都属于「合计」，平均/最大/中位数各自成行。
  // 混在一行里会出现「合计 15」这种看不懂的格子（那其实是平均值）。
  const groups = new Map();
  for (const c of columns) {
    if (c.total === 'none') continue;
    const fn = c.total || (c.type === 'number' ? 'sum' : (c.type === 'bool' ? 'countTrue' : ''));
    if (!fn) continue;
    const label = fn === 'sum' || fn === 'countTrue' ? '合计' : (AGG_LABELS[fn] || fn);
    if (!groups.has(label)) groups.set(label, {});
    groups.get(label)[c.key] = fn;
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
export function coerceCell(col, raw) {
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

/** 短名字的「宽松值」：空格子当 0 / false / ''，让 `hours * rate` 不会因为空格子变 NaN。 */
function looseValue(col, v) {
  if (col.type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (col.type === 'bool') return v === true;
  if (col.type === 'tags') return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [String(v)]);
  if (v === null || v === undefined) return '';
  return v;
}

function columnNames(columns) {
  const names = [];
  for (const c of columns) {
    names.push(c.key);
    if (c.label !== c.key && IDENT_RE.test(c.label)) names.push(c.label);
  }
  return names;
}

function findColumn(columns, ref) {
  const s = String(ref ?? '').trim();
  return columns.find((c) => c.key === s) || columns.find((c) => c.label === s) || null;
}

function columnValues(columns, rows, ref) {
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
function rowVars(columns, values, i, plainRows) {
  const vars = { ...HELPERS };
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
  vars.col = (ref) => columnValues(columns, plainRows, ref);
  return { vars, names };
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
export function checkFormulaNames(expr, columns, { selfKey, scope = 'row' } = {}) {
  const at = selfKey ? columns.findIndex((c) => c.key === selfKey) : columns.length - 1;
  const values = {};
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

/** 统计行的作用域：整张表（含计算列）+ col / n / 函数。 */
function totalsVars(columns, rows) {
  const vars = { ...HELPERS };
  vars.rows = rows;
  vars['表'] = rows;
  vars.col = (ref) => columnValues(columns, rows, ref);
  vars.n = rows.length;
  return { vars, names: columnNames(columns) };
}

function totalsText(fnName, value, list, col) {
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
export function computeTable(def, value) {
  const spec = normalizeSpec(def, value);
  const columns = spec.columns;
  const input = spec.rows;
  const enteredCols = columns.filter((c) => !c.computed);
  const calcCols = columns.filter((c) => c.computed);
  const errors = [];

  // 第一趟：读入值 + 强转
  const out = input.map((row, i) => {
    const values = {};
    const errs = {};
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

  const computedRows = out.map((r) => r.values);
  const totals = buildTotals(spec, columns).map((t) => {
    const values = {};
    const texts = {};
    const errs = {};
    if (t.agg) {
      for (const [ref, fnName] of Object.entries(t.agg)) {
        const col = findColumn(columns, ref);
        if (!col) { errs[String(ref)] = '没有这一列'; continue; }
        const fn = HELPERS[fnName];
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

/** 数值显示：默认抹掉浮点毛刺，declared precision 才补零，unit 跟在后面。 */
export function formatNumber(n, precision, unit) {
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
export function formatCellValue(col, value) {
  if (value === null || value === undefined) return '';
  const type = col?.type || 'text';
  if (type === 'bool') return value === true || value === 'true' || value === 1 || value === '1' ? '是' : '否';
  if (type === 'number') return formatNumber(value, col?.precision, col?.unit);
  if (type === 'tags') return Array.isArray(value) ? value.join('、') : String(value);
  return String(value);
}

/** 一张表 → 等宽文本（CLI 用）。合计行与公式报错都在这里落地，agent 读到的就是人看到的。 */
export function renderTableText(table, { indent = '  ' } = {}) {
  if (!table || !table.columns.length) return `${indent}（这张表还没有列）`;
  const cols = table.columns;
  const cellText = (row, c) => {
    if (row.errors[c.key]) return '#错误';
    return formatCellValue(c, row.values[c.key]);
  };
  const head = cols.map((c) => (c.computed ? `${c.label}(算)` : c.label));
  const body = table.rows.map((r) => cols.map((c) => cellText(r, c)));
  // 合计行的标签固定落在第一列：第一列自己也有合计值时挤在同一格里
  // （`合计 7.5`）——宁可挤，也不能让一个算出来的数字消失。
  const totalRows = table.totals.map((t) => {
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
  const line = (cells) => {
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
function displayWidth(s) {
  const str = String(s ?? '');
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
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

export { AGG_LABELS };
