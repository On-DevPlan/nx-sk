/* 面板壳 —— 顶栏 + FlexLayout 工作区 + 状态条
 *
 * 这一层只做三件事：
 *   1. 把 FlexLayout 的 Layout 摆进应用骨架（顶栏 / 工作区 / 状态条）
 *   2. 顶栏只放**全局动作**（§十五 15.1）——栏目不进顶栏，栏目只从侧边栏进
 *   3. 布局 = 模型（model.toJson()）→ 落 ui.workspace；改布局 = 改模型
 *
 * 撤销/重试用 flexlayout-react 自带的 useUndo：整段拖拽折叠成一步。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultKeyMap, Layout, Model, getNodeContextMenuItems, showPopupMenu, useUndo } from 'flexlayout-react';
import { AppProvider } from './appctx.jsx';
import { PANELS, PANEL_ORDER, factory } from './registry.jsx';
import { Chip, ConfirmHost } from './ui.jsx';
import { syncAllBlocks } from './api/protoApi.js';
import { resolveNavTree } from './navTree.js';
import { findBlock, updateBlock } from './blocks.js';
import { buildHash, resolveDeepLink } from './activeView.js';
import GlobalSearch from './components/globalSearch.jsx';
import { translate } from './i18n.js';
import { AI_PENDING, BLOCKS, FILES, LEGACY_SETTINGS, SECTIONS, countFileRefs } from './data.js';
import {
  applyGlobalAttrs, clearStoredModel, initialLayoutJson, layoutStats, loadModel, openPanel, saveModel,
} from './workspace.js';

const DOCKS = [
  ['center', '中间'],
  ['left', '左'],
  ['right', '右'],
  ['top', '上'],
  ['bottom', '下'],
];

export default function Shell() {
  const { model, setModel, undo, redo, canUndo, canRedo, undoCount, redoCount } = useUndo(() => loadModel());

  const [sections, setSections] = useState(() => cloneSections(SECTIONS));
  // 显示配置：**老 store 只有老三套**（navGroups / navHidden / navOrder），
  // 没有 navTree → 目录树在**读路径**从老三套推断（只读，不写回）。
  // 用户第一次动树（拖拽重排 / 嵌套）→ 才落成显式 navTree（此时推断让位）。
  const [explicitTree, setExplicitTree] = useState(null);
  const [hidden, setHidden] = useState(() => [...(LEGACY_SETTINGS.navHidden || [])]);
  const navState = useMemo(
    () => resolveNavTree(Object.values(sections), {
      navGroups: LEGACY_SETTINGS.navGroups,
      navHidden: hidden,
      navOrder: LEGACY_SETTINGS.navOrder,
      navTree: explicitTree,
    }),
    [sections, hidden, explicitTree],
  );
  const navTree = navState.tree;
  const treeSource = navState.source;
  // 第一次改树：把**推断出来**的树固化成显式 navTree（加法不换血的落点）
  const setNavTree = useCallback((updater) => {
    setExplicitTree(() => {
      const base = explicitTree ?? navState.tree;
      return typeof updater === 'function' ? updater(base) : updater;
    });
  }, [explicitTree, navState.tree]);
  const [masked, setMasked] = useState(true);
  const [pending, setPending] = useState(AI_PENDING);
  const [blocksByEntry, setBlocksByEntry] = useState({ 'e-job-1': BLOCKS.map((b) => ({ ...b })) });
  // 当前打开的详情条目：块级 AI 的作用对象（R14）
  const [activeEntryId, setActiveEntryId] = useState(null);
  // 导航提示（R15）：定位到某个块。**不放进面板 config**——
  // 它是一次性意图，不是面板身份；放进 config 会把时间戳写进布局 JSON。
  const [focusRequest, setFocusRequest] = useState(null);
  const [drawer, setDrawer] = useState(null); // { anchor, dock }
  // 附件库（**库存**；谁引用它由块里的 id 列表算出来）
  const [library, setLibrary] = useState(() => FILES.map((f) => ({ ...f })));
  const [lastDeepLink, setLastDeepLink] = useState('');
  const layoutRef = useRef(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const confirmResolve = useRef(null);

  // —— 布局落盘：模型变了就存（ui.workspace）
  useEffect(() => {
    if (!model) return undefined;
    const listener = { onAfterAction: () => saveModel(model) };
    model.addChangeListener(listener);
    saveModel(model);
    return () => model.removeChangeListener(listener);
  }, [model]);

  // 整份块树同步给原型服务端（服务端是这批数据的 owner）：
  // **批量推，不按条目推**——按条目推的话服务端手上是哪个条目取决于「哪个详情面板
  // 恰好挂载着」，挂载顺序一变，服务端副本就缺块，baseHash 算成 null，
  // 冲突检测形同虚设（R14 实测踩到，见 log.md）。
  useEffect(() => {
    const entriesMeta = {};
    for (const sec of Object.values(sections)) {
      for (const e of sec.entries || []) entriesMeta[e.id] = { title: e.title, section: sec.id };
    }
    syncAllBlocks(blocksByEntry, entriesMeta).catch(() => {});
  }, [blocksByEntry, sections]);

  // —— 深链（§十五 15.1）：`#/栏目id` → 开该栏目的数据库面板；`#/栏目id/条目id` → 再开详情面板
  // 没有深链时**不兜底**：用存下来的工作区布局（老壳的「默认栏目」这一级由布局接手）。
  const applyDeepLink = useCallback((hash) => {
    const target = resolveDeepLink(hash, sections);
    if (!target) return;
    if (target.missing === 'section') {
      setLastDeepLink(`深链指向的栏目「${target.sectionId}」不存在`);
      return;
    }
    openPanel(model, { component: 'database', name: sections[target.sectionId]?.title || target.sectionId, config: { section: target.sectionId } });
    if (target.entryId) {
      // 详情面板的页签名 = **条目的名字**，不是栏目名（两个面板同名会分不清谁是谁）
      const sec = sections[target.sectionId];
      const entry = (sec?.entries || []).find((e) => e.id === target.entryId);
      openPanel(model, { component: 'detail', name: entry?.title || target.entryId, config: { entryId: target.entryId } });
    }
    setLastDeepLink(target.missing === 'entry'
      ? `深链里的条目已不存在，只开了栏目面板（${target.sectionId}）`
      : `已按深链打开：${target.sectionId}${target.entryId ? ` / ${target.entryId}` : ''}`);
  }, [sections, model, openPanel]);

  // 首次加载 + hashchange
  useEffect(() => {
    applyDeepLink(window.location.hash);
    const onHash = () => applyDeepLink(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyDeepLink]);

  /** 写深链（地址栏 = 当前打开的面板） */
  const navigate = useCallback((sectionId, entryId) => {
    const next = buildHash(sectionId, entryId);
    if (window.location.hash === next) {
      // 同一条深链：hashchange 不会触发 → 直接（幂等地）应用一次
      applyDeepLink(next);
      return;
    }
    window.location.hash = next;
  }, [applyDeepLink]);

  const request = useCallback((payload) => {
    setConfirmReq(payload);
    return new Promise((resolve) => { confirmResolve.current = resolve; });
  }, []);

  const resolveConfirm = useCallback((ok) => {
    setConfirmReq(null);
    if (confirmResolve.current) confirmResolve.current(ok);
    confirmResolve.current = null;
  }, []);


  const fileRefs = useMemo(() => countFileRefs(sections, blocksByEntry), [sections, blocksByEntry]);

  // 把 id 挂到某个块上 / 从某个块上摘掉（块是链接的真相）
  const attachToBlock = useCallback((entryId, blockId, ids) => {
    setBlocksByEntry((m) => {
      const cur = m[entryId] || [];
      const b = findBlock(cur, blockId);
      if (!b) return m;
      const nextFiles = [...(b.files || []), ...ids];
      return { ...m, [entryId]: updateBlock(cur, blockId, { files: nextFiles }) };
    });
  }, []);
  const detachFromBlock = useCallback((entryId, blockId, fileId) => {
    setBlocksByEntry((m) => {
      const cur = m[entryId] || [];
      const b = findBlock(cur, blockId);
      if (!b) return m;
      const nextFiles = (b.files || []).filter((x) => x !== fileId);
      return { ...m, [entryId]: updateBlock(cur, blockId, { files: nextFiles }) };
    });
  }, []);


  const api = useMemo(() => ({
    sections,
    navTree,
    setNavTree,
    treeSource,
    legacySettings: LEGACY_SETTINGS,
    hidden,
    setHidden,
    masked,
    setMasked,
    pending,
    setPending,
    model,
    setModel,
    resetLayout: () => {
      clearStoredModel();
      setModel(applyGlobalAttrs(loadModelFrom(initialLayoutJson())));
    },
    navigate,
    lastDeepLink,
    openPanel: (component, config = {}, name) => {
      if (!model) return;
      openPanel(model, { component, name: name || PANELS[component]?.title || component, config });
    },
    moveEntry: (entryId, toSectionId) => {
      setSections((prev) => {
        const next = cloneSections(prev);
        for (const sec of Object.values(next)) {
          const i = (sec.entries || []).findIndex((e) => e.id === entryId);
          if (i >= 0) {
            const [e] = sec.entries.splice(i, 1);
            const dst = next[toSectionId];
            if (dst) dst.entries = [...(dst.entries || []), e];
            break;
          }
        }
        return next;
      });
    },
    reorderEntries: (sectionId, fromId, toId) => {
      setSections((prev) => {
        const next = cloneSections(prev);
        const sec = next[sectionId];
        if (!sec) return next;
        const i = sec.entries.findIndex((e) => e.id === fromId);
        const j = sec.entries.findIndex((e) => e.id === toId);
        if (i < 0 || j < 0) return next;
        const [it] = sec.entries.splice(i, 1);
        sec.entries.splice(j, 0, it);
        return next;
      });
    },
    moveEntryToGroup: (entryId, sectionId, fieldKey, group) => {
      setSections((prev) => {
        const next = cloneSections(prev);
        const sec = next[sectionId];
        const e = (sec?.entries || []).find((x) => x.id === entryId);
        if (!e) return next;
        e.values = { ...(e.values || {}), [fieldKey]: group };
        return next;
      });
    },
    blocksOf: (entryId) => blocksByEntry[entryId] || [],
    activeEntryId,
    setActiveEntryId,
    focusRequest,
    requestFocus: (entryId, blockId) => setFocusRequest({ entryId, blockId, nonce: Date.now() }),
    setBlocksOf: (entryId, next) =>
      setBlocksByEntry((m) => ({ ...m, [entryId]: typeof next === 'function' ? next(m[entryId] || []) : next })),
    confirm: request,
    library,
    fileRefs,
    // 上传 = 先进库，再挂到块上（真实实现走 `file add`）
    uploadFiles: (entryId, blockId, list) => {
      const stamp = Date.now();
      const added = (list || []).map((f, i) => ({
        id: `f_${stamp}_${i}`,
        name: f.name,
        size: `${Math.max(1, Math.round(f.size / 1024))} KB`,
        tags: [],
      }));
      if (!added.length) return;
      setLibrary((prev) => [...prev, ...added]);
      attachToBlock(entryId, blockId, added.map((a) => a.id));
    },
    assignFile: (entryId, blockId, fileId) => attachToBlock(entryId, blockId, [fileId]),
    detachFile: detachFromBlock,
  }), [sections, navTree, hidden, masked, pending, model, blocksByEntry, activeEntryId, focusRequest, treeSource, library, fileRefs, navigate, request, setModel]);
  const stats = model ? layoutStats(model) : { tabsets: 0, tabs: 0 };

  // 右键菜单：**FlexLayout 不自带**——参考实现的 `LayoutController.showContextMenu`
  // 只有在 props.onContextMenu 存在时才做事，否则右键什么都不会发生（实测）。
  // 菜单条目用官方的 `getNodeContextMenuItems`（标签走 i18nTranslator → 中文），
  // 容器用布局根节点（定位才准）。
  const onContextMenu = useCallback((node, event) => {
    if (event && event.preventDefault) event.preventDefault();
    const items = getNodeContextMenuItems(node);
    showPopupMenu({
      anchor: { x: event?.clientX ?? 0, y: event?.clientY ?? 0 },
      container: layoutRef.current?.getRootDiv?.() ?? undefined,
      items,
      onClose: () => {},
    });
  }, []);

  return (
    <AppProvider value={api}>
      <div className="app">
        {/* 顶栏：只有全局动作，**没有栏目 tab**（§十五 15.1） */}
        <header className="top">
          <span className="brand">nx-sk</span>
          <span className="tagline">本机个人资源管理器 · 原型</span>
          <span className="grow" />
          <GlobalSearch />
          <label className="rowgap" style={{ gap: 4 }}>
            <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
            打码
          </label>
          <button
            onClick={(e) => setDrawer({ anchor: e.currentTarget, dock: 'center' })}
            title="打开面板"
          >
            ＋ 面板
          </button>
          <button onClick={undo} disabled={!canUndo} title="撤销">撤销{undoCount ? ` (${undoCount})` : ''}</button>
          <button onClick={redo} disabled={!canRedo} title="重做">重做{redoCount ? ` (${redoCount})` : ''}</button>
          <button
            onClick={() => { if (model) openPanel(model, { component: 'settings', name: '设置', config: {} }); }}
          >
            设置
          </button>
        </header>

        {/* 工作区：FlexLayout */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {model ? (
            <Layout
              ref={layoutRef}
              model={model}
              factory={factory}
              onContextMenu={onContextMenu}
              onAction={(action) => action}
              onModelChange={() => {}}
              i18nTranslator={translate}
              // 键位：默认只有 关闭页签(Ctrl+Delete) / 重命名(F2)；
              // 焦点在面板组之间移动的三条**默认是关的** —— 不开它们，键盘用户进得来出不去（B10）
              keyMap={{
                ...defaultKeyMap,
                focusTabToggle: 'F6',
                focusNextTabset: 'Ctrl+F6',
                focusPreviousTabset: 'Ctrl+Shift+F6',
              }}
            />
          ) : null}
        </div>

        <div className="statusbar">
          <span>工作区：{stats.tabsets} 个面板组 · {stats.tabs} 个面板</span>
          <span className="grow" />
          <span className="mono">ui.workspace → localStorage('nx-sk-ui.workspace')</span>
          <span className="mono">深链 {window.location.hash || '#/'}</span>
          {lastDeepLink ? <span className="muted">{lastDeepLink}</span> : null}
          <span className="muted">拖页签到四边 = 拆分面板</span>
        </div>
      </div>

      {drawer ? (
        <PanelDrawer
          anchor={drawer.anchor}
          dock={drawer.dock}
          onClose={() => setDrawer(null)}
          onPick={(component) => {
            if (model) openPanel(model, { component, name: PANELS[component]?.title || component, config: {}, location: drawer.dock });
            setDrawer(null);
          }}
          onDock={(dock) => setDrawer({ ...drawer, dock })}
        />
      ) : null}

      <ConfirmHost request={confirmReq} onResolve={resolveConfirm} />
    </AppProvider>
  );
}

/** 面板抽屉：选类型 + 选停靠位（DockLocation） */
function PanelDrawer({ anchor, dock, onClose, onPick, onDock }) {
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - 220);
  const top = Math.min(rect.bottom + 4, window.innerHeight - 420);
  return (
    <div className="drawer" style={{ left: `${left}px`, top: `${top}px` }} onClick={(e) => e.stopPropagation()}>
      <div className="hd">停靠位置</div>
      <div className="rowgap" style={{ padding: '0 6px 4px' }}>
        {DOCKS.map(([id, label]) => (
          <Chip key={id} on={dock === id} onClick={() => onDock(id)}>{label}</Chip>
        ))}
      </div>
      <div className="sep" />
      <div className="hd">面板</div>
      {PANEL_ORDER.map((id) => (
        <div key={id} className="it" onClick={() => onPick(id)}>{PANELS[id].title}</div>
      ))}
      <div className="sep" />
      <div className="it" onClick={onClose}>关闭</div>
    </div>
  );
}

/** 深拷贝演示数据（让面板的写操作有真正的不可变边界） */
function cloneSections(sections) {
  const out = {};
  for (const [id, sec] of Object.entries(sections)) {
    out[id] = {
      ...sec,
      groups: (sec.groups || []).map((g) => ({ ...g })),
      fields: (sec.fields || []).map((f) => ({ ...f })),
      entries: (sec.entries || []).map((e) => ({ ...e, values: { ...(e.values || {}) } })),
    };
  }
  return out;
}

function loadModelFrom(json) {
  return Model.fromJson(json);
}
