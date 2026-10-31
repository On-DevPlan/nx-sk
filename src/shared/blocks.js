// 块字段（`entry.body`）的内核：类型词汇表 + 归一 + 校验。
//
// **块是递归的**（设计 §十三 13.1）：容器块有 children，叶块没有。
// 类型词汇表对齐 §十三 13.2 + R13 修订，与字段字典**共用同一套值形状**
// （paragraph=文本、table=自描述文档、entrylist=行数组、secret=密文信封……），
// 不发明新形状 —— 校验/渲染/导出能复用的就复用。
//
// 为什么放在 `src/shared/` 而不是 `src/core/`：与 shared/table.js 同一条理由 ——
// 面板**不许 import core**（eslint 的前后端边界规则），而「块怎么算合法」只允许有一份实现，
// CLI 与面板对不上比不给更糟。本文件必须保持**纯函数 + 零依赖**：
// 一旦它 import 了 fs/crypto，浏览器就打包不出来了。
//
// 两条铁律（写错的代价是静默丢数据）：
//   ① normalize 必须把 `body` 显式收进来 —— 白名单重建会把没列的键丢掉；
//   ② 转类型是**整块替换**不是合并 —— 合并会把旧类型的残留字段留在块里。
//
// 修订记录：column 分两层（widths 非空 = 列组 / 为空 = 叶子列）；
// entrylist 块自带 fields（块不是字段，没有栏目字典可查子列定义）。

/** 块 id 前缀：复用 ids.js 的 id 族（与 f_ 附件同一先例）。 */
export const BLOCK_ID_PREFIX = 'b_';

/** 叶块七种 + 容器两种（§十三 13.2）；toggle 下一版。 */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'md',
  'table',
  'entrylist',
  'file',
  'secret',
  'section',
  'column',
];

/**
 * 块类型的中文名。**CLI 渲染与面板共用这一份**——两处各写一套标签，
 * 迟早出现「CLI 叫图文、面板叫 markdown」这种同一件事两个名字的分叉。
 */
export const BLOCK_LABELS = {
  paragraph: '段落',
  heading: '标题',
  md: '图文',
  table: '表格',
  entrylist: '清单',
  file: '附件',
  secret: '密钥',
  section: '内嵌栏目',
  column: '分栏',
};

/** 容器块：能装 children 的块。 */
export const CONTAINER_TYPES = ['section', 'column'];

export function isContainerType(type) {
  return CONTAINER_TYPES.includes(type);
}

/** 叶块 */
export function isLeafType(type) {
  return !isContainerType(type);
}

/** column 的判别：widths 非空 = 列组（children 是子列），为空 = 叶子列（children 是内容块）。 */
export function isColumnGroup(block) {
  return !!block && block.type === 'column' && Array.isArray(block.widths) && block.widths.length > 0;
}

/** 转类型时**文本会不会丢**（只有文本型的块能保住 text）。 */
export function keepsText(type) {
  return type === 'paragraph' || type === 'heading' || type === 'md';
}

/**
 * 归一一个块（递归）。非法块返回 null（调用方过滤），**不静默改写**：
 * 缺 id / 缺 type / 类型不在词汇表里 → null；字段值交由各类型自己的规则校验。
 */
export function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  if (!BLOCK_TYPES.includes(type)) return null;

  const out = { id: String(raw.id || ''), type };

  switch (type) {
    case 'paragraph':
      out.text = String(raw.text ?? '');
      break;
    case 'heading':
      out.text = String(raw.text ?? '');
      out.level = [1, 2, 3].includes(raw.level) ? raw.level : 2;
      break;
    case 'md':
      out.text = String(raw.text ?? '');
      break;
    case 'table':
      // 表格是自描述文档：列与行的校验复用 shared/table.js 的同一条实现（由调用方传入）
      out.columns = Array.isArray(raw.columns) ? raw.columns : [];
      out.rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (Array.isArray(raw.totals)) out.totals = raw.totals;
      if (raw.summary === false) out.summary = false;
      break;
    case 'entrylist':
      // 块不是字段，没有栏目字典可查子列定义 → **自带 fields**（R13 修订）
      out.fields = Array.isArray(raw.fields) ? raw.fields : [];
      out.value = Array.isArray(raw.value) ? raw.value : [];
      break;
    case 'file':
      // 附件 id 列表（不是文件名、不是路径）
      out.files = Array.isArray(raw.files) ? raw.files.map(String) : [];
      break;
    case 'secret':
      // 密文信封（与 secret 字段同一条加密路径）；明文不落盘
      out.label = String(raw.label || '密钥');
      out.value = raw.value ?? null;
      break;
    case 'section':
      // 内嵌另一个栏目的数据库视图
      out.sectionId = String(raw.sectionId || '');
      if (raw.viewId) out.viewId = String(raw.viewId);
      break;
    case 'column':
      // widths 非空 = 列组（widths[i] 是第 i 个子列的宽度百分比），为空 = 叶子列
      out.widths = Array.isArray(raw.widths) ? raw.widths.map((w) => (Number.isFinite(w) ? w : 0)) : [];
      out.children = Array.isArray(raw.children) ? normalizeBlocks(raw.children) : [];
      break;
    default:
      return null;
  }
  if (!out.id) return null;
  return out;
}

/** 归一一组块（丢弃非法项）。 */
export function normalizeBlocks(list) {
  return (Array.isArray(list) ? list : []).map(normalizeBlock).filter(Boolean);
}

/**
 * 校验一组块，返回错误信息数组（空数组 = 合法）。
 *
 * 与 normalize 的分工：normalize 负责「形状归一」（坏块丢掉），validate 负责「业务规则」
 * （id 重复、secret 块的明文、容器空 children、sectionId 缺失……）。
 * 保存前调用（「写入即体检」），与面板的预检共用这一份实现。
 */
export function validateBlocks(list) {
  const errors = [];
  const seen = new Set();

  const walk = (blocks, path) => {
    for (const [i, b] of (blocks || []).entries()) {
      const at = path ? `${path}[${i}]` : `[${i}]`;
      if (!b || typeof b !== 'object' || !b.id) {
        errors.push(`${at}: 块缺少 id`);
        continue;
      }
      if (seen.has(b.id)) errors.push(`${at}: 块 id 重复: ${b.id}`);
      seen.add(b.id);

      if (b.type === 'secret' && b.value != null && typeof b.value !== 'object') {
        errors.push(`${at}: secret 块的 value 应是密文对象（AES-256-GCM 信封），存明文是泄露`);
      }
      if (b.type === 'section' && !b.sectionId) {
        errors.push(`${at}: section 块缺少 sectionId`);
      }
      if (b.type === 'column') {
        const group = Array.isArray(b.widths) && b.widths.length > 0;
        if (group) {
          if (!Array.isArray(b.children) || b.children.length < 2) {
            errors.push(`${at}: 列组至少要 2 个子列`);
          }
          const sum = (b.widths || []).reduce((s, w) => s + (Number(w) || 0), 0);
          if (Math.abs(sum - 100) > 1) errors.push(`${at}: 列组 widths 之和应为 100，现在是 ${Math.round(sum)}`);
        }
      }
      if (b.children) walk(b.children, `${at}.children`);
    }
  };
  walk(list, '');
  return errors;
}

/** 深度优先找块 */
export function findBlock(list, id) {
  for (const b of list || []) {
    if (b.id === id) return b;
    if (b.children) {
      const hit = findBlock(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** 找到某个块所在的容器（返回容器块或 null = 顶层） */
export function findContainer(list, id) {
  for (const b of list || []) {
    if (!b.children) continue;
    if (b.children.some((c) => c.id === id)) return b;
    const hit = findContainer(b.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 不可变更新一个块（按 id 深搜，PATCH 合并语义）。 */
export function updateBlock(list, id, patch) {
  return (list || []).map((b) => {
    if (b.id === id) return { ...b, ...patch, id };
    if (!b.children) return b;
    const children = updateBlock(b.children, id, patch);
    return children === b.children ? b : { ...b, children };
  });
}

/** **整体替换**一个块（转换类型用 —— 合并会把旧类型的残留字段留下）。 */
export function replaceBlock(list, id, newBlock) {
  return (list || []).map((b) => {
    if (b.id === id) return { ...newBlock, id };
    if (!b.children) return b;
    const children = replaceBlock(b.children, id, newBlock);
    return children === b.children ? b : { ...b, children };
  });
}

/** 不可变删除一个块（含其子树）。 */
export function removeBlock(list, id) {
  return (list || [])
    .filter((b) => b.id !== id)
    .map((b) => (b.children ? { ...b, children: removeBlock(b.children, id) } : b));
}

/** 块的子孙 id 集合（防把父挪进自己的子树）。 */
export function descendantIds(block) {
  const out = new Set();
  const walk = (b) => {
    for (const c of b.children || []) {
      out.add(c.id);
      walk(c);
    }
  };
  walk(block);
  return out;
}

/** 在容器内把 fromId 移到 toIndex（不可变）；toIndex 越界时夹到边界。 */
export function moveToIndex(list, containerId, id, toIndex) {
  const container = containerId ? findBlock(list, containerId) : null;
  if (containerId && !container) return list;
  const arr = containerId ? (container.children || []) : (list || []);
  const i = arr.findIndex((b) => b.id === id);
  if (i < 0) return list;
  const j = Math.max(0, Math.min(arr.length - 1, Number(toIndex)));
  if (i === j) return list;
  const next = [...arr];
  const [it] = next.splice(i, 1);
  next.splice(j, 0, it);
  return containerId ? updateBlock(list, containerId, { children: next }) : next;
}

/** 在容器末尾（或某块之后）追加块。 */
export function appendBlock(list, block, afterId = null) {
  if (afterId) {
    const container = findContainer(list, afterId);
    const arr = container ? (container.children || []) : list;
    const i = arr.findIndex((b) => b.id === afterId);
    if (container) {
      const children = [...arr];
      children.splice(i + 1, 0, block);
      return updateBlock(list, container.id, { children });
    }
    const next = [...list];
    next.splice(i + 1, 0, block);
    return next;
  }
  return [...(list || []), block];
}

/** 深度优先收集块（含容器 children 里的）。 */
export function walkBlocks(list, fn) {
  for (const b of list || []) {
    fn(b);
    if (b.children) walkBlocks(b.children, fn);
  }
}

/** 块正文里引用的附件 id（file 块）——附件清理/导出打包的引用扫描用。 */
export function fileIdsInBlocks(blocks) {
  const out = [];
  walkBlocks(blocks || [], (b) => {
    if (b.type === 'file' && Array.isArray(b.files)) out.push(...b.files);
  });
  return out;
}

/** 块正文里引用的图片 id（md 块正文里的 `![x](f_xxx)`）——重映射用。 */
export function mdImageIdsInBlocks(blocks) {
  const out = [];
  walkBlocks(blocks || [], (b) => {
    if (b.type === 'md' && typeof b.text === 'string') out.push(b.text);
  });
  return out;
}

// ── 块级 AI：可比较的文本 + 字符级差异（S4）────────────────────
//
// 差异计算放在这里（而不是服务端或前端各写一份）的理由与 shared/table.js 同一条：
// 「这两块算不算改了」只能有一个判定。服务端用它算 pending，前端用它渲染红删绿增，
// 两边算法不一致 = 用户看到的 diff 和实际应用的内容对不上。

/** 参与差异比较的文本。非文本块返回空串（它们的差异由「结构是否变化」表达）。 */
export function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (keepsText(block.type)) return String(block.text ?? '');
  return '';
}

/**
 * 字符级差异 → `[{op:'same'|'del'|'ins', text}]`。
 *
 * 用 LCS（不是按行 diff）：块正文常是一两句话，按字符才看得出「改了哪个词」。
 * 代价是 O(n·m)，所以有两道闸：超过 `maxCells` 直接退化成「整段删 + 整段增」，
 * 保证最坏情况不把服务端拖死（一段 4000 字的长文就是 1600 万格，够卡 100ms+）。
 */
export function diffText(before, after, { maxCells = 1_000_000 } = {}) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (a === b) return a ? [{ op: 'same', text: a }] : [];
  if (!a) return [{ op: 'ins', text: b }];
  if (!b) return [{ op: 'del', text: a }];

  const n = a.length;
  const m = b.length;
  if (n * m > maxCells) return [{ op: 'del', text: a }, { op: 'ins', text: b }];

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const raw = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push(['same', a[i]]); i += 1; j += 1; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { raw.push(['del', a[i]]); i += 1; }
    else { raw.push(['ins', b[j]]); j += 1; }
  }
  while (i < n) { raw.push(['del', a[i]]); i += 1; }
  while (j < m) { raw.push(['ins', b[j]]); j += 1; }

  const out = [];
  for (const [op, ch] of raw) {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += ch;
    else out.push({ op, text: ch });
  }
  return out;
}

const DIFF_OPS = new Set(['same', 'del', 'ins']);

/**
 * pending 结构体检（应用前必过）。
 *
 * 为什么要校验一份「自己刚写出去的文件」：pending 落在 `~/nx-sk/pending/` 里，
 * 用户可能手改、也可能被别的进程写坏。坏文件直接应用 = 把脏块写进 store，
 * 所以宁可明确报错（`INVALID_INPUT`）也不猜。
 */
export function validatePending(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['pending 不是对象'];
  if (!String(raw.id || '')) errors.push('pending 缺少 id');
  if (!String(raw.entryId || '')) errors.push('pending 缺少 entryId');
  if (!Array.isArray(raw.blocks)) errors.push('pending 缺少 blocks（最终块正文）');
  if (!Array.isArray(raw.diffs)) errors.push('pending 缺少 diffs');

  for (const [i, d] of (Array.isArray(raw.diffs) ? raw.diffs.entries() : [])) {
    if (!d || typeof d !== 'object') { errors.push(`diffs[${i}] 不是对象`); continue; }
    if (!String(d.blockId || '')) errors.push(`diffs[${i}] 缺少 blockId`);
    if (!String(d.baseHash || '')) errors.push(`diffs[${i}] 缺少 baseHash（服务端算，客户端不许自带）`);
    if (!Array.isArray(d.segments)) { errors.push(`diffs[${i}] 缺少 segments`); continue; }
    for (const [k, s] of d.segments.entries()) {
      if (!s || !DIFF_OPS.has(s.op)) errors.push(`diffs[${i}].segments[${k}] 的 op 非法`);
      else if (typeof s.text !== 'string') errors.push(`diffs[${i}].segments[${k}] 的 text 不是字符串`);
    }
  }
  for (const [i, b] of (Array.isArray(raw.newBlocks) ? raw.newBlocks.entries() : [])) {
    if (!b || !b.id || !BLOCK_TYPES.includes(b.type)) errors.push(`newBlocks[${i}] 不是合法块`);
  }
  for (const [i, id] of (Array.isArray(raw.removedIds) ? raw.removedIds.entries() : [])) {
    if (!String(id || '')) errors.push(`removedIds[${i}] 不是块 id`);
  }
  return errors;
}
