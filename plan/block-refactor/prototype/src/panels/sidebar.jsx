/* 侧边栏目录树 —— 栏目的**唯一入口**
 *
 * 这里是 §十三 13.3 的两类拖拽语义落地：
 *   · 拖**栏目节点** = 改显示配置 settings.navTree（重排 / 嵌套成子目录 / 拖进隐藏区）——安全
 *   · 拖**条目节点**到另一个栏目 = 改**数据归属**（`entry update --section`）——危险，必须二次确认
 * 两种语义共用一个 DndContext，但用 data.kind 区分，落到不同的处理分支。
 *
 * R18：树可以是**从老三套推断出来的**（`navGroups`/`navHidden`/`navOrder`），
 * 也可以是用户显式改过的 `navTree`——两种来源都渲染，分组节点（kind:'group'）也支持。
 * 推断是**只读**的：用户第一次动树才落盘（见 shell.jsx 的 navTree 状态）。
 */

import { useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCenter, useDroppable,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApp } from '../appctx.jsx';
import { findNode } from '../navTree.js';
import { Tag } from '../ui.jsx';

/** 找节点在树里的位置：{ parentId, index, list } */
function locate(list, id, parentId = null) {
  const i = list.findIndex((n) => n.id === id);
  if (i >= 0) return { parentId, index: i, list };
  for (const n of list) {
    if (!n.children) continue;
    const r = locate(n.children, id, n.id);
    if (r) return r;
  }
  return null;
}

/** 从列表里摘掉节点（返回节点本身） */
function detach(list, id) {
  const i = list.findIndex((n) => n.id === id);
  if (i >= 0) return list.splice(i, 1)[0];
  for (const n of list) {
    if (!n.children) continue;
    const r = detach(n.children, id);
    if (r) return r;
  }
  return null;
}

function insert(list, parentId, node, index) {
  if (!parentId) {
    if (index < 0 || index > list.length) list.push(node);
    else list.splice(index, 0, node);
    return;
  }
  const parent = findNode(list, parentId);
  if (!parent) return;
  parent.children = parent.children || [];
  if (index < 0 || index > parent.children.length) parent.children.push(node);
  else parent.children.splice(index, 0, node);
}

export default function SidebarPanel() {
  const { navTree, setNavTree, hidden, setHidden, sections, moveEntry, reorderEntries, confirm, treeSource } = useApp();
  const [drag, setDrag] = useState(null);
  const [hint, setHint] = useState(null); // { type, id, mode }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (e) => {
    const d = e.active.data.current;
    setDrag({ kind: d.kind, id: d.id, label: d.label });
  };

  const onDragEnd = async (e) => {
    const d = e.active.data.current;
    const over = e.over;
    setDrag(null);
    setHint(null);
    if (!over) return;

    // —— 拖进隐藏区：栏目从树上摘掉（改显示配置，不动数据）
    if (over.id === 'hidden-zone') {
      if (d.kind !== 'sec') return;
      const next = navTree.map((n) => ({ ...n, children: n.children ? [...n.children] : n.children }));
      detach(next, d.id);
      setNavTree(next);
      setHidden((h) => (h.includes(d.id) ? h : [...h, d.id]));
      return;
    }

    const overData = over.data.current;
    if (!overData) return;

    // —— 条目 → 栏目：改数据归属（危险，二次确认）
    if (d.kind === 'entry' && overData.kind === 'sec' && overData.nodeKind === 'section') {
      const from = d.sectionId;
      if (!from || from === overData.id) return;
      const ok = await confirm({
        title: '改条目归属？',
        body: `把「${d.label}」从「${sections[from]?.title || from}」移到「${sections[overData.id]?.title || overData.id}」——这是写操作，会改数据的归属。`,
      });
      if (ok) moveEntry(d.id, overData.id);
      return;
    }

    // —— 栏目/分组节点 → 节点：重排 / 嵌套（改 settings.navTree）
    if (d.kind === 'sec' && overData.kind === 'sec') {
      if (d.id === overData.id) return;
      const src = locate(navTree, d.id);
      const dst = locate(navTree, overData.id);
      if (!src || !dst) return;

      // 落点语义：靠上 1/4 = 排到它前面，靠下 1/4 = 排到它后面，中间 1/2 = 嵌进去
      const ar = e.active.rect.current.translated;
      const or = over.rect;
      const ratio = or.height ? (ar.top - or.top) / or.height : 0.5;
      const mode = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'nest';

      const next = navTree.map((n) => ({ ...n, children: n.children ? [...n.children] : n.children }));
      const node = detach(next, d.id);
      if (!node) return;
      if (mode === 'nest') {
        insert(next, overData.id, node, -1);
      } else {
        const d2 = locate(next, overData.id);
        if (!d2) return;
        insert(next, d2.parentId, node, mode === 'before' ? d2.index : d2.index + 1);
      }
      setNavTree(next);
      return;
    }

    // —— 条目 → 条目：同栏目内排序
    if (d.kind === 'entry' && overData.kind === 'entry') {
      if (d.id === overData.id) return;
      reorderEntries(d.sectionId, d.id, overData.id);
    }
  };

  const onDragOver = (e) => {
    const over = e.over;
    const d = e.active.data.current;
    if (!over) { setHint(null); return; }
    if (over.id === 'hidden-zone') { setHint({ type: 'hide' }); return; }
    const od = over.data.current;
    if (!od) { setHint(null); return; }
    if (d.kind === 'entry' && od.kind === 'sec' && od.nodeKind === 'section') { setHint({ type: 'move', id: od.id }); return; }
    if (d.kind === 'sec' && od.kind === 'sec') { setHint({ type: 'nest', id: od.id }); return; }
    setHint(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => { setDrag(null); setHint(null); }}
      >
        <div style={{ padding: '6px 6px 10px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          <div className="muted" style={{ padding: '0 6px 4px', fontSize: 11 }}>
            目录树来源：{treeSource === 'inferred' ? '推断（老三套，未写回）' : '显式 navTree'}
          </div>
          <SortableContext items={navTree.map((n) => `node:${n.id}`)} strategy={verticalListSortingStrategy}>
            {navTree.map((n) => (
              <TreeNode key={n.id} node={n} hint={hint} />
            ))}
          </SortableContext>
          {hidden.length ? <HiddenList ids={hidden} /> : null}
        </div>
        <HiddenZone hint={hint} />
        <DragOverlay>
          {drag ? <div style={{ background: 'var(--paper)', border: '1px solid var(--soft-2)', borderRadius: 6, padding: '2px 8px' }}>{drag.label}</div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/** 树节点：栏目节点或分组节点 */
function TreeNode({ node, hint }) {
  if (node.kind === 'group') return <GroupNode node={node} hint={hint} />;
  return <SectionNode node={node} hint={hint} />;
}

/** 分组节点（由老三套的 navGroups 推断而来）：一个目录，里面是栏目 */
function GroupNode({ node, hint }) {
  const { setNavTree } = useApp();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `node:${node.id}`,
    data: { kind: 'sec', id: node.id, nodeKind: 'group', label: node.title },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const toggle = (patch) => {
    const walk = (list) => list.map((n) => (n.id === node.id ? { ...n, ...patch } : { ...n, children: n.children ? walk(n.children) : n.children }));
    setNavTree(walk);
  };

  const nestHint = hint && hint.type === 'nest' && hint.id === node.id;

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className="row"
        {...attributes}
        {...listeners}
        onClick={() => toggle({ expanded: !node.expanded })}
        title="分组（由 navGroups 推断）"
        style={{
          display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 6px',
          cursor: 'grab', whiteSpace: 'nowrap', borderRadius: 6,
          outline: nestHint ? '2px solid var(--mid)' : 'none',
          outlineOffset: '-2px',
          background: nestHint ? 'var(--soft)' : undefined,
        }}
      >
        <span className="muted" style={{ width: 12, fontSize: 10, textAlign: 'center', flexShrink: 0 }}>
          {node.expanded ? '▾' : '▸'}
        </span>
        <span className="muted" style={{ flexShrink: 0 }}>▣</span>
        <span className="nowrap grow" style={{ fontWeight: 600 }}>{node.title}</span>
        <span className="muted" style={{ fontSize: 11 }}>分组</span>
      </div>

      {node.expanded && node.children?.length ? (
        <div style={{ marginLeft: 14, borderLeft: '1px solid var(--soft-2)', paddingLeft: 2 }}>
          <SortableContext items={node.children.map((c) => `node:${c.id}`)} strategy={verticalListSortingStrategy}>
            {node.children.map((c) => (
              <TreeNode key={c.id} node={c} hint={hint} />
            ))}
          </SortableContext>
        </div>
      ) : null}
    </div>
  );
}

/** 栏目节点：可排序（重排 / 嵌套），可展开，可切紧凑形态 */
function SectionNode({ node, hint }) {
  const { sections, navigate, setNavTree } = useApp();
  const sec = sections[node.id];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `node:${node.id}`,
    data: { kind: 'sec', id: node.id, nodeKind: 'section', label: sec?.title || node.id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const toggle = (patch) => {
    // 就地改一个节点的展示属性（显示配置，不是数据）
    const walk = (list) => list.map((n) => (n.id === node.id ? { ...n, ...patch } : { ...n, children: n.children ? walk(n.children) : n.children }));
    setNavTree(walk);
  };

  const nestHint = hint && hint.type === 'nest' && hint.id === node.id;
  const moveHint = hint && hint.type === 'move' && hint.id === node.id;

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className="row"
        {...attributes}
        {...listeners}
        onClick={() => navigate(node.id)}
        title="点击在工作区打开数据库面板（并写深链 #/栏目id）"
        style={{
          display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 6px',
          cursor: 'grab', whiteSpace: 'nowrap', borderRadius: 6,
          outline: nestHint ? '2px solid var(--mid)' : moveHint ? '2px solid var(--danger)' : 'none',
          outlineOffset: '-2px',
          background: nestHint ? 'var(--soft)' : undefined,
        }}
      >
        <span
          className="muted"
          style={{ width: 12, fontSize: 10, textAlign: 'center', flexShrink: 0, cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); toggle({ expanded: !node.expanded }); }}
        >
          {node.expanded ? '▾' : '▸'}
        </span>
        <span className="muted" style={{ flexShrink: 0 }}>▤</span>
        <span className="nowrap grow">
          {sec?.title || node.id}
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button
            title="紧凑数据库形态"
            style={{ height: 20, padding: '0 5px' }}
            onClick={(e) => { e.stopPropagation(); toggle({ compact: !node.compact, expanded: true }); }}
          >
            ▦
          </button>
        </span>
      </div>

      {node.expanded && node.compact && sec ? (
        <div style={{ margin: '2px 0 6px 17px', border: '1px solid var(--soft-2)', borderRadius: 6, overflow: 'hidden' }}>
          <SortableContext items={sec.entries.map((x) => `ent:${x.id}`)} strategy={verticalListSortingStrategy}>
            {sec.entries.map((en) => (
              <EntryRow key={en.id} entry={en} sectionId={node.id} />
            ))}
          </SortableContext>
          {!sec.entries.length ? <div className="muted" style={{ padding: '4px 8px' }}>（空栏目）</div> : null}
        </div>
      ) : null}

      {node.expanded && node.children?.length ? (
        <div style={{ marginLeft: 14, borderLeft: '1px solid var(--soft-2)', paddingLeft: 2 }}>
          <SortableContext items={node.children.map((c) => `node:${c.id}`)} strategy={verticalListSortingStrategy}>
            {node.children.map((c) => (
              <TreeNode key={c.id} node={c} hint={hint} />
            ))}
          </SortableContext>
        </div>
      ) : null}
    </div>
  );
}

/** 条目节点：可排序；点它打开详情面板（不落进侧边栏） */
function EntryRow({ entry, sectionId }) {
  const { navigate } = useApp();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `ent:${entry.id}`,
    data: { kind: 'entry', id: entry.id, sectionId, label: entry.title },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="nowrap"
      {...attributes}
      {...listeners}
      onClick={() => navigate(sectionId, entry.id)}
      title="点击打开详情面板（并写深链 #/栏目id/条目id）"
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 22,
          padding: '0 6px', fontSize: 11, cursor: 'grab',
          borderBottom: '1px solid var(--soft)',
        }}
      >
        <span className="nowrap grow">{entry.title}</span>
        {entry.values?.state ? <Tag>{entry.values.state}</Tag> : null}
      </div>
    </div>
  );
}

/** 隐藏区：拖栏目进来 = 从目录树上摘掉（显示配置，不动数据） */
function HiddenZone({ hint }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'hidden-zone' });
  const active = hint && hint.type === 'hide';
  return (
    <div
      ref={setNodeRef}
      style={{
        margin: '4px 6px 8px', border: `1px dashed ${active ? 'var(--mid)' : 'var(--soft-2)'}`,
        borderRadius: 6, padding: '3px 8px', color: active ? 'var(--ink)' : 'var(--mid)',
        background: isOver ? 'var(--soft)' : undefined, flexShrink: 0,
      }}
    >
      拖到此处隐藏栏目
    </div>
  );
}

/** 已隐藏栏目的回收站：能放回树上 */
function HiddenList({ ids }) {
  const { sections, setHidden, setNavTree } = useApp();
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--soft-2)', paddingTop: 6 }}>
      <div className="muted" style={{ padding: '0 6px' }}>已隐藏</div>
      {ids.map((id) => (
        <div key={id} className="row" style={{ display: 'flex', gap: 6, height: 26, padding: '0 6px' }}>
          <span className="nowrap grow">{sections[id]?.title || id}</span>
          <button
            style={{ height: 20, padding: '0 6px' }}
            onClick={() => {
              setHidden((h) => h.filter((x) => x !== id));
              setNavTree((t) => [...t, { kind: 'section', id, expanded: false, compact: false, children: [] }]);
            }}
          >
            放回
          </button>
        </div>
      ))}
    </div>
  );
}
