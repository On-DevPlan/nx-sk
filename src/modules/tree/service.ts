// 条目树服务（0.43）：读树、移动节点、列出子条目。
//
// 所有「文件夹」语义都落在这里：folder 只是有子条目的条目，没有独立实体。
// 移动是条目级操作，和模板无关——换模板不会改父子关系，删模板也不会。
import { loadStore, mutateStore } from '../../core/store.ts';
import { ancestorsOf, buildTree, childrenOf, nextSort, subtreeOf, wouldCycle } from '../../core/tree.ts';
import { badInput, blocked } from '../../core/errors.ts';
import { resolveEntry } from '../../core/locator.ts';
import { nowIso } from '../../core/ids.ts';

export async function treeView({ parent, depth }: { parent?: string; depth?: number } = {}) {
  const store = await loadStore();
  const nodes = buildTree(store);
  if (parent !== undefined) {
    const p = parent === '' || parent === 'root' ? null : resolveEntry(store, parent).id;
    const visible = new Set<string>();
    const walk = (pid: string | null, d: number) => {
      for (const e of childrenOf(store, pid)) {
        visible.add(e.id);
        if (d > 0) walk(e.id, d - 1);
      }
    };
    walk(p, Number.isFinite(depth) && (depth as number) > 0 ? Math.min(Number(depth), 64) : 64);
    return { count: visible.size, total: nodes.length, nodes: nodes.filter((n) => visible.has(n.id)) };
  }
  return { count: nodes.length, total: nodes.length, nodes };
}

/** 一个条目的直接子条目 + 祖先链（agent 读上下文用）。 */
export async function entryContext(ref: unknown, { template }: { template?: string } = {}) {
  const store = await loadStore();
  const e = resolveEntry(store, ref, template);
  return {
    entry: { id: e.id, title: e.title, template: e.template, parent: e.parent ?? null, sort: e.sort ?? 0 },
    ancestors: ancestorsOf(store, e.id).map((x) => ({ id: x.id, title: x.title })),
    children: childrenOf(store, e.id).map((x) => ({ id: x.id, title: x.title, hasChildren: childrenOf(store, x.id).length > 0 })),
  };
}

/**
 * 移动条目：parent 为目标父条目（null = 根）。会拒绝成环和移到自身子树。
 * `sort` 缺省 = 目标父级末尾；`before` / `after` 是 Notion 式拖拽落点：
 * 把条目插到某个兄弟的前面/后面，并把该父级的 sort 重新编号成 0,10,20…，
 * 避免 mid-point 插入反复拖动后把数字挤成浮点或重复。
 */
export async function moveEntry(ref: unknown, { parent, sort, before, after, template, 'dry-run': dryRun }: {
  parent?: string | null; sort?: number; before?: string; after?: string; template?: string; 'dry-run'?: boolean;
} = {}) {
  if (before && after) throw badInput('before 与 after 只能给一个：告诉我要插到哪个兄弟的前面或后面。');
  const store = await loadStore();
  const target = resolveEntry(store, ref, template);
  const parentGiven = parent !== undefined;
  let pid = parent === null || parent === undefined || parent === '' || parent === 'root'
    ? null : resolveEntry(store, parent).id;
  let anchorId: string | null = null;
  if (before || after) {
    const anchor = resolveEntry(store, before || after);
    anchorId = anchor.id;
    if (parentGiven && (anchor.parent ?? null) !== pid) {
      throw badInput(`落点「${anchor.title}」不在目标父级下——先把 parent 指到同一个父级。`);
    }
    if (!parentGiven) pid = anchor.parent ?? null;
  }
  if (wouldCycle(store, target.id, pid)) throw badInput('不能把条目移到它自己或它的子条目下面——那会成环。');

  const siblings = childrenOf(store, pid).filter((e) => e.id !== target.id);
  let insertAt = siblings.length;
  if (anchorId) {
    const at = siblings.findIndex((e) => e.id === anchorId);
    if (at < 0) throw badInput('落点条目和目标父级对不上，可能刚被移动过；刷新后重试。');
    insertAt = before ? at : at + 1;
  }
  const next = anchorId
    ? insertAt * 10
    : Number.isFinite(sort) ? Number(sort) : nextSort(store, pid);

  if (dryRun) return { status: 'skipped', dryRun: true, wouldMove: { id: target.id, parent: pid, sort: next, before: before || null, after: after || null } };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.parent = pid;
    e.sort = next;
    e.updatedAt = nowIso();
    // 相对落位：整个兄弟序列重新编号，保证「拖到哪就是哪」不受旧 sort 空洞影响。
    if (anchorId) {
      const ordered = childrenOf(s, pid).filter((x) => x.id !== target.id).map((x) => x.id);
      ordered.splice(insertAt, 0, target.id);
      ordered.forEach((id, i) => {
        const row = s.entries.find((x) => x.id === id);
        if (row) row.sort = i * 10;
      });
    }
  });
  return { status: 'ok', moved: { id: target.id, title: target.title, parent: pid, sort: next } };
}

/** 批量把若干条目移到同一父级（面板拖拽多选时用）。 */
export async function moveMany(refs: unknown, { parent, template }: { parent?: string | null; template?: string } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要移动的条目');
  const store = await loadStore();
  const pid = parent === null || parent === undefined || parent === '' || parent === 'root'
    ? null : resolveEntry(store, parent).id;
  const targets = list.map((r) => resolveEntry(store, r, template));
  for (const t of targets) {
    if (wouldCycle(store, t.id, pid)) throw badInput(`条目「${t.title}」不能移到自己或子条目下面。`);
    if (subtreeOf(store, t.id).some((x) => x.id === pid)) throw blocked(`目标父级在「${t.title}」的子树里，会成环。`);
  }
  await mutateStore((s) => {
    let sort = nextSort(s, pid);
    for (const t of targets) {
      const e = s.entries.find((x) => x.id === t.id);
      if (!e) continue;
      e.parent = pid;
      e.sort = sort++;
      e.updatedAt = nowIso();
    }
  });
  return { status: 'ok', moved: targets.map((t) => t.id), parent: pid };
}
