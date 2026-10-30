/* FlexLayout 内置文案的中文化
 *
 * FlexLayout 的 `i18nTranslator` 把**所有内置 UI 文案**交给应用翻（参考实现
 * `src/view/I18nLabel.ts` 的 I18nLabel 枚举 + I18nLabelDefaults）。
 * 原型全中文，菜单却是英文的（「Popout」「Float」「Close All」）——两套语言混着很割裂，
 * 而且**英文菜单里藏着一个功能入口，用户根本不会想到去点它**。
 *
 * 这里把全部内置 key 翻成中文。**漏翻一个 key 就回落到英文**（不是报错，是那一项露馅），
 * 所以这里按 I18nLabel 枚举**逐条列全**，不省略。
 */

export const ZH = {
  'flexlayout.ui.close.tab': '关闭',
  'flexlayout.ui.pinned.tab': '已固定',
  'flexlayout.ui.rename.tab': '重命名页签',
  'flexlayout.ui.close.tabset': '关闭面板组',
  'flexlayout.ui.active.tabset': '当前面板组',
  'flexlayout.ui.move.tabset': '移动面板组',
  'flexlayout.ui.move.tabs (?)': '移动页签（?）',
  'flexlayout.ui.move.group (?)': '移动分组（?）',
  'flexlayout.ui.maximize.tabset': '最大化面板组',
  'flexlayout.ui.restore.tabset': '还原面板组',
  'flexlayout.ui.popout.tab': '把选中的页签弹出成新窗口',
  'flexlayout.ui.popout.tab.float': '把选中的页签浮成浮窗',
  'flexlayout.ui.popout.float.to.window': '把浮窗弹出成新窗口',
  'flexlayout.ui.dock.float.to.layout': '拖到另一个布局里',
  'flexlayout.ui.dock.float.tabs (?)': '拖回布局（?）',
  'flexlayout.ui.overflow.menu.tooltip': '隐藏的页签',
  'flexlayout.ui.splitter': '调宽度',
  'flexlayout.ui.error.rendering.component': '面板渲染出错',
  'flexlayout.ui.error.rendering.component.retry': '重试',
  'flexlayout.ui.popout.window.name': 'nx-sk 面板',
  'flexlayout.ui.menu.rename': '重命名',
  'flexlayout.ui.menu.pin': '固定',
  'flexlayout.ui.menu.unpin': '取消固定',
  'flexlayout.ui.menu.popout': '弹出成新窗口',
  'flexlayout.ui.menu.float': '浮成浮窗',
  'flexlayout.ui.menu.popout.tabset': '把整个面板组弹出成新窗口',
  'flexlayout.ui.menu.float.tabset': '把整个面板组浮成浮窗',
  'flexlayout.ui.menu.maximize': '最大化',
  'flexlayout.ui.menu.restore': '还原',
  'flexlayout.ui.menu.overlay': '浮出（覆盖式）',
  'flexlayout.ui.menu.split': '分栏（占位式）',
  'flexlayout.ui.menu.close.all': '关闭全部',
  'flexlayout.ui.menu.close.right': '关闭右侧',
  'flexlayout.ui.menu.close.others': '关闭其他',
  'flexlayout.ui.menu.add.to.new.group': '新建分组并加入',
  'flexlayout.ui.menu.add.to.group': '加入分组',
  'flexlayout.ui.menu.remove.from.group': '移出分组',
  'flexlayout.ui.menu.ungroup': '解散分组',
  'flexlayout.ui.menu.expand': '展开',
  'flexlayout.ui.menu.collapse': '折叠',
  'flexlayout.ui.rename.group': '重命名分组',
  'flexlayout.ui.group.color': '分组颜色',
  'flexlayout.ui.group.pill.tooltip': '分组',
  'flexlayout.ui.group.name.label': '分组名',
  'flexlayout.ui.group.name.placeholder': '分组名…',
  'flexlayout.ui.group.color.n': '分组颜色 {n}',
  'flexlayout.ui.group.default.name': '新分组',
};

/**
 * 给 <Layout i18nTranslator={…}> 用。
 * 未知 key 回落英文（FlexLayout 自己会兜底），**但我们在这里显式记一笔**，
 * 免得「漏翻一个 key」变成没人发现的事。
 */
export function translate(key) {
  if (ZH[key]) return ZH[key];
  return key;
}
