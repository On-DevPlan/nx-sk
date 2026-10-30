# 迭代日志（rp-loop · block-refactor 设计优化）

> 每轮追加一段：本轮改了什么 / 为什么 / 推翻了什么。循环的记忆在这里与 00-design.md。

## 基线（布防前）

- 从会话讨论沉淀 `00-design.md` v0：概念映射（Property/Block 二分）+ L1-L4 目标架构 + 五条红线 + S0-S5 分期 + 四个开放问题。
- 参考输入已就位：FlexLayout 已克隆至 `.claude/repo/FlexLayout` 并登记 git.remote；本地 demo（Flutter 块编辑器）已通读。
- 设计中部分断言只到 README 层面（未逐行对源码），由后续轮次按议程逐层落实到 file:line。

## R1 · 拍板四问 + 原型信息架构

- 四个开放问题全部拍板，落 00-design.md §七：
  - **D1** 详细页 = 非 kv 栏目全量（kv 保持表格内联），不设栏目级开关——依据 `entries/view.jsx:24-32` 栏目本就按形状分两种布局，详细页是渲染升级、零迁移；否决 opt-in（第三个特性位的 sync/transfer/settings 链路成本）与 kv 页面化。
  - **D2** board 放 S3 与拖拽基建同期——没有拖拽的看板不如分组筛选；否决 S2 半成品看板。
  - **D3** 依赖定案 `flexlayout-react` + `@dnd-kit/core` + `@dnd-kit/sortable`——bundle 基线 ~480KB（实测 `src/web/public/assets/`）无压力；eslint 前端边界（`eslint.config.js:94-102`）不禁 npm 包；否决全手写与「FlexLayout 兼管块拖拽」。
  - **D4** FlexLayout 只管栏目工作区，整壳迁移 = S6 可选——顶部导航数据驱动且有单测钉住（`App.jsx:21-52`、`tests/unit/active-view.test.mjs`、`nav-model.test.mjs`）；否决整壳换。
- **新事实**：当前条目页已是「左列表 + 右表单」双栏、分割条可拖宽（`entries/view.jsx:55-80`，`ui.listW` 持久化）——数据库页 + side-peek 有直接前身，不是外来范式。
- 产出 `prototype/README.md`：视觉语言六条（styles.css:1-29）+ 六画面导航图 + 覆盖矩阵 + 制作规则。
- 推翻：无。基线方向全部站住了。

## R2 · 数据模型 schema + database.html 骨架

- **抓到一个真腐蚀点**：`normalizeEntry` / `normalizeSection` 是白名单重建（`store.js:68-79` / `43-66`）——基线假设「`body`/`views` 可选字段直通存活」**不成立**，不显式加键就会在第一次写回时被静默抹掉。已落 00-design.md §八 8.0（normalize 两行改法 + 不 bump STORE_VERSION 的论证 + 降级丢数据风险登记给 R5）。
- schema 定稿（§八）：`Block = {id:'b_*', type, value}`，v1 七种块类型**全部复用字段值形状**（paragraph/heading/md/table/entrylist/file/secret），仅 heading 是新形状（三行校验）；内核落位 `src/shared/blocks.js`（同 table.js 的 shared 理由：校验前后端同源，「写入即体检」）。`ViewConfig` **只存投影**（key/width/hidden），类型/标签回查字段字典——单一事实源，避免 README「字段字典两处漂移」教训。
- 复用性对账（§八 8.1 表）：md→mdimages 重映射、table→table.js 全内核、file→attachments 引用扫描、secret→vault 同路径，四条全部有现行机制接住，transfer 零新增。
- 交付 `prototype/database.html`：表格视图骨架（列头=字段投影+类型弱标注、视图 chips（看板标 S3）、搜索过滤、行选择、side-peek 占位、状态条 CLI 提示），视觉 token 逐条对齐 styles.css:11-29。
- 遗留：version>3 时迁移器行为、blocks.js 分层定稿 → R3；sensitiveViewer 扩展 → R4。
- 推翻：1 条（8.0 的白名单假设）。

## R3 · action 契约 + 降级守卫决策 + kv.html / 视图切换

- **三项可行性核实（全过）**：① 三段式 CLI 合法——`resolveCommand` 最长前缀匹配不限段数（`cli.js:168-179`）；② 新路由无遮蔽——`compareRoutes` 字面量段优先（`spec.js:157-169`），`blocks/remove-many` 与 `blocks/:blockId` 是 entry.remove-many 同模式；③ 降级场景**无任何现有守卫**：`normalize()` 无条件写回 `base.version = STORE_VERSION`（`store.js:179`），`loadStore` 只有 `<` 方向的迁移分支（`store.js:234`）。
- **D5（推翻 R2 结论）**：`STORE_VERSION` 3→4，理由是**降级守卫**而非迁移——不 bump 则块时代的 store 被老代码读后静默丢 body/views 且无从警告。S1 落地：bump + `oldVersion > STORE_VERSION` 拒绝写入（BLOCKED），读不受限。已同步修正 §八 8.0。
- **action 契约定稿（§九）**：块 7 条（body.get / block.add·update·move·remove·remove-many / entry.table 加 --block）+ 视图 5 条（view.list·add·update·remove·set-default）；错误码全部映射到现有六码；「列宽拖拽结束 = 一次 update」、临时值归 ui（listW 先例）。
- 原型：新增 `kv.html`（KV 视图：仅一枚 KV chip、打码开关含 ≤10 字符全星、行内编辑、语义红删除）；`database.html` 升级——「精简」第二视图演示**同数据多投影**，chips 可切换。
- 推翻：1 条（D5 对 R2「不 bump」的推翻——两次核实都是先读源码再下结论，白名单教训的重复应用）。

## R4 · 安全边界推演 + detail.html 骨架

- 通读安全四件套（crypto.js 全文 + entries/service.js:310-429 写路径 + vault.js 导出面 + render.js:101-105 读路径），落 §十：
  - 块复用**同一套**加密原语，不新造：`encryptValue` 的落盘形状与 secret 字段完全一致（store.json 里看不出差别）；kid 不符 / 密文损坏都是现成的 `BLOCKED`。
  - **块不做「键名像凭据」自动判定**（字段侧有 `looksSecretish → secret`，entries/service.js:90；块没 key，按内容猜的后果是「用户再也解不开自己的块」）→ 块的密文属性只由显式 type 决定。
  - **块级比表格安全一档**：表格的密文认领只能「按打码值猜 + 行号兜底」，源码自陈其已知限制（prepareTable 注释 383-388：打码状态下拖行、两格打码值相同 → 认不出谁是谁）；**块有稳定 id，按 blockId 精确认领**，move 不影响认领——这个限制在块级不存在。
  - 导出三出口对齐：包恒明文（secret 块导出时**必须解密写出**，否则包里是用户读不懂的 blob）、导入重新加密、外发必须 `--passphrase`；pending AI diff **不落盘**（可能含明文密钥）。
  - file 块的附件 id 计入正式引用（对齐 0.20 的 source 袋 file 先例），否则 file cleanup 会误删。
- **自查抓到原型自己的错**：kv.html 把 `maskValue` 的短值写成固定 `***`，实际是 `crypto.js:71` 的 `'*'.repeat(len)`（同长度全星）→ 已改。原型与源码不同步正是 R9 要系统性查的东西，先自查到一处。
- 交付 `prototype/detail.html`：面包屑 + 属性区分组表单（空值显示「未填」弱提示）+ 块正文（段落/标题/图文/表格含计算列与表尾合计/附件/密文）+ 侧栏条目信息 + 密文边界说明；块选中态显示 handle 与工具条。
- 遗留：transfer 导出器对 secret 的实际分支、导入对明文 secret 的处理、包格式版本 → R5。
- 推翻：0 条；修正 1 处原型错误。

## R5 · 迁移兼容矩阵 + detail.html 块交互

- 核实 transfer 导出器（`transfer/service.js`）：`plainValues`（55-87）**确实解密写出** → 证实 §十 10.4 的假设；导入端对含 `******` 的值**跳过该字段**（587-594），不是当成明文存。
- **⚠ 抓到既有缺陷（非本次重构引入）**：0.19 新增的 `table` 类型支持 `sensitive: true` 列，其单元格写入时是密文 blob（`entries/service.js:378-381`），但 `plainValues` **全文没有 table 分支** → 导出包里表格敏感列是密文 blob，导入到另一台机器（另一把密钥）永远解不开——正是该函数自己注释（66-67）担心的情形，只是发生在 table 上。归属：0.20 的缺陷，建议 S1 顺带修并在 CHANGELOG 明写。已落 §十一 11.5。
- 矩阵落 §十一：版本阶梯（v1→v4，**v3→v4 无迁移函数**——只加可选键）、body 缺席的 7 条读路径行为、transfer 包兼容矩阵（新增 `manifest.formatVersion`，缺失 = 1）、降级矩阵（读放行 / 写被 D5 拦）、导出掩码统计要扩到块（否则预览说「明文随包」而包里有掩码）、file 块要进两处附件引用扫描（`referencedFileIds` 与 `attachments.js:166-181` 的反向链接）。
- 澄清一个疑似缺口并排除：`TABLE_CELL_TYPES`（table.js:24）不含 file，故表格不涉及附件引用，无需改。
- 原型 `detail.html` 升级为可交互：原生 HTML5 DnD 拖拽重排（handle 拖起 + 落点上/下半区判定）、斜杠菜单（6 种块类型，每项标注等价 CLI 参数）、尾部加块区、悬浮工具条、插入后选中并滚动就位。
- 推翻：0 条；新增 1 个待修缺陷（11.5）。

## R6 · 前端架构 + workbench.html

- 读了前端三处落点：`store.jsx`（DEFAULT_UI / patchUi 只持久化「跨会话有意义的选择」、当前 tab 归地址栏）、`activeView.js`（深链优先级的纯函数 + 单测）、`registry.js`（静态页签表）。
- 落 §十二：
  - **三张注册表各管一件事**：`VIEWS`（页签级，已有，不新增条目页签）/ `BLOCK_RENDERERS`（块级，新增，放 `web/frontend/blocks/`——modules 互依禁列不允许放那里）/ `navModel`（已有）。**渲染在前端、校验在 shared、数据在 service**，分工照搬 table.js 的先例。
  - **不新增第二个编辑入口**：今天右栏的字段编辑，明天在 side-peek 属性区做——一条数据一个编辑面。
  - ui 新增键：`viewId` / `peekOpen` / `workspace`；`entry`（已有）正好就是 side-peek 的目标条目。
  - 深链扩展 `#/栏目id/条目id`，规则仍是「一处实现 + 纯函数 + 单测」。
  - **两层拖拽分工写死**：FlexLayout 管壳（面板停靠）｜dnd-kit 管页内**顺序**（块/卡片/列）｜**手写管尺寸**（列宽、分割条）。
  - **视觉冲突处理**：引 FlexLayout 的能力、**不引它的主题**（自带蓝色系 tabset 会破坏「单色 + 唯一语义红」的视觉语言），用项目 token 覆写其 class；bundle 量级 +130~200KB（以实测构建为准）。
  - **修正基线**：布局 JSON 从「存 settings」改为**存 ui/localStorage**——「窗口怎么摆」是本机习惯，settings 装的是跨端配置（§三 L4 与 L4 条目同步改）。
- 交付 `prototype/workbench.html`：工作台分栏（数据库页 + side-peek）、**分割条可拖**（手写尺寸交互）、页签拖到边缘的停靠落点提示、布局 JSON 去处说明；风格只用项目 token。
- 推翻：1 条（布局 JSON 的存储位置：settings → ui）。

## R7 · 方向修正：递归块 + Notion 式侧边栏（用户纠正）

**用户纠正三点**：① 整个栏目模块本身就是一个块，块里还是块；② 整个模块可以综合放在侧边栏、以数据库形式展示，子目录栏目也进侧边栏；③ 所有布局按 FlexLayout 参考一样可拖。三点都成立——原先的设计把「块」当成条目的正文序列、把侧边栏当成栏目列表，**窄了一层**。

- 模型修订落 §十三（**取代** §二 Block 行、§三 L1–L4、§八 8.1/8.2 部分结论、§十二 12.8 部分结论，逐条对照见 13.5）：
  - **块递归**：`Block = {id, type, value, children?}`；栏目=顶层块、条目=栏目块的行、正文=块序列；新增容器块类型 `section`（正文里内嵌另一个栏目的数据库视图 = Notion inline database）、`column`、`toggle` —— BlockType 由 7 种变 10 种。
  - **侧边栏升为第一公民**（新 L4 层）：Notion 式目录树（栏目可重排/嵌套成子目录/收起）+ 节点可就地切「紧凑数据库」形态（mini table）+ 侧边栏本身是 FlexLayout 面板（可拖宽/折叠/拖出）。FlexLayout 的管辖范围由「栏目工作区」扩到「整个壳」（新 L5 层）。
  - **两类拖拽语义分开**（关键）：拖**栏目节点** = 改显示配置 `settings.navTree`（安全）；拖**条目节点**到另一个栏目 = 改**数据归属**（写操作，必须二次确认 + 走 action）。原型里用不同拖动源区分。
  - **子目录是视图不是数据**：栏目仍是平铺集合 + order，不加 `parent` 字段；树存 `settings.navTree`（缺省 `[]` = 今天行为）——与 `navGroups` 同源，加法不换血、零迁移。
  - 修订：§二 Block 行、§三 分层框（加指向 §十三 的说明）、§十二 12.8、§三 L4 的「布局 JSON 存 settings」一并对齐。
- 原型：新增 **`shell.html`（新旗舰）** —— Notion 式侧边栏树（展开/条目子节点/紧凑数据库切换）+ 主区数据库页 + side-peek 详情 + 侧边栏拖宽与折叠 + **两类拖拽语义**（栏目拖拽改树、条目拖拽弹确认框）+ 隐藏区。`prototype/README.md` 的 IA 与覆盖矩阵同步重写（新增 shell.html）。
- 议程调整：原 R7（块级 AI 状态机 + ai.html）顺延到 R8，与实施计划同轮产出；§十 10.7 的 AI 红线（pending 不落盘）已就位。
- 推翻：3 条（块不递归 / 侧边栏非第一公民 / FlexLayout 只管工作区）。

## R8 · 完整落地计划 + ai.html / board.html

- 读了 A07（`server-cli-web-scaffold/references/A07-extension-loop.md`）的 12 处触点原文与「3 处静默」清单，并核对本项目一致性测试的五组断言（`tests/unit/consistency.test.mjs:27/33/53/70/83/105`）。
- **重要推论**：本次**不新增模块**（块/视图挂在既有 entries/sections，navTree 走 settings）→ A07 第 4/5/6/7 处（后端注册表、前端 VIEWS、`src/index.js` export、eslint 互依禁列）**不触发**；但新增**一条 core→shared 依赖边**（store.js 导入 shared/blocks.js 的 normalizeBlock）要在 eslint 注释里登记（分层规则对新边不可见，README 坑：漏补是静默的）。
- 核实 settings 是**键白名单**（`settings/service.js:7` 的 SETTING_KEYS，每键一个 coerce）→ `navTree` 必须加键 + `coerceNavTree`（对齐 `coerceNavGroups`）；不加键会直接报错（安全失败，不会静默）。
- 产出 **`10-implementation-plan.md`**（交付物 A 正身）：一页速览 / 已核实事实表（每条带 file:line）/ S0–S6 分期总览 / **逐期触点表**（按 A07 的 12 处编号 + 本项目特有的 4 处，每条写「漏了会怎样」）/ 测试计划（6 个新增单测文件 + 冒烟 + 手测）/ 9 条风险登记与回退 / 体积预算 / 执行顺序速查。
- **解决一个真矛盾**（§十四 4）：「pending 不落盘」与「CLI 无状态、pending 要跨进程可见」冲突 → pending 落**独立运行态目录 `~/nx-sk/pending/`**（不进 store.json/导出包/备份，CLI 与面板读同一目录）。
- 块级 AI 状态机落 §十四：`pending` 是业务状态不是失败（返回 `{status:'pending'}`，退出码 0，与项目契约一致）；与 demo `_computePendingDiffs` 的三组差异一一对应；**冲突检测用 baseHash**（块被改过 → CONFLICT，不覆盖）；三条 action（suggest/apply/reject）两端齐备；AI 永不直接改数据。
- 原型：`board.html`（看板：列=select 候选值、拖卡=改字段值并提示真实写 action）、`ai.html`（AI Bar + 字符级红删绿增 + 新增块淡绿 + 删除块置灰删除线 + 顶部「应用全部/拒绝全部」+ pending 不落盘说明）。
- 推翻：0 条；新增 1 个待补触点（core→shared 边登记）。

## R9 · 红队审查（设计 + 全部原型）

对着 README 的 10 条踩坑清单、三条不变量、A07 的 12 处触点，逐条打**设计文档与 7 个原型**。抓到 9 个问题，全部已修。

| # | 问题 | 性质 | 修法 |
| --- | --- | --- | --- |
| 1 | `kv.html` 工具条写「6 个键」，表里 4 行、状态条也写 4 | **原型自身数据不一致** | 改为 4 |
| 2 | `section.view.*` 若要条目数据，实现者很可能 import entries 模块 → 违反 eslint 互依禁列 | **分层违规风险**（事实核查：`sections/service.js:3-10` 今天**不** import entries，经 `core/store.js` 读 store + `core/render.js` 渲染） | §十三 13.8 写死约束：视图 action 只碰 store 与 core |
| 3 | `--columns 姓名` 若只认字段 key，agent 按中文标签写就报错 | **踩坑冲突**（README：清单的行只认列 key） | 13.8：key 与中文标签都认 |
| 4 | 「破坏性写操作一律先导出」照搬到块删除 → 每删一块都要求导出，不可用 | **踩坑冲突** | 13.8：块删除属条目内编辑（与 `--unset` 同级）；删条目/删栏目维持现状 |
| 5 | file 块的上传入口若放附件中心 → 条目里看不到入口 | **踩坑冲突**（README：把上传/选择放到附件中心） | 13.8：上传入口在块编辑器里，附件中心只做库存展示 |
| 6 | navTree 若存条目 id，条目删除后配置留残 → 配置与数据脱节 | **数据一致性** | 13.3.6：条目节点是**推导**出来的，配置只存栏目节点与结构 |
| 7 | 视图 `filter` 查询 DSL / `toggle` 容器 / `gallery` 视图 / 回收站与撤销 | **过度设计** | 13.9 全部砍掉或推迟（v1 只做 columns/sort；两个容器够用） |
| 8 | §八 8.1 仍写「BlockType v1 = 7 种 / children v1 预留」 | **陈旧结论** | 8.1 加「已被 §十三 修订」提示，保留演进轨迹 |
| 9 | 计划漏了 `core/render.js` 的 `serializeEntry` 也要输出 body（只写了 vault/render 的 sensitiveViewer） | **漏触点** | S1 触点 8 补上 |

- 三条不变量复核：**全部成立** —— ① 每条新 action 都给了 CLI + HTTP 两端（§九 9.2/9.3、§十四 4.5），`navTree` 走既有 `setting set`（已有两端）；② 依赖向下：视图 action 不跨模块（见问题 2）；③ `{status}` 语义：pending 是业务状态（`{status:'pending'}`，退出码 0），冲突走 CONFLICT。
- 踩坑清单逐条过：路由遮蔽（已验证字面量优先）、打码写回（prepareBlockValue + blockId 认领）、掩码拒绝写回、store 损坏改名、前端禁 core（块注册表放 web/frontend）、读命令 flag 不带 default（已核对新 action 无 default）、模板演进（默认视图从字典重算）、列名 key/label 双认（问题 3）。
- 推翻：0 条；修正 9 处。
- 遗留（给 R10/R11）：原型未覆盖 `section`/`column` 容器块与多视图表格并排（detail.html 只有叶块）——属实现期细节，R10 在覆盖矩阵里标注。

## R10 · 架构修订 v2（栏目只在侧边栏 + 全模块化可编排）

**用户第三次纠正**：① 栏目不放顶部；② 按侧边栏目录结果放侧边栏；③ 所有布局参考 repo 完全按**模块化、可编排**操作；④ 重构所有原型。三点都成立——原先把「目录」当成侧边栏、把「工作区」当成固定两段，都不是 FlexLayout 的模型。

- 落 **§十五（架构修订 v2）**，取代 §十三 13.3/13.4、§十二 12.2/12.8 的相关结论：
  - **顶部栏只留全局动作**（品牌/搜索/打码/面板抽屉/设置），**栏目 tab 概念取消**；栏目唯一入口 = 侧边栏目录树；`resolveActiveView` 语义改为「当前打开的栏目 id」（深链 `#/栏目id` 指向目录树里那个栏目的数据库面板）。
  - **显示配置从三套合成一棵**：`navGroups`+`navHidden`+`navOrder` → `settings.navTree`；**老 store 读路径从老三套推断出一棵树（只读推断，不写回）** → 老用户显示配置不丢，仍是加法不换血。
  - **工作区 = 布局树**（对齐 FlexLayout 的 JSON 树 row/col → tabset → tab）：面板可拖动停靠、拖到四边拆分、页签合并、双击最大化、面板抽屉添加；**栏目数据库本身是一个面板**（可同时开多个不同视图/条目）；布局 JSON 存 `ui.workspace`。
  - **侧边栏是一个面板**（`component:'sidebar'`），可拖到任何位置/拖出成浮窗；「栏目只在侧边栏」是默认布局的约定，不是硬编码的壳。
- 原型 `shell.html` **重写**为可编排工作区（自写布局引擎，约 200 行）：布局树渲染、分割条拖拽调权重、页签拖到四边拆分、页签合并进别的 tabset、双击最大化、面板抽屉（8 种面板）、点目录里的栏目 → 工作区新开数据库面板、目录树拖拽（重排/嵌套/隐藏区）。
- 推翻：2 条（顶部含栏目 tab / 工作区是固定两段结构）。

## R11 · 七个原型统一换外壳 + 校验

- 用脚本把 database / kv / detail / workbench / board / ai 六个原型统一换成 §十五 的外壳：顶部去掉栏目 tabs（只留搜索 / ＋面板 / 设置）、加侧边栏目录树、内容包进「工作区 + tab 条」容器；顺带清掉重复的 `grow` 段与 kv.html 的高亮项（原来高亮「求职」，应为「密钥」）。
- **校验**（写脚本做，不靠肉眼）：HTML 标签平衡（python `html.parser` 栈检查）七个文件全通过；JS 语法 `node --check` 全通过；顶部是否残留栏目 tab 全为「否」。
- 校验当场抓出两处自身缺陷：detail.html 的 `<tfoot>` 未闭合（标签不平衡）、kv.html 键数与表内行数不一致（R9 已修过一次同类错）→ 都已修。
- 实施计划 S3 触点表按 §十五 15.6 改写：App.jsx 顶部栏改写、navModel.js 角色降级为「目录树数据源」、settings 增加「从老三套推断出树」、activeView 语义改为「当前打开的栏目 id」。
- `prototype/README.md` 的 IA 与覆盖矩阵重写为 v2（顶部无栏目、侧边栏唯一入口、三类拖拽语义）。
- 推翻：0 条；修正 2 处原型缺陷。

## R12 · 原型真跑 FlexLayout（推翻静态 HTML 原型）

**用户第四次纠正**：「完全没有参考 .claude/repo 的精髓 完全没有」→ **成立**。
R1–R11 的原型是**视觉模拟**：自造了布局 JSON 的形状（`{type:'row'|'col', weight, active, maximized}`）、
自己仿了拖拽与停靠、没有撤销、布局不是「一棵树」而是「一堆 div」，README 里自陈「编排是**视觉模拟**」。
问题不在画得糙，在于**它验证不了任何东西**——真 FlexLayout 的停靠语义
（`DockLocation` + 嵌套换方向 + `Actions.addTab`）与假动作并不一致，按原型实现照样返工。

- 读 `.claude/repo/FlexLayout` 源码，把「精髓」拆成 9 条可核对的能力：
  `AGENTS.md` · `IJsonModel.ts` · `Actions.ts` · `DockLocation.ts` · `Model.ts` · `useUndo.ts` ·
  `BorderContainer.tsx` · `_themes.scss` · `examples/{basic,borders,undo-redo,popout}`。
- **决定**：原型从 7 个静态 HTML 换成**真跑 `flexlayout-react@0.11.1` 的独立 vite 应用**
  （`plan/block-refactor/prototype/`，独立 root，不动主应用的 build 与产物）。
- 依赖：根 `package.json` **devDependencies** 加 `flexlayout-react@0.11.1` + `@dnd-kit/{core,sortable,utilities}`——纯加法，主应用暂不 import。
- 产出：`prototype/src/{main,shell,workspace,registry,appctx,ui,data,theme.css}` + `src/panels/{sidebar,database,detail,board,kv,ai,tools}.jsx`；
  `prototype/README.md` 重写为「IA + **与参考仓库逐条对照表**」。
- **实测**（真浏览器 CDP，非目测）：
  ① 目录树点栏目 → 工作区新开数据库面板；
  ② 抽屉选「左」+ 看板 → **真拆出新面板组**（tabset 3→4、分割条 3→4）；
  ③ 撤销回退到 3 组、按钮随之置灰；
  ④ 「布局 JSON」面板摊开 `model.toJson()`——布局不是画出来的，是这棵树推导出来的；
  ⑤ 密度实测：字号 12px、页签按钮 26px、分割条 5px；
  ⑥ 清库重载 3 轮，面板数稳定 4（先前出现过一次游离面板，定位为 MCP 浏览器 profile 里的**残留 localStorage**，非自动打开）。
- **抓出并修的自身缺陷**（4 处）：
  ① 工具条窄时 chips 被挤成两行 → 改 nowrap + 横向滚；
  ② 表格块横向溢出 → `mini-table` 包一层 `overflow-x:auto`；
  ③ `shell.jsx` 漏 import `useRef` → 白屏（真浏览器才发现，构建不报错）；
  ④ `sidebar.jsx` 漏取 `reorderEntries`（python 静默 replace 未命中 → 引用未定义）。
- **推翻 3 条**：① 静态 HTML 原型整套（作废，删除 7 个 html）；② 布局 JSON 的 `col` 字段（FlexLayout **没有 col**，嵌套换方向）；
  ③ 面板参数叫 `props`（是 tab 的 `config`）。
- **修正**：§15.3 的 JSON 形状；`active`/`maximized` 是**模型级单例**不是每节点布尔；补上「FlexLayout 还有 `borders` 机制」这条事实
  （目录走 tabset 而非 border，因为目录是**可拖走的面板**）。
- 文档：`00-design.md` 加 **§十六（原型落地修订 v3）**；`10-implementation-plan.md` 的 S0 换载体、S3 触点表加 1b/1c/1d/8b 四行。
- 遗留（给 R13+）：原型数据全在内存（未落盘）、pending 未真落 `~/nx-sk/pending/`、容器块只给占位、全局搜索未接、浮窗未做引导入口。

### R12 附：把「上一轮那个从未触发的循环」救活

- 查 `~/.nx-rp/loops/67f9832ef80b.json`：上一轮确实建了循环（`maxIterations:13`），
  但 **`lastFiredAt: null`**——它**从未真正触发过**。
- 根因：skill `rp-loop` 规定的命令面是 `nx-rp loop on|start|stop|…`，而已发布的
  `@flowot6/nx-rp@0.4.1` **没有 loop 模块**（`src/runtime/registry.js` 的 MODULES 只有
  system / link / doc / workflow / hook-prompt / hook-skill）→ `nx-rp loop` 报「未知命令: loop」；
  而项目 `.claude/settings.local.json` 的 Stop hook 又指着 `nx-rp loop stop` → hook 永远失败。
  **所以 R1–R11 是 agent 手工一轮轮做的，不是循环跑出来的。**
- **修法**：按 skill 的 `references/loop-commands.md` 协议**本地实现** `scripts/rp-loop.mjs`
  （状态落在同一处 `~/.nx-rp/loops/<sha1(cwd 小写)前12位>.json` + `.jsonl` 审计，
  判决分支与文档一一对应，**退出码恒为 0**，`reason` 严格等于 prompt 原文）。
  协议实现与验证：
  | 分支 | 实测 |
  | --- | --- |
  | 5 未命中 → block + 灌回 prompt | 通过 |`{"decision":"block","reason":"<原文>","systemMessage":"[loop] 第 1/2 轮"}` |
  | 3 达上限 → 结束 | 通过 |`{"systemMessage":"[loop] 循环结束：已达轮次上限 2。"}` |
  | 4 命中承诺词 → 结束 | 通过 |`{"systemMessage":"[loop] 命中完成承诺「DONE」，循环结束。"}` |
  | 1/2 无循环 / 非本会话 → 放行 | 通过 |静默 exit 0 |
  | 6 异常（坏 JSON / 读不到 transcript）→ 放行且**不杀循环** | 实测喂坏 JSON 时静默放行，循环仍 active |
- 踩到并修掉的两个坑：① `await` 用在非 async 函数里 → 改成 `async function`；
  ② **`console.log` 后立刻 `process.exit(0)` 会丢掉管道里的输出**（stdout 未刷）→ 改成置 `process.exitCode` 后自然退出。
- 附带产物：根 `package.json` 加 `loop:on/off/status/log/cancel` 五个脚本；
  `.claude/settings.local.json` 的 Stop hook 指向本地脚本（local scope，不入库）。
- 本轮收尾时用新实现布防了**十轮**循环（`max-iterations 10`，仅轮次模式、无承诺词），
  绑定当前会话；待办清单（B1–B12）写在循环 prompt 里，从 R13 开始逐轮推进。

## R13 · 容器块真渲染（B1）+ 词汇表对齐 + 修一个落点缺陷

- **先对设计，后写码**：R12 的原型块类型是 `attachment` / `embed` / `columns`，
  而 §十三 13.2 + §八 8.1 定的词汇表是 **`file` / `section` / `column`**（叶块七种：paragraph/heading/md/table/entrylist/file/secret）。
  → **推翻 3 条命名**，按设计改，并把 `md` / `entrylist` 两种叶块补进原型（之前根本没渲染）。
- **B1 实现**：
  | 容器 | 形状 | 行为 | 实测 |
  | --- | --- | --- | --- |
  | `section` | `{ sectionId, viewId? }` | 正文里内嵌另一个栏目的数据库视图 | 「内嵌栏目 求职 · 3 条」表格；点「李四」→ **新开李四详情面板**（click-through） |
  | `column` | `{ widths:[62,38] }` + children | 列组：子列并排，**拖列边框改 widths** | 拖动后列宽 `[260,159]` → `[102,317]`，分隔线 x=1484 → 1326 |
- **「内嵌栏目」与数据库面板共用 `src/panels/sectionTable.jsx`** → 内嵌那张表与数据库面板那张表
  **是同一段代码、同一份数据源**（S2「视图 = 投影」的结构保证），不是另画的装饰。
- **新增 `src/blocks.js`**：块树纯函数（find / update / remove / move / append / descendantIds），
  渲染与排序都递归下去——块不是画出来的，是这棵树推导出来的（与工作区模型同构）。
- **设计澄清 3 条**（写进 `00-design.md` §十三 13.2 的「R13 修订」表 + §八 8.1 补注）：
  ① `column` **分两层**：`widths` 非空 = 列组（children 是子列）、`widths` 为空 = 叶子列（children 是内容块）
  ——不判别渲染层没法决定 children 是并排还是竖排；
  ② `entrylist` 块**自带 `fields`**（子列定义）——**块不是字段，没有栏目字典可查** `entrylist.fields`，
  不自带就渲染不出表头（这条推翻 §八 8.1「值形状与同名字段完全一致」的一处想当然）；
  ③ 块 id 用 `b_` 前缀（§十三 13.6 已写，实现时别自造）。
- **实测抓出的缺陷（已修）**：从侧边栏或内嵌块开面板时，页签落进了**目录面板自己的 tabset**
  ——`activeTabsetId` 取的是 active tabset，而目录那个 tab 恰好是选中的 → 目录那一组会越攒越多，
  工作区反而没开。修法：`activeTabsetId(model, ['sidebar'])`，落点**排除含 sidebar 的面板组**，
  回退到最后一个不含它的组。修后实测面板组分布 `[["目录"], ["字段样例","求职"], ["详情","李四"]]`。
- **实测证据**：`pnpm run lint` 干净；`pnpm run proto:build` 成功（443KB / gzip 129KB）；
  浏览器 console 零报错；正文 10 块全部渲染（md 块的标题/列表/待办正常，
  entrylist 的密码列打码成 `sk-1******cdef`，与 `maskValue` 同规则）；列宽拖拽前后数值如上。
- **踩坑（会复发，记一笔）**：用 shell heredoc 写 JS 时，`\n` 会被 shell→python→文件这条链**变成真换行**，
  JS 单引号字符串当场断掉（两个 Parsing error）。带转义符的代码**改用 Edit 工具**写，别走 heredoc。
- **推翻 3 条**（块类型命名）；**修正 1 条**（§八 8.1 的 entrylist 形状）；
  **设计澄清 3 条**（column 两层 / entrylist 自带 fields / 块 id 前缀）；**修缺陷 1 处**（面板落点）。
- 遗留（给 R14+）：B2–B11 未做；**块里的文字还不能就地编辑**（增删/排序/改列宽可以）。

## R14 · 块级 AI 的 pending 真落目录（B2）+ 冲突检测 + 隔离自检

- **B2 实现**：原型给 vite dev server 挂了一个极小的服务端（`prototype/server/pending.mjs`，`/proto-api/*`），
  §十四 的机制**真跑起来**，不再是内存里的假动作：
  suggest → 服务端写 `<home>/pending/<id>.json`；列表 → 真从磁盘目录读；
  apply → 服务端算哈希，≠ baseHash → **409 CONFLICT，不覆盖**；强推 → 显式强推；reject → 删文件；
  隔离自检 → 真 grep `store.json` 与导出包。
- **`<home>` 的取法与 `src/core/paths.js` 同源**：`NX_SK_HOME` 优先，没有则用原型自己的沙箱
  `<prototype>/.tmp/home` —— **绝不碰用户真实的 `~/nx-sk/`**（那里面是 264KB 的真 store.json）。
- **实测证据**（真浏览器 + 落盘核对）：
  | 步骤 | 观察到的 |
  | --- | --- |
  | 生成建议 | 面板显示「pending · 已落盘：…\.tmp\home\pending\p_mvuxtusm.json」；落盘文件含 `diffs/baseHash/segments/finalText/newBlocks` |
  | baseHash | `601b37f5e4ea8b2d`（**服务端算**，非客户端自带） |
  | 改块后点「应用」 | `conflict · 冲突：b_1 已被改过，未覆盖` · `base=601b37f5e4ea8b2d now=661f151c65a0800c`；**块内容确认未被覆盖**（详情页仍是「用户自己改过了这段内容。」） |
  | 点「强推」 | `ok · 已应用（写 store）`；pending 归零；pending 目录清空；store.json 里出现改写后的块与新块 |
  | 隔离自检 | 4 条全通过（probe 在 pending 里 / 不在 store.json / 不在 bundle.json / **store 与导出包里没有 pending 独有的结构字段**） |
  | 落盘核对 | `grep -c 'baseHash\|segments\|removedIds'` 在 store.json 与 export/bundle.json 里均为 **0** |
- **实测抓出并修掉的三处缺陷**（都是「看起来对、实际失效」那一类）：
  ① **baseHash 算成 `null`**：原先客户端自带 baseHash、服务端副本又落后一步 → 冲突检测**形同虚设**。
     改成「**baseHash 由服务端按自己那份算，客户端不许自带**」+ suggest 前先同步一次。
  ② **按条目同步会丢块**：服务端手上是哪个条目，取决于「哪个详情面板恰好挂载着」——
     挂载顺序一变就丢块，baseHash 又变 `null`（实测：store.json 里只有 `e-job-2`）。
     改成**整份批量推**（`POST /proto-api/blocks`）后稳定。
  ③ **0700 在 Windows 上不成立**：`chmodSync(dir, 0o700)` 改不了 POSIX 位（实测 `stat` 恒为 `666`），
     真正的隔离要靠 NTFS ACL。原型改为**如实上报实际 mode**，不假装是 0700。
- **设计补写**：`00-design.md` §十四 新增 **14.6「R14 补四条」**——
  ① baseHash **谁**算；② 服务端持有「当前块内容」这件事怎么说；③ 0700 的平台 caveat；
  ④ 隔离自检要**两层**（文本层 + **结构层**：pending 独有的字段名不许出现在 store / 导出包里）。
  结构层比文本层硬得多——文本可能碰巧不重复，字段名一出现就是记录漏进去了。
- **顺带定下两条纪律**：pending 列表按**新 → 旧**排；「拒绝」是**删文件**（pending 是运行态，不是历史）。
- **顺带做了 B8 的一部分**：块内文字可**双击就地编辑**——没有它就没法真的制造「块已被改过」的冲突。
- **推翻/修正**：§十四 澄清 4 条（baseHash 谁算 / 服务端持有状态 / 0700 平台 caveat / 隔离两层口径），
  **不是新增类型**；修实现缺陷 3 处。**B2 完成。**
- 遗留（给 R15+）：B3–B11 未做；AI 的「模型」是原型自己编的改写方案（pending 的形状是真的）。

## R15 · 全局搜索真接（B3）+ 把「搜索」的语义定死

- **B3 实现**：顶栏搜索框不再是占位。新增 `prototype/src/search.js`（纯函数：`searchAll` / `snippet` /
  `dedupeHits`）+ `prototype/src/components/globalSearch.jsx`（输入框 + 结果面板 + ↑↓/Enter/Esc 键盘）。
  搜**四类**：栏目名 / 条目名 / 字段值 / 块正文，跨所有栏目。
- **此前全文没有一处定义搜索** —— 顶栏那个框一直是占位，语义没人写过。
  R15 把语义定死并写进 `00-design.md` **§十七**（四类命中各开什么、排序、密文边界、落点）。
- **最重要的一条：密文不参与搜索**（§十七.2）——
  `secret` 字段与 `secret` 块跳过；`entrylist` 的 **sensitive 子列**、`table` 的 sensitive 列也跳过；
  **结果里连片段都不给**。理由：搜索框是唯一一个会把内容摊到屏幕上的输入口，
  它能搜出密文明文 = 密钥进截图、进录屏、进剪贴板历史。
  （`secret` 的**名称**照常可搜——`DB_PASSWORD` 这名字不是秘密，值才是。）
- **实测证据**（真浏览器，五个查询）：
  | 查询 | 结果 |
  | --- | --- |
  | `李四` | 2 条：条目名 + 字段·档案名 |
  | `13800000000` | 1 条：字段·电话（**跨栏目**命中：命中在「求职」，搜索在顶栏） |
  | `示例条目` | 3 条：条目名 + 字段·名称 + 字段·描述（片段带上下文，命中词灰底加粗） |
  | `普通段落块` | 1 条：**正文**命中（块正文里的句子） |
  | `sk-abcdefghijklmnopqrstuvwx` | **0 条** —— 密文不参与搜索 |
  | `password` | 2 条：`DB_PASSWORD` 的**名称**命中（值不命中） |
- **正文命中能定位到块**：点命中 → 开详情面板 → 滚到那个块 → 灰底闪一下（实测背景 `rgb(245,246,247)`）。
- **实测抓出的两处设计问题（都修了）**：
  ① **栏目标题搜不到**：搜「求职」原本 0 命中——栏目标题不在搜索范围内。
     → 加第四类命中「栏目名」，命中后开**该栏目的数据库面板**（不是某条条目）。
  ② **定位提示放错了地方**：本来把 `focusBlockId` 塞进面板 `config`，结果——
     · 同一个条目会**开出第二个面板**（config 变了 → 身份变了）；
     · 要塞时间戳才能重复触发 → **时间戳会写进 `ui.workspace` 布局 JSON**；
     · 同一块再定位一次时**高亮不会重来**（effect 依赖没变）。
     → 改成**应用级一次性导航状态**（`focusRequest` + nonce）：不进 config、不污染布局 JSON、
     重复定位会重新触发。实测：连续两次命中 → 页签数不变（8 → 8）、高亮两次都出现。
- **设计补写**：`00-design.md` **§十七（全局搜索）** —— 四类命中各开什么、排序（条目名 > 字段 > 正文）、
  **密文边界**、**定位提示不是面板身份**、实现期落点（应为服务端 `entry search` action，
  「密文边界必须在服务端兜住，前端过滤是第二道防线」）。
- **推翻/修正**：§十七 新增（此前**根本没有**搜索定义，不算推翻）；修设计问题 2 处（栏目名漏搜 / 定位提示放错层）。
  **B3 完成。**
- 遗留（给 R16+）：B4–B11 未做；搜索命中还没生成深链 `#/栏目id/条目id`（§十二 12.4，与 B7 一起做）。

## R16 · 浮窗与弹出有入口了（B4）+ 右键菜单是应用的责任

- **B4 实现**：能力本来就开着（`tabEnableFloat` / `tabEnablePopout`），缺的是**入口**。R16 补两条：
  | 入口 | 位置 | 实测 |
  | --- | --- | --- |
  | **可见入口** | 面板组标题栏右侧的「浮窗」「弹出」图标 | 浮窗出现在页内；弹出**真开了一个浏览器窗口** |
  | **右键菜单** | 右键页签 / 面板组 | 中文菜单：浮成浮窗 / 弹出成新窗口 / 重命名 / 关闭 |
- **内置文案全中文化**：`<Layout i18nTranslator={translate}>`。新增 `src/i18n.js`，
  按官方 `I18nLabel` 枚举**逐条列全 40 个 key**（漏一个就回落到英文——不是报错，是那一项露馅）。
  实测：「最大化面板组」「调宽度」「把选中的页签浮成浮窗」等全部变中文。
- **弹出成新窗口真的开了窗口**（实测）：`http://127.0.0.1:5190/popout.html?id=…`，
  面板内容**完整渲染**（工具条 / 表格 / 页脚都在，样式在运行时被复制过去）。
  → 需要在原型根加一个空的 `popout.html` 宿主页 + vite 多页产物（index + popout）。
- **实测纠正一条重要认知**：**FlexLayout 不自带右键菜单**——
  参考实现 `LayoutController.showContextMenu` 只有在 `props.onContextMenu` 存在时才做事，
  否则右键**什么都不会发生**。库只给零件（`getNodeContextMenuItems` 建条目、
  `showPopupMenu` 弹面板），**菜单是应用的责任**。
  → 原型在 `<Layout onContextMenu>` 上用这两个官方函数拼出中文菜单。
- **实测抓出的第二个缺陷**：加了浮窗/弹出图标后**老布局里看不见**——
  因为 `toJson()` 只写**与默认值不同**的项，存盘里的 `global` 是「用户改过的差量」，
  不是完整配置，老布局里压根没有这两个 key。
  → 修法：**加载后把出厂全局属性重新盖上去**（`model.updateAttrs(GLOBAL_ATTRS)`）。
  这条对实现期同样要带走（否则用户升级后新入口集体消失）。
- **设计补写**：`00-design.md` **§十八（浮窗与弹出）** —— 两条入口、
  **右键菜单是应用的责任**、**出厂全局属性每次加载都要补**、**弹出需要宿主页**。
- **推翻/修正**：新增 §十八（此前**没写**过浮窗/弹出的入口设计，不算推翻）；
  修「出厂属性被存盘差量吃掉」这一处实现缺陷。**B4 完成。**
- 遗留（给 R17+）：B5–B11 未做；浮窗/弹出的**布局持久化**（浮窗位置会进 `ui.workspace`）还没在设计里写清楚。

## R17 · 四种视图在同一栏目面板内切换（B5）+ 投影降级

- **B5 实现**：一个**栏目面板**里切四种视图，不换数据源。
  新增 `prototype/src/views.js`（纯函数：`inferViews` / `viewsOf` / `resolveView` /
  `resolveColumns` / `sortRows`），`panels/database.jsx` 按 `config.viewId` 渲染对应投影；
  看板与 KV 从**独立面板**降级为**栏目面板的一种视图**（`panels/board.jsx` / `panels/kv.jsx`
  已删，改为 `boardView.jsx` / `kvView.jsx`）。
- **视图是面板身份的一部分**（`config.viewId`）→ 同一个栏目能**同时开多个面板**（不同视图）。
  切视图 = 改本面板的 `config`（`Actions.updateNodeAttributes(tabId, {config})`）。
- **实测证据**（真浏览器，逐个 chip 点）：
  | chip | 结果 |
  | --- | --- |
  | 表格 | 7 列：名称/描述/数量/完成/状态/日期/标签 · `view=v_table · table` |
  | 精简 | 2 列：名称/状态 · `view=v_compact · table`（**仍是 table，不是新类型**） |
  | 看板 | 三列（未开始/进行中/已完成），无表头 · `view=v_board · board` |
  | 自定义 | 3 列：名称/数量/**已删字段** · `view=v_custom · table` |
  | 「求职」（**没配 views → 走推断**） | chips = 表格/精简/看板；7 列 = **除 source 外全部字段**（含附件列） |
- **投影降级真的演出来了**：「自定义」视图引用了一个**已删字段** `ghost_note` →
  表头写「已删字段」（弱占位）、单元格写「—」，**不炸也不静默消失**（设计 §八 8.2）。
- **看板拖卡是写操作**：实测把「对照条目」从「未开始」拖到「已完成」→
  看板里卡片换列，**侧边栏紧凑表同步变成「对照条目 已完成」** → 改的是数据源，不是本地态。
- **实测抓出并修掉的两处**：
  ① **切视图没反应**：面板拿不到 `tabId`/`model`（改不了自己的 config）→
     修法：`factory(node)` 把 `{ tabId, model, node }` 作为第二个参数传给面板，
     `registry.jsx` 逐条 `render: (cfg, ctx) => <X config={cfg} ctx={ctx} />`。
     （第一版只改了 factory，**registry 里没把 ctx 传下去**——症状是 chips 在、点了不动。）
  ② **列的口径擅自比设计窄**：原型只让标量字段进列，而设计 §八 8.2 写的是
     「**全部非 source 字段**」→ 改回设计口径（密文/附件列照常进，值默认打码）。
- **顺手修的**：Chrome DevTools 报「form field 应有 id 或 name」→ 四个输入框补 id/name（console 现在零 issue）。
- **设计补写**：`00-design.md` **§十九（视图与面板身份）** —— 四种视图 ↔ `type` 的对应
  （**精简不是第四种类型，是 table 的另一个投影**）、视图是面板身份的一部分、
  缺省推断的具体形状、投影降级的表现、看板拖卡是写操作。
- **推翻/修正**：新增 §十九（此前只定义了 ViewConfig 形状，没定义视图与面板的关系，不算推翻）；
  修正「列口径比设计窄」这处实现偏差。**B5 完成。**
- 遗留（给 R18+）：B6–B11 未做；`sort` / `columns.width` / `hidden` 已在数据形状里，渲染还没接。

## R18 · 目录树从老三套推断出来（B6）+ 只读推断、不写回

- **B6 实现**：原型**故意不用** `settings.navTree`，而是拿一份**老 store 的配置**
  （`navGroups` / `navHidden` / `navOrder`，形状对齐 `src/modules/settings/service.js:17-19`），
  让「从老三套推断出一棵树」这条兼容路径**真的被跑到**。
  新增 `prototype/src/navTree.js`（纯函数：`inferNavTree` / `resolveNavTree` / `sectionNodes` +
  树操作 `findNode`/`removeNode`/`insertNode`），侧边栏支持**分组节点**（`kind:'group'`）。
- **推断规则**（口径对齐老实现 `settings/service.js:193-212` 与 `App.jsx` 的 nav 构造）：
  ① 隐藏的 → 不进树，进隐藏区；② 分组里的 → 分组节点（组顺序 = navGroups 顺序，组内顺序 = 列出的顺序）；
  ③ 其余可见 → 平铺在根层（navOrder 优先，其余按栏目自身 order）；④ **平铺在前、分组在后**（老实现的渲染顺序）；
  ⑤ 栏目不存在 / 空组 → 跳过。
- **实测证据**（真浏览器）：
  | 观察点 | 结果 |
  | --- | --- |
  | 侧边栏顶部 | 「目录树来源：**推断（老三套，未写回）**」 |
  | 推断出的树 | `字段样例 / 项目 / 密钥` + 分组「**求职档案**」（`▣` 标记 + 「分组」字样） |
  | 隐藏区 | 「项目经历」（来自 `navHidden`）+ 放回按钮 |
  | **拖一次树之后** | 树变成 `密钥 / 字段样例 / 项目 / 求职档案`，来源变成「**显式 navTree**」 |
- **这就是「加法不换血」的关键动作**：推断在**读路径**、**不写回**；
  用户**第一次动树**才把推断结果固化成显式 `settings.navTree`，此后推断让位。
  而**「隐藏」仍走老的 `navHidden`** —— 老三套能表达的事不换机制（换机制 = 老用户显示配置要迁移）。
- **实测抓出的设计含糊处（已写进设计 §二十）**：
  ① 推断规则原文没定 → 现在逐条写死并标注老实现出处；
  ② **树节点原来只有「栏目节点」一种** → 老配置能表达「分组」，所以必须有**分组节点**
     （`kind:'group'`）；且推断出来的树**必然比显式树浅**（老三套只能表达一层分组）——
     这是「加法不换血」的代价，不是缺陷；
  ③ 面板上必须**说清当前用的是哪一套**（侧边栏顶部常驻「目录树来源：…」），
     否则用户以为「分组」是系统自动的，也不知道它什么时候会变。
- **设计补写**：`00-design.md` **§二十（老配置推断）** —— 五条推断规则 + 两种树节点 +
  「只读推断、第一次改树才落盘」+ 面板上要说清来源。
- **推翻/修正**：新增 §二十（此前只写了原则没写规则，不算推翻）；修正「树节点只有栏目节点一种」这处实现缺口。
  **B6 完成。**
- 遗留（给 R19+）：B7–B11 未做；推断出的树**不支持任意嵌套**（显式 navTree 才支持），下一轮可验证这条差异。

## R19 · 深链（B7）：地址栏 = 当前打开的面板

- **B7 实现**：新增 `prototype/src/activeView.js`（纯函数 `parseHash` / `buildHash` / `resolveDeepLink`），
  抄老实现 `src/web/frontend/activeView.js` 的纪律（**一处实现 + 纯函数 + 断言**）。
  深链形态：`#/栏目id` → 开该栏目的数据库面板；`#/栏目id/条目id` → 再开该条目的详情面板；
  **没有深链时不兜底**（用存下来的工作区布局；老壳「默认栏目」那一级由布局接手）。
- **应用内导航一律写 hash**：点目录里的栏目、点表格里的行、搜命中 → 都改地址栏
  → 地址栏可复制、可分享、可后退。
- **实测证据**（真浏览器，逐个改 hash）：
  | 深链 | 结果 |
  | --- | --- |
  | `#/secret` | 开出「密钥」数据库面板（KV 视图） |
  | `#/job/e-job-2` | 开出「求职」数据库面板 **+** 「**李四**」详情面板；状态条「已按深链打开：job / e-job-2」 |
  | `#/nope`（栏目不存在） | **不开任何面板**；状态条「深链指向的栏目「nope」不存在」 |
  | `#/job/e-gone`（条目已删） | **只开栏目面板**；状态条「深链里的条目已不存在，只开了栏目面板（job）」 |
- **实测抓出并修掉的一处**：**复用已打开的面板时不刷新页签名** ——
  条目改名、或深链给的标题与旧页签不一致时，页签还挂着旧名字 →
  出现「两个面板同名、分不清谁是谁」（实测踩到：详情面板页签名成了栏目名「求职」）。
  修法：`openPanel` 复用时若名字不同 → `Actions.renameTab(tabId, name)`。
- **设计补写**：`00-design.md` **§二十一（深链在新壳里的语义）** —— 新壳的两级解析（深链 > 布局）、
  **缺失的处置（不许开坏面板）**、地址栏 = 当前打开的面板、以及「一处实现 + 纯函数」的纪律。
- **推翻/修正**：新增 §二十一（此前深链的语义仍按老壳写——「指向哪个 tab 显示」，
  而新壳已经没有栏目 tab 了，**这条其实已经过时**，R19 把它改成「指向开哪个面板」）；
  修「复用面板不刷新页签名」这处实现缺陷。**B7 完成。**
- 遗留（给 R20+）：B8–B11 未做；「推断树 vs 显式树的嵌套差异」还没实测（推断树只支持一层分组）。

## R20 · 块编辑真能用（B8）：斜杠菜单 + 转类型 + 上移下移

- **B8 实现**：块的五个面板动作全部落地
  （文字可编辑 R14 已做，本轮补齐**斜杠菜单 / 转类型 / 上移下移 / 空块**）：
  | 动作 | 实测 |
  | --- | --- |
  | 尾部加块 | 新块是**空块**，带占位「空段落 · 双击编辑，输入 / 选类型」（不然看不见） |
  | 斜杠菜单 | 空块里打 `/` → 直接开块类型菜单（非空块里 `/` 是正文，不触发） |
  | 转类型 | 菜单里 9 种类型逐项列出：**当前**项标灰底、结构型标「文本会丢」；实测标题→段落后原文「9 月复盘」**保留** |
  | 上移 / 下移 | 实测 `b_2` 下移一位：`[b_1,b_2,b_3,b_4]` → `[b_1,b_3,b_2,b_4]` |
  | 删除块 | 实测删 `b_3`：`[b_1,b_3,b_2,b_4]` → `[b_1,b_2,b_4,…]` |
  | 文字可编辑 | 实测双击 b_1 → 输入「改过的第一段。」→ Enter → 块内容变成「改过的第一段。」 |
- **实测纠正一条映射**：设计 §九 9.2 的块 action **没有 `entry.block.convert`** ——
  「转类型」就是 `entry.block.update`（PATCH）一份新形状的块。
  而且实现上必须是**整块替换**而不是合并：合并会把旧类型的残留字段留在块里
  （table → paragraph 之后块里还挂着 `columns`/`rows`）。
  → 新增 `blocks.js` 的 `replaceBlock`（保留 id、整体替换）。
- **转换的有损性必须标出来**：只有文本型（paragraph/heading/md）能保留原文，
  转成结构型**文本会丢** —— 菜单里逐项标注（不标 = 用户以为转换无损 = 静默丢数据）。
- **上移/下移与拖拽是同一动作的两个入口**：都落 `moveBlock` / `moveBy`
  （对应 `entry.block.move --to <index±1>`）。
- **设计补写**：`00-design.md` **§二十二（块编辑）** —— 面板动作 ↔ action 的对应表、
  转换有损性、整块替换、斜杠菜单的触发条件（只有空块）。
- **推翻/修正**：新增 §二十二（此前块编辑动作与 action 的对应没写过，不算推翻）；
  实现缺口 1 处（菜单只有「转段落/转标题」两个占位项，没有真的转换）。
  **B8 完成。**
- 遗留（给 R21+）：B9–B11 未做；块编辑**没有撤销**（已在 README 已知简化里写明）。

## R21 · 附件指派（B9）：选择面板 + 上传 + 逐行移除

- **B9 实现**：`file` 块在**块编辑器里**完成指派（附件中心只做库存展示 + 「只看未引用」筛选，§十三 13.8）：
  | 动作 | 实测 |
  | --- | --- |
  | 从附件库选… | **选择面板不是下拉框**：可搜索（名称/标签）、**未引用优先**（已引用的排后面并标「已被 N 处引用」）、点一行即追加（可连点多个）、**已挂上的从列表里消失** |
  | 上传文件 | 真的选了本地文件 → 「面试笔记.md · 1 KB」进库并挂到块上 |
  | 逐行移除 | 每个附件一个 ×；移除 = 从块上摘掉，**附件本身还在库里** |
  - 实测追加过程：块初始只有「张三-简历-后端.pdf」→ 选择面板里**它已不在列表**（已挂上）→
    连点「头像.jpg」「成绩单.pdf」→ 两行从列表消失 → 块里变成三份附件 + 一份上传的。
- **块的值改成附件 id 列表**（对齐 §八 8.1「file | 附件 id 列表」）——
  之前原型把 {name,size} 塞在块里，等于把库存拷进了块。改成 id 后**渲染时从库里解析**；
  库里没有的 id 渲染成「未知附件 <id>」，不静默消失。
- **引用关系不存库，现算**：`countFileRefs(sections, blocksByEntry)` **两种引用都算**
  （① file 块里的 id；② file **字段**值里的 id，对齐 40-files.md「两种引用都算已引用」）。
  附件中心原来把 `refs` 写死在数据里 → 改成现算 + 「只看未引用（N）」筛选片。
  **为什么必须现算**：存了就会和块里的 id 脱节——块里摘掉了、库里还记着「被引用」，
  「清理未引用」就会删错东西。
- **实测抓出并修掉的两处**：
  ① **TDZ 崩溃（白屏）**：`fileRefs` 声明在引用它的 `api` memo **之后** →
     `Cannot access 'fileRefs' before initialization`，整棵树挂掉（构建不报错，真浏览器才发现）。
     修法：把声明搬到 api 之前。
  ② **`useApp is not defined`（FieldValue 崩溃）**：给 ui.jsx 加 `useApp` 时，
     import 补丁没打上（那条 import 行早在 R16 就被改掉了，replace 静默未命中）
     → FieldValue 一渲染就抛错。修法：补上 import。
     **两条都是「构建绿但运行崩」** —— 又一次证明「真浏览器验」这一步不能省。
- **设计补写**：`00-design.md` **§二十三（附件指派）** —— 块的值 = id 列表、
  选择面板的四条规矩、两种引用都算、**引用关系不存库现算**、上传先进库再挂块。
- **推翻/修正**：新增 §二十三（此前附件指派只有一句话原则，不算推翻）；
  修「块里存 {name,size}」这处与 §八 8.1 不一致的实现 + 2 处运行时缺陷。**B9 完成。**
- 遗留（给 R22+）：B10、B11 未做；上传只是「进库挂块」，没有真实字节写入（原型不落盘）。

## R22 · 键位与无障碍（B10）+ 布局导入导出（B11）—— 收尾轮

- **B10 键位**：FlexLayout 默认只开「关闭页签(Ctrl+Delete) / 重命名(F2) / 关闭浮层(Escape)」；
  **焦点在面板组之间移动的三条默认是关的**（`focusTabToggle` / `focusNextTabset` / `focusPreviousTabset`）。
  → 原型开了：`F6`（焦点切到面板内容）、`Ctrl+F6` / `Ctrl+Shift+F6`（下/上个面板组），
  并在**设置面板里放了一张键位表**——没人知道的快捷键等于没有。
- **B10 无障碍——「假控件」纪律**：可点击的东西必须是真按钮（`role="button"` + `tabIndex=0` + Enter/Space 触发）。
  原型里所有 chips（视图切换 / 列设置 / 停靠位置 / 筛选片）统一走 `ui.jsx` 的 `Chip` 组件。
  **实测**：chip 的 `role=button`、`tabindex=0`；**键盘 Enter 真的切了视图**（精简：表头变 档案名/求职状态，`view=v_compact`）。
- **B11 布局导入导出**：「布局 JSON」面板 = `复制` / **`粘贴导入（应用）`** / `重置布局`。
  **实测**：① 取当前布局 JSON → 把两个面板组的 weight 改成 8/70 → 粘贴 → 应用 →
  存盘的布局真的变成 `[8,70,30]`（**从 URL/JSON 重建布局**，与 `Model.fromJson` 同一条路）；
  ② 粘贴坏 JSON → 语义红显示 `Unexpected token 'o'… is not valid JSON`，**当前布局保持不变**、应用不崩（6 个页签都活着）。
- **实测抓出并修掉的一处**：`useMemo` 的依赖数组里写了 `resetLayout` ——
  它是这个 memo **自己创建的属性**，不是外部变量 → `resetLayout is not defined`，整棵树挂掉（白屏）。
  修法：deps 里去掉自引用。（又是「构建绿但运行崩」——真浏览器验这一步再次立功。）
- **设计补写**：`00-design.md` **§二十四（键位、无障碍与布局导入导出）** —— 键位表（默认关的三条要开）、
  「假控件」纪律、布局导入导出 = `Model.fromJson/toJson` 的直接应用 + 坏 JSON 的处置。
- **推翻/修正**：新增 §二十四；修实现缺陷 1 处（memo deps 自引用）。
  **B10、B11 完成 —— B1–B12 待办全部清完。**
- 遗留（实现期再议）：块编辑没有撤销；上传没有真实字节写入；`sort` / `columns.width` / `hidden` 的渲染；
  深链生成 `#/栏目id/条目id` 已可用但「复制深链」按钮还没加。

## S1 · 块内核实现轮（shared/blocks.js + 块 action + v4 守卫 + 详细页面板）

- 按 10-implementation-plan.md §四触点表施工，12 个触点全部落地，**S1 完成**（详见 20-implementation-progress.md 的 S1 完成记录）。
- 实现与设计的三处对账结果：
  - §九 action 契约：块 7 条全部按「一条 action 双端」（CLI 与 HTTP 面板走同一 service 路径）；
  - §八 8.0：`STORE_VERSION` 3→4，`oldVersion > STORE_VERSION` 时 `loadStore` 报 BLOCKED 拒绝写入（读不受限），
    单测钉住「要记住磁盘版本」——normalize 会把版本抹成当前值，断言必须打在 diskVersion 上；
  - §二十三：file 块的值 = 附件 id 列表，引用关系**现算不存库**（`countFileRefs` 两种引用都算）。
- 计划笔误修正：触点 9 的 `registry.js` 实落为 `registry.jsx`（注册的是 React 编辑器组件），
  并新增 `blockPanel.jsx` 作面板壳（加块 / 转类型 / 排序 / 删除 / 打码开关）。
- 实测抓出并修掉：bootstrap 渲染崩溃（注释与函数声明粘连）、块删除 dry-run 分支缺陷、
  smoke 两处断言与实现语义不符；headless Chrome 实测 8 块全渲染、无白屏。
- 验证：`pnpm test` 337 单测 + lint + build 全绿；smoke 157 断言全过（含导出→导入块正文跟随）。
