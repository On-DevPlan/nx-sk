import { lazy } from 'react';

// 新增面板 = 写组件 + 登记一行。tab 顺序由 order 决定。
//
// `tab: false` 的条目**不出现在导航里**，但仍然必须登记——它由「栏目」动态挂载
// （每个栏目一个 tab，共用同一个视图）。一致性测试对的是「模块声明了 view ↔ 这里登记了」，
// 而不是「有没有 tab」。
//
// 注意：必须用**字面量** lazy(() => import('...'))：变量拼路径会让 Vite 静态分析不了，失去代码分割。
export const VIEWS = [
  { id: 'sections', title: '栏目', order: 500, component: lazy(() => import('../../modules/sections/view.jsx')) },
  { id: 'entries', title: '条目', order: 600, tab: false, component: lazy(() => import('../../modules/entries/view.jsx')) },
  { id: 'export', title: '导出', order: 700, component: lazy(() => import('../../modules/export/view.jsx')) },
  { id: 'backup', title: '加密备份', order: 750, component: lazy(() => import('../../modules/backup/view.jsx')) },
  { id: 'settings', title: '设置', order: 900, component: lazy(() => import('../../modules/settings/view.jsx')) },
];

export const SECTION_VIEW = VIEWS.find((v) => v.id === 'entries').component;

/** 模块 id → 视图 id 的映射，供一致性测试核对「模块声明的 view」都登记过。 */
export const VIEW_MODULE_IDS = VIEWS.map((v) => v.id);
