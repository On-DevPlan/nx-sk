// 字段层级（「组」）的**唯一实现**：组是字段，不是条目模板的第二份结构。
//
// 0.42 起模型变了：
//   · 条目模板只有 `fields[]` 这一种结构，没有 `groups[]`；
//   · 每个字段也不带 `group`；「组」是 type='group' 的一条字段，用 `keys` 引用
//     同条目模板里的其他字段 key（可以是标量字段，也可以嵌套另一个组字段）；
//   · 每个非 group 字段**恰好**归属一个组——这条不变量由 normalizeStructure() 收口，
//     读路径（core/store-shape 的 normalizeTemplate）与写入路径共用同一份实现。
//
// 本文件必须保持**零依赖**：后端（core/fields/*）与面板（components/blockBoard 等）共用，
// 一旦 import 了 fs / node 内置模块，浏览器就打包不出来。这里只有纯函数。

/** 组字段的最小形状（读路径历史上可能出现脏数据，一律按宽松形态收）。 */
export interface GroupLike {
  key: string;
  label?: string;
  type?: string;
  keys?: unknown;
  [k: string]: unknown;
}

/** 归一化出来的结构视图。 */
export interface StructureView {
  /** 组 key → 该组的直接成员 key（顺序即显示顺序，已保证成员存在且不重复）。 */
  groups: Map<string, string[]>;
  /** 字段 key → 所属组 key（只有非 root 的普通字段与嵌套组才有）。 */
  parentOf: Map<string, string>;
  /** 顶层组 key（顺序 = 字段字典里出现的顺序）。 */
  roots: string[];
}

/** 这条定义是不是组字段（判据只此一处）。 */
export function isGroupDef(def: unknown): def is GroupLike & { type: 'group'; keys: string[] } {
  const d = def as GroupLike | null | undefined;
  return !!d && typeof d === 'object' && d.type === 'group';
}

/**
 * 组 key 的可用名字：字段与组共用一个 key 空间（同一张表主键是 (条目模板, key)），
 * 旧数据里「组 id == 成员字段 key」（如 `education` 组里有 `education` 字段）必须改名。
 *
 * 规则：能直接用就用；撞了就加 `Group`（再撞加序号）。`source` → `sourceGroup`
 * 正好与内置资料袋的 key 对齐，迁移后不会多出一条空组。
 */
export function freeGroupKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let cand = `${base}Group`;
  let n = 2;
  while (taken.has(cand)) { cand = `${base}Group${n}`; n += 1; }
  return cand;
}

/** 组字段声明的成员 key（脏数据一律回空数组）。 */
export function groupKeysOf(def: unknown): string[] {
  const keys = (def as GroupLike | null | undefined)?.keys;
  return Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
}

/**
 * 从字段字典推导结构：**假定已规范化**（写入/读路径都过 normalizeStructure）。
 * 面板侧只用来渲染，不做修复；要修复用 normalizeStructure。
 */
export function structureOf(defs: ReadonlyArray<{ key: string; type?: string; keys?: unknown }> | null | undefined): StructureView {
  const groups = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const roots: string[] = [];
  const list = Array.isArray(defs) ? defs : [];
  const leaves = new Set(list.filter((d) => !isGroupDef(d)).map((d) => String(d.key)));
  const groupKeys = new Set(list.filter(isGroupDef).map((d) => String(d.key)));

  for (const def of list) {
    if (!isGroupDef(def)) continue;
    const key = String(def.key);
    const members = groupKeysOf(def).filter((k) => k !== key && (leaves.has(k) || groupKeys.has(k)));
    groups.set(key, members);
    for (const m of members) if (!parentOf.has(m)) parentOf.set(m, key);
  }
  for (const key of groups.keys()) if (!parentOf.has(key)) roots.push(key);
  return { groups, parentOf, roots };
}

/**
 * 修复字段字典的结构不变量，返回**新数组**（不改入参）：
 *
 *  1. key 去重（先出现的赢）；
 *  2. 组声明的成员必须存在、不能是自己；重复归属只留首个（按字段字典顺序从前往后）；
 *  3. 成环的引用剪掉（DFS 时把回边丢弃）；
 *  4. 没有任何组接管的普通字段 → 归到根组 `root`（没有根组就合成一个，放在最前）；
 *  5. 组字段的 `keys` 按修复结果写回（保证存储里只有这一份结构）。
 *
 * `ensureRoot: false` 用于空白模板（`__blank__`）——它只是一个占位，不需要面板分组。
 */
export function normalizeStructure<T extends { key: string; type?: string; keys?: unknown; label?: string }>(
  defs: T[] | null | undefined,
  { ensureRoot = true, rootKey = 'root', rootLabel = '未分组' }: { ensureRoot?: boolean; rootKey?: string; rootLabel?: string } = {},
): T[] {
  const src = Array.isArray(defs) ? defs : [];
  // ── 1. key 去重 ──
  const seen = new Set<string>();
  const out: T[] = [];
  for (const d of src) {
    if (!d || typeof d !== 'object') continue;
    const key = String(d.key ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...d, key });
  }

  const groupDefs = out.filter(isGroupDef);
  const fieldKeys = new Set(out.map((d) => String(d.key)));

  // 组自己的成员里若引用不存在的字段 / 自己 → 剪掉（成环在下面 DFS 时再剪）。
  const rawMembers = new Map<string, string[]>();
  for (const g of groupDefs) {
    const me = String(g.key);
    const list = groupKeysOf(g).filter((k) => k !== me && fieldKeys.has(k));
    rawMembers.set(me, list);
  }

  // ── 2/3. 归属唯一 + 断环（按字段字典顺序先到先得） ──
  // 每个节点至多一个父节点，所以「成环」只可能出现在组链上：从任一节点沿父链上溯，
  // 走回自己就是环——把闭环处那条父边剪掉即可（剪掉的是「后声明的那一层」）。
  const parentOf = new Map<string, string>();
  for (const g of groupDefs) {
    for (const child of rawMembers.get(String(g.key)) || []) {
      if (parentOf.has(child)) continue; // 2. 重复归属只留首个
      parentOf.set(child, String(g.key));
    }
  }
  for (const start of [...parentOf.keys()]) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur != null && !path.includes(cur)) {
      path.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur != null && path.includes(cur)) {
      // path 里 cur 之后的整段是一个环：剪掉「环上最后一个节点 → 它父亲」这条边。
      const cycle = path.slice(path.indexOf(cur));
      const last = cycle[cycle.length - 1];
      parentOf.delete(last);
    }
  }

  // ── 4. 孤儿归根组 ──
  const members = new Map<string, string[]>(groupDefs.map((g) => [String(g.key), [] as string[]]));
  const roots = [...members.keys()].filter((k) => !parentOf.has(k));
  let rootKeyFinal = rootKey;
  const orphanFields = out.filter((d) => !parentOf.has(String(d.key)) && !isGroupDef(d)).map((d) => String(d.key));
  if (ensureRoot && orphanFields.length) {
    if (roots.includes(rootKey)) {
      rootKeyFinal = rootKey;
    } else {
      // 没有可用的根组（或 root 已被当成别的字段 key）：合成一个，放在字典最前。
      let n = 2;
      rootKeyFinal = rootKey;
      while (fieldKeys.has(rootKeyFinal)) {
        rootKeyFinal = `${rootKey}${n}`;
        n += 1;
      }
      out.unshift({ key: rootKeyFinal, label: rootLabel, type: 'group', keys: [] } as unknown as T);
      fieldKeys.add(rootKeyFinal);
      members.set(rootKeyFinal, []);
      roots.unshift(rootKeyFinal);
    }
    for (const k of orphanFields) {
      parentOf.set(k, rootKeyFinal);
      members.get(rootKeyFinal)!.push(k);
    }
  }

  // ── 5. 写回 keys（members 由 parentOf 重建，顺序沿用字段字典顺序） ──
  for (const [child, parent] of parentOf) {
    if (!members.has(parent)) members.set(parent, []);
    if (!members.get(parent)!.includes(child)) members.get(parent)!.push(child);
  }
  return out.map((d) => (isGroupDef(d) ? ({ ...d, keys: members.get(String(d.key)) || [] } as unknown as T) : d));
}

/**
 * 面板/正文板要用的分组清单：顶层组 + 每组的**直接成员定义**（含嵌套组，按 keys 顺序）。
 * 空成员组会被保留（用户刚建的空组要看得见，否则没法往里加字段）。
 */
export function boardGroupsOf<T extends { key: string; type?: string; keys?: unknown; label?: string }>(
  defs: ReadonlyArray<T> | null | undefined,
): Array<{ id: string; title: string; fields: T[] }> {
  const list = Array.isArray(defs) ? defs : [];
  const view = structureOf(list);
  const byKey = new Map(list.map((d) => [String(d.key), d]));
  return view.roots.map((id) => {
    const members = (view.groups.get(id) || []).map((k) => byKey.get(k)!).filter(Boolean);
    return { id, title: String(byKey.get(id)?.label ?? id), fields: members };
  });
}

