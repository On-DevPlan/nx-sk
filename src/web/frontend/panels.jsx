/* 面板注册表 —— component 名字 → React 组件
 *
 * FlexLayout 的 factory 只认 `node.getComponent()` 这个字符串，
 * 其余参数（这里叫 config）从 `node.getConfig()` 取。加一种面板 = 这里加一行。
 *
 * 与 registry.js（导航用的 VIEWS）的分工：那边是「顶部导航里有哪些页」，
 * 这边是「工作区里能开哪些面板」。栏目不再是导航项，而是**从目录树打开的面板**，
 * 所以 database 面板带 config.section。
 */

import { Suspense, lazy } from 'react';
import SidebarPanel from './components/sidebar.jsx';

const EntriesView = lazy(() => import('../../modules/entries/view.jsx'));
const SectionsView = lazy(() => import('../../modules/sections/view.jsx'));
const FilesView = lazy(() => import('../../modules/files/view.jsx'));
const ExportView = lazy(() => import('../../modules/export/view.jsx'));
const SettingsView = lazy(() => import('../../modules/settings/view.jsx'));

/** 空态：还没选栏目时的落地页。讲清「下一步做什么」，不放装饰。 */
function WelcomePanel() {
  return (
    <div className="pad stack welcome">
      <div><strong>从左边目录选一个栏目</strong>，或用右上角「＋ 面板」开一个工具面板。</div>
      <div className="hint">面板可以拖到任意一边拆分，也可以拖出成浮窗；布局会自动记住。</div>
      <div className="hint">
        CLI 等价：<code>nx-sk section list</code>　·　<code>nx-sk entry list --section 栏目</code>
      </div>
    </div>
  );
}

const wrap = (C) => (
  <Suspense fallback={<div className="pad muted">加载中…</div>}>
    <C />
  </Suspense>
);

export const PANELS = {
  // 目录面板拿 model：点栏目 = 在工作区开 database 面板（openPanel 走模型，不靠全局事件）
  sidebar: { title: '目录', render: (cfg, ctx) => <SidebarPanel model={ctx && ctx.model} /> },
  welcome: { title: '开始', render: () => <WelcomePanel /> },
  database: {
    title: '数据库',
    // config.section 为空 = 还没选栏目（初始布局）；此时给空态而不是空白
    render: (cfg) => (cfg && cfg.section
      ? (
        <Suspense fallback={<div className="pad muted">加载中…</div>}>
          <EntriesView sectionId={cfg.section} />
        </Suspense>
      )
      : <WelcomePanel />),
  },
  sections: { title: '栏目管理', render: () => wrap(SectionsView) },
  files: { title: '附件', render: () => wrap(FilesView) },
  export: { title: '导出导入', render: () => wrap(ExportView) },
  settings: { title: '设置', render: () => wrap(SettingsView) },
};

/** 抽屉里的顺序：先业务后工具 */
export const PANEL_ORDER = ['database', 'sections', 'files', 'export', 'settings'];

/**
 * FlexLayout 的 factory 只认 `node.getComponent()`，其余参数从 `node.getConfig()` 取。
 * 这里额外把 `tabId` 与 `model` 传给面板——面板要改**自己**的 config（比如切视图）时需要它们
 * （`Actions.updateNodeAttributes(tabId, { config })`）。
 */
export function factory(node) {
  const p = PANELS[node.getComponent()];
  if (!p) {
    return <div className="muted" style={{ padding: 12 }}>未知面板：{node.getComponent()}</div>;
  }
  const ctx = { tabId: node.getId(), model: node.getModel(), node };
  return p.render(node.getConfig(), ctx);
}
