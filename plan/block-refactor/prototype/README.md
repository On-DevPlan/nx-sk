<!-- 原型 v3 · 真实 FlexLayout 原型（IA + 与参考仓库的逐条对照）
     对应设计：../00-design.md **§十六（原型落地修订 v3，当前为准）** · §十五（架构修订 v2）· §十三（递归块 + 目录树）· §十四（块级 AI）
     参考实现：.claude/repo/FlexLayout（v0.11.1，MIT） -->

# 原型 v3 · 真实 FlexLayout 面板壳

> **这一版把原型从「视觉模拟」换成了「真跑 FlexLayout」。**
> 上一版（R1–R11）用手写 CSS/JS 模拟了一个「像 FlexLayout 的壳」，
> 结果是**精髓全丢**：模型形状是自己发明的、拖拽没有停靠语义、没有撤销、
> 布局不是「一棵树」而是「一堆 div」。原型骗得过眼睛，骗不过实现。
>
> 现在原型**直接依赖 `flexlayout-react@0.11.1`**：
> 模型、动作、停靠、分割、最大化、浮动、撤销——全是参考仓库自己的代码。
> 原型跑得动 = 实现期不用再猜 FlexLayout 的行为。

## 怎么跑

```bash
pnpm install                 # 根目录（原型复用根 node_modules）
pnpm proto:dev                # → http://127.0.0.1:5190
pnpm proto:build              # 产物在 plan/block-refactor/prototype/dist/
```

依赖装在**根** `package.json` 的 devDependencies（`flexlayout-react` / `@dnd-kit/*`），
原型是独立 vite root（`plan/block-refactor/prototype/vite.config.js`），
**不影响主应用**（`src/web/frontend` → `src/web/public`）的构建与产物。

## 信息架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 顶栏：nx-sk · 全局搜索 · 打码 · ＋面板 · 撤销/重做 · 设置   ← **没有栏目 tab** │
├─────────────┬─────────────────────────────────────────────────────────────┤
│ 目录面板     │ 工作区 = FlexLayout 布局树（row → tabset → tab）             │
│ (一个 tab)   │  ┌ tabset ──────────┬ tabset ─────────────┐                │
│             │  │ [目录][字段样例]  │ [详情]              │                │
│ ▸ 字段样例 ▾ │  ├──────────────────┼──────────────────────┤                │
│   · 示例条目 │  │ 表格视图          │ 属性区 + 块正文      │ ← 分割条可拖   │
│   · 对照条目 │  │ 行点击→新开面板   │ 块可嵌块            │                │
│ ▸ 求职 ▾    │  └──────────────────┴──────────────────────┘                │
│ ▸ 项目 ▾    │                                                             │
│   ▸ 项目经历 │  拖页签 → 别的 tabset（合并）／四边（拆出新面板）             │
│ ▸ 密钥      │  双击/⤢ → 最大化面板组   ·   ＋ → 面板抽屉                 │
│ ⇲ 隐藏区     │                                                             │
└─────────────┴─────────────────────────────────────────────────────────────┘
```

**栏目的唯一入口**是目录树：点栏目 → 工作区**新开一个数据库面板**（可同时开多个不同视图/条目）。
工作区里没有第二处栏目列表——避免两个入口分叉。

## 与 .claude/repo/FlexLayout 的逐条对照

| FlexLayout 的机制 | 参考实现位置 | 本原型的落点 |
| --- | --- | --- |
| **模型即唯一真源**（JSON 树 → UI 是投影） | `src/model/Model.ts` `toJson/fromJson` | `src/workspace.js` `initialLayoutJson()`；「布局 JSON」面板直接摊开 `model.toJson()` 给人看 |
| **改动只走 Actions**（不直接改节点属性） | `src/model/Actions.ts` | `workspace.js` 的 `openPanel/dockPanel` 全部 `model.doAction(Actions.*)` |
| **停靠语义 DockLocation**（center/left/right/top/bottom） | `src/model/DockLocation.ts` | 面板抽屉「停靠位置」chips → `Actions.addTab(..., DockLocation.getByName(loc), -1, true)`；实测「左」真的拆出新面板组 |
| **拖页签到四边 = 拆分** | `src/view/layout/DragDropManager.tsx` | FlexLayout 原生，本原型不重写 |
| **分割条调权重** | `src/view/Splitter.tsx` | FlexLayout 原生 |
| **面板组最大化** | `Actions.maximizeToggle` | tabset 标题栏的 ⤢ 按钮（FlexLayout 原生） |
| **撤销/重做**（整段拖拽折叠成一步） | `src/view/useUndo.ts` | 顶栏「撤销/重做」按钮，直接用 `useUndo` |
| **浮动 / 新窗口** | `Actions.popoutTab / popoutTabset` | `global.tabEnableFloat/tabEnablePopout = true`（tab 右键菜单里出现） |
| **属性继承**（`global.tabXxx` ← 每节点覆盖） | `src/model/Attributes.ts` | `workspace.js` `GLOBAL_ATTRS` |
| **主题 = CSS 变量** | `style/_themes.scss` | `src/theme.css` **全量覆写** `--flexlayout-*`；浮窗/子布局/弹出窗一起变 |
| **目录树 = 一个 tab**（可拖到任何位置） | — | `component:'sidebar'`；「栏目只在侧边栏」是**默认布局的约定**，不是硬编码的壳 |
| **块树也是一棵模型树**（同一条原则，换个领域） | `Model.fromJson/toJson` | `src/blocks.js` 的纯函数树操作（find / update / remove / move / append）+ `detail.jsx` 的递归渲染：**块不是画出来的，是这棵树推导出来的**（R13 实测） |
| **服务端持有状态，客户端只是视图** | `Model` 由 `Layout` 驱动，UI 不持有模型 | 原型的 `server/pending.mjs` 持有「当前块内容」，浏览器每次改块就把副本推上去；AI 的 `baseHash` 与冲突检测都按**服务端那份**算（R14 实测） |
| **面板身份 = component + config**，导航提示不算身份 | `config` 是 tab 的属性（`src/model/TabNode.ts:469`） | 「定位到某个块」走**应用级一次性状态**，不进 `config` —— 否则同一个条目会开出第二个面板，且时间戳会写进布局 JSON（R15 实测） |
| **右键菜单是应用的责任，库只给零件** | `LayoutController.showContextMenu` 只在 `props.onContextMenu` 存在时才做事（`src/view/layout/LayoutController.tsx:1082`） | 原型用官方的 `getNodeContextMenuItems` + `showPopupMenu` 在 `<Layout onContextMenu>` 上拼出**中文**菜单（浮窗 / 弹出 / 重命名 / 关闭）（R16 实测） |
| **面板的 `config` 就是它的身份**，面板可自己改 | `config` 是 tab 的属性（`src/model/TabNode.ts:469`），官方明写要用 `Actions.updateNodeAttributes` 改 | 切视图 = 改本面板的 `config.viewId`（`updateNodeAttributes`）→ 视图是**面板身份的一部分**，同一栏目能同时开多个视图面板（R17 实测） |
| **配置是差量不是全量** | `toJson()` 只写与默认值不同的项（`src/model/Model.ts:894`） | 加载后把**出厂全局属性重新盖上去**（`model.updateAttrs`）——否则「老布局 + 新入口」= 新入口不出现（R16 实测） |
| **模型能整体重建**（`Model.fromJson`） | `src/model/Model.ts:846` | 深链 = **从 URL 重建布局的一部分**：`#/栏目id` → 开对应面板；`#/栏目id/条目id` → 再开详情面板。解析是纯函数（`src/activeView.js`），不散在组件里（R19 实测） |
| **块的动作面很小**（add/update/move/remove，§九 9.2） | `src/model/Actions.ts` | 面板的五个编辑动作全部落到这五条：转类型 = `entry.block.update`（**没有 convert**，整块替换）；上移/下移与拖拽都落 `entry.block.move`；删除 = `entry.block.remove`（R20 实测） |
| **附件的引用关系是算出来的** | 引用扫描 `src/core/attachments.js` | 附件中心不存「谁引用我」，每次从块/字段里的附件 id 列表**现算**（两种引用都算：file 块 + file 字段）——存了就会和块脱节，「清理未引用」会删错东西（R21 实测） |
| **键盘焦点在面板组间移动**（三条默认关） | `src/view/layout/LayoutTypes.ts` `defaultKeyMap` | `focusTabToggle=F6`、`focusNext/PreviousTabset=Ctrl(±Shift)+F6` —— 不开它们，键盘用户进了面板就出不来（R22 实测） |

> **纠正一条旧结论（R11 的说法）**：上一版设计把布局写成 `{type:'row'|'col'}`。
> FlexLayout **没有 `col`**：顶层是 `row`，**嵌套一层就换方向**（row 里的 row 实际是列）。
> 面板参数也不叫 `props`——是 tab 的 **`config`**（`node.getConfig()`）。
> 详见 `00-design.md` §十六。

## 三类拖拽语义（互不混用）

| 拖什么 | 语义 | 危险？ | 实现 |
| --- | --- | --- | --- |
| 工作区里的**页签** | 改 `ui.workspace` 布局 JSON（合并/拆分/最大化/浮动） | 否 | FlexLayout 原生 |
| 侧边栏里的**栏目节点** | 改 `settings.navTree`（重排 / 嵌套成子目录 / 拖进隐藏区） | 否 | dnd-kit，落点三分区：靠上 1/4 = 排前面、靠下 1/4 = 排后面、中间 1/2 = 嵌进去 |
| 侧边栏里的**条目节点** → 另一个栏目 | 改**数据归属**（`entry update --section`） | **是** → 二次确认 | dnd-kit，落点用语义红描边 + 确认弹窗 |

> 三类拖拽用**不同的拖动源**（`data.kind`）区分，不靠「看起来像不像」。

## 视觉语言（提取自 `src/web/frontend/styles.css:1-29`）

| 规则 | 内容 |
| --- | --- |
| 单色 + 无 emoji | 唯一允许的彩色是语义红 `#b3261e`（危险操作 / 错误） |
| 状态 | 用标签（tag），不用颜色块 |
| 立体感 | **只给**可被按 / 可被填的元素（按钮 / 选中态 / 输入框）；容器一律不投影 |
| 密度 | 核心行 28px · 按钮 32px · 字号 12px（两级密度差 4px） |
| 分隔 | 全站只用 1px 浅底线，不用 margin / 投影把容器撑成岛屿 |

Tokens：`--ink #14161a` · `--paper #fff` · `--soft #f5f6f7` · `--soft-2 #ebedf0` · `--mid #8b9096` · `--danger #b3261e`。
字体：`system-ui` 栈，mono 用 `ui-monospace` 栈。

**只借结构不借配色**：原型引 `flexlayout-react/style/light.css` 拿 `.flexlayout__*` 的盒模型与拖拽几何，
颜色全部由 `theme.css` 里 `:root` 的 `--flexlayout-*` 覆写接管——
所以浮窗、子布局、弹出窗用的是同一批变量，不会「主区换了肤、浮窗还是老样子」。

## 面板清单（registry）

| component | 面板 | 覆盖的设计点 |
| --- | --- | --- |
| `sidebar` | 目录树 | §十三 13.3 两类拖拽语义、紧凑数据库形态、隐藏区 |
| `database` | 数据库 | **一个栏目面板里四种视图**（表格/精简/看板/KV）、列设置、搜索 |
| `detail` | 详情页 | L2 属性区 + 块正文（dnd-kit 排序、块菜单、尾部加块） |
| `ai` | 块级 AI | §十四 AI Bar + pending diff（红删绿增）、应用/拒绝 |
| `files` | 附件中心 | 只做库存展示 + 「只看未引用」（指派发生在条目/块里，引用关系现算） |
| `exportp` | 导出导入 | 整库包说明 |
| `settings` | 设置 | 默认栏目 / navTree / navHidden / ui.workspace |
| `layout` | 布局 JSON | **模型的体检口**：`model.toJson()` 摊开 + 重置布局 |

## 块模型（R13 起真渲染）

块正文 = `entry.body`，**递归**（容器块有 children）。类型名**对齐设计文档的词汇表**，原型不另发明：

| 类别 | 类型 | 值形状 | 渲染 |
| --- | --- | --- | --- |
| 叶块 | `paragraph` | string | 纯文本 |
| 叶块 | `heading` | `{ text, level }` | 标题 |
| 叶块 | `md` | markdown 串 | 轻量 md（标题/列表/待办） |
| 叶块 | `table` | `{ columns, rows }` 自描述 | 迷你表（计算列标「算」） |
| 叶块 | `entrylist` | `{ fields, value }`（**自带子列定义**，见下） | 迷你表（敏感子列打码） |
| 叶块 | `file` | 附件 id 列表 | 附件标签 |
| 叶块 | `secret` | 密文信封 | 打码展示 |
| 容器 | `section` | `{ sectionId, viewId? }` | **内嵌另一个栏目的数据库视图** |
| 容器 | `column` | `{ widths: [number] }` + children | **列组**：子列并排，**拖列边框改 widths** |
| 容器 | `toggle` | `{ text, collapsed? }` | 下一版（设计已推迟） |

两条实现细则（与 `00-design.md` §十三 13.2 的 R13 修订表同步）：

- **`column` 分两层**：`widths` **非空** = 列组（children 是 2–3 个子列）；`widths` **为空** = 叶子列（children 是内容块）。
  判别靠 `widths` 是否为空——否则渲染层没法决定「children 是并排还是竖排」。
- **`entrylist` 块自带 `fields`**：块不是字段，**没有栏目字典可查**子列定义，不自带就渲染不出表头。

**「内嵌栏目」与数据库面板是同一段代码**（`src/panels/sectionTable.jsx`）→ 内嵌的那张表与
数据库面板那张表**同一份数据源**，不是另画的装饰。

## 块级 AI 的 pending（R14 起真落目录）

原型给 vite dev server 挂了一个极小的服务端（`server/pending.mjs`，`/proto-api/*`），
让 §十四 的机制**真跑起来**，而不是在内存里演：

| 动作 | 落点 | 真做了什么 |
| --- | --- | --- |
| suggest | `POST /proto-api/pending` | 服务端算 `baseHash`（**客户端不许自带**）→ 写 `<home>/pending/<id>.json` |
| 列表 | `GET /proto-api/pending` | 真从磁盘目录读 |
| 应用 | `POST /proto-api/pending/:id/apply` | 服务端拿**自己那份**当前块算哈希：≠ `baseHash` → **409 CONFLICT，不覆盖** |
| 强推 | 同上 + `force` | 显式强推（仍要用户点） |
| 拒绝 | `POST /proto-api/pending/:id/reject` | 删文件（pending 是运行态，不是历史） |
| 隔离自检 | `GET /proto-api/isolation` | 真 grep `store.json` 与导出包；**两层**：特征串 + pending 独有的结构字段名 |

- **`<home>` 的取法与 `src/core/paths.js` 同源**：环境变量 `NX_SK_HOME` 优先，
  没有则用原型自己的沙箱 `<prototype>/.tmp/home`——**绝不碰用户真实的 `~/nx-sk/`**。
- **服务端持有「当前块内容」**：浏览器每次改块就把**整份**块树推上去
  （按条目推会因「哪个面板恰好挂载着」丢块 → `baseHash` 算成 `null`，冲突检测形同虚设）。
- **0700 的平台 caveat**：`chmod` 在 Windows 上改不了 POSIX 位（实测 `stat` 恒为 `666`），
  真正的隔离要靠 NTFS ACL。原型**如实上报实际 mode**，不假装是 0700。

## 全局搜索（R15 起真接）

顶栏搜索框不再是占位：跨栏目搜**栏目名 / 条目名 / 字段值 / 块正文**，命中直接开对应面板。

- **纯函数在 `src/search.js`**（`searchAll` / `snippet` / `dedupeHits`），可直接单测。
- **密文不参与搜索**：`secret` 字段与 `secret` 块跳过；`entrylist` 的 sensitive 子列、
  `table` 的 sensitive 列也跳过。搜索框**不是泄露口**（设计 §十七.2）。
  但 `secret` 的**名称**照常可搜——`DB_PASSWORD` 这名字不是秘密，值才是。
- **正文命中会定位到那个块**：滚动过去 + 灰底闪一下。
- 定位提示走**应用级一次性状态**（带 nonce），**不进面板 config**——
  config 是面板身份的一部分，带上它会让同一个条目开出第二个面板。

## 浮窗与弹出（R16 起有入口）

能力本来就开着（`tabEnableFloat` / `tabEnablePopout`），R16 补的是**入口**：

| 入口 | 位置 | 实测 |
| --- | --- | --- |
| **可见入口** | 每个面板组标题栏右侧的「浮窗」「弹出」图标 | 浮窗出现在页内（可拖回布局）；弹出**真开了一个浏览器窗口** |
| **右键菜单** | 右键页签 / 面板组 | 中文菜单：浮成浮窗 / 弹出成新窗口 / 重命名 / 关闭 |

两条都要有：图标给不找菜单的人，菜单给熟手。

- **内置文案全中文化**：`<Layout i18nTranslator={translate}>`（`src/i18n.js` 按官方
  `I18nLabel` 枚举**逐条列全**，漏一个就回落到英文）。
- **右键菜单是应用的责任**：FlexLayout **不自带**右键菜单——
  `showContextMenu` 只在传了 `props.onContextMenu` 时才做事。原型用官方给的零件自己拼：
  `getNodeContextMenuItems(node)` 建条目 + `showPopupMenu({ anchor, container, items })` 弹。
- **弹出成新窗口需要宿主页**：同位置一个空的 `popout.html`（内容由主窗口用 React Portal 注入，
  样式运行时复制过去）+ vite 多页产物（`index` + `popout`）。
- **存盘里的 `global` 是差量不是全量**：`toJson()` 只写与默认值不同的项 →
  加载后必须把出厂全局属性重新盖上去（`model.updateAttrs`），否则「老布局 + 新入口」= 入口不出现。

## 视图（R17 起：四种视图在同一面板内切换）

S2「视图 = 投影，数据同源」落地：一个**栏目面板**里切四种视图，不换数据源。

| chip | `type` | 实测 |
| --- | --- | --- |
| 表格 | `table` | 除 source 外的全部字段 |
| 精简 | `table` | 仍是 table，只是列少（标题 + 第一个 select） |
| 看板 | `board` | 按 select 分组；**拖卡 = 改字段值（写操作）** |
| KV | `kv` | 整栏目的键值读法 |

- **视图是面板身份的一部分**（`config.viewId`）→ 同一个栏目能**同时开多个面板**（不同视图）。
  切视图 = 改本面板的 `config`（`Actions.updateNodeAttributes`）。
- **缺省推断不落盘**：`src/views.js` 的 `inferViews` 只在**读路径**给一份视图集，
  栏目配了 `section.views` 就用配置的（原型里「字段样例」配了四个，「求职」走推断）。
- **投影降级**：view 引用的字段被删 → **列还在**，表头写「已删字段」，单元格写「—」。
  （原型在「字段样例 → 自定义」视图里引用了一个已删字段 `ghost_note` 专门演示这条。）
- **看板拖卡改的是数据源**：拖完侧边栏的紧凑表立刻跟着变——所以它不是本地态。

## 老配置推断（R18 起：目录树从老三套推断）

原型**故意不用** `settings.navTree`，而是拿一份**老 store 的配置**：

```js
navGroups = [{ title: '求职档案', sections: ['job'] }]   // 数组顺序 = 显示顺序
navHidden = ['internships']                              // 入口不显示
navOrder  = ['demo', 'projects', 'secret']               // 平铺区顺序
```

目录树在**读路径**从这三套推断出来（`src/navTree.js`，纯函数）：

| # | 规则 |
| --- | --- |
| ① | 隐藏的栏目 → 不进树，进隐藏区 |
| ② | 分组里的栏目 → **分组节点**（组顺序 = navGroups 顺序，组内顺序 = 列出的顺序） |
| ③ | 其余可见栏目 → 平铺在根层（navOrder 优先，其余按栏目自身 order） |
| ④ | 平铺在前、分组在后（与老实现的渲染顺序一致） |
| ⑤ | 栏目不存在 / 空组 → 跳过 |

- **实测**：推断出 `字段样例 / 项目 / 密钥` + 分组「求职档案」，「项目经历」进隐藏区；
  侧边栏顶部显示「目录树来源：**推断（老三套，未写回）**」。
- **用户第一次动树 → 落成显式 navTree**：实测把「密钥」拖到最前，树变成
  `密钥 / 字段样例 / 项目 / 求职档案`，来源随之变成「**显式 navTree**」。
- **隐藏仍走老的 `navHidden`** —— 老三套能表达的事不换机制。
- 推断出来的树**必然比显式树浅**（老三套只能表达一层分组）；任意嵌套是显式 navTree 才有的能力。

## 深链（R19 起：地址栏 = 当前打开的面板）

| 深链 | 打开 |
| --- | --- |
| `#/栏目id` | 该栏目的**数据库面板** |
| `#/栏目id/条目id` | 该栏目的数据库面板 **+** 该条目的**详情面板** |
| 没有深链 | 用存下来的工作区布局（`ui.workspace`），**不兜底到某个栏目** |

- 应用内导航（点目录里的栏目、点表格里的行、搜命中）**都写 hash** → 地址栏可复制、可分享。
- **缺失的处置**：栏目不存在 → 不开任何面板，报「深链指向的栏目「X」不存在」；
  条目已被删 → 只开栏目面板，报「深链里的条目已不存在，只开了栏目面板」。**不开坏面板**。
- 解析是**纯函数**（`src/activeView.js` 的 `parseHash` / `buildHash` / `resolveDeepLink`）——
  抄老实现 `src/web/frontend/activeView.js` 的纪律（「兜底不该兜的时候兜了」在这项目反复出过事）。
- 复用已打开的面板时**同步页签名**（条目改名 / 深链给的标题与旧页签不一致时，
  否则两个面板同名，分不清谁是谁）。

## 块编辑（R20 起：斜杠菜单 + 转类型 + 上移下移）

块的五个面板动作，全部落到设计 §九 9.2 的**五条 action**：

| 面板动作 | action | 实测 |
| --- | --- | --- |
| 尾部加块 | `entry.block.add` | 新块是**空块**（有占位提示「空段落 · 双击编辑，输入 / 选类型」） |
| 块内文字可编辑 | `entry.block.update` | 双击进入，Enter 提交 / Esc 取消 |
| **转类型**（斜杠菜单） | `entry.block.update`（**整块替换**） | 菜单里标出「当前」与「文本会丢」 |
| 上移 / 下移 | `entry.block.move --to <index±1>` | 与拖拽是同一动作的两个入口 |
| 删除块 | `entry.block.remove` | 语义红 |

- **空块里打 `/` → 开块类型菜单**（非空块里 `/` 是正文的一部分，不触发）。
- **转换是有损的，必须标出来**：只有文本型（段落/标题/图文）能保留原文，
  转成结构型（表格/清单/附件/密文/栏目/列）**文本会丢** —— 菜单里逐项标。
- **转换是整体替换不是合并**：否则 table → paragraph 之后块里还挂着 `columns`/`rows`。

## 附件指派（R21 起：指派发生在块里）

`file` 块与 `file` 字段的值都是**附件 id 的列表**（不是文件名/路径/文件对象）。

- **选择面板，不是下拉框**（40-files.md 的规矩）：
  可搜索（名称/标签）、**未引用优先**（已引用的排后面并标「已被 N 处引用」，仍可选——同一原件可共享）、
  点一行即追加（可连点多个）、已挂上的从列表里消失、逐行移除（附件本身还在库里）。
- **上传入口在块编辑器里**（附件中心只做库存展示 + 「只看未引用」筛选）：
  上传 = 先进库 → 立刻挂到当前块（真实实现对应 `file add` + `entry block update`）。
- **引用关系不存库，现算**：两种引用都算（file 块 + file 字段）。
  存了就会和块里的 id 脱节——块里摘掉了、库里还记着「被引用」，「清理未引用」就会删错东西。
- 库里没有的 id 渲染成「未知附件 <id>」，不静默消失。

## 键位、无障碍与布局导入导出（R22）

**键位**（设置面板里有一张表，没人知道的快捷键等于没有）：

| 键 | 动作 |
| --- | --- |
| `Ctrl+Delete` / `F2` | 关闭页签 / 重命名 |
| `F6` | 焦点在「选中的页签按钮 ↔ 面板内容」之间切换 |
| `Ctrl+F6` / `Ctrl+Shift+F6` | 焦点移到下/上一个面板组 |
| `Escape` | 关闭浮层 |

**「假控件」纪律**：可点击的东西必须是真按钮（`role="button"` + `tabIndex=0` + Enter/Space 触发）。
原型里所有 chips 统一走 `ui.jsx` 的 `Chip` 组件——裸 `<span onClick>` 是「看着像按钮、用起来不是」。

**布局导入导出**：「布局 JSON」面板里 `复制` / `粘贴导入（应用）` / `重置布局`。
坏 JSON **明确报错**（语义红）、当前布局保持不变，**不吞掉整台应用**。

## 原型制作规则

1. **原型与源码同源**：字段清单、打码长度、类型语义都回读 `src/core/fields.js` / `src/core/crypto.js` 核对
   （打码规则 = `maskValue`：≤10 位全星，否则首 4 + 星 + 尾 4）；
2. **改布局 = 改模型**：任何布局调整都必须落到 `Actions.*`，不许直接改节点属性；
3. **不模拟参考库的行为**：FlexLayout 有的能力直接用，不自己仿一个；
4. **词汇表不另发明**：块类型名 / 字段类型名 / CLI 参数名，一律回读设计文档与源码；
5. 示例数据用「字段样例」的真实播种值（`DEMO_FIELDS` / `DEMO_TABLE_COLUMNS`）；
6. 已知简化写在文件头注释里，不藏在心里。

## 已知简化（本原型没做到的事）

- **不落盘**：数据在内存里（`src/data.js` + React state），改条目/改归属/改块只改内存；
  真实实现走 `entry update` / `entry update --section` / `entry block move`。
- **块编辑没有撤销**：菜单里的转类型/删除一旦做了就做了（真实现走 CLI 有 store 备份与 `transfer export` 兜底）。
- **AI 的「模型」是假的**：pending / 冲突 / 隔离都是真的（真落盘、真算哈希、真 grep），
  但「生成建议」是原型自己编的改写方案——真实现要调外部模型，pending 的形状不变。
