// 头部导航配置的**纯模型**：分组 + 隐藏。零 React、零 IO，可单测。
//
// 为什么单独一层：这块的逻辑（增删改、排序、可用性、校验）比渲染多得多，
// 混在 JSX 里既说不清也测不了。表现层只管画，动手改数据一律走这里——
// 于是「管理逻辑」只有一份，前端拦一道、后端（settings service）再拦一道，两边同口径。
//
// 配置形状（与 settings.navGroups / navHidden / navOrder 一一对应）：
//   { groups: [{ title, sections: [栏目id…] }], hidden: [栏目id…], order: [栏目id…] }
// 组顺序 = 头部显示顺序；组内顺序 = 展开列表顺序；hidden = 入口不显示（直达仍可用）；
// order = **平铺区的显示顺序**（没列进去的栏目按栏目自己的 order 跟在后面）。

export const emptyConfig = () => ({ groups: [], hidden: [], order: [] });

/** 从后端 settings 取一份**工作副本**（深拷贝，编辑不污染原数据）。 */
export function configFromSettings(settings) {
  return {
    groups: (settings?.navGroups || []).map((g) => ({ title: String(g.title || ''), sections: [...(g.sections || [])] })),
    hidden: [...(settings?.navHidden || [])],
    order: [...(settings?.navOrder || [])],
  };
}

/** 保存时发出去的形状（只带这两个键，其他设置项各自负责）。 */
export function configToPayload(cfg) {
  return {
    navGroups: cfg.groups.map((g) => ({ title: g.title.trim(), sections: [...g.sections] })),
    navHidden: [...cfg.hidden],
    navOrder: [...(cfg.order || [])],
  };
}

export const isDirty = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * 结构是否等价：「屏幕上会长成什么样」相同就算没变。
 *
 * 与 isDirty 的区别在 `order`：平铺区只要挪过一次，order 里就会落下一串完整序列，
 * 即使最终位置和原来一模一样，isDirty 也会判脏（用户看到的是「拖一下就提示未保存」）。
 * 这里只比组名 / 组成员 / 隐藏 / 平铺可见顺序——拖回原位就算没动。
 */
export function sameStructure(a, b, allIds = []) {
  const shape = (c) => JSON.stringify({
    groups: c.groups.map((g) => [g.title.trim(), g.sections]),
    hidden: c.hidden,
    pool: ungroupedIds(c, allIds),
  });
  return shape(a) === shape(b);
}

// —— 分组：增删改 + 排序 ——

export const addGroup = (cfg, title = '') => ({ ...cfg, groups: [...cfg.groups, { title, sections: [] }] });

export const removeGroup = (cfg, gi) => ({ ...cfg, groups: cfg.groups.filter((_, i) => i !== gi) });

export const renameGroup = (cfg, gi, title) => ({
  ...cfg,
  groups: cfg.groups.map((g, i) => (i === gi ? { ...g, title } : g)),
});

/** 上移 / 下移一个分组（delta = ±1）；越界原样返回。 */
export const moveGroup = (cfg, gi, delta) => {
  const to = gi + delta;
  if (to < 0 || to >= cfg.groups.length) return cfg;
  const groups = [...cfg.groups];
  [groups[gi], groups[to]] = [groups[to], groups[gi]];
  return { ...cfg, groups };
};

/**
 * 把分组挪到指定位置（拖把手换位用）。
 * 是「挪」不是「交换」：0 拖到 2 时中间那组上移一格，
 * 交换会把 A B C 变成 C B A（B 反而留在原地），拖着的感觉和结果对不上。
 */
export const moveGroupTo = (cfg, from, to) => {
  const n = cfg.groups.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return cfg;
  const groups = [...cfg.groups];
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  return { ...cfg, groups };
};

// —— 组成员：加入 / 移除 / 排序 ——

/** 把栏目加进某个分组（已在该组或别的组里则原样返回）。 */
export function addSection(cfg, gi, sid) {
  const target = cfg.groups[gi];
  if (!target || target.sections.includes(sid)) return cfg;
  if (cfg.groups.some((g) => g.sections.includes(sid))) return cfg; // 一个栏目只能属于一个分组
  return { ...cfg, groups: cfg.groups.map((g, i) => (i === gi ? { ...g, sections: [...g.sections, sid] } : g)) };
}

export const removeSection = (cfg, gi, sid) => ({
  ...cfg,
  groups: cfg.groups.map((g, i) => (i === gi ? { ...g, sections: g.sections.filter((x) => x !== sid) } : g)),
});

export const moveSection = (cfg, gi, si, delta) => {
  const g = cfg.groups[gi];
  const to = si + delta;
  if (!g || to < 0 || to >= g.sections.length) return cfg;
  const sections = [...g.sections];
  [sections[si], sections[to]] = [sections[to], sections[si]];
  return { ...cfg, groups: cfg.groups.map((x, i) => (i === gi ? { ...g, sections } : x)) };
};

/**
 * 把栏目放到指定分组的指定位置（拖拽编排的主力原语）。
 * `index === null` 表示追加到末尾；越界按边界处理。
 * 来源可以是别的分组、也可以是「未归组」——两种情况都先摘掉再插入，
 * 所以「拖动即等于移动」，不会出现同一栏目短暂存在两份。
 */
export function moveSectionTo(cfg, sid, gi, index = null) {
  return moveToContainer(cfg, sid, { kind: 'group', gi }, index);
}

/**
 * **容器**是这块的统一心智模型：一个栏目要么在「平铺」里、要么在某个分组里、要么在「隐藏」里。
 * `{kind:'pool'} | {kind:'group', gi} | {kind:'hidden'}` —— 拖拽就是把栏目从一个容器挪到另一个。
 */
/**
 * 容器里**看得见的那几行**，顺序与屏幕上一致。
 *
 * 平铺区只能用这个口径：`poolOrder` 是全量顺序（含已被归组 / 隐藏的栏目），
 * 拿它当行号会与「屏幕上的第几行」差好几格，落点于是莫名其妙地偏。
 * 拖拽索引、位置换算一律走这里，屏幕上第 i 行就是 rows[i]。
 */
export function viewRows(cfg, target, allIds = []) {
  if (!target) return [];
  if (target.kind === 'hidden') return [...cfg.hidden];
  if (target.kind === 'pool') return ungroupedIds(cfg, allIds);
  return [...(cfg.groups[target.gi]?.sections || [])];
}

/**
 * 栏目现在在哪个容器里，以及在该容器里的位置（拖拽要用它做索引换算）。
 * `index` 是**可见行**里的位置（= viewRows 的下标），不是全量顺序里的位置。
 */
export function containerOf(cfg, sid, allIds = []) {
  if (cfg.hidden.includes(sid)) return { kind: 'hidden', index: cfg.hidden.indexOf(sid) };
  const gi = cfg.groups.findIndex((g) => g.sections.includes(sid));
  if (gi >= 0) return { kind: 'group', gi, index: cfg.groups[gi].sections.indexOf(sid) };
  return { kind: 'pool', index: ungroupedIds(cfg, allIds).indexOf(sid) };
}

/**
 * 平铺区的显示顺序：`order` 里显式排过的优先（按它的次序），
 * 没排过的新栏目按传入的栏目顺序（= 栏目自己的 order）跟在后面。
 * 于是「从没拖过」= 纯栏目 order（老行为不变），拖过之后以拖的为准。
 */
export function poolOrder(cfg, allIds) {
  const ranked = (cfg.order || []).filter((id) => allIds.includes(id));
  const rest = allIds.filter((id) => !ranked.includes(id));
  return [...ranked, ...rest];
}

/**
 * 指针落位 → 真正的插入位。
 * 落点语义是「插到第 `hoveredIndex` 行**之前**」，但被拖走的自身会让位：
 * 同容器内往下拖时索引要减 1，否则结果会比指示线差一格。
 * `hoveredIndex === null` 表示追加到末尾（空容器），原样返回。
 */
export function insertionIndex(cfg, sid, target, hoveredIndex, allIds = []) {
  if (hoveredIndex === null || hoveredIndex === undefined) return null;
  const from = containerOf(cfg, sid, allIds);
  const sameContainer = target.kind === from.kind && (target.kind !== 'group' || target.gi === from.gi);
  if (sameContainer && typeof from.index === 'number' && from.index < hoveredIndex) return hoveredIndex - 1;
  return hoveredIndex;
}

/**
 * 指针 Y 坐标 → 插入位（0..n）。`midYs` 是各行**中线**的 Y，从上到下。
 *
 * 只跟中线比：指针越过某行中线才落到它后面。这样行的上下边缘、行与行之间的缝隙、
 * 容器的内边距都天然归到「最近的一侧」，不需要额外的容错区间——
 * 而「行内一个落点、行外另一个落点」正是先前边缘处反复横跳的来历。
 */
export function slotAt(midYs, y) {
  let i = 0;
  while (i < midYs.length && y > midYs[i]) i += 1;
  return i;
}

/** 把栏目挪进目标容器（index = 在该容器里的插入位，null = 末尾）。 */
export function moveToContainer(cfg, sid, target, index = null, allIds = []) {
  // 先从所有容器里摘掉（分组 + 隐藏 + 平铺顺序），再放进目标——「移动」永远只落一处
  const groups = cfg.groups.map((g) => ({ ...g, sections: g.sections.filter((x) => x !== sid) }));
  const hidden = cfg.hidden.filter((x) => x !== sid);
  const base = { ...cfg, groups, hidden, order: (cfg.order || []).filter((x) => x !== sid) };

  if (target.kind === 'hidden') return { ...base, hidden: [...hidden, sid] };

  if (target.kind === 'pool') {
    // 平铺区的顺序就是 order：先算出「去掉自己之后」的序列，再插到目标位
    const isPool = (id) => !groups.some((g) => g.sections.includes(id)) && !hidden.includes(id);
    const seq = poolOrder(base, allIds).filter((id) => id !== sid && isPool(id));
    const at = index === null ? seq.length : Math.max(0, Math.min(index, seq.length));
    return { ...base, order: [...seq.slice(0, at), sid, ...seq.slice(at)] };
  }

  const gi = target.gi;
  const cur = groups[gi];
  if (!cur) return cfg;
  const at = index === null ? cur.sections.length : Math.max(0, Math.min(index, cur.sections.length));
  const sections = [...cur.sections.slice(0, at), sid, ...cur.sections.slice(at)];
  return { ...base, groups: groups.map((g, i) => (i === gi ? { ...cur, sections } : g)) };
}

/** 把栏目移出分组（回到头部的平铺区）。 */
export const ungroupSection = (cfg, sid) => moveToContainer(cfg, sid, { kind: 'pool' });

/** 分组内相邻交换（键盘/触摸的兜底路径，拖拽之外的退路）。 */
export const swapSection = (cfg, gi, i, j) => {
  const g = cfg.groups[gi];
  if (!g || i === j || i < 0 || j < 0 || i >= g.sections.length || j >= g.sections.length) return cfg;
  const sections = [...g.sections];
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return { ...cfg, groups: cfg.groups.map((x, k) => (k === gi ? { ...g, sections } : x)) };
};

// —— 隐藏：入口显不显示 ——

export const toggleHidden = (cfg, sid) => ({
  ...cfg,
  hidden: cfg.hidden.includes(sid) ? cfg.hidden.filter((x) => x !== sid) : [...cfg.hidden, sid],
});

export const isHidden = (cfg, sid) => cfg.hidden.includes(sid);

// —— 派生 ——

export const groupedIds = (cfg) => cfg.groups.flatMap((g) => g.sections);

/**
 * 分组入口上的角标 = **栏目数**（这个分组收拢了几个栏目）。
 *
 * 为什么不是条目数之和：角标紧挨着组名，回答的是「这一坨里有多少个栏目」；
 * 条目数是**每个栏目各自**的属性，把它们加在一起塞给组名，会让人以为这个分组本身
 * 是个栏目、底下挂着 N 条记录 —— 展开后每行又有自己的条目数，角标既冗余又误导。
 * （组内某个栏目有 16 条，不代表这个分组有 16 条。）
 */
export const groupSectionCount = (group) => (group?.sections || []).length;

/** 「平铺」容器里的栏目（既不在分组里、也没被隐藏），按平铺顺序。 */
export const ungroupedIds = (cfg, allIds) => {
  const skip = new Set([...groupedIds(cfg), ...cfg.hidden]);
  return poolOrder(cfg, allIds).filter((id) => !skip.has(id));
};

/** 某个分组**还能**加入哪些栏目：不在本组、也不在别的组。 */
export function availableFor(cfg, gi, allIds) {
  const target = cfg.groups[gi];
  if (!target) return [];
  const others = new Set(cfg.groups.flatMap((g, i) => (i === gi ? [] : g.sections)));
  return allIds.filter((id) => !target.sections.includes(id) && !others.has(id));
}

/**
 * 前端先拦一道（后端 settings service 用同一套口径再拦一次）。
 * 返回 [{ field, message }]，空数组 = 可以保存。
 */
export function validate(cfg, allIds) {
  const known = new Set(allIds);
  const problems = [];
  const owner = new Map();

  cfg.groups.forEach((g, i) => {
    const label = g.title.trim() || `第 ${i + 1} 个分组`;
    if (!g.title.trim()) problems.push({ field: `groups.${i}.title`, message: `${label}：每个分组都要有组名` });
    if (!g.sections.length) problems.push({ field: `groups.${i}.sections`, message: `${label}：还没有栏目——加一个，或删掉这个分组` });
    for (const sid of g.sections) {
      if (!known.has(sid)) {
        problems.push({ field: `groups.${i}.sections.${sid}`, message: `${label}：栏目 ${sid} 已不存在，请移除` });
        continue;
      }
      const prev = owner.get(sid);
      if (prev !== undefined) {
        problems.push({ field: `groups.${i}.sections.${sid}`, message: `栏目 ${sid} 同时出现在「${prev}」与「${label}」里——一个栏目只能属于一个分组` });
        continue;
      }
      owner.set(sid, label);
    }
  });

  for (const sid of cfg.hidden) {
    if (!known.has(sid)) problems.push({ field: `hidden.${sid}`, message: `要隐藏的栏目 ${sid} 已不存在` });
  }
  for (const sid of cfg.order || []) {
    if (!known.has(sid)) problems.push({ field: `order.${sid}`, message: `平铺顺序里的栏目 ${sid} 已不存在` });
  }
  return problems;
}
