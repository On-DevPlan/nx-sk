import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import type { ThemeConfig } from 'antd';
import { Breadcrumb } from 'antd';
import { MenuUnfoldOutlined, ReloadOutlined } from '@ant-design/icons';
import { SECTION_VIEW, VIEWS } from './registry.ts';
import type { ViewProps } from './registry.ts';
import { ErrorBoundary, Toasts, DialogHost } from './components/ui.tsx';
import { useStore } from './store.tsx';
import { normalizeViewId, resolveActiveView } from './activeView.ts';
import AppSidebar from './components/appSidebar.tsx';
import type { EntryLite } from './components/appSidebar.tsx';

/**
 * `#/<栏目>` 或 `#/<栏目>?entry=<id>`。
 * entry 是 #6 补的深链：侧栏条目与 peek 菜单的「新标签页」打开 `#/栏目?entry=id`，
 * 新标签页里必须直接选中这一条（entries/view 的 load 已经会读 ui.entry）。
 */
function routeFromHash(): { view: string; entry: string } {
  const raw = (window.location.hash || '').replace(/^#/, '');
  const cut = raw.indexOf('?');
  const path = cut >= 0 ? raw.slice(0, cut) : raw;
  const m = /^\/?([^/]*)/.exec(path);
  const id = m ? decodeURIComponent(m[1]) : '';
  let entry = '';
  if (cut >= 0) {
    try {
      entry = new URLSearchParams(raw.slice(cut + 1)).get('entry') || '';
    } catch {
      entry = '';
    }
  }
  return { view: normalizeViewId(id), entry };
}

/** 侧栏收起态的落盘 key：与 store 的 ui 分开——它是纯视觉开关，不参与数据选择。 */
const SB_COLLAPSED_KEY = 'nx-sk-sidebar-collapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SB_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** antd 主题对齐本面板的单色系：主色即墨色，边线用同一套 rgba。 */
const ANTD_THEME: ThemeConfig = {
  token: {
    colorPrimary: '#14161a',
    colorInfo: '#14161a',
    colorText: '#14161a',
    colorTextSecondary: '#8b9096',
    borderRadius: 6,
    fontSize: 13,
    controlHeight: 28,
    colorBorder: 'rgba(20, 22, 26, .14)',
    colorBorderSecondary: 'rgba(20, 22, 26, .085)',
    colorBgContainer: '#fff',
  },
};

/** 当前视图解析结果的最小形状（栏目带条目数，工具页带懒加载组件）。 */
interface CurrentView {
  id: string;
  [k: string]: unknown;
  title: string;
  kind: 'section' | 'view';
  count?: number;
  component?: LazyExoticComponent<ComponentType<ViewProps>>;
}

export default function App() {
  const { boot, bootError, ui, patchUi, reload } = useStore();
  // 侧栏收起：Notion 的面板开关——收起后内容区独占，面包屑左侧的开关负责展开
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SB_COLLAPSED_KEY, next ? '1' : '0');
      } catch { /* 隐私模式 */ }
      return next;
    });
  }, []);

  // 侧栏条目缓存（栏目 id → 条目摘要）。App 持有：侧栏树用它画子节点，
  // 面包屑用它把 ui.entry 翻译成条目标题——一处数据，两处使用。
  const [entryMap, setEntryMap] = useState<Record<string, EntryLite[]>>({});

  // 导航是**数据驱动**的：栏目来自 bootstrap.sections，分组与隐藏来自 settings（设置页可配），
  // 静态工具页来自前端注册表。顺序：未分组栏目（按 order）→ 分组（按配置顺序）→ 工具（按 order）。
  const nav = useMemo(() => {
    const sections = (boot?.sections || []).map((s) => ({
      id: s.id, title: s.title, order: s.order, count: s.entries, kind: 'section' as const,
    }));
    // 隐藏**只隐藏入口**：`#/栏目id` 直达仍然渲染，所以 all 里保留全部栏目
    const hidden = new Set(boot?.settings?.navHidden || []);
    const visible = sections.filter((s) => !hidden.has(s.id));

    // 分组是**显示配置**：成员栏目被删掉时优雅降级（过滤掉、配置保留），成员全没了就不显示这个组
    const groups = (boot?.settings?.navGroups || [])
      .map((g) => ({
        title: g.title,
        sections: (g.sections || [])
          .map((sid) => visible.find((s) => s.id === sid))
          .filter((s): s is NonNullable<typeof s> => Boolean(s)),
      }))
      .filter((g) => g.sections.length);
    const grouped = new Set(groups.flatMap((g) => g.sections.map((s) => s.id)));
    // 平铺顺序：settings.navOrder 里显式排过的优先（按它的次序），其余按栏目自己的 order 跟在后面
    const rank = new Map((boot?.settings?.navOrder || []).map((id, i) => [id, i]));
    const rankOf = (s: { id: string; order?: number }) =>
      rank.has(s.id) ? Number(rank.get(s.id)) : Number.MAX_SAFE_INTEGER;
    const flat = visible.filter((s) => !grouped.has(s.id))
      .sort((a, b) => rankOf(a) - rankOf(b) || (a.order ?? 50) - (b.order ?? 50));
    const tools = VIEWS.filter((v) => v.tab !== false)
      .map((v) => ({ id: v.id, title: v.title, order: v.order, kind: 'view' as const, component: v.component }))
      .filter((v) => !sections.some((s) => s.id === v.id))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    const all: CurrentView[] = [
      ...flat, ...groups.flatMap((g) => g.sections), ...tools,
      ...sections.filter((s) => hidden.has(s.id)),
    ];
    return { flat, groups, tools, all };
  }, [boot]);
  // 没 boot 之前**不要**拿第一个 tab 兜底：那时动态栏目还没到，nav 里只有静态视图，
  // 兜底会选中第一个静态视图并由下面的 effect 写进 ui —— 于是「默认视图」被顶掉。
  // 规则本体在 ./activeView.js（纯函数，单测覆盖）：深链 > 本次选择 > 默认栏目 > 第一个 tab。
  const booted = !!boot;
  const current = resolveActiveView(ui.view, nav.all, boot?.settings?.defaultSection, { booted });
  const currentId = current ? current.id : '';

  // hash → ui：挂载时把深链里的选择（栏目 + 条目）写回 ui，之后交给 hashchange。
  useEffect(() => {
    const from = routeFromHash();
    if (from.view) patchUi({ view: from.view, ...(from.entry ? { entry: from.entry } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const on = () => {
      const from = routeFromHash();
      if (from.view) patchUi({ view: from.view, ...(from.entry ? { entry: from.entry } : {}) });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [patchUi]);

  // 注意：这里**刻意不**给「兜底选出来的 tab」补一个 hash（规则见 activeView 的说明）：
  // 地址栏里只有**用户真的点过**的栏目；没有就按默认栏目落地。
  const go = useCallback((id: string) => {
    patchUi({ view: id });
    window.location.hash = `#/${id}`;
  }, [patchUi]);

  // 当前条目的标题（面包屑第三级用）；侧栏还没加载过这个栏目就没有
  const entryTitle = useMemo(() => {
    if (!ui.entry) return '';
    return entryMap[currentId]?.find((e) => e.id === ui.entry)?.title || '';
  }, [entryMap, currentId, ui.entry]);

  // 当前栏目落在哪个分组里（面包屑第一级）
  const groupName = useMemo(
    () => nav.groups.find((g) => g.sections.some((s) => s.id === currentId))?.title || '',
    [nav.groups, currentId],
  );

  const crumbs = useMemo(() => {
    if (!current) return [];
    const isSectionLike = current.kind === 'section';
    const items: Array<{ key: string; title: ReactNode }> = [];
    if (groupName) items.push({ key: 'group', title: <span className="crumb">{groupName}</span> });
    if (isSectionLike) {
      items.push({
        key: 'section',
        title: (
          <a className="crumb crumb-link" onClick={(e) => { e.preventDefault(); go(current.id); }}>
            {current.title}
          </a>
        ),
      });
      if (entryTitle) items.push({ key: 'entry', title: <span className="crumb crumb-entry">{entryTitle}</span> });
    } else {
      items.push({ key: 'view', title: <span className="crumb">{current.title}</span> });
    }
    return items;
  }, [current, groupName, entryTitle, go]);

  return (
    <ConfigProvider theme={ANTD_THEME}>
      <div className={`app ${collapsed ? 'sb-collapsed' : ''}`}>
        {!collapsed ? (
          <AppSidebar
            boot={boot}
            nav={nav}
            currentId={currentId}
            entryId={ui.entry}
            entryMap={entryMap}
            setEntryMap={setEntryMap}
            onGo={go}
            onOpenEntry={(sid, eid) => {
              patchUi({ view: sid, entry: eid });
              window.location.hash = `#/${sid}?entry=${encodeURIComponent(eid)}`;
            }}
          />
        ) : null}

        <div className="main">
          {/* 面包屑栏：替代被删掉的头部——左边是收起开关，中间是「分组 › 栏目 › 条目」定位，
              右边只留一个刷新。元信息（版本 / 存储路径）已迁到侧栏顶部与底部。 */}
          <div className="crumbs">
            <button
              className="btn small ghost icon-btn"
              onClick={toggleCollapsed}
              title={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            >
              <MenuUnfoldOutlined />
            </button>
            {crumbs.length ? (
              <Breadcrumb items={crumbs} />
            ) : <span className="crumb muted">正在装载…</span>}
            <span className="grow" />
            <button className="btn small ghost" onClick={() => reload()} title="重新拉取全部数据">
              <ReloadOutlined /> 刷新数据
            </button>
          </div>

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
                    : <ToolPane view={current} />}
                </Suspense>
              </ErrorBoundary>
            ) : null}
          </main>
        </div>
      </div>

      <Toasts />
      <DialogHost />
    </ConfigProvider>
  );
}

/** 栏目视图的动态挂载点：共用 entries 模块的视图，把 sectionId 传进去。 */
function SectionPane({ sectionId }: { sectionId: string }) {
  const View = SECTION_VIEW;
  return <View sectionId={sectionId} />;
}

/** 工具页的动态挂载点：component 在注册表里必有，这里只为收窄类型。 */
function ToolPane({ view }: { view: CurrentView }) {
  const Component = view.component;
  if (!Component) return null;
  return <Component />;
}
