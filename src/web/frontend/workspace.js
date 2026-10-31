/* 工作区 —— 布局模型（唯一真源）+ 持久化 + 开面板
 *
 * 这一层刻意贴着 FlexLayout 的模型语义写，不自造：
 *   · 模型 = JSON 树（row → tabset → tab），UI 是它的投影
 *   · 所有改动走 Actions.*（model.doAction），**不直接改节点属性**
 *   · 存盘 = model.toJson()；恢复 = Model.fromJson()
 *   · 拖拽/停靠的语义由库负责，我们只提供「往哪个 tabset 塞哪块面板」
 *
 * 布局存 localStorage（`ui.workspace` 的落地形式）：它是「跨会话有意义的选择」，
 * 但**不该进 store.json** —— 面板摆在哪跟数据无关，进 store 只会让 diff 变噪音。
 */

import { Actions, DockLocation, Model } from 'flexlayout-react';

/** ui.workspace 的落点。与 store 的 LS_KEY（'nx-sk-ui'）分开存：布局大、单独读写不易互相踩。 */
export const WORKSPACE_KEY = 'nx-sk-ui.workspace';

/** 全局属性：属性继承的根（global.tabXxx ← 每个 tab 的默认值） */
const GLOBAL_ATTRS = {
  tabEnableClose: true,
  tabEnableDrag: true,
  tabEnableRename: true,
  tabEnablePopout: true,
  tabEnablePopoutIcon: true, // 标题栏出现「弹出」按钮——可见入口
  tabEnableFloat: true,
  tabEnableFloatIcon: true, // 标题栏出现「浮窗」按钮——可见入口
  tabEnablePin: false,
  tabSetEnableClose: false,
  tabSetEnableCloseButton: true,
  tabSetEnableMaximize: true,
  tabSetEnableDrag: true,
  tabSetEnableDrop: true,
  tabSetEnableTabGroups: false,
  tabSetAutoSelectTab: true,
  borderEnableClose: false,
  enableEdgeDock: true,
  enableEdgeDockIndicators: true,
  rootOrientationVertical: false,
};

/**
 * 初始布局：目录树在左（一个 tabset，可拖宽/可拖走），工作区在右。
 * 「栏目只从侧边栏进」是**默认布局的约定**，不是硬编码的壳 ——
 * 目录面板本身只是一个 tab，可以拖去任何地方、拖出成浮窗。
 */
export function initialLayoutJson() {
  return {
    global: { ...GLOBAL_ATTRS },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          id: 'ts_sidebar',
          weight: 20,
          children: [{ type: 'tab', id: 't_sidebar', name: '目录', component: 'sidebar' }],
        },
        {
          type: 'tabset',
          id: 'ts_main',
          weight: 80,
          children: [{ type: 'tab', id: 't_welcome', name: '开始', component: 'welcome' }],
        },
      ],
    },
  };
}

/**
 * 出厂全局属性**每次加载都补上**。
 *
 * 为什么不靠存盘里的 `global`：`toJson()` 只写**与默认值不同**的项，
 * 所以一份旧布局里可能压根没有 `global` 这一段（或缺某几项）——
 * 存盘里的属性是「用户改过的差量」，不是「完整配置」。
 * 不补 = 老布局加载后新开的入口又消失了（浮窗/弹出图标不出现，因为存盘里的
 * global 还是加图标之前的那份）。
 */
export function applyGlobalAttrs(model) {
  model.updateAttrs({ ...GLOBAL_ATTRS });
  return model;
}

/** 读盘 → 模型；坏数据不吞掉整台应用，退回初始布局 */
export function loadModel() {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
    const json = JSON.parse(raw);
    if (!json || !json.layout) return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
    return applyGlobalAttrs(Model.fromJson(json));
  } catch {
    return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
  }
}

/** 落盘：布局 JSON */
export function saveModel(model) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(model.toJson()));
  } catch {
    /* 配额 / 隐私模式：布局不落盘不影响本次会话使用 */
  }
}

export function clearStoredModel() {
  try {
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 找到已打开的同款面板（component + config 一致）——避免重复开同名面板 */
export function findOpenPanel(model, component, config) {
  const want = JSON.stringify(config || {});
  let hit = null;
  model.visitNodes((node) => {
    if (hit) return;
    if (node.getType() !== 'tab') return;
    if (node.getComponent() !== component) return;
    if (JSON.stringify(node.getConfig() || {}) !== want) return;
    hit = node;
  });
  return hit;
}

/** 全部 tabset（主布局里的；border 的不算——那是边界栏） */
export function allTabsets(model) {
  const out = [];
  model.visitNodes((node) => {
    if (node.getType() === 'tabset') out.push(node);
  });
  return out;
}

/** 这个 tabset 里有没有指定 component 的页签 */
function hasComponent(tabset, components) {
  if (!components || !components.length) return false;
  return (tabset.getTabNodes() || []).some((t) => components.includes(t.getComponent()));
}

/**
 * 开面板的落点。
 *
 * **不能落进侧边栏自己的 tabset**——目录树是一个「面板」，它所在的面板组是给目录用的；
 * 从目录点栏目开数据库面板，页签应该进**工作区**，否则工作区会开在侧边栏旁边，
 * 侧边栏那一组还会越攒越多。
 */
export function activeTabsetId(model, exclude = []) {
  const ts = model.getActiveTabset() || model.getFirstTabSet();
  if (ts && !hasComponent(ts, exclude)) return ts.getId();
  const fallback = [...allTabsets(model)].reverse().find((s) => !hasComponent(s, exclude));
  return fallback ? fallback.getId() : (ts ? ts.getId() : undefined);
}

/**
 * 开一个面板。
 * @param {object} model
 * @param {{component:string, name:string, config?:object, location?:string}} spec
 *        location ∈ center | left | right | top | bottom（FlexLayout 的 DockLocation）
 * @returns {{tabId:string, reused:boolean}}
 */
export function openPanel(model, spec) {
  const { component, name, config = {}, location = 'center' } = spec;
  const existing = findOpenPanel(model, component, config);
  if (existing) {
    model.doAction(Actions.selectTab(existing.getId()));
    // 复用面板时**同步页签名**：条目改名 / 深链给的标题与旧页签不一致时，
    // 页签还挂着旧名字，就会出现「两个面板同名、分不清谁是谁」。
    if (name && existing.getName() !== name) {
      model.doAction(Actions.renameTab(existing.getId(), name));
    }
    return { tabId: existing.getId(), reused: true };
  }

  const target = activeTabsetId(model, ['sidebar']);
  if (!target) return { tabId: null, reused: false };

  const dock = DockLocation.getByName(location);
  model.doAction(Actions.addTab({ type: 'tab', name, component, config }, target, dock, -1, true));
  // addTab 之后按 component+config 找回刚建的 tab（FlexLayout 会分配 id）
  const created = findOpenPanel(model, component, config);
  return { tabId: created ? created.getId() : null, reused: false };
}

/** 把一个面板挪到指定停靠位（换布局用） */
export function dockPanel(model, tabId, location) {
  const target = activeTabsetId(model);
  if (!target) return false;
  model.doAction(Actions.moveNode(tabId, target, DockLocation.getByName(location), -1, true));
  return true;
}

/** 关闭某个面板（抽屉里的「关掉这个面板」用） */
export function closePanel(model, tabId) {
  if (!tabId) return false;
  model.doAction(Actions.deleteTab(tabId));
  return true;
}

/** 布局统计（状态条用） */
export function layoutStats(model) {
  let tabsets = 0;
  let tabs = 0;
  model.visitNodes((node) => {
    if (node.getType() === 'tabset') tabsets += 1;
    if (node.getType() === 'tab') tabs += 1;
  });
  return { tabsets, tabs };
}

/** 当前选中的 tab（状态条 / 深链同步用） */
export function activeTab(model) {
  const ts = model && model.getActiveTabset();
  const tab = ts && ts.getSelectedNode();
  return tab || null;
}
