// 条目正文的**块布局**：把「一个分组 = 一块面板、一个字段 = 面板里的一个块」这件事
// 变成一份可以单独存、单独改的 JSON。
//
// 为什么需要它：字段字典只说「有哪些字段、属于哪个分组」，说的是**内容**；
// 「这些块在面板里怎么摆」（顺序 / 跨列 / 高度 / 在窄屏上怎么折）是**显示关系**，
// 是另一件事。两件事混在一份数据里，任何一次拖拽都会变成对字段字典的写入，
// 于是「改版式」和「改结构」再也分不开。所以版式单独存成 `section.layout`：
//
//   { v: 1, mode: 'grid' | 'flow', panels: [分组id…], groups: { 分组id: { collapsed, layouts } } }
//
// 其中 `layouts` 直接用网格引擎（react-grid-layout）的原生形状：按断点分组的
// `[{ i: 字段key, x, y, w, h }]`——`i` 就是字段 key，`x/y/w/h` 是**列单位**的坐标。
// 引擎只认这份 JSON，面板不自己算像素，也不自己实现碰撞/回弹。
//
// 本文件是**纯函数**（不 import node、不 import react）：CLI / 服务端 / 浏览器
// 三方共用同一套「默认怎么摆」「字段增删后怎么自愈」的规则——这类规则一旦有
// 两份实现，必然漂移成「面板上好好的，CLI 读出另一套」。

/** 版式 JSON 的版本。结构变了才加，读的时候按版本兜底。 */
export const LAYOUT_VERSION = 1;

/** 两种正文形态：grid = 面板块（默认），flow = 老的单列表单（长文/兼容用）。 */
export const LAYOUT_MODES = ['grid', 'flow'];

/** 断点与列数：窄屏列数少，块自然堆成一列——响应式不靠媒体查询手写。 */
export const BREAKPOINTS = Object.freeze({ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 });
export const BP_COLS = Object.freeze({ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 });

/** 一行的高度（px）与块间距。行高刻意压到 8px：**高度要跟着内容走**，
 *  一档 8px 才能贴住内容（30px 一档会让「按内容撑开」变成「每隔 30px 跳一下」）。 */
export const ROW_HEIGHT = 8;
export const MARGIN = Object.freeze([10, 10]);

/** 块的最小尺寸（列 / 行）。比这更小就只剩一条边，拖不回来。 */
export const MIN_W = 2;
export const MIN_H = 4;

/** 单组块数上限：版式是显示配置，不该变成数据倾倒场（防御性校验）。 */
export const MAX_BLOCKS = 400;

/** 内容像素 → 行数（块的显示高度 = rows*8 + (rows-1)*10）。 */
export function rowsForPx(px) {
  const v = Math.max(0, Number(px) || 0);
  return Math.max(MIN_H, Math.ceil((v + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])));
}

/** 行数 → 显示高度（px），与网格引擎的算法一致。 */
export function blockHeightPx(rows) {
  const h = Math.max(1, Math.round(Number(rows) || 1));
  return h * ROW_HEIGHT + (h - 1) * MARGIN[1];
}

/**
 * 这些类型的字段**天然要一整行**：多行文本、附件、图文、清单、表格、资料袋——
 * 压成半列只会让内容挤成一条缝。其余（单行输入 / 下拉 / 日期 / 勾选）默认半列，
 * 两个并排刚好，也才有「把单列变成多列」的余地。
 */
const WIDE_TYPES = new Set(['textarea', 'file', 'md', 'entrylist', 'table', 'source']);

/**
 * 各类型的**默认最小高度（px）**——不是「固定高度」：内容比它高就按内容长（见
 * web 端 blockBoard 的测量逻辑），删掉内容再缩回这个高度。所以这里估的是
 * 「块头 + 控件 + 一点呼吸」，而不是「一个框」。
 */
const DEFAULT_PX = {
  text: 58,
  number: 58,
  date: 58,
  month: 58,
  select: 58,
  tags: 58,
  bool: 58,
  secret: 58,
  textarea: 76,
  file: 130,
  md: 180,
  entrylist: 150,
  table: 200,
  source: 90,
};

const DEFAULT_H = Object.fromEntries(
  Object.entries(DEFAULT_PX).map(([type, px]) => [type, rowsForPx(px)]),
);

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};

/** 某个字段在某个列数下的默认块尺寸（列单位）。 */
export function defaultBlockSize(def, cols) {
  const total = Math.max(MIN_W, Math.round(Number(cols) || BP_COLS.lg));
  const wide = WIDE_TYPES.has(def?.type || 'text');
  // 窄屏（<= 4 列）一律整行：两列并排在手机上每个块只剩 60px，谁也填不了
  const w = total <= 4 ? total : (wide ? total : Math.max(MIN_W, Math.floor(total / 2)));
  const h = DEFAULT_H[def?.type] || DEFAULT_H.text;
  return { w: Math.min(w, total), h };
}

/** 把一组字段按顺序铺成网格（逐行填，放不下就换行）。默认版式就靠它生成。 */
export function packBlocks(fields, cols) {
  const total = Math.max(MIN_W, Math.round(Number(cols) || BP_COLS.lg));
  const items = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || !f.key) continue;
    const { w, h } = defaultBlockSize(f, total);
    if (x > 0 && x + w > total) { x = 0; y += rowH; rowH = 0; }
    items.push({ i: String(f.key), x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
    if (x >= total) { x = 0; y += rowH; rowH = 0; }
  }
  return items;
}

/** 还没存过版式时的默认布局：每个断点各铺一份（各断点列数不同，不能简单缩放）。 */
export function defaultLayouts(fields) {
  const out = {};
  for (const bp of Object.keys(BP_COLS)) out[bp] = packBlocks(fields, BP_COLS[bp]);
  return out;
}

/** 空布局（也用来清空某个栏目）。 */
export function emptyLayout(mode = 'grid') {
  return { v: LAYOUT_VERSION, mode: LAYOUT_MODES.includes(mode) ? mode : 'grid', panels: [], groups: {} };
}

function sanitizeItem(raw, cols) {
  if (!raw || typeof raw !== 'object') return null;
  const i = String(raw.i ?? raw.key ?? '').trim();
  if (!i) return null;
  const w = clampInt(raw.w, MIN_W, cols, Math.min(cols, 6));
  const h = clampInt(raw.h, MIN_H, 80, 2);
  const x = clampInt(raw.x, 0, Math.max(0, cols - w), 0);
  const y = clampInt(raw.y, 0, 100000, 0);
  return { i, x, y, w, h };
}

function uniqueStrings(list, limit = 200) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 版式 JSON 的**结构校验 + 归一化**。输入任何东西都不抛错：
 * 认识的留下并夹到合法范围，不认识的丢掉，返回 null 表示「根本不是一份版式」。
 * 服务端落盘前过一遍（不让人手搓的脏 JSON 进 store），面板读回来也过一遍。
 */
export function sanitizeLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mode = LAYOUT_MODES.includes(String(raw.mode)) ? String(raw.mode) : 'grid';
  const panels = uniqueStrings(raw.panels);
  const groups = {};
  const srcGroups = raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups) ? raw.groups : {};
  for (const [gid, g] of Object.entries(srcGroups)) {
    const id = String(gid || '').trim();
    if (!id || !g || typeof g !== 'object') continue;
    const layouts = {};
    const srcLayouts = g.layouts && typeof g.layouts === 'object' ? g.layouts : {};
    for (const bp of Object.keys(BP_COLS)) {
      const list = srcLayouts[bp];
      if (!Array.isArray(list)) continue;
      const cols = BP_COLS[bp];
      const items = [];
      const seen = new Set();
      for (const it of list.slice(0, MAX_BLOCKS)) {
        const item = sanitizeItem(it, cols);
        if (!item || seen.has(item.i)) continue;
        seen.add(item.i);
        items.push(item);
      }
      // 空数组也是「这个断点我看过、现在没有块」——但要能区分「没这个断点」（交给引擎生成）
      if (items.length) layouts[bp] = items;
    }
    groups[id] = { collapsed: g.collapsed === true, layouts };
  }
  return { v: LAYOUT_VERSION, mode, panels, groups };
}

/**
 * 内容驱动高度：把量到的内容高度套到版式上（只对当前断点）。
 * 高度 = max(存储的最小高, 内容需要的行数)：内容长就长，内容删掉就缩回最小高。
 * 视图期算出来的高度**不落盘**——它是「这一条内容有多高」，不是「这个栏目该怎么排」。
 */
export function growHeights(items, measured) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const px = measured ? measured[it.i] : 0;
    if (!px) return it;
    const need = rowsForPx(px);
    return need > it.h ? { ...it, h: need } : it;
  });
}

/** 回写前把视图期算出来的高度换回存储的最小高（只保留 x/y/w 这些真被拖过的关系）。 */
export function keepMinHeights(items, base) {
  const mins = new Map((Array.isArray(base) ? base : []).map((it) => [it.i, it.h]));
  return (Array.isArray(items) ? items : []).map((it) => {
    const min = mins.get(it.i);
    return min === undefined || min === it.h ? it : { ...it, h: min };
  });
}

/**
 * 按给定顺序重新铺一遍（**保留每个块原有的宽度**，高度用最小高）。
 *
 * 拖动排序走的是这一步：顺序是用户给的，格子位置是我们算的。
 * 这样拖动过程中不必让引擎去猜「这个落点行不行」——只在松手时重排一次，
 * 不会出现「块在碰撞格之间跳」「拖到空处又被吸上去」的卡手感。
 */
export function repackBlocks(items, cols) {
  const total = Math.max(MIN_W, Math.round(Number(cols) || BP_COLS.lg));
  const out = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const w = Math.min(Math.max(MIN_W, Math.round(Number(it.w) || MIN_W)), total);
    const h = Math.max(MIN_H, Math.round(Number(it.h) || MIN_H));
    if (x > 0 && x + w > total) { x = 0; y += rowH; rowH = 0; }
    out.push({ ...it, x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
    if (x >= total) { x = 0; y += rowH; rowH = 0; }
  }
  return out;
}

/** 栏目 = 分组 + 字段字典 → 版式只关心「哪些分组、每组有哪些字段」。 */export function groupsForLayout(section) {
  const groups = Array.isArray(section?.groups) ? section.groups : [];
  const fields = Array.isArray(section?.fields) ? section.fields : [];
  return groups
    .map((g) => ({ id: String(g.id), title: g.title || String(g.id), fields: fields.filter((f) => f.group === g.id) }))
    // 空分组在面板上不出现（没有块可摆），版式里也不该占位
    .filter((g) => g.fields.length);
}

/**
 * 把一份（可能是旧的、残缺的）版式对齐到**当前**的分组与字段：
 *
 * - 分组被删了 → 它的块布局跟着丢；新分组 → 追加到尾部并按默认尺寸铺一遍；
 * - 字段被删了 → 该字段的块从每个断点里摘掉（不会留下空位）；新字段 → 追加到最底部；
 * - 某个断点从没存过 → 不动它（交给网格引擎按相邻断点生成），完全不存则铺默认。
 *
 * 幂等：对已经对齐的版式再跑一次，结果一模一样——所以读的时候跑、写之前也跑。
 */
export function reconcileLayout(layout, groups) {
  const safe = sanitizeLayout(layout) || emptyLayout();
  const list = Array.isArray(groups) ? groups.filter((g) => g && g.id) : [];
  const ids = list.map((g) => String(g.id));

  const panels = [
    ...safe.panels.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !safe.panels.includes(id)),
  ];

  const outGroups = {};
  for (const g of list) {
    const gid = String(g.id);
    const stored = safe.groups[gid] || null;
    const fields = Array.isArray(g.fields) ? g.fields.filter((f) => f && f.key) : [];
    const keys = fields.map((f) => String(f.key));
    const storedLayouts = stored?.layouts || {};
    const bps = Object.keys(storedLayouts);

    let layouts;
    if (!bps.length) {
      layouts = defaultLayouts(fields);
    } else {
      layouts = {};
      for (const bp of bps) {
        const cols = BP_COLS[bp] || BP_COLS.lg;
        const kept = [];
        const seen = new Set();
        for (const it of storedLayouts[bp]) {
          if (!keys.includes(it.i) || seen.has(it.i)) continue;
          seen.add(it.i);
          const w = Math.min(it.w, cols);
          kept.push({ i: it.i, x: Math.min(it.x, Math.max(0, cols - w)), y: it.y, w, h: it.h });
        }
        // 新字段接在**这一组最下面**：不插队，避免每次加字段都把已有版式打散
        let y = kept.reduce((m, it) => Math.max(m, it.y + it.h), 0);
        let x = 0;
        let rowH = 0;
        for (const f of fields) {
          const key = String(f.key);
          if (seen.has(key)) continue;
          seen.add(key);
          const { w, h } = defaultBlockSize(f, cols);
          if (x > 0 && x + w > cols) { x = 0; y += rowH; rowH = 0; }
          kept.push({ i: key, x, y, w, h });
          x += w;
          rowH = Math.max(rowH, h);
          if (x >= cols) { x = 0; y += rowH; rowH = 0; }
        }
        layouts[bp] = kept;
      }
    }
    outGroups[gid] = { collapsed: stored?.collapsed === true, layouts };
  }

  return { v: LAYOUT_VERSION, mode: safe.mode, panels, groups: outGroups };
}

/**
 * 落位对齐：把一个断点里的块**横向**吸附到「自身宽度的整数倍」档位上。
 *
 * 为什么需要：网格引擎按鼠标位置算列号，半宽的块拖到别人中间会落在第 3 列（0..11 里的 3），
 * 于是「两块并排」变成「一块压在缝上、另一块被挤下去」——看起来像没对齐。这里只做一件事：
 * 宽能整除列数（半宽 6 / 三分之一 4 / 整行 12）的块，x 吸到 0、6、12… 这些档位；
 * 拖动距离不足半档时原地不动。宽度不能被整除（用户自由拉的 5 列）就保持原样——
 * 那本来就是他特意调的，不该被「自动摆正」。
 *
 * 只改坐标、不重排、不判碰撞：碰撞与回弹仍然归引擎（它会按 y 做垂直压实）。
 */
export function snapItems(items, cols) {
  const total = Math.max(MIN_W, Math.round(Number(cols) || BP_COLS.lg));
  return (Array.isArray(items) ? items : []).map((it) => {
    const w = Math.min(it.w, total);
    if (!w || total % w !== 0) return it;
    const x = Math.min(total - w, Math.round(it.x / w) * w);
    return x === it.x ? it : { ...it, x };
  });
}

/** 对整份版式的每个断点各吸附一次（幂等）。 */
export function snapLayout(layout) {
  const safe = sanitizeLayout(layout) || emptyLayout();
  const groups = {};
  for (const [gid, g] of Object.entries(safe.groups)) {
    const layouts = {};
    for (const [bp, items] of Object.entries(g.layouts)) layouts[bp] = snapItems(items, BP_COLS[bp]);
    groups[gid] = { collapsed: g.collapsed, layouts };
  }
  return { ...safe, groups };
}

/**
 * 两份版式是否等价（只比会落盘的部分）。
 * 面板用它判断引擎回报的「当前布局」是不是真被用户改了——引擎在挂载时也会回调一次，
 * 不回比就会把「打开页面」也当成一次拖拽，白白发一次写请求。
 */
export function sameLayout(a, b) {
  const norm = (x) => {
    if (!x || typeof x !== 'object') return '';
    const parts = [String(x.mode || 'grid'), (x.panels || []).join(',')];
    for (const gid of Object.keys(x.groups || {}).sort()) {
      const g = x.groups[gid] || {};
      parts.push(`${gid}:${g.collapsed ? 1 : 0}`);
      for (const bp of Object.keys(g.layouts || {}).sort()) {
        const items = (g.layouts[bp] || []).map((it) => `${it.i}@${it.x},${it.y},${it.w},${it.h}`).sort();
        parts.push(`${bp}=${items.join(';')}`);
      }
    }
    return parts.join('|');
  };
  return norm(a) === norm(b);
}
