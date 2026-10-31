<!-- 实现进度 —— 原型设计 → 当前项目（S1–S6）
     对应：00-design.md（§十三～§二十四）· 10-implementation-plan.md（S1–S6 触点表）· prototype/（真跑的原型）
     规矩：每完成一期跑 `pnpm test`（= lint + build + smoke + unit），全绿才算完成 -->

# 实现进度

> 起点：R22（原型 B1–B12 全部清完）。实现按 10-implementation-plan.md 的分期走，
> 每期的触点表就是这一轮的清单 —— 不重新发明，只照单施工。

## 状态总览

| 期 | 内容 | 状态 |
| --- | --- | --- |
| S1 | 块内核（shared/blocks.js + 块 action + v4 守卫 + 详细页 + 顺带修 table 导出缺陷） | ✅ 完成（2026-10-30） |
| S2 | 数据库视图（section.views + view action + 四视图面板） | ✅ 完成（2026-10-30） |
| S3 | 全域拖拽 + Notion 式壳（FlexLayout + dnd-kit + 目录树 + 容器块 + 看板） | ✅ 完成（2026-10-30） |
| S4 | 块级 AI（AI Bar + pending 落盘 + 冲突检测） | ✅ 完成（2026-10-30） |
| S5 | 兼容与收尾（包版本字段 + 降级提示 + 文档） | ✅ 完成（2026-10-31） |

## S1 触点清单（10-implementation-plan.md §四）

| # | 触点 | 状态 |
| --- | --- | --- |
| 1 | `src/shared/blocks.js`（新增） | ✅ |
| 2 | `src/core/store.js`：normalizeEntry 加 body · STORE_VERSION 4 · 降级拒绝写入 | ✅ |
| 3 | eslint 注释登记 core→shared 依赖边 | ✅ |
| 4 | `src/core/attachments.js`：引用扫描纳入 file 块 | ✅ |
| 5 | `src/modules/transfer/service.js`：referencedFileIds 纳入 file 块 + 修 table 敏感列不解密 | ✅ |
| 6 | `src/modules/entries/service.js`：块 CRUD + prepareBlockValue | ✅ |
| 7 | `src/modules/entries/index.js`：块 action 声明 | ✅ |
| 8 | `src/core/render.js` serializeEntry 输出 body · vault sensitiveViewer 扩到 secret 块 | ✅ |
| 9 | `src/web/frontend/blocks/registry.jsx`（新增） | ✅ |
| 10 | `src/modules/entries/view.jsx`：详细页属性区 + 块正文 | ✅ |
| 11 | `src/web/frontend/styles.css`：块样式 | ✅ |
| 12 | 测试：blocks / store-version / block-crypto 单测 + smoke | ✅ |

## 记录

### S1 开始（2026-10-30）

- 起点核对：`STORE_VERSION = 3`、`normalizeEntry` 白名单重建（未知键丢弃）✓ 与计划一致。
- 设计依据：00-design.md §八 8.1（块形状）、§十三 13.2/13.6（类型词汇表 + R13 修订）、
  §二十二（块编辑动作 ↔ action 对应）。

### S1 完成（2026-10-30）

- **12 个触点全部落地**。与计划的两处偏差：
  ① 触点 9 落为 `src/web/frontend/blocks/registry.jsx`（React 组件注册表，计划写 `.js` 是笔误——
  注册的是编辑器组件，天然是 JSX）；配套新增 `src/modules/entries/blockPanel.jsx`（块面板壳：
  加块 / 转类型 / 排序 / 删除 / 打码开关，块 CRUD 走 HTTP action）。
  ② 块面板的块数据走 `GET/PATCH /api/entries/:ref/blocks`，与 CLI 同一条 service 路径（一条 action 双端）。
- **验证**（全绿）：
  - `pnpm test`：337 项单测通过（含新增 blocks / block-crypto / store-version 三份）、lint、build；
  - `tests/smoke.mjs`：157 项断言通过（含块 CRUD、导出→导入块正文跟随、secret 块打码）；
  - CLI 实测：`entry block add/list/move/update` 七种块类型渲染正确，`--mask` 打码生效；
  - 真浏览器（headless Chrome）实测：详细页块面板 8 块全部渲染
    （heading 双击编辑、md 走 MdView、table 复用 TableFieldControl、secret 打码态只读 + 不写入），
    无「视图崩溃」降级。
- **实测抓出并修掉的**：bootstrap 后渲染崩溃（渲染注释与函数声明粘连）；
  块删除 action 的 dry-run 分支缺陷；smoke 两处断言与实现语义不符（块数 4→8、导入块数）。
- **transfer**：导出包带 `body`（块正文随条目往返），导入按 conflict 策略写回；
  file 块附件 id 计入 `referencedFileIds`，table 敏感列导出解密缺陷顺带修掉。
- 遗留给 S2+：容器块（section/column）编辑随 S3；section 块的内嵌表格渲染随 S3 数据库视图。

## S2 触点清单（10-implementation-plan.md §五）

| # | 触点 | 状态 |
| --- | --- | --- |
| 1 | `src/core/store.js`：normalizeSection 加 `views` / `defaultView` | ✅ |
| 2 | `src/modules/sections/service.js`：视图 CRUD + 缺省推断（不落盘） | ✅ |
| 3 | `src/modules/sections/index.js`：5 条 view action（§九 9.3） | ✅ |
| 4 | `src/modules/entries/view.jsx`：视图 chips + table 视图（列 = 字段投影） | ✅ |
| 5 | `src/web/frontend/components/viewChips.jsx`（新增） | ✅ |
| 6 | 测试：`tests/unit/views.test.mjs` + smoke 视图 CRUD / 导出往返 | ✅ |

### S2 完成（2026-10-30）

- **新增一件计划外的 shared 文件**：`src/shared/views.js`（类型词汇表 / 归一 / 缺省推断 / 投影解析）。
  理由与 `shared/blocks.js` 完全相同：面板不许 import core，而「什么算合法视图」「缺省长什么样」
  只允许一份实现 —— 计划把归一写在 store、校验写在 sections service，会变成两份实现（table.js 的教训）。
- 6 个触点全部落地。另有两处**计划内未写、但不做就断链**的补充：
  ① `src/modules/entries/entriesTable.jsx`（表格投影的渲染，密文列在表格里一律打码）；
  ② transfer 导出包带 `section.views` / `defaultView`，导入只在「新建栏目」或「目标没配过视图」时应用
     （目标已有视图 = 用户自己配过，不静默覆盖，预览里给警告）。
- **`FORMAT_VERSION` 1 → 2**：包里现在有 `body` 与 `views` 两个新键。升版本不是为迁移（都是可选键），
  是为了**让老版本读到新包时明确拒绝**——老版本的白名单会静默丢掉这两个键（S5 的降级方向提前落地）。
- 语义决策两处（都写进了代码注释）：
  ① **第一次改视图时把当前生效的推断视图一起固化**。只写用户新建的那一条，会让其余 chips 凭空消失，
     看起来像丢了配置；
  ② `views: []` 与「没配过」行为完全一致（都走推断）—— 否则「配过又删光」会进入一个既没有视图、
     也不推断的死状态。
- **验证**（全绿）：
  - `pnpm test`：346 项单测（新增 views 9 项）+ lint + build；
  - smoke 164 项断言（新增：推断三条 / add 固化 4 条 / provisional 转 false / update 列宽+排序 /
    不存在字段报 INVALID_INPUT / set-default / 导出→导入视图跟随）；
  - 真浏览器（CDP 真点击）实测：chips = 表格/精简/看板（看板置灰），表格视图 13 列含「密文」标记，
    点「精简」→ 2 列（名称/状态）、点回「表格」→ 13 列，全程无崩溃、`推断（未落盘）` 提示在位。
- 遗留：看板**渲染**随 S3（配置与 action 已可用）；列宽拖拽 UI 随 S3（`--set col.x.width` 已可用）；
  `--filter` 按设计 §8.2 **明确拒绝**（v1 不做筛选 DSL，避免存一个不生效的配置）。

## S3 触点清单（10-implementation-plan.md §六）

| # | 触点 | 状态 |
| --- | --- | --- |
| 1 | `package.json`：`@dnd-kit/*`、`flexlayout-react` 移到 dependencies | ✅ |
| 1b | 布局壳：`workspace.js`（模型+落盘）、`panels.jsx`（注册表）、`App.jsx`（顶栏+Layout） | ✅ |
| 1c | 撤销/重做：flexlayout 自带 `useUndo`，顶栏按钮 | ✅ |
| 1d/6 | 布局存 localStorage（`nx-sk-ui.workspace`）；ui 键 `viewId`（S2 已加）、`entry` | ✅ |
| 2 | `App.jsx` 顶栏改写：栏目 tab 移除，只留全局动作 | ✅ |
| 3 | `components/sidebar.jsx`（新增）：目录树 + 拖拽重排/嵌套 + 隐藏 + 条目子节点 | ✅（条目拖拽改归属**明确不做**，见记录） |
| 4 | 树纯函数 → `src/shared/navTree.js`（**位置偏离计划**，见记录）+ `tests/unit/nav-tree.test.mjs` | ✅ |
| 4b | `navModel.js` 降级为目录树数据源 | ✅（读路径改走 navTree；navModel 保留给设置页的分组编辑） |
| 5 | `settings.service`：`navTree` 键 + `coerceNavTree` + 从老三套推断 | ✅ |
| 7 | `activeView.js`：`parseHash` / `buildHash` / `resolveDeepLink` 两段深链 | ✅ |
| 8 | `components/blockDnd.jsx`（新增）：正文块拖拽排序 | ✅（限顶层块，见记录） |
| 8b | 面板抽屉：停靠位置 chips → `Actions.addTab(… DockLocation …)` | ✅ |
| 9 | `styles.css`：FlexLayout 变量覆写（不引自带主题）+ 目录树样式 | ✅ |
| 10 | `shared/blocks.js` 容器块 section/column | ✅（S1 已完成） |
| 11 | 详细页 board 视图：拖卡 = `entry update --set` 写操作 | ✅ |
| 12 | 测试：nav-tree 单测 9 项 + settings navTree 4 项 + activeView 深链 3 项；DOM 拖拽走 CDP 手测 | ✅ |

### S3 完成（2026-10-30）

- **三处与计划的偏差，都有明确理由**：
  ① 树纯函数落 `src/shared/navTree.js` 而不是计划的 `web/frontend/components/navTree.js`：
     `settings.service`（后端）也要从老三套推断同一棵树（`settings get` 的渲染要与面板一致），
     两边各写一份必然分叉 —— 与 shared/views.js 同一条理由。
  ② **条目拖拽改归属不做**：后端没有 `entry move`，硬做只能「新建+删旧」，会把附件与块正文的
     引用打散；界面上不画一个拖不动的把手（假交互比没有更糟）。入口留给后续版本。
  ③ 块拖拽限**顶层**块：容器 children 的拖拽要沿 findContainer 算目标容器，与「把手在嵌套层级
     点不准」纠缠，随 S6 整壳迁移一起做。上移/下移菜单照旧可用（含嵌套块）。
- 新增/改动的文件：
  - `src/shared/navTree.js`（新）：normalizeNavTree / pruneNavTree / moveNode（arrayMove 语义，
    拒绝自嵌套）/ inferNavTree（老三套→树，只读不写回）/ resolveNavTree（显式优先）。
  - `src/modules/settings/service.js`：`navTree` 键 + `coerceNavTree`（写坏了明确报错，不静默丢：
    kind 不认识 / 栏目不存在 / 同栏目挂两处 / 空分组）；`getSettings` 返回 `navTree` + `navTreeSource`
    （explicit / inferred），CLI 渲染目录树并写明来源。
  - `src/web/frontend/workspace.js`（新）：FlexLayout 模型读写 / openPanel（复用同 config 面板、
    同步页签名）/ 落点选择（不许开进侧边栏自己的 tabset）。
  - `src/web/frontend/panels.jsx`（新）：面板注册表（sidebar / welcome / database / sections /
    files / export / settings）+ factory。
  - `src/web/frontend/components/sidebar.jsx`（新）：目录树（展开条目子节点走 `/api/sections/tree`；
    拖拽落点：分组=嵌套、栏目=插到其后、空白=根层末尾；隐藏走 navHidden，树底可恢复）。
  - `src/web/frontend/components/blockDnd.jsx`（新）+ `blockPanel.jsx` 顶层块接入把手排序。
  - `src/web/frontend/App.jsx`：整壳替换（顶栏全局动作 / Layout / 抽屉 / 状态条 / 深链）。
  - `src/web/frontend/activeView.js`：parseHash / buildHash / resolveDeepLink（两段深链；
    坏转义不炸、查询串忽略、旧别名归一、条目清单没拉到时不误报「条目不存在」）。
  - `src/modules/entries/view.jsx`：ui.entry 变化跟随切换条目（目录树点条目 / 深链第二段），
    **有未保存改动时不切**并提示——静默丢编辑比「点了没反应」糟。
  - `styles.css`：`--flexlayout-*` 全量变量覆写（只借结构 CSS，配色仍走全站 token）+ 目录树/抽屉/状态条。
- **实测抓出并修掉的**：
  - 不引 `flexlayout-react/style/light.css` 时面板组高度算成 0，库**直接不渲染面板内容**
    （页签在、内容空）——已在 main.jsx 注释钉住这个坑。
  - CDP 模拟拖拽三连坑（都写进探针注释）：`pointerdown` 的 `button` 必须是 0（dnd-kit 只认主键）；
    `Page.navigate` 到相同 URL 是同文档导航不刷新，探针会拖到上一轮的幽灵卡片。
- **验证**（全绿）：
  - 单测：353 项（nav-tree 9 + settings navTree 4 + activeView 深链 3 + views 看板分桶 2）+ lint + build；
  - CDP 真浏览器（隔离 store 实例，不碰真实数据）：
    - 壳：目录树 8 栏目渲染 / 点栏目开 database 面板（hash `#/job`）/ 布局落盘 localStorage；
    - 看板：切「看板」chip → 按 select 字段分列；**拖卡写回**（拖「男」→「女」，toast 确认，
      dump 复核 gender=女，右侧详情同步显示）；
    - 目录树拖拽：拖 job 到 demo 之后 → `settings.navTree` 固化（`navTreeSource: explicit`），
      再读回 `navTree = [demo, job]`。
- 体积记录：主 bundle 161 KB → 422 KB（gzip 53 → 124 KB），增量全部来自 flexlayout-react + dnd-kit
  （计划 §十二允许的前端-only 依赖；CLI 侧零变化）。
- 遗留给 S4/S5：条目跨栏目移动 action；列宽拖拽 UI；容器块（column）的可视化编辑。

## S4 触点清单（10-implementation-plan.md §七 / 设计 §十四）

| # | 触点 | 状态 |
| --- | --- | --- |
| 1 | `src/core/paths.js`：`pendingDir()` | ✅ |
| 2 | pending 服务（新文件 `src/modules/entries/aiPending.js`：差异/哈希/落盘/查询/渲染） | ✅（**位置偏离计划**：没塞进 service.js，见记录） |
| 3 | `service.js`：aiSuggest / aiApply / aiReject / aiList + 明文比对 | ✅ |
| 4 | `entries/index.js`：4 条 action（list/suggest/apply/reject，计划 3 条，**补了 list**） | ✅ |
| 5 | `components/aiBar.jsx`（新增）+ `blockPanel.jsx` 挂载 + styles.css | ✅（评审条形态，**不在面板里生成提议**，见记录） |
| 6 | `shared/blocks.js`：diffText / blockText / validatePending | ✅ |
| 7 | 测试：`tests/unit/ai-pending.test.mjs` 15 项 + smoke 11 项断言 | ✅ |

### S4 完成（2026-10-30）

- **核心语义决策（与计划 §七「pending 服务：请求（调 AI）」的一处偏差）**：
  nx-sk **不内置大模型**。提议由调用方（agent 或外部模型）产出后经
  `entry ai suggest --from @proposal.json` 交进来，`--prompt` 只是留痕。
  理由：本地优先的产品没有模型凭据可用；而「agent 走 CLI 落 pending、人在面板上审同一条」
  恰好是设计 §14.5「agent 走 CLI 同语义」想要的形态，且不需要第二个 AI 入口。
  面板的 AI Bar 因此是**评审条**（渲染 diff + 应用/拒绝），不是「生成条」。
- **计划外的三处补强（都在实现中实测踩出来）**：
  ① **secret 块按明文比对**：store 里是密文、提议（来自 `entry block list`）里是明文，
     直接比哈希会把没动过的密钥全报成「密文块已变更」→ 增加服务端解密对照（解不开退回密文比）。
  ② **readPending 不跑 validateBlocks**：pending 里的 secret 是明文，而块校验合理地拒收
     「value 不是密文」——块的业务校验移到落盘侧（setEntryBody → seal → validate）。
     校验位置错了只会把合法提议挡在门外。
  ③ **容器块不进 diffs**：column/section 的哈希含 children，子块一改父块必变，照实报是假噪声。
- **验证**（全绿）：
  - `pnpm test`：379 项单测（新增 ai-pending 15 项）+ lint（0 error）+ build；
  - smoke 175 项断言（新增 11：suggest 不写 store / list 无 blocks / apply 写入并删 pending /
    字段名不进 store.json / conflict 不覆盖 / --force 才覆盖 / noop / reject）;
  - CLI 端到端（隔离 home）：suggest → list → apply → 改一段出字符级 diff（「资源管理器」→「知识库」，
    same/del/ins/same）→ 外部改动 → conflict → force → reject → noop → 泄漏自检 → `--block` 越界拒绝；
  - CDP 真浏览器（隔离实例）：详细页 AI 提议条渲染（prompt / 时间 / 改动统计 / 红删绿增 / 新增淡绿）、
    点「应用全部」→ toast、正文两块更新、条目消失、store 复核一致。
- pending 隔离双层自检（文本层 + 结构层字段名）进了单测；`~/nx-sk/pending/` 删目录即清空。
- S5 顺带完成两项：导出预览掩码统计扩到块 + **导入对打码密钥块的防线**
  （此前会把 `******` 加密存盘——与 0.19 字段路径同类缺陷；现在值清空待重填并计数/警告）。

## S5 触点清单（10-implementation-plan.md §八）

| # | 触点 | 状态 |
| --- | --- | --- |
| 1 | `transfer/service.js`：`manifest.formatVersion`（缺失 = 1）；导入按版本分支 | ✅（S2 已落地，S5 补测试） |
| 1-附 | 「新包导旧库警告已忽略」→ 实现为**显式拒绝**（S2 决策，比警告更强），CHANGELOG 有说明 | ✅ |
| 2 | 导出预览的掩码统计扩到块 | ✅（S4 顺带完成） |
| 3 | 降级守卫的用户提示：bootstrap / health 展示「store 由更新版本写入」 | ✅ |
| 4 | references：块（10-§五）、视图（10-§六）、包版本（60-transfer） | ✅（**文档落点偏离计划**，见记录） |
| 5 | README 命令总表 + CHANGELOG 破坏性变更 | ✅（README 随 S3/S4 提交已齐；CHANGELOG 0.21.0/0.23.0） |

### S5 完成（2026-10-31）

- **起点**：合并远程 0.22.0（source 资料袋 markdown 化）之后收尾。包版本分支与掩码统计
  在 S2/S4 已实现，S5 的实际增量是**验证补齐 + 降级提示 + 文档**。
- **降级提示**（store.js:225 注释预留的最后一个消费方）：新增 `downgradeNote()`
  （与 `corruptNote()` / `migrationNote()` 同一模式）；`bootstrapInfo` / `healthInfo`
  带上 `downgrade` 字段，CLI `bootstrap` 与 `health` 输出主动展示
  「磁盘 v99 > 当前 v4，写入会被拒」——不等用户改一次被 BLOCKED 才知道。
  health 的 store 检查 `ok` 保持 true（能读能看，只是改不了——health 的职责是「现在能不能用」）。
- **包版本测试补齐**（验收矩阵里此前没测的两格）：
  旧包（manifest 无 `formatVersion`）→ 视为 v1 照常导入、导入后无 body（不凭空补空数组）；
  更新包（`formatVersion` 3）→ preview 与 apply 同一条守卫，明确报「版本过新」，
  不留半个栏目。`FORMAT_VERSION` 从 service 导出供测试引用（单一事实来源）。
- **文档落点偏离计划的说明**：计划写「15-special-fields（块）」，但块不是字段类型——
  15-special-fields 的职责是「值不是标量的那几种**字段**」。块正文与 AI 提议落
  10-sections-entries §五（S3/S4 已写），本次补 §六**数据库视图**（此前完全没写）
  并把 §八 Web 面板从「每栏目一个 tab」的过期描述重写为工作区壳
  （目录树 / FlexLayout / 两段深链 / navTree 固化时机）。60-transfer 的包版本段补
  「manifest 缺键视为 1 号包」。
- **验证**（全绿）：
  - `pnpm test`：单测 386 项（新增：包版本分支 2 项；downgradeNote 是既有降级守卫测试里的新断言）+ lint + build
    + smoke 175 项断言；
  - CLI 实测（临时 v99 store）：`health` 出「!! 降级运行」行 + store 检查明细、
    `bootstrap` 出「注意」行、写操作明确报 BLOCKED（磁盘版本 v99 > 当前 v4…请升级）。
- **0.23.0**：版本号随本提交升级（远程已把 0.22.0 用于 source markdown 发布）。
