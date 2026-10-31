/* 目录面板 —— Notion 式树（S3 触点 3）
 *
 * 三条语义刻意分开（混在一起就会「拖一下改了别的东西」）：
 *   ① 点栏目名 = **在工作区打开该栏目的数据库面板**（导航），不改任何数据；
 *   ② 拖栏目 / 分组 = 改 `settings.navTree`（显示配置，写 store）；
 *   ③ 拖条目到别的栏目 = 改条目归属（写数据，需要二次确认）—— 这一版**不做**：
 *      后端没有 entry move，硬做只能靠「新建 + 删旧」，会把附件与块正文的引用打散。
 *      入口留给后续版本，界面上不画一个拖不动的把手（假交互比没有更糟）。
 *
 * 树来自 `settings.navTree`；没配过就从老三套（navGroups / navHidden / navOrder）
 * **推断**（只读、不写回）。用户第一次拖动 → 把推断结果固化成显式 navTree，
 * 从这一刻起推断让位（「加法不换血」的落点）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { api } from '../api/client.js';
import { useStore } from '../store.jsx';
import { Empty } from './ui.jsx';
import { openPanel, setTabsetAttrs, tabsetOfComponent } from '../workspace.js';
import { findNode, locateNode, moveNode, resolveNavTree } from '../../../shared/navTree.js';

export default function SidebarPanel({ model }) {
  const { boot, ui, patchUi, toast, guard, reload, dialog } = useStore();
  const [treeData, setTreeData] = useState(null); // /api/sections/tree（条目索引）
  const [open, setOpen] = useState(() => new Set()); // 展开的栏目 id
  const [busy, setBusy] = useState(false);

  const loadTree = useCallback(async () => {
    try {
      setTreeData(await api('/api/sections/tree'));
    } catch {
      setTreeData(null); // 条目索引读不出来不该让目录空白：栏目仍然能点开
    }
  }, []);
  useEffect(() => { loadTree(); }, [loadTree, boot]);

  // boot?.sections 每次 render 都是新数组字面量时，下游 useMemo/useCallback 全会失效
  const sections = useMemo(() => (boot && boot.sections) || [], [boot]);
  const nav = useMemo(
    () => resolveNavTree(sections.map((s) => ({ id: s.id, title: s.title, order: s.order })), boot?.settings),
    [sections, boot],
  );
  const tree = nav.tree;
  const hiddenIds = useMemo(() => {
    const known = new Set(sections.map((s) => s.id));
    return (nav.hidden || []).filter((id) => known.has(id));
  }, [nav.hidden, sections]);

  const countOf = useCallback((id) => {
    const s = sections.find((x) => x.id === id);
    return s ? s.entries : null;
  }, [sections]);
  const entryListOf = useCallback((id) => {
    const sec = (treeData?.sections || []).find((s) => s.id === id);
    return sec ? sec.entryList || [] : null;
  }, [treeData]);

  /** 写树：第一次拖动时把**推断结果**整棵固化，之后都听显式的 */
  const saveTree = guard(async (next) => {
    setBusy(true);
    try {
      const body = next.length ? next : [];
      await api('/api/settings', { method: 'PATCH', body: { set: { navTree: body } } });
      await reload();
    } finally {
      setBusy(false);
    }
  });

  /** 打开栏目面板（导航语义，不写数据） */
  const openSection = useCallback((id) => {
    const s = sections.find((x) => x.id === id);
    patchUi({ view: id });
    window.location.hash = `#/${encodeURIComponent(id)}`;
    if (model) openPanel(model, { component: 'database', name: s ? s.title : id, config: { section: id } });
  }, [model, patchUi, sections]);

  /** 打开某条条目（沿用 ui.entry：详情面板按它定位当前条目） */
  const openEntry = useCallback((sectionId, entryId) => {
    const s = sections.find((x) => x.id === sectionId);
    patchUi({ view: sectionId, entry: entryId });
    window.location.hash = `#/${encodeURIComponent(sectionId)}/${encodeURIComponent(entryId)}`;
    if (model) openPanel(model, { component: 'database', name: s ? s.title : sectionId, config: { section: sectionId } });
  }, [model, patchUi, sections]);

  const toggleOpen = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const hideSection = guard(async (id, name) => {
    const ok = await dialog({
      message: `把「${name}」从目录里隐藏？隐藏只是不进目录，地址直达与 CLI 仍然可用（设置 → navHidden 可恢复）。`,
      confirmText: '隐藏',
    });
    if (!ok) return;
    const next = [...new Set([...(boot?.settings?.navHidden || []), id])];
    await api('/api/settings', { method: 'PATCH', body: { set: { navHidden: next } } });
    toast(`已隐藏「${name}」`);
    await reload();
  });

  const unhide = guard(async (id) => {
    const next = (boot?.settings?.navHidden || []).filter((x) => x !== id);
    await api('/api/settings', { method: 'PATCH', body: { set: { navHidden: next } } });
    await reload();
  });

  // —— 拖拽：栏目 / 分组重排与嵌套（写 navTree）——
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const dropTarget = (over, draggedId) => {
    if (!over) return null;
    if (over.kind === 'root') return { parentId: '', index: -1 };
    if (over.id === draggedId) return null;
    const target = findNode(tree, over.id);
    if (!target) return null;
    if (target.kind === 'group') return { parentId: target.id, index: -1 }; // 放进组末尾
    const loc = locateNode(tree, target.id);
    return { parentId: loc && loc.parent ? loc.parent.id : '', index: loc ? loc.index + 1 : -1 };
  };

  const onDragEnd = (ev) => {
    const dragged = ev.active?.data?.current;
    if (!dragged || dragged.kind !== 'nav') return;
    const hit = dropTarget(ev.over?.data?.current, dragged.id);
    if (!hit) return;
    const next = moveNode(tree, dragged.id, hit.parentId, hit.index);
    if (next === tree) return; // 拒绝的情况（自嵌套 / 目标不存在）不写盘、不报错
    saveTree(next);
  };

  // —— 展开收起双态：宽度就是状态 ——
  // 拖窄到阈值以下（树没法用了）→ 自动变一条窄轨；点轨（或头部的「收起」）回**标准宽度**。
  // 两个宽度都是布局 weight：收起 2.5（~40px）、展开 15（~240px）——
  // 布局本身就是持久化（刷新后保持）；想要别的宽度自己拖，拖完自然记住。
  const COLLAPSE_AT = 140;
  const W_COLLAPSED = 2.5;
  const W_EXPANDED = 15;
  const rootRef = useRef(null);
  const [paneW, setPaneW] = useState(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPaneW(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const collapsed = paneW !== null && paneW < COLLAPSE_AT;
  // enableTabStrip 跟着收起/展开一起翻：39px 宽的 tabset 挤不下页签条，
  // 「目」字残片和图标碎片比空白更难看。两个属性都进布局，刷新后保持。
  const setSidebarState = (collapsed) => {
    const tsId = tabsetOfComponent(model, 'sidebar');
    if (tsId) setTabsetAttrs(model, tsId, { weight: collapsed ? W_COLLAPSED : W_EXPANDED, enableTabStrip: !collapsed });
  };
  const collapse = () => setSidebarState(true);
  const expand = () => setSidebarState(false);
  // 拖拽触发的收起/展开也要落到模型（weight + 页签条）——rail 的渲染是 CSS 驱动的，
  // 没有这一步，拖出来的收起态页签条还在。只在**翻转**时生效：挂载即设会把用户拖好的宽度冲掉。
  const prevCollapsed = useRef(null);
  useEffect(() => {
    if (prevCollapsed.current === null) { prevCollapsed.current = collapsed; return; }
    if (prevCollapsed.current === collapsed) return;
    prevCollapsed.current = collapsed;
    setSidebarState(collapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // 两种状态共用一个**稳定宿主**：ResizeObserver 观察它——状态切换会换掉内层 DOM，
  // 但宿主不变，宽度测量不会断（否则收起后再展开，观察不到宽度恢复，会卡死在窄轨）。
  if (!sections.length && !boot && !collapsed) return <div className="pad muted">正在装载…</div>;

  return (
    <div ref={rootRef} className="navtree-host">
      {collapsed ? (
        <div
          className="navtree-rail"
          title="展开目录"
          onClick={expand}
          role="button"
          aria-label="展开目录"
        >
          <span className="rail-btn" aria-hidden>»</span>
          <span className="rail-label">目录</span>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="navtree">
            <div className="navtree-head">
              <span className="muted nowrap grow">{boot?.counts?.sections ?? sections.length} 个栏目</span>
              <button
                type="button"
                className="btn small ghost"
                title="收起目录（收起后点窄条展开）"
                onClick={collapse}
              >«</button>
              <button
                type="button"
                className="btn small ghost"
                title="列表面板（栏目的增删改、拖拽与隐藏都在那里）"
                onClick={() => openSection('sections')}
              >管理</button>
            </div>

            {nav.source === 'inferred' ? (
              <div className="navtree-note hint">
                目录是从旧的导航配置推断的；拖动任意栏目后，它会变成你自己配的树。
              </div>
            ) : null}

            <RootDrop>
              {tree.length ? (
                <NodeList
                  nodes={tree}
                  depth={0}
                  open={open}
                  busy={busy}
                  countOf={countOf}
                  entryListOf={entryListOf}
                  onToggle={toggleOpen}
                  onOpenSection={openSection}
                  onOpenEntry={openEntry}
                  onHide={hideSection}
                  activeView={ui.view}
                  activeEntry={ui.entry}
                />
              ) : <Empty>还没有栏目。用「管理」建一个，或 CLI：nx-sk section add --template job</Empty>}
            </RootDrop>

            {hiddenIds.length ? (
              <div className="navtree-hidden">
                <div className="hint">已隐藏（{hiddenIds.length}）</div>
                {hiddenIds.map((id) => {
                  const s = sections.find((x) => x.id === id);
                  return (
                    <div key={id} className="nrow hidden-row">
                      <span className="nlabel nowrap muted">{s ? s.title : id}</span>
                      <button type="button" className="btn small ghost" onClick={() => unhide(id)}>显示</button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </DndContext>
      )}
    </div>
  );
}

/** 根层落点：把节点拖到空白处 = 移到根层末尾 */
function RootDrop({ children }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'nav-root', data: { kind: 'root' } });
  return <div ref={setNodeRef} className={`navtree-body${isOver ? ' over' : ''}`}>{children}</div>;
}

function NodeList({ nodes, depth, open, busy, countOf, entryListOf, onToggle, onOpenSection, onOpenEntry, onHide, activeView, activeEntry }) {
  return (
    <ul className="nlist" style={depth ? { paddingLeft: 0 } : undefined}>
      {nodes.map((n) => (n.kind === 'group' ? (
        <GroupRow
          key={n.id}
          node={n}
          depth={depth}
          open={open}
          busy={busy}
          countOf={countOf}
          entryListOf={entryListOf}
          onToggle={onToggle}
          onOpenSection={onOpenSection}
          onOpenEntry={onOpenEntry}
          onHide={onHide}
          activeView={activeView}
          activeEntry={activeEntry}
        />
      ) : (
        <SectionRow
          key={n.id}
          node={n}
          depth={depth}
          open={open}
          busy={busy}
          count={countOf(n.id)}
          entries={entryListOf(n.id)}
          onToggle={onToggle}
          onOpenSection={onOpenSection}
          onOpenEntry={onOpenEntry}
          onHide={onHide}
          activeView={activeView}
          activeEntry={activeEntry}
        />
      )))}
    </ul>
  );
}

function GroupRow({ node, depth, open, busy, countOf, entryListOf, onToggle, onOpenSection, onOpenEntry, onHide, activeView, activeEntry }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `nav:${node.id}`,
    data: { kind: 'nav', id: node.id },
    disabled: busy,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: node.id, data: { kind: 'node', id: node.id } });
  const expanded = !!node.expanded;
  const style = { transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined };
  return (
    <li>
      <div
        ref={(el) => { setNodeRef(el); setDropRef(el); }}
        style={style}
        className={`nrow group${isDragging ? ' dragging' : ''}${isOver ? ' over' : ''}`}
        data-depth={depth}
        {...attributes}
        {...listeners}
      >
        <button type="button" className="ntwist" onClick={() => onToggle(node.id)} aria-label={expanded ? '收起' : '展开'}>
          {expanded ? '▾' : '▸'}
        </button>
        <span className="nlabel group-label nowrap">{node.title}</span>
        <span className="ncount muted">{(node.children || []).length}</span>
      </div>
      {expanded ? (
        <div className="nchildren">
          <NodeList
            nodes={node.children || []}
            depth={depth + 1}
            open={open}
            busy={busy}
            countOf={countOf}
            entryListOf={entryListOf}
            onToggle={onToggle}
            onOpenSection={onOpenSection}
            onOpenEntry={onOpenEntry}
            onHide={onHide}
            activeView={activeView}
            activeEntry={activeEntry}
          />
        </div>
      ) : null}
    </li>
  );
}

function SectionRow({ node, depth, open, busy, count, entries, onToggle, onOpenSection, onOpenEntry, onHide, activeView, activeEntry }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `nav:${node.id}`,
    data: { kind: 'nav', id: node.id },
    disabled: busy,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: node.id, data: { kind: 'node', id: node.id } });
  const expanded = open.has(node.id);
  const active = activeView === node.id;
  const style = { transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined };
  const name = node.title || node.id;
  return (
    <li>
      <div
        ref={(el) => { setNodeRef(el); setDropRef(el); }}
        style={style}
        className={`nrow${active ? ' on' : ''}${isDragging ? ' dragging' : ''}${isOver ? ' over' : ''}`}
        data-depth={depth}
        {...attributes}
        {...listeners}
      >
        <button
          type="button"
          className="ntwist"
          onClick={() => onToggle(node.id)}
          aria-label={expanded ? '收起条目' : '展开条目'}
          title="展开 / 收起这个栏目的条目"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="nlabel"
          onClick={() => onOpenSection(node.id)}
          title={`打开「${name}」`}
        >
          <span className="nowrap">{name}</span>
        </button>
        {typeof count === 'number' ? <span className="ncount muted">{count}</span> : null}
        <button
          type="button"
          className="nact"
          onClick={() => onHide(node.id, name)}
          title="从目录隐藏（数据不动）"
          aria-label="隐藏"
        >−</button>
      </div>
      {expanded ? (
        <div className="nchildren entries">
          {entries === null ? <div className="nrow muted hint" data-depth={depth + 1}>正在读条目…</div>
            : entries.length ? entries.map((e) => (
              <div
                key={e.id}
                className={`nrow entry${activeEntry === e.id && active ? ' on' : ''}`}
                data-depth={depth + 1}
              >
                <span className="ntwist" aria-hidden />
                <button type="button" className="nlabel" onClick={() => onOpenEntry(node.id, e.id)} title={`${e.id}　完整度 ${e.ratio}%`}>
                  <span className="nowrap">{e.title || '（无名）'}</span>
                </button>
                <span className="ncount muted">{e.ratio}%</span>
              </div>
            )) : <div className="nrow muted hint" data-depth={depth + 1}>（空栏目）</div>}
        </div>
      ) : null}
    </li>
  );
}
