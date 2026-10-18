import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { SECTION_VIEW, VIEWS } from './registry.js';
import { Copyable, DialogHost, ErrorBoundary, Toasts } from './components/ui.jsx';
import { useStore } from './store.jsx';
import { normalizeViewId, resolveActiveView } from './activeView.js';

function viewFromHash() {
  const m = /^#\/?([^?/]*)/.exec(window.location.hash || '');
  const id = m ? decodeURIComponent(m[1]) : '';
  return normalizeViewId(id);
}

export default function App() {
  const { boot, bootError, ui, patchUi, reload } = useStore();
  const view = normalizeViewId(ui.view);

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
        {nav.groups.map((g) => (
          <GroupTab key={g.title} group={g} currentId={currentId} onGo={go} />
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

/**
 * 头部的一个**分组入口**：一个 pill 收拢多个栏目（同域栏目不再挤成一排）。
 * 悬浮展开、点击也能开（触屏没有 hover）；点行切换栏目。
 * 外点关闭用 `pointerdown`——`click` 与触发按钮自己的 onClick 同阶段冒泡，
 * 会「点一下关了又弹开」；受控组件而非纯 CSS hover，是为了能用键盘 Esc 关。
 */
function GroupTab({ group, currentId, onGo }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  // 离开时**延迟**再关：鼠标斜着从 pill 划到菜单行会短暂出界，立刻关就「刚展开就消失」
  const closeTimer = useRef(null);
  const active = group.sections.some((s) => s.id === currentId);
  const total = group.sections.reduce((n, s) => n + (s.count || 0), 0);

  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const openNow = () => { cancelClose(); setOpen(true); };
  const closeSoon = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 140); };
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span
      className="tab-group"
      ref={ref}
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
    >
      <button className={`tab ${active ? 'active' : ''}`} aria-expanded={open} onClick={openNow}>
        {group.title}
        <span className="count">{total}</span>
        <span className="caret" aria-hidden />
      </button>
      {open ? (
        <div className="tab-menu" role="menu">
          {group.sections.map((s) => (
            <button
              key={s.id}
              role="menuitem"
              className={`tab-menu-row ${s.id === currentId ? 'current' : ''}`}
              onClick={() => { cancelClose(); setOpen(false); onGo(s.id); }}
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
