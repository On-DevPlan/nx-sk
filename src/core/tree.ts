// 条目树（0.43）：folder 不是新实体，是条目的父子关系。
//
// 纪律：
//   - 每个条目恰好一行 folders；根节点 parent_id = NULL。
//   - 同一父级下 sort 唯一即可（移动/新建时取 max+1）。
//   - 任何条目都能有子条目：没有子条目时它就是普通条目，有子条目时它同时是文件夹。
//   - 层级只由 folders 决定；模板不参与导航，也不拥有条目。
import type { Store, StoreEntry } from './store-shape.ts';
import type { TreeNode } from '../shared/tree.ts';

/** 条目 id → 子条目（按 sort）。 */
export function childrenOf(store: Store, parent: string | null): StoreEntry[] {
  return store.entries
    .filter((e) => (e.parent ?? null) === parent)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));
}

/** 从根到某条目的祖先链（不含自身）。父链断掉时停在断点。 */
export function ancestorsOf(store: Store, id: string): StoreEntry[] {
  const out: StoreEntry[] = [];
  const seen = new Set<string>([id]);
  let cur = store.entries.find((e) => e.id === id) || null;
  while (cur && cur.parent) {
    if (seen.has(cur.parent)) break;
    seen.add(cur.parent);
    const p = store.entries.find((e) => e.id === cur!.parent) || null;
    if (!p) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

/** 某条目的全部后代（深度优先，按 sort），含自身由 `withSelf` 决定。 */
export function subtreeOf(store: Store, id: string, withSelf = true): StoreEntry[] {
  const out: StoreEntry[] = [];
  const seen = new Set<string>();
  const walk = (pid: string | null) => {
    for (const c of childrenOf(store, pid)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  const root = store.entries.find((e) => e.id === id);
  if (withSelf && root) {
    seen.add(root.id);
    out.push(root);
  }
  walk(id);
  return out;
}

/** 把 parent 设为 id 会不会成环（parent 是自身或自身后代时为真）。 */
export function wouldCycle(store: Store, id: string, parent: string | null): boolean {
  if (!parent) return false;
  if (parent === id) return true;
  if (!store.entries.some((e) => e.id === parent)) return false;
  return subtreeOf(store, id, false).some((e) => e.id === parent);
}

/** 同父级下一个可用 sort。 */
export function nextSort(store: Store, parent: string | null): number {
  const siblings = childrenOf(store, parent);
  return siblings.length ? (siblings[siblings.length - 1].sort ?? 0) + 1 : 0;
}

/** 左侧目录树：扁平节点列表，按 parent/sort 排好；前端自己折成缩进树。 */
export function buildTree(store: Store): TreeNode[] {
  const byId = new Map(store.entries.map((e) => [e.id, e]));
  const children = new Map<string | null, StoreEntry[]>();
  for (const e of store.entries) {
    const p = e.parent && byId.has(e.parent) && e.parent !== e.id ? e.parent : null;
    const list = children.get(p) || [];
    list.push(e);
    children.set(p, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));
  }
  const out: TreeNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const e of children.get(parent) || []) {
      if (depth > 64) continue;
      const kids = children.get(e.id) || [];
      const tpl = store.templates.find((s) => s.id === e.template);
      out.push({
        id: e.id,
        title: e.title || '（无名）',
        parent,
        sort: e.sort ?? 0,
        template: e.template,
        templateTitle: tpl?.title || e.template,
        tags: e.tags || [],
        childCount: kids.length,
        hasChildren: kids.length > 0,
      });
      walk(e.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
