// 条目正文的**块面板**：一个分组 = 一块面板，一个字段 = 面板里的一个块。
//
// 底层用 react-grid-layout（MIT）的 Responsive 网格做「布局引擎」——拖块换位/换列、
// 拖右边缘改宽、按断点折列，都由它算；我们只把一份版式 JSON 喂给它、把回调的新版式交回去。
// **不自己实现碰撞/回弹/折行**：那是这个功能里最容易出错、也最没有复用价值的部分。
//
// 四条刻意的选择（都跟「正文阅读优先」有关）：
//   1. **高度跟着内容走**：块头 + 块体内容量到多少就长到多少（md 正文、附件列表、
//      清单表格都是「内容多高就多高」）。存储的 h 只是**最小高**——版式 JSON 存的是
//      「这个条目模板怎么排」，不是「这一条内容有多高」，后者跟着每条记录变，不该落盘。
//   2. **只能改宽，不能改高**：高度既然由内容决定，再叠一个手动高度就互相打架；
//      拖左右边缘改宽度（单列 → 多列），内容重排后高度自己会跟。
//   3. **整个块头就是拖拽把手**（dragConfig.handle = '.blk-head'）。块头里没有输入框，
//      整条都能按下去；可拖性只靠 cursor:grab 表达（验收反馈：⠿ 图标丑，删）。
//      块体（输入区）仍然不能拖——否则选词会变成搬块。
//   4. **版式与字段值两条保存链**：拖块只写 template.layout（防抖自动存），
//      填字段仍然走「N 处改动 → 保存」。否则拖一下版式会把没填完的值一起提交。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { Responsive } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import {
  BP_COLS, BREAKPOINTS, MARGIN, ROW_HEIGHT,
  defaultLayouts, growHeights, keepMinHeights, repackBlocks, snapItems,
} from '../../../../shared/blockLayout.ts';
import type { BlockLayout, GridItem, GroupLayout } from '../../../../shared/blockLayout.ts';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import { reorderAt } from '../../util/listSort.ts';
import { useListDrag } from '../listDrag/index.tsx';
import { FieldControl, FieldGroup } from '../fieldEditor/index.tsx';

/** 块里要显示的分组 / 字段（来自 template 的 groups + fields）。 */
export interface BoardGroup {
  id: string;
  title: string;
  fields: FieldDef[];
}

/** 表格外的一层上下文，只有 source 控件用到。 */
export type BoardContext = {
  templateTitle?: string;
  entryTitle?: string;
  templateId?: string;
  entryId?: string;
  /** 字段控件要把「这次填写」直接落库时用（目前只有 grill 的确认按钮）。 */
  onCommitField?: (key: string, value: unknown) => Promise<boolean | undefined>;
};

/** 块头「⋯」菜单的动作（任务 #24 的三个 + 任务 #27 的变化历史）。 */
export interface FieldActions {
  /** 查看这个字段：定义 + 当前值 + 定位符（只读）。 */
  view: (key: string, def: FieldDef) => void;
  /** 任务 #27：看这个字段的历史版本并恢复。 */
  history: (key: string, def: FieldDef) => void;
  /** 编辑这个字段的属性（显示名 / 描述）——只作用于本条目。 */
  edit: (key: string, def: FieldDef) => void;
  /** 删除 / 从本条目移除（语义由调用方按 template 判定）。 */
  remove: (key: string, def: FieldDef) => void;
}

interface BlockProps {
  def: FieldDef;
  value: any;
  onPatch: (key: string, value: any) => void;
  ctx: BoardContext;
  onMeasure: (key: string, px: number) => void;
  dragProps: HTMLAttributes<HTMLDivElement>;
  className?: string;
  /** 任务 #24：块头「⋯」菜单（未传则不渲染，其它调用点零影响）。 */
  fieldActions?: FieldActions;
}

/**
 * 块头右上角的「⋯」菜单。
 *
 * 不用 `<details>`（条目模板「更多」那套）：块的根节点是 `overflow: hidden`（高度由网格锁着），
 * 绝对定位的下拉会被裁掉。所以浮层 portal 到 body、fixed 定位，位置按按钮实测。
 * 打开期间：点任意处 / Esc / 滚动 / 改窗口尺寸都关——菜单不该在页面上「漂着」。
 */
function BlockMenu({ def, actions }: { def: FieldDef; actions: FieldActions }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return undefined;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', close);
    };
  }, [at]);

  const toggle = () => {
    if (at) { setAt(null); return; }
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    // 菜单宽 168：右缘对齐按钮；下方放不下就翻到按钮上方
    const left = Math.max(8, Math.min(b.right - 168, window.innerWidth - 176));
    const top = b.bottom + 160 > window.innerHeight ? Math.max(8, b.top - 152) : b.bottom + 4;
    setAt({ x: left, y: top });
  };

  const pick = (fn: () => void) => { setAt(null); fn(); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="blk-menu-btn"
        title="字段操作：查看 / 历史 / 编辑 / 删除"
        aria-label={`字段操作 ${def.label}`}
        aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      >⋯</button>
      {at ? createPortal(
        <div className="blk-menu" style={{ left: at.x, top: at.y }} role="menu" aria-label={`字段操作 ${def.label}`}>
          <button type="button" role="menuitem" onClick={() => pick(() => actions.view(def.key, def))}>查看字段</button>
          <button type="button" role="menuitem" onClick={() => pick(() => actions.history(def.key, def))}>变化历史…</button>
          <button type="button" role="menuitem" onClick={() => pick(() => actions.edit(def.key, def))}>编辑字段属性…</button>
          <button
            type="button"
            role="menuitem"
            className="danger-item"
            onClick={() => pick(() => actions.remove(def.key, def))}
          >{def.template === false ? '删除扩展字段' : '从本条目移除'}</button>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/**
 * 面板里的一块：块头（把手 + 标签 + 字段 key）+ 块体（真正的控件）。
 *
 * 尺寸测量就发生在这里：块体里包着的控件是**自然高度**（不设 flex/overflow），
 * ResizeObserver 盯它的盒子——输入多行字、贴图加载完、清单加一行，都会触发重报。
 * 报上去的是「块头 + 块体」需要多少像素，高度换算与是否落盘由面板统一决定。
 */
function Block({ def, value, onPatch, ctx, onMeasure, dragProps, fieldActions, ...rest }: BlockProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    // 网格引擎会把 style / className 注入到这一层的根节点（它 clone 子元素），
    // 所以量高度的目标必须是**块体内部**，而不是被引擎锁死的根节点。
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    let raf = 0;
    let last = 0;
    const report = () => {
      raf = 0;
      const head = body.parentElement?.querySelector('.blk-head');
      const inner = body.firstElementChild;
      const innerH = inner ? inner.getBoundingClientRect().height : 0;
      // 量的是**内容自身**的自然高度。不能直接用 body.scrollHeight：块体被网格撑高后
      // 它也跟着变大，会形成「越量越高」的反馈。取控件高度 + 当前被裁掉的那一点。
      const overflow = Math.max(0, body.scrollHeight - body.clientHeight);
      const contentH = innerH + overflow;
      const need = Math.ceil(((head as HTMLElement | null)?.offsetHeight || 0) + contentH + 8);
      if (Math.abs(need - last) < 2) return; // 抖 1px 不必重排
      last = need;
      onMeasure(def.key, need);
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(report);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(body);
    // 观察内容本身（不是块体）：块体高度被网格锁着，内容变高它不会变，只有内容会
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    schedule();
    // 条目页可能先渲染空控件、随后才填入异步读回的值；首帧量到的 54px 会锁在网格里，
    // 而 body 自身高度不变、ResizeObserver 不会再报。补一次延迟量，防止「首帧量矮」。
    const settle = setTimeout(schedule, 220);
    return () => { if (raf) cancelAnimationFrame(raf); clearTimeout(settle); ro.disconnect(); };
  }, [def.key, onMeasure]);

  return (
    <div {...rest} className={`blk ${rest.className || ''}`} data-block={def.key}>
      {/* 块头整条都是把手：鼠标落在「公司名称」这行任意位置就能拖 */}
      <div
        className="blk-head"
        {...dragProps}
        // 任务 #20/#24：从块头按钮起拖不算拖块（与 panel-head 对按钮的同一守卫口径）
        onDragStart={(e) => {
          if ((e.target as HTMLElement).closest('button')) { e.preventDefault(); return; }
          dragProps.onDragStart?.(e);
        }}
        title="按住这一行拖动：插到别的块上方 / 下方"
      >
        <span className="blk-label nowrap" title={`${def.label}（${def.key}）`}>{def.label}</span>
        {def.sensitive ? <span className="tag bad">密文</span> : null}
        {def.fill && def.fill !== 'normal' ? <span className="tag">{def.fillLabel || def.fill}</span> : null}
        {def.hint ? <span className="blk-hint" title={def.hint}>{def.hint}</span> : null}
        <span className="blk-key mono nowrap">{def.key}</span>
        {fieldActions ? <BlockMenu def={def} actions={fieldActions} /> : null}
      </div>
      <div className="blk-body" ref={bodyRef}>
        <FieldControl def={def} value={value} onChange={(v) => onPatch(def.key, v)} ctx={ctx} />
      </div>
    </div>
  );
}

type PanelDrag = ReturnType<typeof useListDrag>;

interface PanelProps {
  group: BoardGroup;
  layoutGroup?: GroupLayout;
  index: number;
  drag: PanelDrag;
  draft: Record<string, unknown>;
  onPatch: (key: string, value: any) => void;
  ctx: BoardContext;
  onLayouts: (gid: string, layouts: Record<string, GridItem[]>) => void;
  onCollapse: (gid: string, collapsed: boolean) => void;
  onReset: (gid: string) => void;
  /** 任务 #24：块头「⋯」菜单，原样透传给每个 Block。 */
  fieldActions?: FieldActions;
}

/**
 * 面板正文的实测宽度。
 *
 * 不用 react-grid-layout 的 `useContainerWidth`：它用普通 ref + 一次性 effect 观察
 * 挂载当时那个节点，节点被卸载重挂（折叠再展开）或容器晚一步才拿到真实宽度时，
 * 都不会重新量 —— 网格就按旧宽度排版，块被压成窄条、看上去内容消失了（#40）。
 * 这里用 callback ref：节点一被挂上来就量一次并观察它，卸载时断开。
 */
function useBodyWidth() {
  const [width, setWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!node) return;
    const measure = () => {
      const cs = getComputedStyle(node);
      const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
      const next = Math.round(Math.max(0, node.clientWidth - pad));
      setWidth((prev) => (prev === next ? prev : next));
    };
    measure();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(node);
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  return { width, containerRef, mounted: width > 0 };
}

/**
 * 一块面板（= 一个分组）的正文：测量 + 网格 + 块。
 * 只在这一组展开时挂载，所以每次展开都会重新量一次宽度。
 */
function PanelGrid({ group, layoutGroup, draft, onPatch, ctx, onLayouts, fieldActions }: {
  group: BoardGroup;
  layoutGroup?: GroupLayout;
  draft: Record<string, unknown>;
  onPatch: (key: string, value: any) => void;
  ctx: BoardContext;
  onLayouts: (gid: string, layouts: Record<string, GridItem[]>) => void;
  fieldActions?: FieldActions;
}) {
  const { width, containerRef, mounted } = useBodyWidth();
  const layouts = useMemo<Record<string, GridItem[]>>(() => layoutGroup?.layouts || {}, [layoutGroup]);
  const [bp, setBp] = useState('lg');
  const [measured, setMeasured] = useState<Record<string, number>>({}); // 字段 key → 内容需要的像素高

  // 量到的高度影响**所有断点**：Responsive 回调的当前断点可能晚一拍，
  // 只改 state 里的 bp 会让正在显示的 md 布局仍用旧高度（内容被裁 8px）。
  const effective = useMemo(() => {
    const out: Record<string, GridItem[]> = {};
    for (const [key, items] of Object.entries(layouts)) out[key] = growHeights(items, measured);
    return out;
  }, [layouts, measured]);

  const onMeasure = useCallback((key: string, px: number) => {
    setMeasured((prev) => (prev[key] === px ? prev : { ...prev, [key]: px }));
  }, []);

  /**
   * 落定一份版式（**只在用户真的改过之后**调用）。
   *
   * 刻意不挂 in `onLayoutChange`：引擎在挂载、断点切换、内容变高时都会回调，
   * 那些是「视图在跟着内容调整」，不是「用户改了版式」——跟着存就会把
   * 「打开过一次页面」也写成一次版式改动，还会把当时的最小高冻结下来。
   */
  const commit = useCallback((layout: readonly GridItem[]) => {
    const items = [...layout];
    const stripped = keepMinHeights(items, layouts[bp] || []);
    const snapped = snapItems(stripped, BP_COLS[bp] || BP_COLS.lg);
    onLayouts(group.id, { ...layouts, [bp]: snapped });
  }, [bp, group.id, layouts, onLayouts]);

  // —— 块的顺序与「插入式」拖拽 ——
  // 不用引擎的自由拖拽：12 列里全宽块只有 x=0 一个落点、半宽块只有两个，
  // 拖起来块只能在「合法格」之间跳，还动不动被纵向压实吸回去（用户反馈：卡手）。
  // 这里改成**拖动只表达顺序**：拖到某块上/下缘就插到那儿，松手按新顺序重新铺格。
  // 宽度仍然是独立的自由度（拖左右边缘），所以「单列变多列」照样成立。
  const order = useMemo(() => {
    const keys = group.fields.map((f) => f.key);
    const seen = [...(layouts[bp] || [])]
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .map((it) => it.i)
      .filter((k) => keys.includes(k));
    for (const k of keys) if (!seen.includes(k)) seen.push(k);
    return seen;
  }, [group.fields, layouts, bp]);

  const fieldDrag = useListDrag((from, insertAt) => {
    const next = reorderAt(order, from, insertAt);
    if (next === order) return;
    const byKey = new Map<string, GridItem>((layouts[bp] || []).map((it) => [it.i, it] as [string, GridItem]));
    const repacked = repackBlocks(next.map((k) => byKey.get(k) || { i: k }), BP_COLS[bp] || BP_COLS.lg);
    onLayouts(group.id, { ...layouts, [bp]: repacked });
  });

  const fieldsInOrder = order
    .map((k) => group.fields.find((f) => f.key === k))
    .filter((f): f is FieldDef => Boolean(f));

  return (
    <div className="panel-body" ref={containerRef}>
      {mounted ? (
        <Responsive
          width={width}
          className="blk-grid"
          layouts={effective}
          breakpoints={BREAKPOINTS}
          cols={BP_COLS}
          rowHeight={ROW_HEIGHT}
          margin={MARGIN}
          containerPadding={[0, 0]}
          // 位置由上面的「插入式排序」决定，不让引擎自己搬块；只留左右改宽
          dragConfig={{ enabled: false }}
          resizeConfig={{ enabled: true, handles: ['e', 'w'] }}
          onResizeStop={commit}
          onBreakpointChange={(next) => setBp(next)}
        >
          {fieldsInOrder.map((def, i) => (
            // 注意：直接子元素必须是**原生 div**——网格引擎靠 cloneElement + ref 给子元素
            // 注入定位与尺寸，函数组件接不住 ref（会抛 DraggableCore not mounted）。
            // 块本身放在这层里面；这块 div 同时是「插入式拖拽」的落点判定区。
            <div key={def.key} className={`blk-cell${fieldDrag.draggingIndex === i ? ' dragging' : ''}${fieldDrag.dropClass(i)}`} {...fieldDrag.itemProps(i)}>
              <Block
                def={def}
                value={draft[def.key]}
                onPatch={onPatch}
                ctx={ctx}
                onMeasure={onMeasure}
                dragProps={fieldDrag.dragStartProps(i)}
                fieldActions={fieldActions}
              />
            </div>
          ))}
        </Responsive>
      ) : <div className="hint pad">正在量宽度…</div>}
    </div>
  );
}

/**
 * 一块面板（= 一个分组）：标题行常驻，正文交给 PanelGrid。
 *
 * **为什么正文要单独一个组件**：折叠会卸载 `.panel-body`，而 `useContainerWidth`
 * 的 ResizeObserver 只在组件挂载时观察当时的那个节点。展开后 DOM 是新节点，
 * 却没有任何东西重新观察它 —— 网格一直用折叠前的宽度排版，块被压成窄条，
 * 看起来就是「收起再展开，字段内容不见了」（#40）。
 * 把测量与网格一起放在「只在展开时挂载」的 PanelGrid 里，每次展开都会重新量宽。
 */
function Panel({ group, layoutGroup, index, drag, draft, onPatch, ctx, onLayouts, onCollapse, onReset, fieldActions }: PanelProps) {
  const collapsed = layoutGroup?.collapsed === true;
  return (
    <div
      className={`panel${collapsed ? ' collapsed' : ''}${drag.draggingIndex === index ? ' dragging' : ''}${drag.dropClass(index)}`}
      {...drag.itemProps(index)}
    >
      {/* 面板标题行整条都是抓手（与块头同一套手感）；行内按钮不触发拖动 */}
      <header
        className="panel-head"
        title="按住这一行拖动：换面板顺序"
        draggable
        onDragStart={(e: ReactDragEvent<HTMLElement>) => {
          if ((e.target as HTMLElement).closest('button')) { e.preventDefault(); return; }
          drag.dragStartProps(index).onDragStart(e);
        }}
        onDragEnd={drag.dragStartProps(index).onDragEnd}
      >
        <button type="button" className="panel-toggle" onClick={() => onCollapse(group.id, !collapsed)} title={collapsed ? '展开这一组' : '折叠这一组'}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="panel-title nowrap">{group.title}</span>
        <span className="panel-count">{group.fields.length}</span>
        <span className="right panel-acts">
          <button type="button" className="btn small ghost" onClick={() => onReset(group.id)} title="把这一组的块按字段顺序重排一遍">重排</button>
        </span>
      </header>
      {collapsed ? null : (
        <PanelGrid
          group={group}
          layoutGroup={layoutGroup}
          draft={draft}
          onPatch={onPatch}
          ctx={ctx}
          onLayouts={onLayouts}
          fieldActions={fieldActions}
        />
      )}
    </div>
  );
}

export interface BlockBoardProps {
  groups: BoardGroup[];
  board: BlockLayout;
  onBoard: (next: BlockLayout) => void;
  draft: Record<string, unknown>;
  onPatch: (key: string, value: any) => void;
  templateTitle?: string;
  entryTitle?: string;
  /** 透传给 source / shortcut 的 peek 头部：「新标签页」深链。 */
  templateId?: string;
  entryId?: string;
  /** 字段级直接回写（grill 确认按钮用；不传时控件只能改草稿）。 */
  onCommitField?: (key: string, value: unknown) => Promise<boolean | undefined>;
  /** 任务 #24：块头「⋯」菜单的三个动作（查看 / 编辑 / 删除）。未传则不渲染。 */
  fieldActions?: FieldActions;
}

/**
 * 正文版式：块布局（默认）或表单视图（单列流式）。
 * `board` 是**已经按当前字段对齐过**的版式（shared/blockLayout.ts 的 reconcileLayout），
 * 所以这里可以假定「每个字段在版式里都有一块」。
 */
export default function BlockBoard({
  groups, board, onBoard, draft, onPatch, templateTitle, entryTitle, templateId, entryId, onCommitField, fieldActions,
}: BlockBoardProps) {
  const mode = board?.mode === 'flow' ? 'flow' : 'grid';
  const ctx = useMemo<BoardContext>(
    () => ({ templateTitle, entryTitle, templateId, entryId, onCommitField }),
    [templateTitle, entryTitle, templateId, entryId, onCommitField],
  );

  // 面板顺序以版式为准：新分组（还没进版式）接在后面
  const ordered = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g] as [string, BoardGroup]));
    const list = (board?.panels || [])
      .map((id) => byId.get(id))
      .filter((g): g is BoardGroup => Boolean(g));
    const seen = new Set(list.map((g) => g.id));
    for (const g of groups) if (!seen.has(g.id)) list.push(g);
    return list;
  }, [groups, board?.panels]);

  // 面板顺序本身也是版式的一部分：拖把手调顺序，落盘到 board.panels
  const panelDrag = useListDrag((from, insertAt) => {
    const ids = ordered.map((g) => g.id);
    const next = reorderAt(ids, from, insertAt);
    if (next === ids) return;
    onBoard({ ...board, panels: next });
  });

  const setLayouts = (gid: string, layouts: Record<string, GridItem[]>) => {
    onBoard({ ...board, groups: { ...board.groups, [gid]: { ...board.groups[gid], layouts } } });
  };
  const setCollapsed = (gid: string, collapsed: boolean) => {
    onBoard({ ...board, groups: { ...board.groups, [gid]: { ...board.groups[gid], collapsed } } });
  };
  const resetGroup = (gid: string) => {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    setLayouts(gid, defaultLayouts(g.fields));
  };
  const resetAll = () => {
    const next: BlockLayout = { ...board, panels: groups.map((g) => g.id), groups: {} };
    for (const g of groups) next.groups[g.id] = { collapsed: false, layouts: defaultLayouts(g.fields) };
    onBoard(next);
  };
  const toggleMode = () => onBoard({ ...board, mode: mode === 'grid' ? 'flow' : 'grid' });

  return (
    <div className={`board mode-${mode}`}>
      {/* 提示不常驻：正文优先——操作说明收进「⋯」按钮的悬浮提示，不在页面上占一行 */}
      <div className="board-bar">
        <span className="right rowgap">
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{
              items: [
                ...(mode === 'grid' ? [{ key: 'reset', label: '重置版式（不影响字段值）' }] : []),
                { key: 'mode', label: mode === 'grid' ? '切换为表单视图' : '切换为块布局' },
              ],
              onClick: ({ key }) => {
                if (key === 'reset') resetAll();
                else if (key === 'mode') toggleMode();
              },
            }}
          >
            <button type="button" className="btn small ghost icon-btn" aria-label="更多版式操作" title="拖块头换序（插到块上/下缘）· 拖左右边缘改宽 · 拖面板标题行换面板顺序；版式自动保存，不影响字段值。重置 / 切换块布局与表单视图在这里">
              <MoreOutlined />
            </button>
          </Dropdown>
        </span>
      </div>

      {mode === 'flow' ? groups.map((g) => (
        <FieldGroup
          key={g.id}
          title={g.title}
          fields={g.fields}
          draft={draft}
          onPatch={onPatch}
          templateTitle={templateTitle}
          entryTitle={entryTitle}
          templateId={templateId}
          entryId={entryId}
          onCommitField={onCommitField}
        />
      )) : ordered.map((g, i) => (
        <Panel
          key={g.id}
          group={g}
          index={i}
          layoutGroup={board?.groups?.[g.id]}
          drag={panelDrag}
          draft={draft}
          onPatch={onPatch}
          ctx={ctx}
          onLayouts={setLayouts}
          onCollapse={setCollapsed}
          onReset={resetGroup}
          fieldActions={fieldActions}
        />
      ))}
      {!groups.length ? <div className="hint pad">还没有字段</div> : null}
    </div>
  );
}

