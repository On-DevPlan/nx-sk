import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

/** 面板视图的公共 props：条目模板视图收 `templateId`，工具页不收。 */
export interface ViewProps {
  templateId?: string;
  /**
   * #14：侧栏树里已经能看到当前条目模板的条目时，正文不再重复渲染条目列表
   * （列表列与它的拖拽线一起隐藏，编辑器独占正文宽度）。由 App 计算后传入。
   */
  listHidden?: boolean;
  /**
   * 任务 #28：侧栏收起时侧栏条目模板行上的「＋」不可见，条目模板页的工具条要留一个
   * 「新建条目」兜底；侧栏展开时不再重复摆第二个新建入口。
   */
  sidebarCollapsed?: boolean;
  /**
   * 任务 #49：条目模板页的「新建条目」也走统一创建弹窗；当前模板只作为默认选项，
   * 用户仍可在创建时改选别的模板或空白条目。未传时该入口不工作。
   */
  onCreateEntry?: (templateId?: string) => void;
}

export interface ViewDef {
  id: string;
  title: string;
  order: number;
  tab?: false;
  component: LazyExoticComponent<ComponentType<ViewProps>>;
}

// 面板视图的**唯一**登记处。后端模块只描述 action，不声明视图——
// 也就不会出现「同一页被声明两次、改了一边忘了另一边」。
//
// 新增面板 = 在 src/web/frontend/modules/<id>/ 写组件 + 这里登记一行。
// tab 顺序由 order 决定；`tab: false` 的条目**不出现在导航里**，但仍必须登记——
// 它由「条目模板」动态挂载（每个条目模板一个 tab，共用同一个视图）。
//
// 注意：必须用**字面量** lazy(() => import('...'))：变量拼路径会让 Vite 静态分析不了，失去代码分割。
export const VIEWS: ViewDef[] = [
  { id: 'templates', title: '条目模板', order: 500, component: lazy(() => import('./modules/templates/view.tsx')) },
  { id: 'entries', title: '条目', order: 600, tab: false, component: lazy(() => import('./modules/entries/view.tsx')) },
  { id: 'files', title: '附件', order: 650, component: lazy(() => import('./modules/files/view.tsx')) },
  { id: 'export', title: '导出导入', order: 700, component: lazy(() => import('./modules/export/view.tsx')) },
  { id: 'settings', title: '设置', order: 900, component: lazy(() => import('./modules/settings/view.tsx')) },
];

export const SECTION_VIEW = VIEWS.find((v) => v.id === 'entries')!.component;

