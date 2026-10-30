/* 面板注册表 —— component 名字 → React 组件
 *
 * FlexLayout 的 factory 只认 `node.getComponent()` 这个字符串，
 * 其余参数（这里叫 config）从 `node.getConfig()` 取。
 * 加一种面板 = 在这里加一行 + 写一个 panels/*.jsx，不动别处。
 */

import SidebarPanel from './panels/sidebar.jsx';
import DatabasePanel from './panels/database.jsx';
import DetailPanel from './panels/detail.jsx';
import AiPanel from './panels/ai.jsx';
import { FilesPanel, ExportPanel, SettingsPanel, LayoutPanel } from './panels/tools.jsx';

export const PANELS = {
  sidebar: { title: '目录', render: () => <SidebarPanel /> },
  database: { title: '数据库', render: (cfg, ctx) => <DatabasePanel config={cfg} ctx={ctx} /> },
  detail: { title: '详情页', render: (cfg, ctx) => <DetailPanel config={cfg} ctx={ctx} /> },
  ai: { title: '块级 AI', render: () => <AiPanel /> },
  files: { title: '附件中心', render: () => <FilesPanel /> },
  exportp: { title: '导出导入', render: () => <ExportPanel /> },
  settings: { title: '设置', render: () => <SettingsPanel /> },
  layout: { title: '布局 JSON', render: () => <LayoutPanel /> },
};

/** 抽屉里的顺序：先业务后工具 */
export const PANEL_ORDER = [
  'database', 'detail', 'ai',
  'files', 'exportp', 'settings', 'layout',
];

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
