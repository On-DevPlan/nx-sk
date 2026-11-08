// 条目正文的**块面板**：一个分组 = 一块面板，一个字段 = 面板里的一个块。
//
// 底层用 react-grid-layout（MIT）的 Responsive 网格做「布局引擎」——拖块换位/换列、
// 拖右边缘改宽、按断点折列，都由它算；我们只把一份版式 JSON 喂给它、把回调的新版式交回去。
// **不自己实现碰撞/回弹/折行**：那是这个功能里最容易出错、也最没有复用价值的部分。
//
// 四条刻意的选择（都跟「正文阅读优先」有关）：
//   1. **高度跟着内容走**：块头 + 块体内容量到多少就长到多少（md 正文、附件列表、
//      清单表格都是「内容多高就多高」）。存储的 h 只是**最小高**——版式 JSON 存的是
//      「这个栏目怎么排」，不是「这一条内容有多高」，后者跟着每条记录变，不该落盘。
//   2. **只能改宽，不能改高**：高度既然由内容决定，再叠一个手动高度就互相打架；
//      拖左右边缘改宽度（单列 → 多列），内容重排后高度自己会跟。
//   3. **整个块头就是拖拽把手**（dragConfig.handle = '.blk-head'）。只有那个 10px 的 ⠿
//      点点可拖太难瞄准了（真实反馈：拖不动）；块头里没有输入框，整条都能按下去。
//      块体（输入区）仍然不能拖——否则选词会变成搬块。
//   4. **版式与字段值两条保存链**：拖块只写 section.layout（防抖自动存），
//      填字段仍然走「N 处改动 → 保存」。否则拖一下版式会把没填完的值一起提交。
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Responsive, useContainerWidth } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import {
  BP_COLS, BREAKPOINTS, MARGIN, ROW_HEIGHT,
  defaultLayouts, growHeights, keepMinHeights, repackBlocks, snapItems,
} from '../../../shared/blockLayout.js';
import { reorderAt } from '../listSort.js';
import { useListDrag } from './listDrag.jsx';
import { FieldControl, FieldGroup } from './fieldEditor.jsx';

/**
 * 面板里的一块：块头（把手 + 标签 + 字段 key）+ 块体（真正的控件）。
 *
 * 尺寸测量就发生在这里：块体里包着的控件是**自然高度**（不设 flex/overflow），
 * ResizeObserver 盯它的盒子——输入多行字、贴图加载完、清单加一行，都会触发重报。
 * 报上去的是「块头 + 块体」需要多少像素，高度换算与是否落盘由面板统一决定。
 */
function Block({ def, value, onPatch, ctx, onMeasure, dragProps, ...rest }) {
  const bodyRef = useRef(null);

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
      // 量的是**内容自身**的自然高度：块体的高度被网格锁着，scrollHeight 在
      // `overflow: visible` 下等于可视高度（量了也白量），只有里面那个控件会按内容长。
      const inner = body.firstElementChild;
      const contentH = inner ? inner.getBoundingClientRect().height : body.scrollHeight;
      const need = Math.ceil((head?.offsetHeight || 0) + contentH + 8);
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
    return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); };
  }, [def.key, onMeasure]);

  return (
    <div {...rest} className={`blk ${rest.className || ''}`} data-block={def.key}>
      {/* 块头整条都是把手：鼠标落在「公司名称」这行任意位置就能拖，不必去戳那个小 ⠿ */}
      <div className="blk-head" {...dragProps} title="按住这一行拖动：插到别的块上方 / 下方">
        <span className="blk-grip" aria-hidden>⠿</span>
        <span className="blk-label nowrap" title={`${def.label}（${def.key}）`}>{def.label}</span>
        {def.sensitive ? <span className="tag bad">密文</span> : null}
        {def.fill && def.fill !== 'normal' ? <span className="tag">{def.fillLabel || def.fill}</span> : null}
        <span className="blk-key mono nowrap">{def.key}</span>
      </div>
      <div className="blk-body" ref={bodyRef}>
        <FieldControl def={def} value={value} onChange={(v) => onPatch(def.key, v)} ctx={ctx} />
      </div>
    </div>
  );
}

/**
 * 一块面板（= 一个分组）。网格宽度由 useContainerWidth 实测（引擎要按像素算位置）；
 * 父容器变宽（拉左栏、窗口缩放）时它自己会重算。
 */
function Panel({ group, layoutGroup, index, drag, draft, onPatch, ctx, onLayouts, onCollapse, onReset }) {
  const { width, containerRef, mounted } = useContainerWidth();
  const layouts = useMemo(() => layoutGroup?.layouts || {}, [layoutGroup]);
  const collapsed = layoutGroup?.collapsed === true;
  const [bp, setBp] = useState('lg');
  const [measured, setMeasured] = useState({}); // 字段 key → 内容需要的像素高

  // 量到的高度只影响**当前断点**：不同断点列宽不同，内容折行后的高度本来就不同。
  const effective = useMemo(() => {
    const items = layouts[bp];
    if (!items) return layouts;
    return { ...layouts, [bp]: growHeights(items, measured) };
  }, [layouts, measured, bp]);

  const onMeasure = useCallback((key, px) => {
    setMeasured((prev) => (prev[key] === px ? prev : { ...prev, [key]: px }));
  }, []);

  /**
   * 落定一份版式（**只在用户真的改过之后**调用）。
   *
   * 刻意不挂 in `onLayoutChange`：引擎在挂载、断点切换、内容变高时都会回调，
   * 那些是「视图在跟着内容调整」，不是「用户改了版式」——跟着存就会把
   * 「打开过一次页面」也写成一次版式改动，还会把当时的最小高冻结下来。
   */
  const commit = useCallback((items) => {
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
    const byKey = new Map((layouts[bp] || []).map((it) => [it.i, it]));
    const repacked = repackBlocks(next.map((k) => byKey.get(k) || { i: k }), BP_COLS[bp] || BP_COLS.lg);
    onLayouts(group.id, { ...layouts, [bp]: repacked });
  });

  const fieldsInOrder = order.map((k) => group.fields.find((f) => f.key === k)).filter(Boolean);

  return (
    <section
      className={`panel${collapsed ? ' collapsed' : ''}${drag.draggingIndex === index ? ' dragging' : ''}${drag.dropClass(index)}`}
      {...drag.itemProps(index)}
    >
      {/* 面板标题行整条都是抓手（与块头同一套手感）；行内按钮不触发拖动 */}
      <header
        className="panel-head"
        title="按住这一行拖动：换面板顺序"
        draggable
        onDragStart={(e) => {
          if (e.target.closest('button')) { e.preventDefault(); return; }
          drag.dragStartProps(index).onDragStart(e);
        }}
        onDragEnd={drag.dragStartProps(index).onDragEnd}
      >
        <span className="panel-grip" aria-hidden>⠿</span>
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
                  />
                </div>
              ))}
            </Responsive>
          ) : <div className="hint pad">正在量宽度…</div>}
        </div>
      )}
    </section>
  );
}

/**
 * 正文版式：块布局（默认）或表单视图（单列流式）。
 * `board` 是**已经按当前字段对齐过**的版式（shared/blockLayout.js 的 reconcileLayout），
 * 所以这里可以假定「每个字段在版式里都有一块」。
 */
export default function BlockBoard({ groups, board, onBoard, draft, onPatch, sectionTitle, entryTitle }) {
  const mode = board?.mode === 'flow' ? 'flow' : 'grid';
  const ctx = useMemo(() => ({ sectionTitle, entryTitle }), [sectionTitle, entryTitle]);

  // 面板顺序以版式为准：新分组（还没进版式）接在后面
  const ordered = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const list = (board?.panels || []).map((id) => byId.get(id)).filter(Boolean);
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

  const setLayouts = (gid, layouts) => {
    onBoard({ ...board, groups: { ...board.groups, [gid]: { ...board.groups[gid], layouts } } });
  };
  const setCollapsed = (gid, collapsed) => {
    onBoard({ ...board, groups: { ...board.groups, [gid]: { ...board.groups[gid], collapsed } } });
  };
  const resetGroup = (gid) => {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    setLayouts(gid, defaultLayouts(g.fields));
  };
  const resetAll = () => {
    const next = { ...board, panels: groups.map((g) => g.id), groups: {} };
    for (const g of groups) next.groups[g.id] = { collapsed: false, layouts: defaultLayouts(g.fields) };
    onBoard(next);
  };
  const toggleMode = () => onBoard({ ...board, mode: mode === 'grid' ? 'flow' : 'grid' });

  return (
    <div className={`board mode-${mode}`}>
      {/* 提示不常驻：正文优先，工具收到一行、文案进 title */}
      <div className="board-bar">
        {mode === 'grid' ? (
          <span className="board-tip nowrap" title="拖块头换顺序（拖到某块的上/下半就插到它前面/后面）；拖块的左右边缘改宽度（单列可变多列）；拖面板标题行换面板顺序。版式自动保存，不影响字段值。">
            拖块头换顺序（插到某块上/下缘）· 拖左右边缘改宽 · 版式自动保存
          </span>
        ) : (
          <span className="board-tip nowrap">按字段顺序单列铺开；切回块布局版式不变。</span>
        )}
        <span className="right rowgap">
          {mode === 'grid' ? (
            <button type="button" className="btn small ghost" onClick={resetAll} title="全部面板回到默认编排（不影响字段值）">重置版式</button>
          ) : null}
          <button type="button" className="btn small ghost" onClick={toggleMode} title="块布局 / 表单视图">
            {mode === 'grid' ? '表单视图' : '块布局'}
          </button>
        </span>
      </div>

      {mode === 'flow' ? groups.map((g) => (
        <FieldGroup
          key={g.id}
          title={g.title}
          fields={g.fields}
          draft={draft}
          onPatch={onPatch}
          sectionTitle={sectionTitle}
          entryTitle={entryTitle}
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
        />
      ))}
      {!groups.length ? <div className="hint pad">这个栏目还没有可显示的字段。</div> : null}
    </div>
  );
}
