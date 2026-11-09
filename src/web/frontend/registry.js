import { lazy } from 'react';

// 面板视图的**唯一**登记处。后端模块只描述 action，不声明视图——
// 也就不会出现「同一页被声明两次、改了一边忘了另一边」。
//
// 新增面板 = 在 src/web/frontend/modules/<id>/ 写组件 + 这里登记一行。
// tab 顺序由 order 决定；`tab: false` 的条目**不出现在导航里**，但仍必须登记——
// 它由「栏目」动态挂载（每个栏目一个 tab，共用同一个视图）。
//
// 注意：必须用**字面量** lazy(() => import('...'))：变量拼路径会让 Vite 静态分析不了，失去代码分割。
export const VIEWS = [
  { id: 'sections', title: '栏目', order: 500, component: lazy(() => import('./modules/sections/view.jsx')) },
  { id: 'entries', title: '条目', order: 600, tab: false, component: lazy(() => import('./modules/entries/view.jsx')) },
  { id: 'files', title: '附件', order: 650, component: lazy(() => import('./modules/files/view.jsx')) },
  { id: 'export', title: '导出导入', order: 700, component: lazy(() => import('./modules/export/view.jsx')) },
  { id: 'settings', title: '设置', order: 900, component: lazy(() => import('./modules/settings/view.jsx')) },
];

export const SECTION_VIEW = VIEWS.find((v) => v.id === 'entries').component;
