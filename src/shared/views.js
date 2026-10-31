// 视图配置（`section.views`）的内核：类型词汇表 + 归一 + 缺省推断 + 投影解析。
//
// 为什么放在 `src/shared/`：与 shared/blocks.js、shared/table.js 同一条理由 ——
// 面板不许 import core（eslint 的前后端边界规则），而「什么算合法视图」「缺省长什么样」
// 只允许有一份实现。CLI（sections/service）、store 归一（core/store）、面板（viewChips）
// 三处共用这一份，对不上比不给更糟。
//
// 本文件必须保持**纯函数 + 零依赖**：一旦 import 了 fs/crypto，浏览器就打包不出来了。
//
// 两条铁律（写错的代价是静默丢配置）：
//   ① `views` / `defaultView` 必须在 core/store 的 normalizeSection 里显式收进来 ——
//      白名单重建会把没列的键丢掉（R2 抓到的真腐蚀点）；
//   ② 缺省视图**只在读路径推断，不落盘** —— 用户第一次改视图才写 section.views。
//      这不是洁癖：落盘会让「字典加了字段、视图自动跟上」失效，也让回退失去意义。

/**
 * 视图类型（§19.1）。gallery 下一版预留，v1 不收。
 *
 * `list`（条目列表 + 右侧详情的复合页）**已退役**：详情改成了工作区里**独立的面板**
 * （可拖到任意分栏、可弹出浮窗），不再嵌在任何视图里——列表视图失去存在的理由，
 * 而它排在缺省位还会把表格视图挤成半屏。类型本身保留在枚举里是为了**老数据兼容**：
 * 存量 store 里固化过的 list 视图照常解析，渲染时按表格投影处理（见面板）。
 *
 * 缺省是**表格**：横着对比一批条目。字段多就横向滚，不再配内嵌详情；
 * 看板 / 精简是可选投影，随取随用。
 */
export const VIEW_TYPES = ['list', 'table', 'board', 'kv'];

/** 类型的中文名。CLI 渲染与面板 chips 共用 —— 两处各写一套必然分叉。 */
export const VIEW_LABELS = { list: '列表', table: '表格', board: '看板', kv: 'KV' };

/** 视图 id：机器定位串（`table-default` / `v_xxx`），只收 ASCII —— 它是引用，不是标题。 */
const VIEW_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isViewId(s) {
  return typeof s === 'string' && VIEW_ID_RE.test(s);
}

/**
 * 列投影归一：**只存投影**（key / width / hidden）。
 * 类型、标签、候选值一律回查字段字典 —— 单一事实源（README 记过「字段字典两处漂移」）。
 */
function normColumns(raw) {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    const key = String((c && c.key) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const col = { key };
    if (Number.isFinite(c.width)) col.width = Math.round(Math.min(800, Math.max(40, c.width)));
    if (c.hidden === true) col.hidden = true;
    out.push(col);
  }
  return out;
}

function normSort(raw) {
  if (!raw || typeof raw !== 'object' || !raw.key) return null;
  return { key: String(raw.key), dir: raw.dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * 容错归一：**坏视图返回 null**（读路径用，绝不抛）。
 * 与 validateViewConfig 的分工同 blocks.js：normalize 管形状，validate 管业务规则。
 */
export function normalizeViewConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!isViewId(id)) return null;
  if (!VIEW_TYPES.includes(raw.type)) return null;
  const out = { id, type: raw.type, title: String(raw.title || VIEW_LABELS[raw.type]) };
  const columns = normColumns(raw.columns);
  if (columns) out.columns = columns;
  // groupBy 只对看板有意义；table 上留着它只会让人以为「表格也能分组」
  if (raw.type === 'board' && raw.groupBy) out.groupBy = String(raw.groupBy);
  const sort = normSort(raw.sort);
  if (sort) out.sort = sort;
  return out;
}

/** 归一一组视图（丢弃非法项、id 去重，先出现的赢）。 */
export function normalizeViews(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const v = normalizeViewConfig(raw);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/**
 * 缺省推断（§19.3，**只读路径，不落盘**）。
 *
 *   非 KV 栏目 → 表格（缺省：横着对比，除 source 外全部字段）／
 *                精简（标题字段 + 第一个 select）／
 *                看板（第一个 select 分组，没有 select 就不出）
 *   KV 栏目   → 一条 kv
 *
 * 密文字段照常进列 —— **值默认打码，列本身不是秘密**（§19.3 末行）。
 */
export function inferViews(section) {
  if (!section || section.kv === true) {
    return [{ id: 'kv-default', type: 'kv', title: VIEW_LABELS.kv, provisional: true }];
  }
  const fields = Array.isArray(section.fields) ? section.fields : [];
  // source（原始资料袋）不进表格：它是「乱入后整理」的入口，不是一列数据。
  const visible = fields.filter((f) => f.type !== 'source');
  const firstSelect = fields.find((f) => f.type === 'select') || null;
  const titleKey = section.titleField
    || (fields.find((f) => f.type === 'text' || f.type === 'textarea') || {}).key
    || null;

  // 缺省是**表格**：详情已独立成工作区面板，视图都是纯投影，不再有内嵌详情的「列表」视图。
  const out = [];

  out.push({
    id: 'table-default',
    type: 'table',
    title: VIEW_LABELS.table,
    columns: visible.map((f) => ({ key: f.key })),
    provisional: true,
  });

  const compactCols = [];
  if (titleKey) compactCols.push({ key: titleKey });
  if (firstSelect && firstSelect.key !== titleKey) compactCols.push({ key: firstSelect.key });
  // 精简要有意义才给：只有一列时它和「表格」在视觉上没差别
  if (compactCols.length > 1) {
    out.push({ id: 'compact-default', type: 'table', title: '精简', columns: compactCols, provisional: true });
  }

  if (firstSelect) {
    out.push({
      id: `board-by-${firstSelect.key}`,
      type: 'board',
      title: VIEW_LABELS.board,
      groupBy: firstSelect.key,
      columns: titleKey ? [{ key: titleKey }] : [],
      provisional: true,
    });
  }
  return out;
}

/**
 * 一个栏目**实际生效**的视图集合：落过盘就用落盘的，没落过就用推断的。
 * `provisional: true` 是给面板/CLI 的提示 —— 让用户知道「这套视图是系统给的，不是你配的」。
 */
export function effectiveViews(section) {
  const stored = normalizeViews(section && section.views);
  if (stored.length) return { views: stored, provisional: false };
  return { views: inferViews(section), provisional: true };
}

/** 生效的缺省视图 id：`defaultView` 指得到就用它，指不到（视图被删）就退回第一个。 */
export function effectiveDefaultViewId(section, views) {
  const list = Array.isArray(views) ? views : effectiveViews(section).views;
  const wanted = section && section.defaultView;
  if (wanted && list.some((v) => v.id === wanted)) return wanted;
  return list.length ? list[0].id : null;
}

/**
 * 投影解析：视图的 columns → 渲染需要的列描述。
 *
 * **投影降级**（§19.4）：columns 引用的字段被删 → 列还在，标 `missing: true`，
 * 渲染成「已删字段」弱占位 + 单元格「—」。不炸、也不静默消失 ——
 * 用户能看出「这里曾经有一列，现在它的字段没了」。
 */
export function resolveViewColumns(section, view) {
  const fields = Array.isArray(section && section.fields) ? section.fields : [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const declared = view && Array.isArray(view.columns) ? view.columns : null;
  const cols = declared && declared.length
    ? declared
    // 没声明 columns = 「全部非 source 字段」，与缺省表格同一口径
    : fields.filter((f) => f.type !== 'source').map((f) => ({ key: f.key }));

  return cols.map((c) => {
    const def = byKey.get(c.key) || null;
    return {
      key: c.key,
      label: def ? String(def.label || def.key) : '已删字段',
      type: def ? String(def.type || 'text') : null,
      width: Number.isFinite(c.width) ? c.width : null,
      hidden: c.hidden === true,
      missing: !def,
      sensitive: !!(def && def.sensitive),
      options: def && Array.isArray(def.options) ? def.options : null,
    };
  }).filter((c) => !c.hidden);
}

/**
 * 看板里「值不在候选内 / 空值」的落点列 id。用它而不是 null：
 * 列需要在 DOM 里有个稳定的 key，也需要能被区分于任何真候选值。
 */
export const UNGROUPED = '__ungrouped__';

/**
 * 看板分桶：一列 = 分组字段的一个候选值。
 *
 * 两条边界（与 boardView 的注释同源，逻辑只在这里实现一份）：
 *   · 空值、以及不在候选里的值（字段改过 / 历史脏数据）→ `ungrouped`，**不静默丢**；
 *   · 返回 Map 的键序 = options 的顺序 —— 列的左右顺序由字段定义决定，不由数据出现顺序决定。
 *
 * 「未分组」不是落点：把卡片拖过去等于把字段清空，语义要另定，这一版不做。
 */
export function bucketByGroup(entries, groupBy, options) {
  const opts = Array.isArray(options) ? options : [];
  const buckets = new Map(opts.map((o) => [String(o), []]));
  const ungrouped = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const raw = e && e.values ? e.values[groupBy] : undefined;
    const key = raw === null || raw === undefined || raw === '' ? UNGROUPED : String(raw);
    if (buckets.has(key)) buckets.get(key).push(e); else ungrouped.push(e);
  }
  return { buckets, ungrouped };
}
