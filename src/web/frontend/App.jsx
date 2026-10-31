/* 应用壳 —— 顶栏 + FlexLayout 工作区 + 状态条（S3 §十五 15.1）
 *
 * 这一层只做四件事：
 *   1. 把 FlexLayout 的 Layout 摆进骨架（顶栏 / 工作区 / 状态条）
 *   2. 顶栏只放**全局动作**——栏目不进顶栏，栏目只从目录树进（两处入口必然分叉）
 *   3. 布局 = 模型（model.toJson()）→ 落 localStorage；改布局 = 改模型
 *   4. 深链：`#/栏目` 开该栏目的数据库面板，`#/栏目/条目` 再定位到条目
 *
 * 撤销/重试用 flexlayout-react 自带的 useUndo：整段拖拽折叠成一步。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layout, defaultKeyMap, getNodeContextMenuItems, showPopupMenu, useUndo,
} from 'flexlayout-react';
import { Copyable, DialogHost, Toasts } from './components/ui.jsx';
import { useStore } from './store.jsx';
import { PANELS, PANEL_ORDER, factory } from './panels.jsx';
import { resolveDeepLink } from './activeView.js';
import { WORKSPACE_KEY, clearStoredModel, layoutStats, loadModel, openPanel, saveModel } from './workspace.js';

/** FlexLayout 自带的右键菜单是英文。只翻译**用得到的**几条；没翻的原样透出（不吞）。 */
const I18N = {
  close: '关闭',
  rename: '重命名',
  maximize: '最大化',
  restore: '还原',
  float: '浮窗',
  dock: '停靠',
  popout: '弹出到新窗口',
  'Close': '关闭',
  'Rename': '重命名',
  'Maximize': '最大化',
  'Restore': '还原',
  'Float': '浮窗',
  'Dock': '停靠',
  'Popout': '弹出到新窗口',
};
const translate = (msg) => I18N[msg] || msg;

const DOCKS = [
  ['center', '中间'],
  ['left', '左'],
  ['right', '右'],
  ['top', '上'],
  ['bottom', '下'],
];

export default function App() {
  const { boot, bootError, ui, patchUi, reload } = useStore();
  const { model, setModel, undo, redo, canUndo, canRedo, undoCount, redoCount } = useUndo(() => loadModel());
  const [drawer, setDrawer] = useState(null); // { dock }
  const [note, setNote] = useState('');
  const [stats, setStats] = useState({ tabsets: 0, tabs: 0 });
  const layoutRef = useRef(null);

  // —— 布局落盘：模型变了就存 ——
  useEffect(() => {
    if (!model) return undefined;
    const listener = { onAfterAction: () => saveModel(model) };
    model.addChangeListener(listener);
    saveModel(model);
    setStats(layoutStats(model));
    return () => model.removeChangeListener(listener);
  }, [model]);

  const linkSections = useMemo(
    () => (boot?.sections || []).map((s) => ({ id: s.id, title: s.title })),
    [boot],
  );

  /**
   * 深链 → 开面板。
   * 没有深链时**不兜底**：用存下来的工作区布局（老壳的「默认栏目」由布局接手）。
   * 已删栏目 / 已删条目要说清是哪一级缺失，不静默什么都不做。
   */
  const applyDeepLink = useCallback((hash) => {
    if (!model) return;
    const t = resolveDeepLink(hash, linkSections);
    if (!t.sectionId) return;
    if (t.missing === 'section') {
      setNote(`深链指向的栏目「${t.sectionId}」不存在`);
      return;
    }
    const sec = linkSections.find((s) => s.id === t.sectionId);
    openPanel(model, { component: 'database', name: sec ? sec.title : t.sectionId, config: { section: t.sectionId } });
    patchUi({ view: t.sectionId });
    if (t.entryId) {
      patchUi({ entry: t.entryId });
      setNote(t.missing === 'entry'
        ? `深链里的条目已不存在，只开了栏目面板（${t.sectionId}）`
        : `已按深链打开：${sec ? sec.title : t.sectionId} / ${t.entryId}`);
    } else {
      setNote('');
    }
  }, [model, linkSections, patchUi]);

  // 首次加载 + hashchange
  useEffect(() => {
    applyDeepLink(window.location.hash);
    const onHash = () => applyDeepLink(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyDeepLink]);

  // 右键菜单：FlexLayout 不自带；条目用官方 getNodeContextMenuItems（标签走 translate）
  const onContextMenu = useCallback((node, event) => {
    if (event && event.preventDefault) event.preventDefault();
    const items = getNodeContextMenuItems(node);
    showPopupMenu({
      anchor: { x: (event && event.clientX) || 0, y: (event && event.clientY) || 0 },
      container: layoutRef.current && layoutRef.current.getRootDiv ? layoutRef.current.getRootDiv() : undefined,
      items,
      onClose: () => {},
    });
  }, []);

  const resetLayout = () => {
    clearStoredModel();
    setModel(loadModel()); // 存盘已清空 → loadModel 自然给回初始的两栏布局
  };

  const openFromDrawer = (component, location) => {
    if (model) {
      openPanel(model, { component, name: PANELS[component].title, config: {}, location });
    }
    setDrawer(null);
  };

  return (
    <div className="app">
      {/* 顶栏：只有全局动作，**没有栏目 tab** */}
      <header className="top">
        <span className="brand">
          <img src="/logo-rounded.png" alt="" />
          nx-sk
        </span>
        <span className="tagline">本机个人资源管理器</span>
        {boot ? <span className="ver mono">v{boot.app.version}</span> : null}
        <span className="grow" />
        {boot ? (
          <span className="store" title={`存储目录：${boot.storePathRaw}`}>
            <span className="store-label">存储</span>
            <Copyable className="mono nowrap" text={boot.storePathRaw}>{boot.storePath}</Copyable>
          </span>
        ) : null}
        <label className="inline hint" title="密文字段打码显示（投屏 / 截图时用）">
          <input type="checkbox" checked={!!ui.mask} onChange={() => patchUi({ mask: !ui.mask })} />
          打码
        </label>
        <button className="btn small ghost" onClick={() => setDrawer({ dock: 'center' })} title="打开一个面板">＋ 面板</button>
        <button className="btn small ghost" onClick={undo} disabled={!canUndo} title="撤销布局改动">撤销{undoCount ? ` (${undoCount})` : ''}</button>
        <button className="btn small ghost" onClick={redo} disabled={!canRedo} title="重做布局改动">重做{redoCount ? ` (${redoCount})` : ''}</button>
        <button
          className="btn small ghost"
          onClick={() => { if (model) openPanel(model, { component: 'settings', name: '设置', config: {} }); }}
        >设置</button>
        <button className="btn small ghost" onClick={() => reload()}>刷新数据</button>
      </header>

      {/* 工作区 */}
      <div className="workarea">
        {bootError ? (
          <div className="pad stack">
            <div className="bad"><strong>读不到后端上下文</strong></div>
            <pre className="block">{bootError}</pre>
            <div className="hint">确认 nx-sk serve 正在运行；或点右上角「刷新数据」重试。</div>
          </div>
        ) : !boot ? (
          <div className="pad muted">正在装载…</div>
        ) : model ? (
          <Layout
            ref={layoutRef}
            model={model}
            factory={factory}
            onContextMenu={onContextMenu}
            onAction={(action) => action}
            onModelChange={() => setStats(layoutStats(model))}
            i18nTranslator={translate}
            // 默认只有「关闭页签 / 重命名」有键位；焦点在面板组之间移动的三条默认是关的——
            // 不开它们，键盘用户进得来出不去
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
        <span className="mono">布局 → localStorage('{WORKSPACE_KEY}')</span>
        <span className="mono">深链 {window.location.hash || '#/'}</span>
        {note ? <span className="muted">{note}</span> : null}
        <button type="button" className="btn small ghost" onClick={resetLayout} title="丢掉存下来的布局，回到初始的两栏">重置布局</button>
      </div>

      {drawer ? (
        <PanelDrawer
          dock={drawer.dock}
          onDock={(dock) => setDrawer({ dock })}
          onPick={(component) => openFromDrawer(component, drawer.dock)}
          onClose={() => setDrawer(null)}
        />
      ) : null}

      <Toasts />
      <DialogHost />
    </div>
  );
}

/** 面板抽屉：选类型 + 选停靠位（DockLocation.getByName 认的那五个值） */
function PanelDrawer({ dock, onPick, onDock, onClose }) {
  return (
    <div className="drawer panel-drawer">
      <div className="hd">停靠位置</div>
      <div className="rowgap drawer-docks">
        {DOCKS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`vchip${dock === id ? ' on' : ''}`}
            onClick={() => onDock(id)}
          >{label}</button>
        ))}
      </div>
      <div className="sep" />
      <div className="hd">面板</div>
      {PANEL_ORDER.map((id) => (
        <button key={id} type="button" className="it" onClick={() => onPick(id)}>{PANELS[id].title}</button>
      ))}
      <div className="sep" />
      <button type="button" className="it" onClick={onClose}>关闭</button>
    </div>
  );
}
