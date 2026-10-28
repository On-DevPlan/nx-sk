import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECTION_VIEW, VIEWS } from './registry.js';
import { Copyable, DialogHost, ErrorBoundary, Toasts } from './components/ui.jsx';
import { useStore } from './store.jsx';
import { normalizeViewId, resolveActiveView } from './activeView.js';
import { groupSectionCount } from './components/navModel.js';

function viewFromHash() {
  const m = /^#\/?([^?/]*)/.exec(window.location.hash || '');
  const id = m ? decodeURIComponent(m[1]) : '';
  return normalizeViewId(id);
}

export default function App() {
  const { boot, bootError, ui, patchUi, reload } = useStore();
  const view = normalizeViewId(ui.view);
  // 展开着哪个分组入口（按下标记）：**同一时刻只开一个**。
  // 交给 App 托管而不是各组件各开各的——否则快速划过两个分组会叠出两个菜单。
  const [openGroup, setOpenGroup] = useState(null);

  // 栏目 tab 是**数据驱动**的（bootstrap.sections）；分组与隐藏来自 settings（设置页可配）；
  // 静态 tab 来自前端注册表。渲染顺序：未分组栏目（按 order）→ 分组（按配置顺序）→ 工具（按 order）。
  const nav = useMemo(() => {    const all = (boot?.sections || []).map((s) => ({
      id: s.id, title: s.title, order: s.order, kind: 'section', count: s.entries,
    }));
    // 隐藏**只隐藏入口**：`#/栏目id` 直达仍然渲染，所以 all 里保留全部栏目
    const hidden = new Set(boot?.settings?.navHidden || []);
    const visible = all.filter((s) => !hidden.has(s.id));

    // 分组是**显示配置**：成员栏目被删掉时优雅降级（过滤掉、配置保留），成员全没了就不显示这个组；
    // 被隐藏的成员在入口里同样不出现
    const groups = (boot?.settings?.navGroups || [])
      .map((g) => ({
        title: g.title,
        sections: (g.sections || [])
          .map((sid) => visible.find((s) => s.id === sid))
          .filter(Boolean),
      }))
      .filter((g) => g.sections.length);
    const grouped = new Set(groups.flatMap((g) => g.sections.map((s) => s.id)));
    // 平铺顺序：settings.navOrder 里显式排过的优先（按它的次序），其余按栏目自己的 order 跟在后面
    const rank = new Map((boot?.settings?.navOrder || []).map((id, i) => [id, i]));
    const rankOf = (s) => (rank.has(s.id) ? rank.get(s.id) : Number.MAX_SAFE_INTEGER);
    const flat = visible.filter((s) => !grouped.has(s.id))
      .sort((a, b) => rankOf(a) - rankOf(b) || (a.order ?? 50) - (b.order ?? 50));
    const stat = VIEWS.filter((v) => v.tab !== false)
      .map((v) => ({ id: v.id, title: v.title, order: v.order, kind: 'view', component: v.component }))
      .filter((v) => !all.some((s) => s.id === v.id))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    const hiddenItems = all.filter((s) => hidden.has(s.id));
    return { flat, groups, tools: stat, all: [...flat, ...groups.flatMap((g) => g.sections), ...stat, ...hiddenItems] };
  }, [boot]);

  // 没 boot 之前**不要**拿第一个 tab 兜底：那时动态栏目还没到，nav 里只有静态视图，
  // 兜底会选中第一个静态视图并由下面的 effect 写进 ui —— 于是「默认视图」被顶掉、
  // 头部高亮也错位，连 `#/job` 这类深链都会被首屏覆盖。
  // 规则本体在 ./activeView.js（纯函数，单测覆盖）：深链 > 本次选择 > 默认栏目 > 第一个 tab。
  const booted = !!boot;
  const current = resolveActiveView(ui.view, nav.all, boot?.settings?.defaultSection, { booted });
  // 高亮/分组展开都按**解析后**的 tab 算：view 可能是空串（没选过）或已失效的 id
  const currentId = current ? current.id : '';

  // hash → ui：挂载时把深链里的选择写回 ui，之后交给 hashchange
  useEffect(() => {
    const fromHash = viewFromHash();
    if (fromHash && fromHash !== view) patchUi({ view: fromHash });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const on = () => { const v = viewFromHash(); if (v) patchUi({ view: v }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [patchUi]);

  // 注意：这里**刻意不**给「兜底选出来的 tab」补一个 hash：
  // 一旦补上（无论是 location.hash 还是 replaceState），下次打开地址栏里就带着它，
  // 于是深链优先 → 设置里的「默认栏目」又变成一个永远不生效的配置。
  // 规则因此是：地址栏里只有**用户真的点过**的栏目；没有就按默认栏目落地。
  const go = (id) => {
    patchUi({ view: id });
    window.location.hash = `#/${id}`;
  };

  // 分组入口的开关（稳定引用：子组件的监听/定时器不会因为父组件重渲染而反复重挂）
  const openGroupAt = useCallback((gi) => setOpenGroup(gi), []);
  // 只关**自己**：A 组的「离开延迟关闭」可能晚于 B 组的展开，不加这个判断会把刚开的 B 关掉
  const closeGroupAt = useCallback((gi) => setOpenGroup((cur) => (cur === gi ? null : cur)), []);

  return (
    <div className="app">
      {/* 身份栏：左边只说「我是谁」，右边才是「存储在哪 / 能做什么」。
          原先 4 段信息（品牌 / 副标题 / 版本 / 存储路径）平铺成一行、字号相近，
          读起来分不出主次；现在按 品牌 ▸ 定位 ▸ 版本 三级收拢，元信息整体右移。 */}
      <header className="top">
        <span className="brand">
          <img src="/logo-rounded.png" alt="" />
          nx-sk
        </span>
        <span className="tagline">本机个人资源管理器</span>
        {boot ? <span className="ver mono">v{boot.app.version}</span> : null}
        <span className="right rowgap">
          {boot ? (
            <span className="store" title={`存储目录：${boot.storePathRaw}`}>
              <span className="store-label">存储</span>
              <Copyable className="mono nowrap" text={boot.storePathRaw}>{boot.storePath}</Copyable>
            </span>
          ) : null}
          <button className="btn small ghost" onClick={() => reload()}>刷新数据</button>
        </span>
      </header>

      {/* 导航栏：内容（栏目）与工具（附件/导出/设置/…）之间加一道细线分组。
          同域栏目可以在**设置页**收拢成一个分组入口（settings.navGroups）——
          悬浮或点击展开上下列表，栏目一多也不会连成一排分不出主次。 */}
      <nav className="tabs">
        {nav.flat.map((t) => (
          <button key={t.id} className={`tab ${t.id === current?.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.title}
            {typeof t.count === 'number' ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
        {nav.groups.map((g, gi) => (
          <GroupTab key={gi} gi={gi} group={g} currentId={currentId}
            open={openGroup === gi} onOpen={openGroupAt} onClose={closeGroupAt} onGo={go} />
        ))}
        {nav.tools.length ? <span className="tabs-sep" aria-hidden /> : null}
        {nav.tools.map((t) => (
          <button key={t.id} className={`tab ${t.id === current?.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.title}
          </button>
        ))}
        {!nav.all.length ? <span className="muted">正在装载…</span> : null}
      </nav>

      <main className="body">
        {bootError ? (
          <div className="pad stack">
            <div className="bad"><strong>读不到后端上下文</strong></div>
            <pre className="block">{bootError}</pre>
            <div className="hint">确认 nx-sk serve 正在运行；或点右上角「刷新数据」重试。</div>
          </div>
        ) : null}
        {!bootError && !booted ? <div className="pad muted">正在装载…</div> : null}
        {!bootError && booted && current ? (
          <ErrorBoundary key={current.id}>
            <Suspense fallback={<div className="pad muted">加载中…</div>}>
              {current.kind === 'section'
                ? <SectionPane sectionId={current.id} />
                : <current.component />}
            </Suspense>
          </ErrorBoundary>
        ) : null}
      </main>

      <Toasts />
      <DialogHost />
    </div>
  );
}

/** 栏目 tab 的动态挂载点：共用 entries 模块的视图，把 sectionId 传进去。 */
function SectionPane({ sectionId }) {
  const View = SECTION_VIEW;
  return <View sectionId={sectionId} />;
}

// 悬浮展开的两个时间常数：
//   OPEN  —— 悬停**意图**：停住才展开。少了这道延迟，鼠标横穿导航栏去点右边的 tab 时，
//            路过的分组会被顺带弹开又收起，一眼看过去就是「乱闪」。
//   CLOSE —— 从 pill 划到菜单行要时间（中间还隔着 4px 空隙），太快就是「刚展开就消失」。
const OPEN_INTENT_MS = 130;
const CLOSE_DELAY_MS = 180;

/**
 * 只有**真能悬浮**的设备才走 hover 这条路。
 * 触屏 tap 会先合成 mouseenter 再发 click：悬停逻辑先把它打开，click 的「切换」
 * 随即又关上——菜单在手机上等于永远出不来。所以按 `(hover: hover)` 分流。
 */
const canHover = () => (typeof window === 'undefined' ? false : window.matchMedia('(hover: hover)').matches);

/**
 * 头部的一个**分组入口**：一个 pill 收拢多个栏目（同域栏目不再挤成一排）。
 * 悬浮展开（带意图延迟）、点击切换（触屏没有 hover，只走这条路）；点行切换栏目。
 *
 * 展开态**由 App 托管**（`open` 受控、同一时刻只开一个）：各开各的会在快速划过时
 * 叠出两个菜单。外点关闭用 `pointerdown`——`click` 与触发按钮自己的 onClick
 * 同阶段冒泡，会「点一下关了又弹开」；不用纯 CSS hover 而用受控状态，
 * 是为了能用键盘 Esc 关、也为了「只开一个」这条约束。
 */
function GroupTab({ group, gi, currentId, open, onOpen, onClose, onGo }) {
  const ref = useRef(null);
  const intentTimer = useRef(null); // 悬停意图：还没到点就离开 → 撤销
  const closeTimer = useRef(null); // 离开后的宽限期：划进菜单就撤销
  const active = group.sections.some((s) => s.id === currentId);
  // 角标是**栏目数**，不是条目数之和 —— 组是容器，不是「一条栏目」；展开后每行有自己的条目数
  const sectionCount = groupSectionCount(group);

  const drop = (t) => { if (t.current) { clearTimeout(t.current); t.current = null; } };
  const openNow = () => { drop(intentTimer); drop(closeTimer); onOpen(gi); };
  const closeNow = () => { drop(intentTimer); drop(closeTimer); onClose(gi); };

  const onEnter = () => {
    if (!canHover()) return;
    drop(closeTimer); // 从菜单划回 pill：本来要关，撤销
    if (open) return;
    drop(intentTimer);
    intentTimer.current = setTimeout(() => { intentTimer.current = null; onOpen(gi); }, OPEN_INTENT_MS);
  };
  const onLeave = () => {
    if (!canHover()) return;
    drop(intentTimer); // 只是路过，别开
    drop(closeTimer);
    closeTimer.current = setTimeout(() => { closeTimer.current = null; onClose(gi); }, CLOSE_DELAY_MS);
  };

  useEffect(() => () => {
    if (intentTimer.current) clearTimeout(intentTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // 已经开着（点开 / 别的组让位 / 换了栏目）→ 清掉还没生效的意图
  useEffect(() => {
    if (open && intentTimer.current) { clearTimeout(intentTimer.current); intentTimer.current = null; }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(gi); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(gi); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, gi, onClose]);

  return (
    <span
      className="tab-group"
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        className={`tab ${active ? 'active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? closeNow() : openNow())}
        title={`${group.title}：${sectionCount} 个栏目`}
      >
        {group.title}
        <span className="count">{sectionCount}</span>
        <span className="caret" aria-hidden />
      </button>
      {open ? (
        <div className="tab-menu" role="menu">
          {group.sections.map((s) => (
            <button
              key={s.id}
              role="menuitem"
              className={`tab-menu-row ${s.id === currentId ? 'current' : ''}`}
              onClick={() => { closeNow(); onGo(s.id); }}
            >
              <span className="grow nowrap">{s.title}</span>
              {typeof s.count === 'number' ? <span className="count">{s.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
