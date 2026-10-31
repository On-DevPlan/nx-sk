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
          weight: 15,
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

/**
 * 剪掉空 tabset（children 为空的面板组），以及修剪后变空的 row。
 *
 * **为什么要剪**：FlexLayout 的 toJson 会把空 tabset 原样写进布局——
 * 拖动/关闭面板的某些路径会留下空面板组，存盘后每次恢复都渲染成一块白板
 * （状态条数出「N 个面板组」，里面却一个面板都没有）。
 * 恢复时剪 = 已经存坏的布局自动愈合；存盘前剪 = 不再产生新的。
 *
 * 纯函数：输入输出都是布局 JSON（不是 Model 实例），单测直接覆盖。
 * 返回 null 表示根被剪空（一个可用面板组都不剩），调用方决定回退到初始布局。
 */
export function pruneEmptyTabsets(json) {
  if (!json || json.type !== 'row' || !Array.isArray(json.children)) return json;
  const walk = (node) => {
    if (node.type !== 'row') return node;
    node.children = (node.children || [])
      .map((c) => (c.type === 'row' ? walk(c) : c))
      .filter((c) => {
        if (c.type === 'tabset') return (c.children || []).length > 0;
        if (c.type === 'row') return (c.children || []).length > 0;
        return true;
      });
    return node;
  };
  const layout = walk(json);
  return layout.children.length ? json : null;
}

/** 读盘 → 模型；坏数据不吞掉整台应用，退回初始布局 */
export function loadModel() {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
    const json = JSON.parse(raw);
    if (!json || !json.layout) return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
    // 剪空面板组：老布局里已经存进去的空 tabset 在这一步愈合，不用用户点「重置布局」
    if (!pruneEmptyTabsets(json.layout)) return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
    return applyGlobalAttrs(Model.fromJson(json));
  } catch {
    return applyGlobalAttrs(Model.fromJson(initialLayoutJson()));
  }
}

/** 落盘：布局 JSON */
export function saveModel(model) {
  try {
    const out = model.toJson();
    // 存盘前剪空面板组：库自己不删（见 pruneEmptyTabsets 的注释）。
    // 剪完为空（理论到不了：关掉最后一个面板时库会连 tabset 一起收）就不写，留着上一份。
    if (out.layout && pruneEmptyTabsets(out.layout)) {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(out));
    }
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

/** 第一个 component 匹配的页签（**不限 config**）——详情面板是单例，只有一块。 */
export function findComponentPanel(model, component) {
  let hit = null;
  model.visitNodes((node) => {
    if (hit) return;
    if (node.getType() !== 'tab') return;
    if (node.getComponent() !== component) return;
    hit = node;
  });
  return hit;
}

/**
 * 打开（或切到）**条目详情面板**。
 *
 * 详情是工作区里的一等面板，不是视图里的右栏：可以拖到任意分栏、弹出浮窗、单独关掉。
 * 单例：已开着就换它的 config（换条目）并选中它——开两块详情没有意义，
 * 反而让人分不清哪块是当前条目的。
 */
export function openEntryPanel(model, { section, entry, title }) {
  if (!model || !section || !entry) return null;
  const existing = findComponentPanel(model, 'entry');
  if (existing) {
    model.doAction(Actions.updateNodeAttributes(existing.getId(), { config: { section, entry } }));
    if (title && existing.getName() !== title) model.doAction(Actions.renameTab(existing.getId(), title));
    model.doAction(Actions.selectTab(existing.getId()));
    return existing.getId();
  }
  const target = activeTabsetId(model, ['sidebar']);
  if (!target) return null;
  // 默认停靠在右边：表格在左、详情在右，是「看一行改一行」最省事的落点；
  // 用户可以自己把它拖走、拖成浮窗、关掉。
  model.doAction(Actions.addTab(
    { type: 'tab', name: title || '条目详情', component: 'entry', config: { section, entry } },
    target,
    DockLocation.getByName('right'),
    -1,
    true,
  ));
  const created = findComponentPanel(model, 'entry');
  return created ? created.getId() : null;
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

/** 找到承载某个 component 页签的 tabset id（侧边栏收起/展开要用它改 weight） */
export function tabsetOfComponent(model, component) {
  if (!model) return null;
  let hit = null;
  model.visitNodes((node) => {
    if (hit) return;
    if (node.getType() !== 'tab') return;
    if (node.getComponent() !== component) return;
    // TabNode 没有 getTabset()（0.11 的 API）：页签的父节点就是它所在的 tabset
    const parent = node.getParent();
    if (parent && parent.getType() === 'tabset') hit = parent;
  });
  return hit ? hit.getId() : null;
}

/** 读某个 tabset 的 weight（布局宽度 = weight 的比例分摊）；找不到返回 null */
export function tabsetWeight(model, tabsetId) {
  if (!model || !tabsetId) return null;
  let w = null;
  model.visitNodes((node) => {
    if (w !== null) return;
    if (node.getType() === 'tabset' && node.getId() === tabsetId) w = node.getWeight();
  });
  return w;
}

export function setTabsetWeight(model, tabsetId, weight) {
  return setTabsetAttrs(model, tabsetId, { weight });
}

/** 改 tabset 属性（weight / enableTabStrip …）；目标不存在时安全 no-op */
export function setTabsetAttrs(model, tabsetId, attrs) {
  if (!model || !tabsetId) return false;
  let found = false;
  model.visitNodes((node) => {
    if (found) return;
    if (node.getType() === 'tabset' && node.getId() === tabsetId) found = true;
  });
  if (!found) return false;
  model.doAction(Actions.updateNodeAttributes(tabsetId, attrs));
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
