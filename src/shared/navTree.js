// 目录树（`settings.navTree`）的内核：**从老三套推断出一棵树** + 纯函数树操作。
//
// 为什么在 `src/shared/`（而不是计划里写的 `web/frontend/components/`）：
// 后端 `settings.service` 也要「从 navGroups/navHidden/navOrder 推断出一棵树」
// （CLI `settings get` 要给出与面板同一棵树）—— 两边各写一份必然分叉，
// 与 shared/views.js、shared/blocks.js 同一条理由：规则只允许一份实现。
//
// 本文件必须保持**纯函数 + 零依赖**：一旦 import 了 fs，浏览器就打包不出来了。
//
// 兼容语义（设计 §十五 15.2「加法不换血」）：
//   老 store 里没有 navTree，只有
//     · navGroups = [{ title, sections:[栏目id…] }]  数组顺序 = 显示顺序
//     · navHidden = [栏目id]                          入口不显示（深链直达仍可用）
//     · navOrder  = [栏目id]                          平铺区顺序；没列进去的按栏目自身 order 跟在后面
//   **读路径推断、不写回**：用户第一次改树（拖拽 / 嵌套）才落成显式 navTree。

/** 树的节点只有两种。分组节点是推断出来的；显式 navTree 可以有任意嵌套。 */
export const NAV_KINDS = ['section', 'group'];

const GROUP_PREFIX = 'group:';

export function isGroupId(id) {
  return typeof id === 'string' && id.startsWith(GROUP_PREFIX);
}

/** 栏目节点的 id 就是栏目 id —— 拖条目 / 开面板都靠它定位。 */
export function sectionNode(id, extra) {
  return { kind: 'section', id: String(id), expanded: false, compact: false, children: [], ...extra };
}

// ── 归一与剪枝 ───────────────────────────────────────────────

/**
 * 归一显式树：读盘上来的东西不能直接信。
 *   · kind 不认识 / id 空 / 分组没标题 → 丢
 *   · 同一 id 在树里出现第二次 → 丢（一个栏目不可能同时挂两处）
 *   · 自嵌套（分组套自己）→ 丢
 * 返回**新**数组，不改入参。
 */
export function normalizeNavTree(raw) {
  const seen = new Set();
  const walk = (nodes) => {
    const out = [];
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || typeof n !== 'object') continue;
      if (!NAV_KINDS.includes(n.kind)) continue;
      const id = String(n.id || '').trim();
      if (!id || seen.has(id)) continue;
      if (n.kind === 'group' && !String(n.title || '').trim()) continue;
      seen.add(id);
      const node = { kind: n.kind, id };
      if (n.kind === 'group') node.title = String(n.title).trim();
      if (n.expanded === true) node.expanded = true;
      if (n.compact === true) node.compact = true;
      const children = walk(n.children);
      if (children.length) node.children = children;
      out.push(node);
    }
    return out;
  };
  return walk(raw);
}

/**
 * 剪枝：栏目被删掉后，树里指向它的节点自动略过（**优雅降级**，不报错）。
 * 分组内部被剪空 → 分组也不显示（与老实现 `filter(g => g.sections.length)` 同口径）。
 * @param {Array<string>} sectionIds 现存栏目 id
 */
export function pruneNavTree(tree, sectionIds) {
  const alive = new Set((sectionIds || []).map(String));
  const walk = (nodes) => {
    const out = [];
    for (const n of nodes || []) {
      if (n.kind === 'section') {
        if (alive.has(n.id)) out.push(n);
        continue;
      }
      const children = walk(n.children);
      if (children.length) out.push({ ...n, children });
    }
    return out;
  };
  return walk(tree);
}

// ── 树操作（纯函数：都返回新树，不改入参） ────────────────────

export function findNode(list, id) {
  for (const n of list || []) {
    if (n.id === id) return n;
    const hit = n.children && findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 找出某个节点所在的父（根层返回 null）与其在父 children 里的下标 */
export function locateNode(list, id, parent = null) {
  const arr = list || [];
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i].id === id) return { parent, index: i };
    const hit = arr[i].children ? locateNode(arr[i].children, id, arr[i]) : null;
    if (hit) return hit;
  }
  return null;
}

export function removeNode(list, id) {
  const out = [];
  for (const n of list || []) {
    if (n.id === id) continue;
    out.push(n.children ? { ...n, children: removeNode(n.children, id) } : n);
  }
  return out;
}

/** 插到 parentId 之下（parentId 为空 = 根层）；index < 0 = 末尾。返回新树。 */
export function insertNode(list, parentId, node, index = -1) {
  const root = [...(list || [])];
  const put = (arr) => {
    const next = [...arr];
    if (index < 0 || index > next.length) next.push(node);
    else next.splice(index, 0, node);
    return next;
  };
  if (!parentId) return put(root);
  const walk = (arr) => arr.map((n) => {
    if (n.id === parentId) return { ...n, children: put(n.children || []) };
    return n.children ? { ...n, children: walk(n.children) } : n;
  });
  return walk(root);
}

/**
 * 移动节点（拖拽重排 / 嵌套的唯一入口）。
 *
 * `index` = **目标下标，arrayMove 语义**（把 id 放到移除之后的第 index 位）。
 * 刻意不采用「DOM 缝坐标」那套：dnd-kit 的 sortable 给的是排序后的下标，
 * 两者混用就会出现「预览一格、落点另一格」（原型里踩过）。
 * 明确成一种语义，比在两处各减一次 1 更可靠。
 *
 * 三条拒绝（返回原树，不炸）：来源不存在 / 往自己身上挂 / 往自己的子树里挂。
 */
export function moveNode(list, id, parentId, index = -1) {
  const src = locateNode(list, id);
  if (!src) return list;
  if (parentId && parentId === id) return list;
  if (parentId) {
    const moving = findNode(list, id);
    if (moving && findNode(moving.children || [], parentId)) return list; // 不能拖进自己的子树
    if (!findNode(list, parentId)) return list;
  }
  const removed = removeNode(list, id);
  return insertNode(removed, parentId || '', { ...findNode(list, id) }, index);
}

/** 开关某个节点的 expanded（不动结构） */
export function toggleExpanded(list, id, value) {
  return (list || []).map((n) => {
    const next = { ...n };
    if (n.id === id) {
      const want = typeof value === 'boolean' ? value : !n.expanded;
      if (want) next.expanded = true; else delete next.expanded;
    }
    if (n.children) next.children = toggleExpanded(n.children, id, value);
    return next;
  });
}

/** 树里的**栏目节点**（分组节点不算栏目），按渲染顺序 */
export function sectionNodes(list) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.kind === 'section') out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(list);
  return out;
}

// ── 从老三套推断 ────────────────────────────────────────────

const INF = Number.MAX_SAFE_INTEGER;

/**
 * 推断目录树。
 * @param {Array} sections 栏目列表（每项 { id, title, order }）
 * @param {object} settings { navGroups, navHidden, navOrder }
 * @returns {{ tree: Array, hidden: string[] }}
 */
export function inferNavTree(sections, settings) {
  const { navGroups = [], navHidden = [], navOrder = [] } = settings || {};
  const all = Array.isArray(sections) ? sections : [];
  // 隐藏只认现存栏目：指向已删栏目的旧配置留着不报错，但也不进 hidden 输出
  const hidden = new Set((navHidden || []).map(String).filter((id) => all.some((s) => s.id === id)));
  const visible = all.filter((s) => !hidden.has(s.id));

  // ② 分组（组内顺序 = 列出的顺序；栏目不存在 / 空组 → 跳过）
  const groups = (navGroups || [])
    .map((g) => ({
      title: String((g && g.title) || ''),
      sections: ((g && g.sections) || []).map((id) => visible.find((s) => s.id === id)).filter(Boolean),
    }))
    .filter((g) => g.sections.length);

  const grouped = new Set(groups.flatMap((g) => g.sections.map((s) => s.id)));

  // ③ 平铺区：navOrder 里排过的优先（按它的次序），其余按栏目自身 order
  const rank = new Map((navOrder || []).map((id, i) => [String(id), i]));
  const flat = visible
    .filter((s) => !grouped.has(s.id))
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : INF;
      const rb = rank.has(b.id) ? rank.get(b.id) : INF;
      if (ra !== rb) return ra - rb;
      return (a.order ?? 50) - (b.order ?? 50);
    });

  // ④ 平铺在前、分组在后（与老实现的渲染顺序一致）
  const tree = [
    ...flat.map((s) => sectionNode(s.id)),
    ...groups.map((g, i) => ({
      kind: 'group',
      id: `${GROUP_PREFIX}${g.title}#${i}`,
      title: g.title,
      expanded: false,
      compact: false,
      children: g.sections.map((s) => sectionNode(s.id)),
    })),
  ];

  return { tree, hidden: [...hidden] };
}

/**
 * 解析生效的目录树。
 *  · 配了 `settings.navTree` → 用它（显式，用户改过的），再剪掉已删栏目
 *  · 没配 → 从老三套推断（只读，不写回）
 * @returns {{ tree: Array, hidden: string[], source: 'explicit'|'inferred' }}
 */
export function resolveNavTree(sections, settings) {
  const s = settings || {};
  const ids = (Array.isArray(sections) ? sections : []).map((x) => String(x.id));
  const explicit = normalizeNavTree(s.navTree);
  if (explicit.length) {
    return { tree: pruneNavTree(explicit, ids), hidden: (s.navHidden || []).map(String), source: 'explicit' };
  }
  const inferred = inferNavTree(sections, s);
  return { tree: inferred.tree, hidden: inferred.hidden, source: 'inferred' };
}
