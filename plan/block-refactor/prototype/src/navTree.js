/* 目录树 —— **从老三套推断出一棵树**（只读推断，不写回）
 *
 * 这是「加法不换血」的兼容关键（设计 §十五 15.2）：
 * 老 store 里没有 `settings.navTree`，只有
 *   · `navGroups`  = [{ title, sections:[栏目id…] }]   数组顺序 = 显示顺序
 *   · `navHidden`  = [栏目id]                        入口不显示（`#/栏目` 直达仍可用）
 *   · `navOrder`   = [栏目id]                        平铺区的显示顺序；没列进去的按栏目自身顺序跟在后面
 *
 * **读路径从这三套推断出一棵树**，**不写回** store —— 用户第一次改树才落盘。
 *
 * 树的节点有两种：
 *   · 栏目节点 { kind:'section', id, expanded, compact, children:[] }
 *   · 分组节点 { kind:'group', id:'group:<标题>', title, expanded, children:[栏目节点…] }
 * 分组节点是**推断**出来的（老三套只能表达「一层分组」）；
 * 显式 navTree 可以有任意嵌套 —— 那是新形态的能力。
 *
 * 推断的顺序口径与老实现一致（src/modules/settings/service.js:193-212 与 App.jsx 的 nav 构造）：
 *   ① 隐藏的栏目 → 不进树，进隐藏区
 *   ② 分组里的栏目 → 进分组节点（组顺序 = navGroups 顺序，组内顺序 = 列出的顺序）
 *   ③ 其余可见栏目 → 平铺在根层，顺序 = navOrder 优先，其余按栏目自身 order
 *   ④ 老实现的渲染顺序是「平铺 → 分组 → 工具」，所以树里也是平铺在前、分组在后
 */

// ── 树操作（纯函数） ────────────────────────────────────────

export function findNode(list, id) {
  for (const n of list || []) {
    if (n.id === id) return n;
    const hit = n.children && findNode(n.children, id);
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

/** 把 node 插到 parentId 之下（parentId 为空 = 根层末尾） */
export function insertNode(list, parentId, node, index = -1) {
  if (!parentId) {
    if (index < 0 || index > list.length) list.push(node);
    else list.splice(index, 0, node);
    return list;
  }
  const parent = findNode(list, parentId);
  if (!parent) return list;
  parent.children = parent.children || [];
  if (index < 0 || index > parent.children.length) parent.children.push(node);
  else parent.children.splice(index, 0, node);
  return list;
}

// ── 从老三套推断 ────────────────────────────────────────────

const INF = Number.MAX_SAFE_INTEGER;

function sectionNode(section) {
  return {
    kind: 'section',
    id: section.id,
    expanded: false,
    compact: false,
    children: [],
  };
}

/**
 * 推断目录树。
 * @param {Array} sections 栏目列表（每项 { id, title, order }）
 * @param {object} settings 老三套 { navGroups, navHidden, navOrder }
 * @returns {{ tree: Array, hidden: string[] }}
 */
export function inferNavTree(sections, settings) {
  const { navGroups = [], navHidden = [], navOrder = [] } = settings || {};
  const all = sections || [];
  const hidden = new Set((navHidden || []).filter((id) => all.some((s) => s.id === id)));
  const visible = all.filter((s) => !hidden.has(s.id));

  // ② 分组（组内顺序 = 列出的顺序；栏目不存在 / 空组 → 跳过）
  const groups = (navGroups || [])
    .map((g) => ({
      title: String(g.title || ''),
      sections: (g.sections || [])
        .map((id) => visible.find((s) => s.id === id))
        .filter(Boolean),
    }))
    .filter((g) => g.sections.length);

  const grouped = new Set(groups.flatMap((g) => g.sections.map((s) => s.id)));

  // ③ 平铺区：navOrder 里的排前面，其余按栏目自身 order
  const rank = new Map((navOrder || []).map((id, i) => [id, i]));
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
    ...flat.map(sectionNode),
    ...groups.map((g, i) => ({
      kind: 'group',
      id: `group:${g.title}#${i}`,
      title: g.title,
      expanded: false,
      compact: false,
      children: g.sections.map(sectionNode),
    })),
  ];

  return { tree, hidden: [...hidden] };
}

/**
 * 解析生效的目录树。
 *  · 配了 `settings.navTree` → 用它（**显式**，用户自己改过的）
 *  · 没配 → 从老三套**推断**（**只读，不写回**）
 * @returns {{ tree: Array, hidden: string[], source: 'explicit'|'inferred' }}
 */
export function resolveNavTree(sections, settings) {
  const s = settings || {};
  if (Array.isArray(s.navTree) && s.navTree.length) {
    return { tree: s.navTree, hidden: s.navHidden || [], source: 'explicit' };
  }
  const inferred = inferNavTree(sections, s);
  return { tree: inferred.tree, hidden: inferred.hidden, source: 'inferred' };
}

/** 树里的**栏目节点**（分组节点不算栏目） */
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
