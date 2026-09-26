import { Suspense, useEffect, useMemo } from 'react';
import { SECTION_VIEW, VIEWS } from './registry.js';
import { Copyable, DialogHost, ErrorBoundary, Toasts } from './components/ui.jsx';
import { useStore } from './store.jsx';

function viewFromHash() {
  const m = /^#\/?([^?/]*)/.exec(window.location.hash || '');
  return m ? decodeURIComponent(m[1]) : '';
}

export default function App() {
  const { boot, bootError, ui, patchUi, reload } = useStore();

  // 栏目 tab 是**数据驱动**的（来自 bootstrap.sections），静态 tab 来自前端注册表。
  // 两者的 id 可能撞车时静态 tab 不参与第一优先级的排序——栏目 order 是 10/20，静态是 500+。
  const tabs = useMemo(() => {
    const dyn = (boot?.sections || []).map((s) => ({
      id: s.id, title: s.title, order: s.order, kind: 'section', count: s.entries,
    }));
    const stat = VIEWS.filter((v) => v.tab !== false).map((v) => ({
      id: v.id, title: v.title, order: v.order, kind: 'view', component: v.component,
    }));
    const seen = new Set();
    return [...dyn, ...stat]
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }, [boot]);

  const current = tabs.find((t) => t.id === ui.view) || tabs[0] || null;

  // hash 与 localStorage 双写对齐：只在挂载时对齐一次，之后交给 hashchange
  useEffect(() => {
    const fromHash = viewFromHash();
    if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
    else if (!window.location.hash) window.location.hash = `#/${ui.view}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const on = () => { const v = viewFromHash(); if (v) patchUi({ view: v }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [patchUi]);

  useEffect(() => {
    if (current && current.id !== ui.view) patchUi({ view: current.id });
  }, [current, ui.view, patchUi]);

  const go = (id) => {
    patchUi({ view: id });
    window.location.hash = `#/${id}`;
  };

  return (
    <div className="app">
      <header className="top">
        <span className="brand"><img src="/logo-rounded.png" alt="" />nx-sk</span>
        <span className="meta">本机个人资源管理器{boot ? ` · v${boot.app.version}` : ''}</span>
        {boot ? (
          <span className="meta">
            存储 <Copyable className="mono" text={boot.storePathRaw}>{boot.storePath}</Copyable>
          </span>
        ) : null}
        <span className="right rowgap">
          <button className="btn small ghost" onClick={() => reload()}>刷新数据</button>
        </span>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${t.id === current?.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.title}
            {typeof t.count === 'number' ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
        {!tabs.length ? <span className="meta">正在装载…</span> : null}
      </nav>

      <main className="body">
        {bootError ? (
          <div className="pad stack">
            <div className="bad"><strong>读不到后端上下文</strong></div>
            <pre className="block">{bootError}</pre>
            <div className="hint">确认 nx-sk serve 正在运行；或点右上角「刷新数据」重试。</div>
          </div>
        ) : null}
        {!bootError && current ? (
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
