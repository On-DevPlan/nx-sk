import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import type { ThemeConfig } from 'antd';
import { Breadcrumb } from 'antd';
import { MenuUnfoldOutlined, ReloadOutlined } from '@ant-design/icons';
import { SECTION_VIEW, VIEWS } from './registry.ts';
import type { ViewProps } from './registry.ts';
import { ErrorBoundary, Toasts, DialogHost } from './components/ui.tsx';
import { useStore, REFRESH_EVENT } from './store.tsx';
import { api } from './api/client.ts';
import { normalizeViewId, resolveActiveView } from './activeView.ts';
import AppSidebar from './components/appSidebar.tsx';
import NewEntryModal from './components/NewEntryModal.tsx';
import type { NewEntryForm } from './components/NewEntryModal.tsx';
import { BLANK_TEMPLATE_ID } from '../../shared/tree.ts';

/**
 * `#/<条目模板>` 或 `#/<条目模板>?entry=<id>`。
 * entry 是 #6 补的深链：侧栏条目与 peek 菜单的「新标签页」打开 `#/条目模板?entry=id`，
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
    const saved = localStorage.getItem(SB_COLLAPSED_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch { /* 隐私模式 */ }
  // 从没选过时，窄屏默认收起：264px 侧栏会把正文挤成一条。
  try {
    return window.matchMedia('(max-width: 760px)').matches;
  } catch {
    return false;
  }
}

/** antd 主题对齐面板口径：文字用墨色，主色用柔和蓝（全站禁止黑色色块），
 * Tooltip 也改白底浅影，避免 antd 默认的黑底提示。 */
const ANTD_THEME: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb',
    colorInfo: '#2563eb',
    colorText: '#14161a',
    colorTextSecondary: '#7d7a75',
    borderRadius: 6,
    fontSize: 13,
    controlHeight: 28,
    colorBorder: 'rgba(55, 53, 47, .16)',
    colorBorderSecondary: 'rgba(55, 53, 47, .09)',
    colorBgContainer: '#ffffff',
    colorBgSpotlight: '#ffffff',
    colorTextLightSolid: '#14161a',
  },
  components: {
    Tooltip: {
      colorBgSpotlight: '#ffffff',
      colorTextLightSolid: '#14161a',
      boxShadowSecondary: '0 6px 24px rgba(20, 22, 26, .12), 0 1px 2px rgba(20, 22, 26, .06)',
    },
  },
};

/** 当前视图解析结果的最小形状（条目模板带条目数，工具页带懒加载组件）。 */
interface CurrentView {
  id: string;
  [k: string]: unknown;
  title: string;
  kind: 'template' | 'view';
  count?: number;
  component?: LazyExoticComponent<ComponentType<ViewProps>>;
}

export default function App() {
  const { boot, bootError, ui, patchUi, reload, toast } = useStore();
  // 侧栏收起：Notion 的面板开关——收起后内容区独占，面包屑左侧的开关负责展开
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // 新建条目表单：父级只决定目录位置，模板选择在弹窗里独立决定。
  const [createForm, setCreateForm] = useState<NewEntryForm | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SB_COLLAPSED_KEY, next ? '1' : '0');
      } catch { /* 隐私模式 */ }
      return next;
    });
  }, []);

  // 导航是**数据驱动**的：0.43 起左侧只有条目树（bootstrap.tree）；
  // 条目模板只留在直达 / 模板库入口里，不再出现在左侧。
  const nav = useMemo(() => {
    const templates = (boot?.templates || []).map((s) => ({
      id: s.id, title: s.title, order: s.order, count: s.entries, kind: 'template' as const, blank: s.blank === true,
    }));
    const hidden = new Set(boot?.settings?.navHidden || []);
    const visible = templates.filter((s) => !hidden.has(s.id) && !s.blank);
    const tools = VIEWS.filter((v) => v.tab !== false)
      .map((v) => ({ id: v.id, title: v.title, order: v.order, kind: 'view' as const, component: v.component }))
      .filter((v) => !templates.some((s) => s.id === v.id))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    // 直达用：条目模板（含隐藏/空白）也要能 resolve 出视图；它们不出现在左侧树里。
    const all: CurrentView[] = [...visible, ...tools, ...templates.filter((s) => hidden.has(s.id) || s.blank)];
    return { tools, all };
  }, [boot]);
  // 没 boot 之前**不要**拿第一个 tab 兜底：那时动态条目模板还没到，nav 里只有静态视图，
  // 兜底会选中第一个静态视图并由下面的 effect 写进 ui —— 于是「默认视图」被顶掉。
  // 规则本体在 ./activeView.js（纯函数，单测覆盖）：深链 > 本次选择 > 默认条目模板 > 第一个 tab。
  const booted = !!boot;
  const current = resolveActiveView(ui.view, nav.all, boot?.settings?.defaultTemplate, { booted });
  const currentId = current ? current.id : '';

  // hash → ui：挂载时把深链里的选择（条目模板 + 条目）写回 ui，之后交给 hashchange。
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
  // 地址栏里只有**用户真的点过**的条目模板；没有就按默认条目模板落地。
  const go = useCallback((id: string) => {
    patchUi({ view: id });
    window.location.hash = `#/${id}`;
  }, [patchUi]);

  // 任务 #30：「刷新数据」只留这一个入口——先重拉 bootstrap（侧栏计数 / 设置），
  // 再广播一次让当前页把自己那份数据也重拉（条目模板页订阅 REFRESH 事件刷新 dump）。
  const refreshAll = useCallback(() => {
    void reload();
    window.dispatchEvent(new Event(REFRESH_EVENT));
  }, [reload]);

  // 当前条目的祖先链（面包屑用）；数据直接来自 bootstrap.tree，不再依赖条目模板缓存。
  const tree = useMemo(() => boot?.tree || [], [boot]);
  const createParentTitle = createForm?.parent
    ? tree.find((n) => n.id === createForm.parent)?.title
    : undefined;

  const entryPath = useMemo(() => {
    if (!ui.entry) return [] as Array<{ id: string; title: string; template: string }>;
    const byId = new Map(tree.map((n) => [n.id, n]));
    const out: Array<{ id: string; title: string; template: string }> = [];
    let cur = byId.get(ui.entry);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift({ id: cur.id, title: cur.title, template: cur.template });
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return out;
  }, [tree, ui.entry]);

  // 侧栏树已经承载条目导航：正文不再重复列条目（除非侧栏收起）。
  const listHidden = !collapsed && tree.length > 0;

  const crumbs = useMemo(() => {
    if (!current) return [];
    const isTemplateLike = current.kind === 'template';
    const items: Array<{ key: string; title: ReactNode }> = [];
    if (isTemplateLike) {
      if (entryPath.length) {
        for (const p of entryPath.slice(0, -1)) {
          items.push({
            key: `p:${p.id}`,
            title: (
              <a className="crumb crumb-link" onClick={(e) => { e.preventDefault(); patchUi({ view: p.template, entry: p.id, focus: '' }); window.location.hash = `#/${encodeURIComponent(p.template)}?entry=${encodeURIComponent(p.id)}`; }}>
                {p.title}
              </a>
            ),
          });
        }
        items.push({ key: 'entry', title: <span className="crumb crumb-entry">{entryPath[entryPath.length - 1].title}</span> });
      } else {
        items.push({
          key: 'template',
          title: (
            <a className="crumb crumb-link" onClick={(e) => { e.preventDefault(); go(current.id); }}>
              {current.title}
            </a>
          ),
        });
      }
    } else {
      items.push({ key: 'view', title: <span className="crumb">{current.title}</span> });
    }
    return items;
  }, [current, entryPath, go, patchUi]);

  // 任务 #49：新建条目统一走一个弹窗——父级只决定目录位置，模板选择在创建时机显式决定。
  // 子条目默认空白，不再继承父条目的模板；根条目也默认空白，需要结构时再选模板。
  const openAddEntry = useCallback((parent: string | null, defaultTemplate = BLANK_TEMPLATE_ID) => {
    setCreateForm({ parent, template: defaultTemplate, title: '' });
  }, []);

  const createEntry = useCallback(async () => {
    if (!createForm || createBusy || !createForm.title.trim()) return;
    setCreateBusy(true);
    try {
      const tid = createForm.template || BLANK_TEMPLATE_ID;
      const dump = tid === BLANK_TEMPLATE_ID
        ? null
        : await api<{ template: { title: string; titleLabel?: string; titleField?: string } }>(
          `/api/templates/${encodeURIComponent(tid)}/dump`,
        );
      const sec = dump?.template;
      const name = createForm.title.trim();
      const body: { template?: string; parent?: string; title: string; set?: Record<string, string> } = {
        template: tid, title: name,
      };
      if (createForm.parent) body.parent = createForm.parent;
      if (sec?.titleField) body.set = { [sec.titleField]: name };
      const created = await api<{ id: string; title: string; template: string; parent?: string | null }>('/api/entries', { method: 'POST', body });
      const tplTitle = tid === BLANK_TEMPLATE_ID
        ? '空白条目'
        : (boot?.templates.find((t) => t.id === tid)?.title || created.template);
      setCreateForm(null);
      toast(`已新建：${created.title} · ${tplTitle}`);
      patchUi({ view: created.template, entry: created.id, focus: '' });
      window.location.hash = `#/${encodeURIComponent(created.template)}?entry=${encodeURIComponent(created.id)}`;
      await reload();
    } catch (e) {
      toast((e as Error)?.message || String(e), 'bad');
    } finally {
      setCreateBusy(false);
    }
  }, [boot, createBusy, createForm, patchUi, reload, toast]);

  // Notion 式拖拽落盘：拖进条目 = parent 设成它；拖到行上/下缘 = 同父级的前/后。
  // 后端会把该父级的 sort 重新编号，所以拖动一次就能稳定落到目标位置。
  const moveEntry = useCallback(async (id: string, parent: string | null, before?: string, after?: string) => {
    const body: { parent: string; before?: string; after?: string } = { parent: parent || 'root' };
    if (before) body.before = before;
    if (after) body.after = after;
    await api(`/api/entries/${encodeURIComponent(id)}/move`, { method: 'POST', body });
    await reload();
  }, [reload]);

  return (
    <ConfigProvider theme={ANTD_THEME}>
      <div className={`app ${collapsed ? 'sb-collapsed' : ''}`}>
        {!collapsed ? (
          <AppSidebar
            boot={boot}
            nav={nav}
            currentId={currentId}
            entryId={ui.entry}
            tree={tree}
            onGo={go}
            onAddEntry={openAddEntry}
            onMoveEntry={moveEntry}
            onOpenEntry={(sid, eid, focus) => {
              // #18：focus = 进入条目后要把哪个字段块滚进视口并短暂高亮（侧栏全局搜索用）
              patchUi({ view: sid, entry: eid, focus: focus || '' });
              window.location.hash = eid ? `#/${sid}?entry=${encodeURIComponent(eid)}` : `#/${sid}`;
            }}
          />
        ) : null}

        <div className="main">
          {/* 面包屑栏：替代被删掉的头部——左边是收起开关，中间是「分组 › 条目模板 › 条目」定位，
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
            <button className="btn small ghost" onClick={refreshAll} title="重新拉取全部数据（含当前页）">
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
                  {current.kind === 'template'
                    ? <TemplatePane templateId={current.id} listHidden={listHidden} sidebarCollapsed={collapsed} onCreateEntry={(tid) => openAddEntry(null, tid)} />
                    : <ToolPane view={current} />}
                </Suspense>
              </ErrorBoundary>
            ) : null}
          </main>
        </div>
      </div>

      <NewEntryModal
        form={createForm}
        parentTitle={createParentTitle}
        templates={boot?.templates || []}
        busy={createBusy}
        onChange={setCreateForm}
        onClose={() => { if (!createBusy) setCreateForm(null); }}
        onSubmit={createEntry}
      />
      <Toasts />
      <DialogHost />
    </ConfigProvider>
  );
}

/** 条目模板视图的动态挂载点：共用 entries 模块的视图，把 templateId 传进去。 */
function TemplatePane({ templateId, listHidden, sidebarCollapsed, onCreateEntry }: { templateId: string; listHidden: boolean; sidebarCollapsed: boolean; onCreateEntry: (templateId?: string) => void }) {
  const View = SECTION_VIEW;
  return <View templateId={templateId} listHidden={listHidden} sidebarCollapsed={sidebarCollapsed} onCreateEntry={onCreateEntry} />;
}

/** 工具页的动态挂载点：component 在注册表里必有，这里只为收窄类型。 */
function ToolPane({ view }: { view: CurrentView }) {
  const Component = view.component;
  if (!Component) return null;
  return <Component />;
}

