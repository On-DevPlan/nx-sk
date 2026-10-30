# nx-sk 块级重构 · 落地计划

> 配套：设计总纲 [`00-design.md`](00-design.md)（**以 §十六 原型落地修订 v3 + §十五 架构修订 v2 为准**）｜原型 [`prototype/`](prototype/)（**真跑 flexlayout-react 的应用**，R12 起）｜迭代日志 [`log.md`](log.md)
> 目标产物：类 Notion 的面板 —— **递归块**（栏目本身是块）+ **Notion 式侧边栏树**（栏目可内嵌成数据库视图）+ **所有层级可拖拽**（FlexLayout 管整个壳）。
> 约束：只做加法（老 store 一个字节不用改）；CLI 侧零依赖不变；一条 action 双端；安全三出口不变。

## 〇、一页速览

| | 内容 |
| --- | --- |
| **不做什么** | 不改栏目的数据语义（仍是「栏目 = 字段字典 + 条目」）；不做多人/云同步；不做移动端布局；不引入新的加密算法；不引入前端框架（React 已是） |
| **最大的风险** | 不是技术，是**范围**：块 + 视图 + 侧边栏 + 拖拽 + AI 五件事一起上会失控 → 用 S0–S5 分期，每期独立可发布、可停 |
| **最重要的纪律** | 每期结束跑 `pnpm test`（= lint + build + smoke + unit）；**A07 的 12 处触点逐条对账**，其中「3 处静默」要么不触发、要么补断言 |
| **本次不新增模块** | 块与视图挂在既有 `entries` / `sections` 模块 → A07 的第 4/5/6/7 处（后端注册表、前端 VIEWS、`src/index.js` export、eslint 禁列）**不触发**；但**新增一个 core→shared 依赖边**（见 S1 触点 1），要在 eslint 注释里登记 |

## 一、已核实的事实（计划的依据，全部落到 file:line）

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| `normalizeEntry`/`normalizeSection` 是**白名单重建**，未知键被丢弃 | `src/core/store.js:68-79` / `43-66` | `body`/`views` 必须显式进 normalize，否则一次写回即丢（**已发生过的设计事故**） |
| `normalize()` 无条件写回 `base.version = STORE_VERSION`；`loadStore` 只有 `oldVersion < STORE_VERSION` 分支 | `store.js:179` / `234` | 降级方向零防护 → 必须 bump 到 v4 + 拒写守卫 |
| 三段式 CLI 合法（最长前缀匹配、不限段数） | `src/runtime/cli.js:168-179` | `section view add` 这类命名合法 |
| 路由按**字面量段优先**排序 | `src/runtime/spec.js:157-169` | 新增 `:ref` 之后的字面量段不会被遮蔽 |
| 密文四件套：`encryptValue`/`decryptValue`/`maskValue`/`looksMasked`；`maskValue` **≤10 字符 = 同长度全星** | `src/core/crypto.js:28-73` | 块复用同一套；打码长度是硬规则，原型必须对齐 |
| 掩码写回规则：**打码值 == 原密文的 maskValue → 保留原密文**；否则打码占位被拒 | `entries/service.js:411-429` | 块级同构，且按 `blockId` 精确认领（表格做不到，见下） |
| 表格敏感列的密文认领**只能按值猜 + 行号兜底**，源码自陈已知限制 | `entries/service.js:383-388` | 块级没有这个限制（设计优势） |
| `plainValues` 解密顶层敏感字段与 entrylist 子值，**无 table 分支** | `src/modules/transfer/service.js:55-87` | **既有缺陷**：0.19 的 table 敏感列导出是密文 blob，跨机器导入永远解不开 → S1 顺带修 |
| 包 manifest **没有版本字段**；外层加密包 = `payload.enc` | transfer/service.js:257, 736 | S5 加 `manifest.formatVersion`（缺失 = 1） |
| settings 键是**白名单** `SETTING_KEYS`，每键有 coerce | `src/modules/settings/service.js:7, 17-19` | `navTree` 必须加键 + `coerceNavTree`（对齐 `coerceNavGroups`） |
| 一致性测试的五组断言 | `tests/unit/consistency.test.mjs:27,33,53,70,83,105` | 每条新 action 都要满足「CLI + HTTP 两端齐备」等既有约束 |
| 面板 bundle 现状 ~480KB JS | 实测 `src/web/public/assets/` | 新依赖的体积预算见 §六 |
| 视觉语言六条铁律（单色无 emoji / 唯一语义红 / 立体感只给可交互元素 / 28px·32px·12px / 1px 底线） | `src/web/frontend/styles.css:1-29` | 原型与实现都按它走；**不引 FlexLayout 自带主题** |

## 二、分期总览

| 期 | 目标 | 主要产出 | 依赖 | 可发布判据（一句话） |
| --- | --- | --- | --- | --- |
| **S0** | 验证「块 = 字段值」这个赌注 | 纯前端原型（不落盘） | 无 | 手感对不对，值形状够不够当块 |
| **S1** | 块内核落地 | `shared/blocks.js` + 7 条 action + 详细页 + v4 守卫 + 顺带修 table 导出缺陷 | 无 | CLI 建块 → 面板看到 → 导出再导入还在 |
| **S2** | 数据库视图 | `section.views` + 5 条 view action + 表格视图 | S1 | 一个栏目两种视图切换，数据同源 |
| **S3** | 全域拖拽 + Notion 式壳 | dnd-kit + FlexLayout + 侧边栏树 + 容器块 + 看板 | S1 S2 | 每种拖拽都有落点反馈；布局可存可恢复 |
| **S4** | 块级 AI | AI Bar + pending diff（应用/拒绝） | S1 S3 | AI 改块必有「应用/拒绝」，pending 不落 store |
| **S5** | 兼容与收尾 | 包版本字段 + 降级守卫提示 + 文档 | S1–S4 | 旧包→新库、新包→旧库（警告）、降级拒写 |
| **S6** | *可选*：整壳迁移（顶部导航也进 FlexLayout） | — | S3 验证 | 只在 S3 验证后决定，默认不做 |

## 三、S0 · 尖锐原型（不落盘）—— **R12 已换载体**

| 项 | 内容 |
| --- | --- |
| 目标 | ① 验证「块 = 字段值」：现有 `md`/`table` 字段值**直接**当块渲染够不够？表格的自描述文档能不能当块值？（整个重构最大的赌注）② 验证「壳的手感」：栏目只在侧边栏 + 工作区可编排，值不值得做成这个形态 |
| **载体（R12 起）** | [`prototype/`](prototype/) —— **真跑 `flexlayout-react@0.11.1` 的独立 vite 应用**（`pnpm proto:dev`）。R1–R11 那套静态 HTML 原型**已整体作废**：它自己发明了布局 JSON 的形状、自己仿了停靠语义，验证不了任何东西（详见 `00-design.md` §十六.1） |
| 触点 | **主应用零触点**（原型是独立 root，不动 `src/web/frontend`）。根 `package.json` 加 **devDependencies**：`flexlayout-react` / `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities`（S3 落地时把 flexlayout-react 移到 dependencies） |
| 数据变更 | **无**（不落盘、无 action、无新字段；数据在原型内存里） |
| 测试 | 无（一次性验证） |
| 验收 | ① 目录树点栏目 → 工作区新开数据库面板；② 拖页签到四边真拆出新面板；③ 撤销/重做可用；④ 详情页里 md/table 字段值直接当块渲染并能拖动排序；写下结论：**哪些值形状不合格**（例如 md 的图片引用、entrylist 的行结构） |
| 回退 | 删掉 `prototype/` 目录 + 根 devDependencies 即可，主应用无残留 |

## 四、S1 · 块内核

**数据变更**：`entry.body?: Block[]`（块可含 `children`，递归）｜`STORE_VERSION` 3 → 4（**无迁移函数**：只加可选键）｜`normalizeEntry` 加 `body`

| # | 触点 | 改什么 | 漏了会怎样 |
| --- | --- | --- | --- |
| 1 | `src/shared/blocks.js`（新增） | `BLOCK_TYPES`（v1 七种叶块；容器块 `section/column/toggle` 留 S3）、`normalizeBlock`（递归）、`validateBlocks` | 校验无处可去 → 前后端各写一份（table.js 的教训） |
| 2 | `src/core/store.js` | `normalizeEntry` 加 `body`；`STORE_VERSION = 4`；`loadStore` 加 `oldVersion > STORE_VERSION` 分支 → **拒绝写入**（`BLOCKED`） | ① 未知键被白名单丢弃 → 块写一次就没了 ② 降级运行静默丢数据 |
| 3 | `src/core/store.js` ← `src/shared/blocks.js` | **新增一条 core→shared 依赖边**（lint 允许，但要在 `eslint.config.js` 的说明里登记一句） | 分层规则对新边不可见（README 坑：漏补是静默的） |
| 4 | `src/core/attachments.js` | 引用扫描纳入 `file` 块 | 附件被 `file cleanup` 误删 |
| 5 | `src/modules/transfer/service.js` | ① `referencedFileIds` 纳入 `file` 块；② **顺带修 table 敏感列不解密的缺陷** | ① 导出包漏原件 ② 跨机器导入永远解不开 |
| 6 | `src/modules/entries/service.js` | 块 CRUD service（list/add/update/move/remove/removeMany）+ `prepareBlockValue`（密文/掩码认领，按 `blockId`） | 掩码写回毁凭据（README 坑：永久丢失） |
| 7 | `src/modules/entries/index.js` | 7 条 action 声明（§九 9.2） | 面板能做的 CLI 不能做 → 破不变量① |
| 8 | `src/core/vault.js` / `src/core/render.js` | ① `sensitiveViewer` 扩展到 `secret` 块（0.19 已扩到表格密文列）；② `serializeEntry` 输出 `body`（自描述文档；表格块的算法仍在 `shared/table.js`，这里只做序列化） | ① 密文块渲染成 blob ② `entry get` / `section dump` 拿不到正文 |
| 9 | `src/web/frontend/blocks/registry.js`（新增） | 块渲染注册表（`type → {render, editor, label}`）——**只管渲染** | 渲染散落各处，加一种块改 N 个文件 |
| 10 | `src/modules/entries/view.jsx` | 详细页：属性区（现有 `FieldGroup`）+ 块正文（七种叶块） | 详细页与数据库页无从谈起 |
| 11 | `src/web/frontend/styles.css` | 块卡片、handle、工具条样式 | — |
| 12 | 测试 + 文档 | 新增 `tests/unit/blocks.test.mjs`、`store-version.test.mjs`、`block-crypto.test.mjs`；`tests/smoke.mjs` 加块 CRUD 冒烟；`assets/nx-sk/references/15-special-fields.md` 补「块」；README 命令总表；CHANGELOG | 三个静默处没人发现（A07 第三节） |

**不触发**（因不新增模块）：`src/runtime/registry.js` 的 `MODULES`、`src/web/frontend/registry.js` 的 `VIEWS`、`src/index.js` 的 export、`eslint.config.js` 的互依禁列。

**验收**：`pnpm test` 全绿；`nx-sk entry block add` → 面板看到 → `nx-sk transfer export` → 新库 `import-new` → 块还在；用 0.20 的老代码读新 store → **写被拒**（不是静默丢）。

## 五、S2 · 数据库视图

**数据变更**：`section.views?: ViewConfig[]`｜`section.defaultView?: string`｜`normalizeSection` 加 `views`

| # | 触点 | 改什么 |
| --- | --- | --- |
| 1 | `src/core/store.js` | `normalizeSection` 加 `views` / `defaultView` |
| 2 | `src/modules/sections/service.js` | 视图 CRUD + **缺省推断**（`views` 缺席时读取层给一个表格视图，不落盘） |
| 3 | `src/modules/sections/index.js` | 5 条 view action（§九 9.3） |
| 4 | `src/modules/entries/view.jsx` | 数据库页：视图 chips + table 视图（列 = 字段投影） |
| 5 | `src/web/frontend/components/viewChips.jsx`（新增） | chips 组件（表格 / 精简 / 看板·S3 / KV） |
| 6 | 测试 | `tests/unit/views.test.mjs`：缺省推断、投影降级（字段被删 → 「已删字段」占位）、`set-default` |

**验收**：一个栏目两种视图切换、同一批数据两种投影；删掉某字段后旧视图不炸。
**回退**：`section.views` 是可选键，删掉即回到今天的单版式。

## 六、S3 · 全域拖拽 + Notion 式壳 + 容器块 + 看板

**依赖**（只进前端 bundle，CLI 侧零依赖不变）：`flexlayout-react`、`@dnd-kit/core`、`@dnd-kit/sortable`

| # | 触点 | 改什么 | 备注 |
| --- | --- | --- | --- |
| 1 | `package.json` / `pnpm-lock.yaml` | 把 **S0 已加进 devDependencies** 的 `flexlayout-react` / `@dnd-kit/*` 移到 dependencies（S0 为原型先行加的） | 版本以实测为准；记录构建后体积 |
| 1b | `src/web/frontend/` 布局壳 | **直接搬原型**：`workspace.js`（模型 + 落盘）、`registry.jsx`（面板注册表）、`shell.jsx`（顶栏 + Layout + 抽屉） | 原型已是真跑 FlexLayout 的应用，S3 是把它接上真数据，不是重写 |
| 1c | `src/web/frontend/` 撤销/重做 | 用 `useUndo`（flexlayout-react 自带），顶栏给按钮 | 「整段拖拽折叠成一步」已实现，不要另造 |
| 1d | `src/web/frontend/store.jsx` | `ui.workspace` 键存 `model.toJson()`；`ui` 里加 `viewId` / `peekOpen` | 布局 = 模型，存的是模型不是画出来的状态 |
| 2 | `src/web/frontend/App.jsx` | **顶部栏改写（§十五 15.1）**：移除栏目 tabs，只留全局动作（品牌 / 搜索 / 打码 / 面板抽屉 / 设置入口）；导航模型降级为「目录树的数据源」 | 栏目又出现在顶部 → 两处入口分叉 |
| 3 | `src/web/frontend/components/sidebar.jsx`（新增） | Notion 式树：栏目节点（展开 / 条目子节点 / 紧凑数据库形态 / 拖拽重排 / 嵌套子目录 / 隐藏）+ 条目节点拖拽（改归属，二次确认） | 两类拖拽语义**必须分开** |
| 4 | `src/web/frontend/components/navTree.js`（新增） | **纯函数**：树移动 / 嵌套 / 降级（栏目被删自动略过）+ **从老三套配置推断出一棵树** | 可单测（同 `activeView.js` 的做法） |
| 4b | `src/web/frontend/components/navModel.js` | 角色变更（§十五 15.6）：从「头部导航模型」降为「目录树数据源」；分组/隐藏/排序的读路径改走 navTree | 旧的分组渲染路径还在跑 → 顶部与侧边栏两套显示配置 |
| 5 | `src/modules/settings/service.js` | `SETTING_KEYS` 加 `navTree` + `coerceNavTree`（对齐 `coerceNavGroups`）；**并实现「从老三套推断出一棵树」**（`navGroups`/`navHidden`/`navOrder` → 树，只读推断不写回，老用户显示配置不丢） | 不加键 → `setting set --set navTree=…` 直接报错（安全失败）；不推断 → 老用户打开面板发现分组没了 |
| 6 | `src/web/frontend/store.jsx` | ui 键：`viewId` / `peekOpen` / `workspace`（布局 JSON，存 localStorage） | `patchUi` 只持久化「跨会话有意义的选择」 |
| 7 | `src/web/frontend/activeView.js` | `parseHash(hash)` 纯函数：两段（栏目 / 条目）；`resolveActiveView` 语义改为「**当前打开的栏目 id**」（深链 `#/栏目id` 指向目录树里那个栏目的数据库面板），优先级不变 | 深链 > 本次选择 > 默认栏目 > 第一个 tab 的优先级不变（`activeView.js:1-9` 的教训：兜底不该兜的时候兜了） |
| 8 | `src/web/frontend/components/blockDnd.jsx`（新增） | dnd-kit 包装：块顺序 / 看板卡片顺序 / 列顺序 | **dnd-kit 管顺序，手写管尺寸**；原型里这三处拖拽已跑通（`prototype/src/panels/{detail,board,sidebar}.jsx`），实现期照搬语义 |
| 8b | 面板抽屉 | 停靠位置 chips → `Actions.addTab(json, target, DockLocation.getByName(loc), -1, true)` | `DockLocation` 是 FlexLayout 的枚举，别自己发明 left/right/top/bottom |
| 9 | `src/web/frontend/styles.css` | FlexLayout 主题覆写（**不引自带主题**）+ 侧边栏样式 | 保「单色 + 唯一语义红」 |
| 10 | `src/shared/blocks.js` | 容器块 `section`（内嵌栏目数据库视图）/ `column`（子列 + 列宽）；`toggle` **下一版** | 递归的第一次真用上 |
| 11 | `src/modules/entries/view.jsx` | 详细页接 dnd-kit；board 视图（拖卡 = `entry update --set`） | 拖卡必须走写 action，不是本地态 |
| 12 | 测试 | `tests/unit/nav-tree.test.mjs`（树操作纯函数）；`tests/smoke.mjs` 加「拖卡改值」的 CLI 等价断言 | DOM 拖拽靠手测脚本，不硬凑单测 |

**验收**：每种拖拽都有落点反馈；侧边栏能拖宽/折叠/拖出；布局 JSON 存 localStorage 并能恢复；树操作有单测。
**回退**：拖拽层可整体关掉（保留只读视图）；版本回退会被 D5 守卫拦（这是有意的，需在 CHANGELOG 说明）。

## 七、S4 · 块级 AI

**关键设计（解决一个真矛盾）**：§十 10.7 要求 pending **不落进 store.json**（可能含明文密钥），但 CLI 是**无状态进程**——pending 必须能跨进程可见才能让 agent 与面板共用同一套语义。

→ **pending 落独立运行态目录 `~/nx-sk/pending/`**（单文件一个 pending，`0700`）：不进 `store.json`、不进导出包、不进备份；删目录即清空；CLI 与 HTTP 服务端读同一目录（同一台机器）。

| # | 触点 | 改什么 |
| --- | --- | --- |
| 1 | `src/core/paths.js` | `pendingDir()` 常量（A07 第 8 处：散落字面量路径的正解） |
| 2 | `src/modules/entries/service.js` | pending 服务：请求（调 AI）→ 落 pending 文件 → 查询 → 应用 / 拒绝 |
| 3 | `src/modules/entries/index.js` | `entry ai suggest` / `entry ai apply` / `entry ai reject`（3 条，两端齐备） |
| 4 | `src/web/frontend/components/aiBar.jsx`（新增） | AI Bar（空格唤起）+ diff 渲染（红删 / 绿增 / 新增淡绿 / 删除置灰）+ 顶部「应用全部 / 拒绝全部」 |
| 5 | `src/shared/blocks.js` | pending 的 diff 结构校验（块 id + 字符级 segments） |
| 6 | 测试 + 文档 | `tests/unit/ai-pending.test.mjs`（状态机 + **断言 pending 不在 store.json、不在导出包**）；skill ref 补一节 |

**验收**：AI 改块必有「应用/拒绝」；应用后块内容 = diff 合并结果；拒绝后内容不变；`grep` store.json 查不到 pending 文本。
**回退**：pending 是目录级运行态，删目录即清空；功能可整段关掉。

## 八、S5 · 兼容与收尾

| # | 触点 | 改什么 |
| --- | --- | --- |
| 1 | `src/modules/transfer/service.js` | `manifest.formatVersion`（缺失 = 1）；导入按版本分支；**新包导旧库时警告「块正文/视图配置已忽略」**（不静默丢） |
| 2 | `src/modules/transfer/service.js` | 导出预览的掩码统计扩到块（否则预览说「明文随包」而包里有掩码） |
| 3 | `src/core/store.js` | 降级守卫的用户提示（bootstrap 展示「store 由更新版本写入」） |
| 4 | `assets/nx-sk/references/` | `15-special-fields`（块）、`10-sections-entries`（视图）、`60-transfer`（包版本） |
| 5 | `README.md` / `CHANGELOG.md` | 命令总表、破坏性变更说明（降级拒写、table 缺陷修复） |

**验收矩阵**：

| 场景 | 期望 |
| --- | --- |
| v3 store → v4 程序 | 正常读写；`body`/`views` 缺席即缺省 |
| v4 store → v4 程序 | 正常 |
| v4 store → **v3 程序** | 读得到；**写被拒**（`BLOCKED`，提示升级） |
| 旧包（无 formatVersion）→ 新库 | 视为 v1：无 body/views，按缺省落库 |
| 新包 → 新库 | 正常，body/views 还原 |
| 新包 → **旧库** | 丢弃 body/views **并警告** |

## 九、S6（可选）：整壳迁移

把顶部导航也放进 FlexLayout（面板化）。**只在 S3 验证后决定**，默认不做 —— 顶部导航是数据驱动且有单测钉住（`App.jsx:21-52`、`tests/unit/active-view.test.mjs`、`nav-model.test.mjs`），换壳要连规则带测试一起搬。

## 十、测试计划

| 文件 | 类型 | 覆盖 |
| --- | --- | --- |
| `tests/unit/blocks.test.mjs` | 新增 | `normalizeBlock` 递归、类型白名单、heading 校验、块 id 全局唯一、children 深度 |
| `tests/unit/block-crypto.test.mjs` | 新增 | secret 块：掩码写回按 `blockId` 认领原密文；打码占位被拒；含 `******` 的值拒绝写回 |
| `tests/unit/store-version.test.mjs` | 新增 | v3 → v4 读；**v4 store 被 v3 逻辑读时写被拒**；v3 store 写入后 version=4 |
| `tests/unit/views.test.mjs` | 新增 | 缺省视图推断（不落盘）、投影降级（字段被删）、`set-default`、删除全部视图后回退缺省 |
| `tests/unit/nav-tree.test.mjs` | 新增 | 树移动 / 嵌套 / 拖出 / 栏目被删自动略过 / 两种拖拽语义分离 |
| `tests/unit/table-export-secrets.test.mjs` | 新增 | **回归**：table 敏感列导出为明文（守住 S1 的缺陷修复） |
| `tests/unit/consistency.test.mjs` | 既有 | 新 action 的 CLI+HTTP 两端齐备（既有断言自动覆盖） |
| `tests/smoke.mjs` | 既有 + 扩 | 块 CRUD、视图 CRUD、`body` 缺席读取、导出→导入往返（块与视图都在）、降级拒写 |
| 手测脚本 | 人工 | 拖拽手感（块 / 列 / 卡片 / 树 / 分割条）、FlexLayout 停靠与浮窗 |

## 十一、风险登记与回退

| # | 风险 | 征兆 | 防线 | 回退 |
| --- | --- | --- | --- | --- |
| R1 | normalize 漏加键 → 块写一次就没 | 数据静默消失 | `store-version.test.mjs` + `blocks.test.mjs` | 该键可选，删掉即回到今天 |
| R2 | 掩码写回毁凭据 | 存进去的是 `sk-1****cdef` | `block-crypto.test.mjs` | 密文块按 `blockId` 认领，认不到就拒收 |
| R3 | 导出丢密文（table 缺陷） | 跨机器导入解不开 | `table-export-secrets.test.mjs` | 导出前先 `transfer export`（唯一回退手段） |
| R4 | 降级运行丢数据 | 老版本静默抹掉新键 | D5 拒写守卫 | 升级 nx-sk；或人工备份 store.json |
| R5 | bundle 膨胀首屏变慢 | 首屏明显变慢 | 记录构建体积；FlexLayout 按需 lazy | 去掉 FlexLayout（布局退回单栏） |
| R6 | 递归块撑爆 store.json | store 文件异常变大 | 体积监控 + `transfer export` 归档 | 清 body（块可再生） |
| R7 | 侧边栏树与栏目删除不同步 | 树里出现空节点 | 读时自动略过（`navGroups` 先例） | 清 `settings.navTree` |
| R8 | AI pending 泄漏明文 | store.json / 导出包里出现明文 | pending 独立目录 + 不落盘断言 | 删 `~/nx-sk/pending/` |
| R9 | 范围失控 | 一次提交改五件事 | 分期、每期独立可发布 | 停在任一期 |

## 十二、依赖与体积预算

| 项 | 现状 | 新增 | 说明 |
| --- | --- | --- | --- |
| 前端 JS | ~480KB（实测 `src/web/public/assets/`） | `flexlayout-react` ≈ +100~150KB；`@dnd-kit/core`+`sortable` ≈ +30~50KB | **量级估计，以实测构建为准**；本地面板无带宽压力，但首屏变慢要写进 CHANGELOG |
| CSS | 31KB（index-CYX-3oPr.css） | FlexLayout 主题**不引**（只引 JS，自写覆写） | 避免第二套视觉语言 |
| CLI 侧 | **零依赖** | **零** | 新依赖只出现在 `src/web/frontend/**` 与 `src/modules/*/view.jsx` |

## 十三、执行顺序速查（下一位执行者照着做）

1. 读 `00-design.md`（**§十三 为准**）与 `prototype/README.md`；
2. 按 S0 → S5 逐期做，**每期结束跑 `pnpm test`**；
3. 每期对照本期的「触点表」逐条打勾（A07 的 12 处 + 本项目特有的 4 处）；
4. 每期在 `log.md` 追加：改了什么 / 为什么 / 推翻了什么 / 遗留；
5. 破坏性改动前先 `nx-sk transfer export` —— 导出的包是**唯一回退手段**；
6. 任何与设计冲突的实现发现，**先改设计再改代码**（设计文档是唯一事实源）。
