/* 应用级上下文 —— 面板之间共享的东西只有三样
 *
 *   openPanel  开/复用面板（写操作走这里，路径唯一）
 *   mask       打码开关（全局动作，§十五 15.1）
 *   navTree    目录树（settings.navTree 的显示配置，不是数据）
 *
 * 刻意不放的：条目数据。条目是数据层的真相，面板只读不缓存——
 * 原型阶段用模块常量演示，等 S1 落地后换成 entries 模块的读路径。
 */

import { createContext, useContext } from 'react';

const AppCtx = createContext(null);

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}

export const AppProvider = AppCtx.Provider;
