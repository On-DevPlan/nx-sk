// 头部导航配置的**纯模型**：分组 + 隐藏。零 React、零 IO，可单测。
//
// 为什么单独一层：这块的逻辑（增删改、排序、可用性、校验）比渲染多得多，
// 混在 JSX 里既说不清也测不了。表现层只管画，动手改数据一律走这里——
// 于是「管理逻辑」只有一份，前端拦一道、后端（settings service）再拦一道，两边同口径。
//
// 配置形状（与 settings.navGroups / navHidden 一一对应）：
//   { groups: [{ title, sections: [栏目id…] }], hidden: [栏目id…] }
// 组顺序 = 头部显示顺序；组内顺序 = 展开列表顺序；hidden = 入口不显示（直达仍可用）。

export const emptyConfig = () => ({ groups: [], hidden: [] });

/** 从后端 settings 取一份**工作副本**（深拷贝，编辑不污染原数据）。 */
export function configFromSettings(settings) {
  return {
    groups: (settings?.navGroups || []).map((g) => ({ title: String(g.title || ''), sections: [...(g.sections || [])] })),
    hidden: [...(settings?.navHidden || [])],
  };
}

/** 保存时发出去的形状（只带这两个键，其他设置项各自负责）。 */
export function configToPayload(cfg) {
  return { navGroups: cfg.groups.map((g) => ({ title: g.title.trim(), sections: [...g.sections] })), navHidden: [...cfg.hidden] };
}

export const isDirty = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

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
 * 栏目现在在哪个容器里，以及在该容器里的位置（拖拽预览要用它做索引换算）。
 * 平铺区的顺序由栏目自己的 order 决定，没有「位置」可言，index 记为 null。
 */
export function containerOf(cfg, sid) {
  if (cfg.hidden.includes(sid)) return { kind: 'hidden', index: cfg.hidden.indexOf(sid) };
  const gi = cfg.groups.findIndex((g) => g.sections.includes(sid));
  if (gi >= 0) return { kind: 'group', gi, index: cfg.groups[gi].sections.indexOf(sid) };
  return { kind: 'pool', index: null };
}

/**
 * 悬停行索引 → 真正的插入位。
 * 落点语义是「插到悬停行**之前**」，但被拖走的自身会让位：
 * 同容器内往下拖时悬停行索引要减 1，否则实时预览会比实际落点差一格。
 * `hoveredIndex === null` 表示拖在容器空白处 = 追加到末尾，原样返回。
 */
export function insertionIndex(cfg, sid, target, hoveredIndex) {
  if (hoveredIndex === null || hoveredIndex === undefined) return null;
  const from = containerOf(cfg, sid);
  const sameContainer = target.kind === from.kind && (target.kind !== 'group' || target.gi === from.gi);
  if (sameContainer && typeof from.index === 'number' && from.index < hoveredIndex) return hoveredIndex - 1;
  return hoveredIndex;
}

/** 把栏目挪进目标容器（index = 在该容器里的插入位，null = 末尾）。 */
export function moveToContainer(cfg, sid, target, index = null) {
  // 先从所有容器里摘掉（分组 + 隐藏），再放进目标——所以「移动」永远只落一处
  const groups = cfg.groups.map((g) => ({ ...g, sections: g.sections.filter((x) => x !== sid) }));
  const hidden = cfg.hidden.filter((x) => x !== sid);

  if (target.kind === 'hidden') return { groups, hidden: [...hidden, sid] };
  if (target.kind === 'pool') return { groups, hidden };

  const gi = target.gi;
  const cur = groups[gi];
  if (!cur) return cfg;
  const at = index === null ? cur.sections.length : Math.max(0, Math.min(index, cur.sections.length));
  const sections = [...cur.sections.slice(0, at), sid, ...cur.sections.slice(at)];
  return { groups: groups.map((g, i) => (i === gi ? { ...cur, sections } : g)), hidden };
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

/** 没进任何分组的栏目（头部平铺的那些）。 */
export const ungroupedIds = (cfg, allIds) => {
  const grouped = new Set(groupedIds(cfg));
  return allIds.filter((id) => !grouped.has(id));
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
  return problems;
}
