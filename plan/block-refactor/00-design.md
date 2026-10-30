# nx-sk 块级重构 · 设计基线（v0）

> 状态：**基线** —— 沉淀自 2026-10-30 会话讨论（0.20.0 时点），由 rp-loop 逐轮迭代。
> 目标：把「栏目 / 条目 / KV」体系升级为类 Notion 形态——**数据库页（多视图）+ 详细页（块正文）**，布局全域可拖拽。
> 边界：本设计阶段**不修改任何业务代码**（`src/` 与 `assets/` 零改动）；S0 原型另行批准。

## 一、输入

| 输入 | 位置 | 学到什么 |
| --- | --- | --- |
| FlexLayout | `.claude/repo/FlexLayout`（1382★，TS，MIT，只依赖 React） | 布局 = 可序列化 JSON 树（row→tabset→tab，`Model.fromJson/toJson`）；tab 存 `component` 字符串、factory 查表渲染；tabset 停靠 / 边缘停靠 / popout / 双击最大化 |
| block_editor_demo | `D:\DevProjects\my\github\fr\lib\lab\demos\block_editor_demo`（Flutter，~3750 行） | 块 = 带 id/type 的持久化数据（TOML），顺序即文档；渲染按 type 注册表（`noteRoot.renderBlock`）；`ReorderableListView` + `ValueKey(block.id)` 列表级拖拽；`toolbar_factory` 按模式换工具栏；**块级 AI：AI Bar 唤起 → pending diff（红删绿增/新增淡绿/删除置灰）→ 顶部固定条「应用全部/拒绝全部」，AI 永不直接改数据** |
| nx-sk 0.20.0 | 本仓库 | 字段字典 = 数据（`section update --add-field`）；0.19 `table` 字段已证明「自描述文档」路线（列/行/公式全在值里）；前端已有视图注册表（`src/web/frontend/registry.js`）、lightbox、md 渲染链（`mdView/mdSmart/mdInline`）；KV = `kv: true` 栏目的唯一版式（`src/modules/entries/kvTable.jsx`） |

## 二、概念映射（核心洞察）

**把「字段类型」机器拆成两个消费者**：Property（schema 在栏目字典）与 Block（schema 在块值自身）。`table` 字段已经证明了后半条路。

| Notion 概念 | nx-sk 现状 | 缺口 |
| --- | --- | --- |
| Database（数据库页） | 栏目（字段字典 = schema，已是数据） | **视图层**：每个栏目只有一种死版式（表单列表 / KV 两列表） |
| Database row | 条目 | 行的多视图呈现（table/board/kv/gallery）与手动排序 |
| Page（详细页） | 条目详情 = 字段表单 | **正文 body**：条目只有 values（属性），没有块序列 |
| Property | 字段（含 sensitive 加密） | 已完备 |
| Block | `table`/`md`/`file`/`secret`/`entrylist` 字段值（半成品） | 从「字段值」升格为「条目自己的一等块序列」**（§十三 13.1 修订：块递归，栏目本身也是块）** |
| View config | 无 | **视图配置也是数据**（存 `section.views`，非每浏览器 UI 态） |

KV 的归宿：`kv: true` 不再是栏目种类，而是**数据库页的一种视图类型**（`{type:'kv'}`），与 table/board 平级；`kvTable.jsx` 从「唯一编辑界面」降级为「视图之一」；secret 的密文边界一行不改。

## 三、目标架构（四层，各自独立可发布）

```
┌─ L4 工作台布局（FlexLayout）─ 数据库页 | 详细页 | 附件中心 停靠/分栏/popout，布局 JSON 存 ui（localStorage，见 §十二 12.8）
├─ L3 数据库视图 ── section.views[] = {id, type: table|board|kv|gallery, columns, groupBy, sort}
│                    列 = 字段字典投影；行 = 条目；拖拽改列序/分组值/行序
├─ L2 详细页 ────── 条目 = 属性区(fields) + 正文区(body: Block[])
│                    Block = {id, type, value, children?}，type 注册表渲染（demo 的 BlockCard 模式）
└─ L1 块内核（数据）─ 复用字段类型的校验/密文/渲染；CLI+HTTP 同一 action（不变量①）
```

> **§十三 13.4 修订**：本分层升为 L1–L5（加「侧边栏树」层），FlexLayout 从「只管栏目工作区」扩到「管整个壳」，块改为**递归**（children 一等公民）。上方分层保留作为演进轨迹，以 §十三 为准。

- **L1 块内核**：`entry.body?: Block[]` **可选字段**，老数据零迁移；块类型第一版复用现有七种字段类型 + `paragraph`/`heading`，不发明新形状；sensitive 块走同一条 AES-256-GCM 边界；新 action `entry block add|move|update|remove`（一条声明两端）；transfer 导出 body 随条目走（md 图片重映射复用 `src/core/mdimages.js`）。
- **L2 详细页**：块卡片 `key=id`、点击选中、拖拽重排、悬浮 `+ / ⋮`、尾部加块区、斜杠菜单插块；块级 AI Bar + pending diff（依赖 L1 的块寻址）。
- **L3 数据库视图**：`section.views` 存 store（跨端一致），不是 `settings.ui`；table 视图列 = 字段投影 + 宽度/顺序；board 拖卡片 = 改 select 字段值（复用写 action，不造第二语义）。
- **L4 工作台**：FlexLayout 只管**壳**（面板停靠/分栏/popout，数据库页 + 详细页 side-peek）；块内部列表拖拽**不用** FlexLayout（它是 tabset 停靠不是列表重排），用 **dnd-kit**（D3）——两层拖拽互不污染，分工细节见 §十二 12.5。

## 四、红线（重构不许破坏的东西）

1. 三条不变量：一 action 双端、依赖只向下（core←modules←runtime←bin，eslint 逐模块枚举禁互依）、业务结果返回 `{status}`；
2. 安全三出口不变：sensitive 块密文落盘、`--mask` 打码、含 `******` 的值拒绝写回；导出包恒明文靠 passphrase；
3. 加法不换血：`body`/`views` 可选、每栏目 opt-in（`section sync` 式补齐）；kvTable 保留为视图类型，老用户 store 零迁移；
4. 前端边界：新依赖（flexlayout-react / DnD 库）只进 `src/web/frontend/` 侧的 bundle；eslint「前端禁 node:*/core/service」照旧；CLI 侧保持零依赖；
5. store.json 体积与 transfer 兼容：旧包导入新库、新包导入旧库都要有明确行为（包格式带版本字段）。

## 五、分期（每期独立可发布，可随时停）

| 期 | 内容 | 验收 |
| --- | --- | --- |
| S0 尖锐原型 | `demo` 栏目上做一个隐藏视图：纯前端把现有 md/table 字段当块渲染 + 列表拖拽，不落盘 | 验证「块=字段值」手感 |
| S1 块内核 | `entry.body` + block CRUD actions + 渲染注册表 + 详细页（属性区+正文区） | CLI 能建块、面板能拖块；smoke + 单测全绿 |
| S2 数据库视图 | `section.views` + table 视图（列=字段投影）+ 行点击开详细页 + kv 收编为视图 | 一个栏目两种视图切换，数据同源 |
| S3 全域拖拽 | 块重排、列拖拽、board 拖卡改值；FlexLayout 上壳（数据库页+详细页分栏） | 布局 JSON 可存可恢复 |
| S4 块级 AI | AI Bar + pending diff（移植 demo overlay/diff 模式），走 action 双端 | AI 改块必有「应用/拒绝」，agent 走 CLI 同语义 |
| S5 收尾 | transfer 兼容、`section sync` 补视图、skill references 更新、CHANGELOG | 老包新包互导行为明确 |

## 六、开放问题（待拍板）

1. **详细页给谁**：所有非 kv 栏目都长 body，还是按栏目 opt-in？
2. **board/kanban 进哪一期**：v1 就要，还是 table+kv 先行？
3. **新依赖**：`flexlayout-react` + 一个 DnD 库（dnd-kit 或纯原生）能否进 package.json？
4. **FlexLayout 管多宽**：整个面板壳换成 FlexLayout，还是只给「工作台」新页用？

## 七、决策记录

### D1 · 详细页给谁：非 kv 栏目全量，kv 不给，不设栏目级开关（R1）

- **决策**：详细页（属性区 + 块正文）是所有**非 kv 栏目**的条目详情形态；`kv: true` 栏目保持 kvTable 内联编辑，不出详细页。v1 不加 `--blocks` / `--detail` 之类的栏目级特性位。
- **依据**：栏目本来就按形状分两种布局（`src/modules/entries/view.jsx:24-32`：kv → kvTable，其余 → 列表+表单）；详细页是「列表+表单」的**渲染升级**——属性区复用现有表单控件（`src/web/frontend/components/fieldEditor.jsx` 的 FieldGroup），数据与 action 零变化，所以「全量」不产生迁移。当前条目页已是「左列表 + 右表单」双栏、分割条可拖宽（`entries/view.jsx:55-80`，宽度持久化 `ui.listW`）——数据库页 + side-peek 有直接前身。
- **被否**：① 按栏目 opt-in 开关——引入第三个栏目级特性位，要贯穿 sync / transfer / settings 三条链路（README 踩坑：字段字典只在模板里曾导致「模板演进到不了老栏目」，特性位有一模一样的同步问题），收益只是省一个空正文区；真有不想要正文的栏目，将来加 `--no-detail` 是纯减法，随时可补。② kv 也出详细页——一行 = 一个键值对，页面化是噪音（`kvTable.jsx:6-14` 的设计意图就是「密钥就是一张表，别的一概不需要」）。

### D2 · board 看板：放 S3，与拖拽基建同期（R1）

- **决策**：S2 只交付 table + kv 两种视图（展示 + 行点击，无拖拽）；board 随 S3 落地。
- **依据**：board 的核心体验是「拖卡片改 select 字段值」——没有拖拽的看板不如「按分组筛选的表格」。S3 反正要建 DnD 基建（依赖、拖拽 = 写 action 的语义、放置命中判定），board 与块重排 / 列拖拽共享同一套。
- **被否**：S2 就上 board——DnD 基建提前，S2 膨胀且交付的是半成品看板。

### D3 · 新依赖：flexlayout-react + @dnd-kit/core + @dnd-kit/sortable（R1）

- **决策**：三个包进 `dependencies`（只进 vite bundle）。CLI 侧零依赖不变（`src/runtime/cli.js` 不 import 它们）。
- **依据**：面板 bundle 现状 ~480KB JS（`src/web/public/assets/`：index 160KB + 最大 view chunk 239KB + 4 个小 chunk），本地 127.0.0.1 场景无带宽压力；FlexLayout 唯一依赖 React、MIT、ESM-only；dnd-kit 自带键盘可达 / touch / auto-scroll，sortable 列表手写这些的成本远超包本身。eslint 前端边界（`eslint.config.js:94-102`）只禁 `node:*` / core / runtime / service，npm 包不受限。
- **被否**：① 全手写拖拽——列宽分割条手写已证明可行（`entries/view.jsx:55-80`），但那是「一根分割条」，不是「sortable 列表」；② 只上 FlexLayout、块拖拽也用它——FlexLayout 是 tabset 停靠语义，块序列是列表重排语义，硬套会得到错误的交互。

### D4 · FlexLayout 管多宽：只管「栏目工作区」，整壳迁移列为 S6 可选（R1）

- **决策**：FlexLayout 容器 = 栏目工作区（数据库页 tabset + 详细页 side-peek tabset + 可选附件面板）。顶部导航（栏目管理 / 附件 / 导出导入 / 设置 + 数据驱动的栏目 tabs）维持现有壳；S3 验证后若收益明显，整壳迁移立 S6。
- **依据**：拖拽价值集中在栏目工作区；顶部导航是数据驱动的（`src/web/frontend/App.jsx:21-52`：bootstrap.sections + settings.navGroups/navHidden/navOrder + 分组悬浮展开），深链与默认栏目规则有单测钉住（`tests/unit/active-view.test.mjs`、`tests/unit/nav-model.test.mjs`）——换壳必须连这套规则和测试一起搬，回归面大。「所有布局可拖拽」由工作区面板停靠 + 块 / 列 / 卡片拖拽共同满足。
- **被否**：整壳换 FlexLayout——设置页自己的 navGroups 拖拽管理（`navManager.jsx`）是另一套领域交互，塞进 FlexLayout 语义更别扭；且 S3 一次换两层拖拽体系，出问题无法定位是哪层。

## 八、数据模型（R2）

### 8.0 决定性的实现事实：normalize 是白名单重建

`normalizeEntry`（`src/core/store.js:68-79`）只挑 `id/section/title/tags/values/createdAt/updatedAt` 七个键**重建新对象**；`normalizeSection`（store.js:43-66）同理。**推论**：`entry.body` 与 `section.views` 不能靠「未知键直通」存活——必须在两处 normalize 显式加键，否则**第一次写回就被静默抹掉**（这正是 README 踩坑「不报错、不崩，只是永远返回半个结果」的同族事故，且更狠：丢数据）。

```js
// normalizeEntry 增加（undefined = 键不存在，落盘省略，老数据零变化）：
body: Array.isArray(raw.body) ? raw.body.map(normalizeBlock) : undefined,
// normalizeSection 增加：
views: Array.isArray(raw.views) ? raw.views.map(normalizeView) : undefined,
```

**STORE_VERSION：R2 说「不 bump」，R3 核实后推翻——要 bump 到 4**。理由不是迁移（可选字段，老数据读到 `undefined` 即缺省），而是**降级守卫**：降级场景现有代码无任何守卫（详见 §九 9.1 D5）。原风险登记：**老版本代码读到含 body/views 的新 store，经白名单 normalize 后写回会抹掉它们**。

### 8.1 `entry.body?: Block[]` —— 块正文

> **已被 §十三 13.1/13.2 修订**（块递归、类型由 7 种扩到 10 种、children v1 就开放）。本节保留作为演进轨迹，**以 §十三 为准**。

```js
Block = {
  id: 'b_<rand>',   // 复用 src/core/ids.js 的 id 族（f_ 附件同一先例）
  type: BlockType,
  value: any,       // 按 type 的自描述值——形状与同名**字段类型**的字段值完全一致
}
```

BlockType v1 = 7 种，**全部复用字段值机器，不发明新形状**（`fields.js:8` 的 FIELD_TYPES 14 种是母体）：

| BlockType | 值形状 = 哪种字段值 | 复用点（已核对） |
| --- | --- | --- |
| `paragraph` | string（同 text/textarea） | 文本 coerce |
| `heading` | `{ text: string, level: 1\|2\|3 }` | **唯一新形状**（校验约三行） |
| `md` | md 字段值（markdown + 内嵌图片 id） | `src/core/mdimages.js` 图片重映射直接覆盖 → transfer 零新增 |
| `table` | 自描述文档 `{columns, rows, totals?}` | `src/shared/table.js` 全内核（`computeTable`/`sanitizeColumns`/公式体检），「自描述」哲学同源（table.js:3-5） |
| `entrylist` | 行数组 | 现有 coerce |
| `file` | 附件 id 列表 | `src/core/attachments.js` 引用扫描把 file 块纳入正式引用（机制同 0.20 的「source 袋 file item 也算正式引用」），孤儿清理不误删 |
| `secret` | secret 密文信封 | `src/core/vault.js` 同一加密路径；`isSensitiveField`（fields.js:832）判定扩展为「字段 + 块」；掩码写回拦截同一套 |

> **R13 补一条**：`entrylist` 块的形状要**多带一个 `fields`**（子列定义）。
> 字段的 `entrylist` 能从栏目字典拿到 `fields`，**块没有栏目字典可查**——不自带就渲染不出表头。
> 见 §十三 13.2 的 R13 修订表第 2 条。

**内核落位**：新增 `src/shared/blocks.js`（纯函数零依赖）——跟 `table.js` 放 shared 的同一条理由（table.js:11-15）：**校验必须前后端同源**（「写入即体检」原则），面板保存前预检与 service 真值校验共用一份实现。导出面：`BLOCK_TYPES / normalizeBlock / validateBlocks`（委托各类型现有 coerce，heading 自带三行校验）。

**完整度**：body **不进**完整度——fill 策略（fields.js:44）是「待填字段」的概念，块正文是内容，混进去会把完整度这个导航数字搅浑。

### 8.2 `section.views?: ViewConfig[]` —— 数据库视图配置

```js
ViewConfig = {
  id: string,                            // 'table-default' / 'board-by-status' / v_<rand>
  type: 'table' | 'board' | 'kv',        // gallery 下一版预留
  title: string,
  columns?: [{ key, width?, hidden? }],  // **只存投影**：类型/标签/候选值回查字段字典（单一事实源）
  groupBy?: string,                      // board：select 字段 key
  sort?: { key, dir: 'asc'|'desc' } | null,
  filter?: [{ key, op, value }] | null,  // **下一版再做**（op: eq|neq|contains|empty|notEmpty）——v1 不发明查询 DSL，只做 columns / sort
}
```

- **缺省供给不落盘**：`views` 为 `undefined` 时读取层推断——非 kv → 一条 `{type:'table', columns: 全部非 source 字段}`；kv → 一条 `{type:'kv'}`。推断结果只在读路径生效，用户第一次改视图才写 `section.views`。继承「播种只发生在文件不存在」的克制（store.js:29-33 注释）。
- **投影降级**：columns 引用的字段被删 → 列渲染「已删字段」弱占位（不炸、不静默消失）；字典新增字段**不**自动进用户视图（视图是显式选择），只有默认表格视图每次从字典重算。
- **kv 栏目的 views**：允许（如 KV 表加 sort），type 限 `'kv'`（D1）。

### 8.3 遗留到后续轮次

- R3：version 高于 `STORE_VERSION`（现为 3，store.js:14）时 `store.js` 迁移器的实际行为——降级写入守卫方案；
- R3：blocks 校验函数被 core 侧 import 是否违反分层（shared 层 eslint 未约束，`eslint.config.js` 只限 core→modules/runtime/web，需定稿）；
- R4：sensitiveViewer 探测扩展到 secret 块（先例：0.19 已扩展到表格密文列，见 CHANGELOG）。

## 九、action 契约（R3）

### 9.0 两项可行性核实（都是先读源码再定形状）

- **三段式 CLI 可用**：`resolveCommand` 最长前缀匹配、不限段数（`src/runtime/cli.js:168-179` 的 `path.every((seg,i) => tokens[i] === seg)`）→ `section view add` 这种三段命令合法，无需造 `view-add` 这种丑名字。
- **路由无遮蔽**：`compareRoutes` 字面量段优先（`src/runtime/spec.js:157-169`）——新增路由全部是「`:ref` 之后追加字面量段」，与现有 `/dump` 同层不同字面量互不遮蔽；`blocks/remove-many`（字面量）恒排在 `blocks/:blockId`（参数）之前，与 `entry.remove-many` 先例（`entries/index.js:110`）同模式。

### 9.1 D5 · STORE_VERSION 3 → 4：为降级守卫而 bump（推翻 R2 结论）

- **事实**：`normalize()` 无条件写回 `base.version = STORE_VERSION`（`store.js:179`）；`loadStore` 的迁移快照只处理 `oldVersion < STORE_VERSION`（`store.js:234`），**`>` 方向没有分支**。若不 bump，块时代的 store（version 仍是 3）被 0.20 老代码读到 → 白名单 normalize 抹掉 body/views → 下次保存静默丢失，且 version 相同**无从警告**。
- **决策**：S1 落地 blocks 时把 `STORE_VERSION` 升到 4（**无迁移函数**——version 数字本身就是守卫）；`loadStore` 增加 `oldVersion > STORE_VERSION` 分支：**拒绝写入**（`saveStore`/`mutateStore` 抛 `BLOCKED`：「store 由更新版本的 nx-sk 写入（v4 > v3），降级运行会丢块正文/视图配置——请升级 nx-sk」），读不受限。
- **被否**：不 bump、只写 CHANGELOG——防腐蚀原则是错误在边界处拦下，不靠文档自觉。

### 9.2 块 actions（entries 模块追加，7 条）

| id | CLI | HTTP | flags 要点 |
| --- | --- | --- | --- |
| `entry.body.get` | `entry body <ref> [--mask]` | `GET /api/entries/:ref/body` | mask 只作用于 secret 块 |
| `entry.block.add` | `entry block add <ref> --type <t> [--data @x.json] [--after <blockId>]` | `POST /api/entries/:ref/blocks` | 缺省追加尾部；`--data` 走 json flag（`@file` 先例 spec.js:78-81） |
| `entry.block.update` | `entry block update <ref> <blockId> [--data @x.json]` | `PATCH /api/entries/:ref/blocks/:blockId` | PATCH 语义；secret 块掩码写回拦截 |
| `entry.block.move` | `entry block move <ref> <blockId> --to <index>` | `POST /api/entries/:ref/blocks/:blockId/move` | 拖拽落点 = 一次 move；`--to` 亦收 `--before/--after <id>` |
| `entry.block.remove` | `entry block remove <ref> <blockId>` | `DELETE /api/entries/:ref/blocks/:blockId` | |
| `entry.block.remove-many` | `entry block remove-many <ref> <ids>` | `POST /api/entries/:ref/blocks/remove-many` | ids 逗号分隔；找不到的跳过并报告（status: partial，对照 0.20） |
| `entry.table`（扩展） | 已有命令加 `--block <blockId>` | `GET /api/tables/:ref` 加 `block` query | 表格块的只读现算**复用同一 action**——「这张表怎么算」保持一份实现 |

错误码：`INVALID_INPUT` = 块类型不合法 / `validateBlocks` 体检失败；`NOT_FOUND` = 条目或块不存在。全部返回 `{status:'ok'}`；块无唯一性，无 `CONFLICT` 语义。

### 9.3 视图 actions（sections 模块追加，5 条）

| id | CLI | HTTP | 备注 |
| --- | --- | --- | --- |
| `section.view.list` | `section view list <id>` | `GET /api/sections/:ref/views` | 缺省推断结果也列出，标 `provisional: true`（不落盘） |
| `section.view.add` | `section view add <id> --type table --title 精简 [--columns 姓名,状态] [--groupby 状态]` | `POST /api/sections/:ref/views` | 第一次 add 落盘 `section.views` |
| `section.view.update` | `section view update <id> <viewId> [--title] [--columns] [--sort key:dir] [--filter @f.json] [--set col.姓名.width=120]` | `PATCH /api/sections/:ref/views/:viewId` | **列宽拖拽结束 = 一次 update**；拖动中是本地 state（listW 先例 `entries/view.jsx:55-60`） |
| `section.view.remove` | `section view remove <id> <viewId>` | `DELETE /api/sections/:ref/views/:viewId` | 删光后回退缺省推断态 |
| `section.view.set-default` | `section view set-default <id> <viewId>` | `POST /api/sections/:ref/views/:viewId/set-default` | 写 `section.defaultView`（数据，不是 settings.ui） |

错误码：`INVALID_INPUT` = type 不合法 / columns 引用不存在字段；`NOT_FOUND` = 栏目或视图不存在；`CONFLICT` = add 时视图 id 重复。

### 9.4 前端调用面（状态归属）

- 视图配置（`section.views`）、块序列（`entry.body`）属 **store**（跨端一致，走上述 actions）；
- 「当前选中哪个视图」「拖列宽/拖块进行中的临时值」属 **ui**（每浏览器；`patchUi` 先例：`ui.listW`、`ui.mask`）；
- 与现有分工完全同构：数据走 action，视图态走 `settings.ui`。

## 十、安全边界推演（R4）

### 10.0 现有四件套（块全部复用，不新造加密）

| 机制 | 落点 | 块的用法 |
| --- | --- | --- |
| `encryptValue` → `{v, alg, kid, iv, tag, ct}` | `src/core/crypto.js:28-40` | secret 块的值落盘形状与 secret 字段**完全一致**（store.json 里看不出差别） |
| `decryptValue` | crypto.js:46-62 | kid 不符 → `BLOCKED` 并明说原因；密文损坏 → `BLOCKED` |
| `maskValue` | crypto.js:68-73 | **≤10 字符 → 同长度全星**（`'*'.repeat(len)`）；>10 → 前 4 + 6 星 + 后 4 |
| `looksMasked` | core 内（写回拦截入口） | 判定「收到的是打码占位而非明文」 |
| `resolveVaultKey` / `vaultStatus` / `currentKeyId` / `sensitiveViewer` | `src/core/vault.js:49/61/89/101` | 环境变量优先（`NX_SK_PASSPHRASE`），否则 `~/.vaultkey`；sensitiveViewer 造解密闭包给渲染层 |
| 读路径渲染 | `src/core/render.js:101-105` | 密文 → 解密 →（mask ? 打码 : 原文） |

### 10.1 哪些块算敏感

- **显式 `secret` 块**；`table` 块的 `sensitive: true` 列（已由 `prepareTable` 覆盖，entries/service.js:348-409）。
- **块不做「键名像凭据」的自动判定**：字段侧有 `looksSecretish(key) → type='secret'` 的自动登记（entries/service.js:90），但那是**字段字典**语义（键名 = 字段 key）；块没有 key，若按内容猜「像密码就密文」，猜错的后果是「用户再也解不开自己的块」。→ 决定：块的密文属性**只由显式 type 决定**。
- 副作用：`secret` 块在面板上必须能被打码开关覆盖（与字段一致）。

### 10.2 写路径：prepareBlockValue（与 prepareValue 同构）

四步，与 `prepareValue`（entries/service.js:411-429）逐条对齐：① 空值 → `null`；② **打码值认领原密文**（明文没改）；③ 打码占位且认领不到 → 抛 `INVALID_INPUT`（拒收，不是静默存掩码）；④ 否则加密落盘。

**块级比表格安全一档（写进设计优势）**：表格的密文认领只能按「打码值猜 + 行号兜底」，源码自陈其已知限制（prepareTable 注释 383-388：打码状态下拖动行、两格打码值相同时无法区分谁是谁）。**块有稳定 id**，认领按 `blockId` 精确命中，move 顺序变化不影响认领——这个限制在块级不存在。

### 10.3 读路径

- `entry body <ref>`：secret 块解密后默认原文，`--mask` 打码（与字段一致，不给块开特例）。
- 面板：块渲染复用同一 `sensitiveViewer` 解密闭包（vault.js:101）。**待改**：`sensitiveViewer` 现只认 entrylist 的 `fields`（CHANGELOG 0.19 已扩到表格密文列），S1 要再扩到 secret 块。

### 10.4 导出 / 导入（安全三出口之一，必须逐字对齐）

- **导出包恒为明文**：secret 块的值在打包时**解密写出**（与现有 secret 字段同一行为，README「包里恒为明文」）——新出口 `body` 不得漏解密，否则包里是一坨用户读不懂的 blob。
- **导入**：包里的明文 → 重新加密落盘（复用 `encryptValue`）。
- **外发必须 `--passphrase`**（scrypt + AES-256-GCM，内层加密再套合法 ZIP）；否则包是明文 ZIP，等同裸奔。
- **待核实（R5）**：transfer 导出器当前对 secret 字段是否确实「解密写出」——要读 `src/modules/transfer/service.js` 落实，块照抄同一分支。

### 10.5 附件引用

`file` 块的附件 id **计入正式引用**（对齐 0.20 的先例：source 袋里的 file item 也算引用，见提交 dae4825）——否则 `file cleanup` 会把仍被块引用的原件删掉。判定入口与 `file` 字段同一条。

### 10.6 待确认（交 R5 迁移轮）

- transfer 导出器对 secret 的实际处理代码位置与分支；
- 导入路径对明文 secret 的处理（`transfer import` 的字段值写入是否复用 `prepareValue`）；
- 包格式版本字段（承接 D5 的 v4 与 body/views 的新增字段）。

### 10.7 pending（AI 差异）内容不进落盘

块级 AI 的 pending diff **只在会话内存**：demo 同样不持久化（`state.dart:52-58` 的「不持久化（运行时状态）」注释）。理由是硬安全边界——pending 里可能含明文密钥，落进 store.json 就等于把它写进了备份与导出面。→ 定为红线：pending 不落盘、不进导出包、不进日志。

## 十一、迁移与兼容矩阵（R5）

### 11.1 store 版本阶梯

| 版本 | 产生于 | 读路径 | 写路径 |
| --- | --- | --- | --- |
| v1 | 0.11.x | 迁到 v2（密钥 8 字段 → 单字段 KV，store.js:90-128） | 同左 |
| v2 | 0.12–0.13 | 迁到 v3（`kv` 标记取代 `settings.kvSection`，store.js:138+） | 同左 |
| v3 | 0.14–0.20 | **现状**：normalize 白名单 + `source` 袋自愈 + 字段组自愈 | 同左 |
| **v4** | 本次重构 S1 | 与 v3 同读；`body`/`views` 缺席即缺省 | 需 bump + 降级守卫（D5） |

**v3 → v4 无迁移函数**：新增的只有可选键，老数据读出来就是「无正文 / 无自定义视图」，正是期望形态。迁移函数只在**结构变形**时需要（v1→v2 的字段搬家、v2→v3 的键位并入）。

### 11.2 `body` 缺席时的读路径矩阵（逐入口）

| 入口 | 行为 | 依据 |
| --- | --- | --- |
| `entry get` | 不输出 `body` 键（不是 `body: []`）——「没有正文」与「正文为空」是两种状态 | 沿用 `isStoredEmpty` 的思路（0.19 为 table 引入的区分） |
| `section dump` | 条目摘要里加 `blocks: 0` 或省略；**不新增未填项**（body 不进完整度，§八 8.1） | §八 8.1 |
| `entry body <ref>` | 返回空序列 `[]` + `provisional: false`；不报 NOT_FOUND | — |
| 面板详细页 | 属性区照常；正文区显示「还没有正文 · 加一个块」的空态 | — |
| `entry list` | 不受影响（不返回 body） | — |
| 导出 | body 为空 → 包里不含 body 键 | — |
| `entry table --block` | body 里没有对应块 → NOT_FOUND（只针对这一个块，不影响条目） | — |

### 11.3 transfer 包兼容矩阵

| 场景 | 行为 |
| --- | --- |
| 旧包（0.20 及以前产出，无 `formatVersion`）→ 新库 | 视为 `formatVersion: 1`：条目无 body、栏目无 views，全部按缺省路径落库 |
| 新包（`formatVersion: 2`，含 body/views）→ 新库 | 正常导入；body 按块数组还原，views 落 `section.views` |
| 新包 → **旧库（0.20）** | 旧代码不认识 body/views：导入时**丢弃这两个键**并给警告「包里有块正文/视图配置，当前版本不支持，已忽略」——不静默丢 |
| 整库包 | `bundle.json` + `sections/<id>.zip`，结构不变；`bundle.json` 里的栏目索引也要带 `formatVersion` |

**包格式版本字段**：`manifest.formatVersion`（整数，缺失 = 1）。写在 `bundle.json` 与单栏目包 manifest 两处；导入端按版本分支，不按「有没有某键」猜。

### 11.4 降级矩阵

| 场景 | 行为 |
| --- | --- |
| v4 store 被 v3 代码读 | 读得到（D5 守卫只拦写）；**写被拒**（`BLOCKED`），报「store 由更新版本写入，降级运行会丢块正文/视图配置」 |
| v4 store 被 v3 代码读后用户手动改 JSON | 不可控，文档化即可（无兜底方案，也不该有） |

### 11.5 ⚠ 本轮实测发现的既有缺陷（非本次重构引入）

**表格的敏感列在导出时不解密**。`plainValues`（`src/modules/transfer/service.js:55-87`）解密了顶层敏感字段与 entrylist 的敏感子值，但**全文没有出现对 `table` 字段的处理**——而 0.19 引入的 `table` 类型支持 `sensitive: true` 列，其单元格在写入时是密文 blob（`entries/service.js:378-381`）。

后果：导出的包里，表格的敏感列是**密文 blob**而非明文 → 导入到另一台机器（另一把密钥）→ 永远解不开。这恰是 `plainValues` 自己的注释（transfer/service.js:66-67）担心的那种情况，只是发生在 table 上。

- **修法**：在 `plainValues` 里补一段——`f.type === 'table'` 且行内有密文 blob 时解密（列的 `sensitive` 由 `normalizeTable` 后的 columns 给出）。
- **归属**：这是 0.20 的既有缺陷，不是重构引入；建议在 **S1 顺带修**（一行边界，测试易写），并在 CHANGELOG 显式记一条。

### 11.6 导出预览的掩码统计要扩到块

导出预览统计 `maskedSecrets` 时只扫**字段**（transfer/service.js:431-435：集合来自 `manifest.section.fields`）。块里的 secret 掩码值不在其中 → 预览会说「凭据随包（明文）」，而包里其实有掩码。→ 块时代的统计口径必须同时扫 body。

### 11.7 附件引用：file 块要进两处扫描

- `referencedFileIds`（transfer/service.js:89-105）：认 `file` 字段 id + `md` 正文图片 + `source` 袋里的 file item——**file 块要加**（否则导出的包漏原件）。
- `src/core/attachments.js:166-181` 的反向链接扫描：附件中心显示「被哪些条目的哪些字段引用」——**file 块要加**，否则附件卡片显示「未引用」而 cleanup 把它删掉。

（说明：`table` 列里没有 file 类型——`TABLE_CELL_TYPES`（table.js:24）不含 file，故表格不涉及附件引用，无需改。）

## 十二、前端架构（R6）

### 12.1 三张注册表，各管一件事

| 注册表 | 位置 | 键 → 值 | 状态 |
| --- | --- | --- | --- |
| `VIEWS` | `src/web/frontend/registry.js:10-16` | 视图 id → 页签组件（lazy import） | 已有；**不新增条目页签**——数据库页/详细页是栏目工作区的内部结构（D4） |
| `BLOCK_RENDERERS` | `src/web/frontend/blocks/registry.js`（新增） | 块 type → `{ render, editor, label }` | 新增；**只管渲染**，校验在 `src/shared/blocks.js` |
| `navModel` | `src/web/frontend/components/navModel.js` | 头部导航模型 | 已有，不动 |

**为什么块注册表放 `web/frontend/blocks/` 而不放 `modules/`**：`modules` 之间禁止互相 import（`eslint.config.js:27-35` 的逐模块禁列），块注册表要被 `modules/*/view.jsx` 与 `web/frontend` 同时用 → 放两边都能引的位置。分工照搬 `table.js` 的先例（table.js:11-15）：**算法/校验要两端一致 → shared；渲染是前端的事 → web/frontend**。现有 `modules/entries/kvTable.jsx:2-3` 已经这么干（从 web/frontend 引 api client 与 store），位置合法。

### 12.2 条目页：从「列表 + 表单」到「数据库页 + 详细页」

- 现状：`SECTION_VIEW`（`src/modules/entries/view.jsx`）= 左列表 + 右表单，双栏，左右栏分割条手写拖拽（entries/view.jsx:55-80）。
- 目标：`SECTION_VIEW` 重构为 `<Workspace sectionId/>`：主区 = 数据库页（视图 chips + 表格/看板/KV），右区 = side-peek 详细页（可开可关）。
- **不新增第二个编辑入口**：今天在右栏做的字段编辑，明天在 side-peek 详细页的属性区做。一条数据一个编辑面——与「一 action 双端」同源，避免两条路径分叉。

### 12.3 ui 状态新增键（`store.jsx` 的 `DEFAULT_UI` 已有可复用的）

| 键 | 含义 | 落点 |
| --- | --- | --- |
| `entry`（**已有**） | 各栏目选中的条目 —— 正好就是 side-peek 的目标条目 | localStorage（store.jsx:12） |
| `viewId`（新增） | 当前数据库视图 id | localStorage |
| `peekOpen`（新增） | side-peek 开合 | localStorage |
| `workspace`（新增） | FlexLayout 布局 JSON | localStorage |
| `mask`（已有） | 打码开关 | localStorage |

依据 store.jsx:41-47 的既有规矩：「只持久化**跨会话有意义**的选择；当前 tab 不在其中（它由地址栏决定）」——`viewId`/`peekOpen`/`workspace` 都属「跨会话有意义」，照存；「当前 tab」仍归地址栏。

### 12.4 深链扩展

- 现状 `#/栏目id`（`App.jsx:8-12` 的正则 `^#\/?([^?/]*)` 只取第一段）。
- 目标 `#/栏目id/条目id` → 直接打开该条目的 side-peek 详细页。
- 规则仍要「**一处实现 + 纯函数 + 单测**」（activeView.js:1-9 明写这项目在此反复出错的教训）：新增 `parseHash(hash)` 纯函数放进 `activeView.js`，返回 `{viewId, entryId}`；`resolveActiveView` 的优先级（深链 > 本次选择 > 默认栏目 > 第一个 tab）**不变**，只多带一个 entryId。单测钉住（`tests/unit/active-view.test.mjs` 已存在，扩用例即可）。

### 12.5 两层拖拽的分工（边界写死，不混）

| 层 | 工具 | 对象 | 落点语义 | 写在哪 |
| --- | --- | --- | --- | --- |
| 工作台面板停靠 | `flexlayout-react` | 面板 / 页签 | 停靠 / 分割 / 浮窗 | `ui.workspace`（布局 JSON，无 action） |
| 页内**顺序** | `@dnd-kit/sortable` | 块序列、看板卡片、表格列顺序 | 顺序 | `entry.block.move` / `entry update` / `section view update` |
| 页内**尺寸** | **手写**（沿用现法） | 列宽、左右栏宽 | 尺寸 | `section view update --set col.x.width` / `ui.listW` |

规则一句话：**dnd-kit 管「顺序」，手写管「尺寸」；FlexLayout 管「壳」，不碰页内。**

### 12.6 依赖引入的视觉冲突（必须处理的一处）

FlexLayout 自带主题 CSS（`style/alpha_light.css` 等）会给 tabset 上蓝色系样式，与项目视觉语言冲突——项目是「单色 + 无 emoji + 唯一彩色是语义红 + 立体感只给可交互元素 + 1px 浅底线分隔」（`styles.css:1-9`）。

- **决策：引 FlexLayout 的能力，不引它的主题**——只 import 其 JS，用项目 token 覆写它的 class（FlexLayout 支持自定义 class 名与 `className` 属性）。否则面板里会出现第二套视觉语言。
- bundle 量级：现有 JS 合计 ~480KB（实测 `src/web/public/assets/`）；`flexlayout-react` 约 +100~150KB、`@dnd-kit/core`+`sortable` 约 +30~50KB（**量级估计，以实测构建为准**）。本地面板无带宽压力，但首屏变慢是实打实的代价，要写进 CHANGELOG。

### 12.7 前后端边界

- 新依赖只出现在 `src/web/frontend/**` 与 `src/modules/*/view.jsx`；eslint 的前端禁 import 规则只禁 `node:*` / core / runtime / service（`eslint.config.js:94-102`），npm 包不受限。
- 块**渲染**注册表在 web/frontend；块**校验**在 shared；块**数据**在 service —— 三层互不越界（对应 core ← modules ← runtime ← bin 的分层精神）。

### 12.8 工作区与面板壳的边界（落地 D4）

- 顶部导航不变（`App.jsx:21-52`）；栏目 tab 的内容从 `SECTION_VIEW` 换成 `<Workspace sectionId/>`。
- Workspace 内部 = FlexLayout 容器：`Model.fromJson(JSON.parse(ui.workspace) || 默认布局)`；主 tabset = 数据库页，side-peek = 详细页。
- **布局 JSON 存 `ui`（localStorage），不存 settings**——「窗口怎么摆」是这台机器的习惯（跨会话有意义），而 settings 装的是跨端配置（navGroups 等）。这是对基线 §三 L4 那句「布局 JSON 存 settings」的**修正**。

## 十三、模型修订 v1：递归块 + Notion 式侧边栏（方向修正）

> 本节**取代** §二 的 Block 行、§三 的 L1–L4 分层、§八 8.1/8.2 的部分结论、§十二 12.8 的部分结论。逐条对照见 13.5。

### 13.1 核心修正：块是递归的，栏目本身就是块

- 块 = `{ id, type, value, children? }`，`children` 是**块数组**（可再嵌）。
- 三层是**同一种东西**：
  - **栏目（数据库）= 顶层块**；
  - **条目（行 / 页）= 栏目块的行**，其正文 = 块序列；
  - 正文里的块**可以再含子块**。
- 于是「整个栏目模块就是一个块」有了确切含义：新增块类型 **`section`**，值 = `{ sectionId, viewId? }`，渲染成该栏目的数据库视图（行内可展开、可编辑）——即 Notion 的 inline / synced database。
- 递归的收益：**「所有布局都能拖」在正文里也成立**——容器块的子块可拖拽重排，列块的列宽可拖，深度不限。

### 13.2 BlockType v2（10 种；容器类 v1 就开放）

| type | value | children | 说明 |
| --- | --- | --- | --- |
| `paragraph` / `heading` / `md` / `table` / `entrylist` / `file` / `secret` | 同 §八 8.1 | 否 | 叶块；值形状与同名字段一致 |
| **`section`** | `{ sectionId, viewId? }` | 否 | **新增**：正文里内嵌另一个栏目的数据库视图 |
| **`column`** | `{ widths: [number] }` | 是（2–3 个子列块） | Notion column_list；拖列边框改 widths = 改布局 |
| **`toggle`** | `{ text, collapsed? }` | 是 | 可折叠容器 —— **下一版再做**（v1 两个容器够用，避免多一类校验与渲染） |

**R13 修订（原型实测后补的三条细则）**——原表只写了字段名与形状，真写渲染时才发现三处含糊：

| # | 含糊处 | 修订 | 为什么必须定死 |
| --- | --- | --- | --- |
| 1 | `column` 的 children 到底是「子列」还是「这一列的内容块」？ | **两层**：`widths` **非空** → 它是**列组**，children 是 2–3 个**子列**；`widths` **为空** → 它是**叶子列**，children 是内容块 | 只有一个列组类型名时，「子列」与「内容」必须靠 `widths` 是否为空来判——否则渲染层没法决定「这一行的 children 是并排还是竖排」 |
| 2 | `entrylist` 块的子列标签从哪来？ | **entrylist 块自带 `fields`**（子列定义），与 `value`（行数组）并列 | §八 8.1 说「值形状与同名字段完全一致」，但**块不是字段**：块没有栏目字典可查 `entrylist.fields`，不自带就渲染不出表头 |
| 3 | 块 id 的前缀 | `b_`（复用 `src/core/ids.js` 的 id 族，与 `f_` 附件同一先例） | §十三 13.6 已写「块 id 全局唯一（`b_` 前缀）」，实现时别再自造 |

> 这三条是**设计澄清**，不是新增类型：类型数仍是 10 种（`toggle` 仍推迟）。

### 13.3 侧边栏：Notion 式目录（新的第一公民）

1. **树**：节点 = 栏目；可拖拽**重排**、**嵌套成子目录**、拖到「隐藏」区收起。展开栏目后其**条目作为子节点**出现（Notion 里数据库的行就是页面）。
2. **内嵌数据库**：节点可切到「紧凑数据库」形态——侧边栏里就地显示该栏目的 mini table（**「整个模块综合放在侧边栏，以数据库形式展示」**）。
3. **侧边栏本身是 FlexLayout 面板**：可拖宽、折叠、拖出成浮窗、与主区互换位置（**「所有布局按参考一样可支持拖拽」**）。
4. **树的数据归属：显示配置** `settings.navTree`（数组，缺省 `[]` = 全栏目平铺 = 今天的行为）。栏目仍是平铺集合 + order，**子目录是视图不是数据关系**——与 `navGroups` 同源（README：「分组只是显示配置，删栏目时头部自动略过」）。→ 加法不换血，零迁移。

```js
settings.navTree = [
  { id: 'demo', expanded: true, compact: 'table', children: [
      { id: 'entry:e_3f9a2c', kind: 'entry' },      // 条目节点 = 数据归属，不是显示配置
  ]},
  { id: 'projects', children: [ { id: 'internships' } ] },   // 子目录（显示层）
]
```

5. **两种拖拽语义必须分开**（原型里用不同拖动源区分）：
   - 拖**栏目节点** → 改 `settings.navTree`（显示配置，安全）；
   - 拖**条目节点**到另一个栏目 → 改**数据归属**（`entry update --section`，属写操作 → 必须确认对话框 + action，不是配置）。
6. **条目节点是推导出来的，不进配置**：展开栏目 → 列出该栏目的条目（按条目自己的 order）→ 条目在树里的出现是数据的镜像。所以 `navTree` 里**只存栏目节点与结构**（顺序、嵌套、展开态、compact 形态），不存条目 id —— 否则配置会与数据脱节（条目删了配置里还留着）。

### 13.4 壳的重新分层（取代 §三 L1–L4）

```
L5 壳层（FlexLayout 全面接管）：侧边栏面板 | 主区 tabset | side-peek —— 全部可拖拽/停靠/分栏/浮窗
L4 侧边栏树（Notion 式）：栏目树 + 内嵌紧凑数据库 + 两类拖拽语义
L3 数据库页：视图 chips（table/board/kv）+ 行点击 → 详细页
L2 详细页：属性区 + 块树（递归）
L1 块内核：Block = {id,type,value,children?}（递归）+ 校验 + 密文
```

**每一层都参与拖拽**：面板（FlexLayout）｜树节点（改 navTree / 改归属）｜列顺序与卡片（dnd-kit）｜块顺序（dnd-kit）｜列宽与面板宽（手写尺寸）。

### 13.5 修订对照表

| 原结论 | 新结论 | 理由 |
| --- | --- | --- |
| §二 Block 行：块 = 「值不是标量的字段」 | 块**递归**（children 一等公民），**栏目本身也是块** | 方向修正：栏目=块、块内是块 |
| §三 L1–L4 四层 | 升为 **L1–L5**（13.4），加「侧边栏树」层 | 侧边栏是第一公民 |
| §三 L4「FlexLayout 只管栏目工作区」 | FlexLayout **管整个壳**（侧边栏也在内） | 「所有布局都可拖拽」 |
| §八 8.1「children 容器块 v1 预留」 | children **v1 就开放**（section/column/toggle） | 递归是本次重构的核心 |
| §八 8.1 BlockType 7 种 | v2 = **10 种**（+section/column/toggle） | — |
| §十二 12.8「栏目 tab 内容换成 Workspace」 | 三段式：侧边栏树 + 主区数据库页 + side-peek；「栏目 tab」这层弱化 | Notion 里没有栏目 tab 这层 |
| §九 视图 actions | 增加 `settings.navTree` 的读写（沿用现有 `setting set --set navTree=…`，不新增 action 家族） | 树是配置不是数据 |
| §十二 12.3 ui 键 | 增 `navTree` 存 **settings**（非 ui）；`workspace` 存布局 JSON | — |

### 13.6 数据模型增量（相对 §八）

| 位置 | 变化 | 迁移 |
| --- | --- | --- |
| `section` | **不变**（不加 parent）——子目录是视图 | 零迁移 |
| `settings` | 加 `navTree`（数组，缺省 `[]`）；`navHidden` 沿用 | 缺省 = 今天行为 |
| `entry` | 加 `body?: Block[]`，块可含 `children`（递归） | 可选键，零迁移 |
| 块 id | 全局唯一（`b_` 前缀），children 内也唯一 | — |

### 13.7 侧边栏的视觉语言（Notion 式，但守项目规则）

窄栏、层级每层缩进 14px、hover 才显操作、当前项高亮、标题一行省略、**不引入彩色**（保持「单色 + 唯一语义红」）。

### 13.8 实现约束（先写下来，免得实现时踩）

| 约束 | 依据 | 落地方式 |
| --- | --- | --- |
| **视图 action 不得 import entries 模块** | eslint 禁模块互依（`eslint.config.js:27-35`）；`sections/service.js` 今天也不 import entries——它经 `core/store.js` 读 store、`core/render.js` 渲染 | `section.view.*` 只碰 store 与 core，不跨模块 |
| **列引用字段时，key 与中文标签都认** | README 踩坑「清单的行只认列 key」 | `--columns 姓名` 与 `--columns name` 等价 |
| **块删除属「条目内编辑」，不强制先导出** | 与 `--unset` 字段同级；README 的「破坏性写操作先导出」针对的是删条目 / 删栏目 | 删块不弹导出提醒；删条目 / 栏目维持现状（唯一回退手段仍是 `transfer export`） |
| **file 块的上传入口在块编辑器里**，附件中心只做统一展示与库存 | README 踩坑「把上传/选择放到附件中心」 | 块内就地「上传 / 从附件库选」 |
| **默认表格视图随模板同步自动补新字段** | README 踩坑「字段字典只在模板里、栏目不落盘」 | 默认视图每次从字典重算；用户自定义视图不自动加列（视图是显式选择） |
| **不做回收站 / 不做撤销** | 避免过度设计 | 块删除靠 `transfer export` 兜底 |

### 13.9 过度设计复核（砍掉的东西）

| 砍掉 | 理由 |
| --- | --- |
| 视图 `filter`（查询 DSL） | v1 只做 columns / sort；过滤片是 UI 关注点，过早发明查询语言必然要返工 |
| `toggle` 容器块 | `section` + `column` 已够表达「块里有块」；第三类容器要额外校验与渲染 |
| `gallery` 视图 | 与 table 高度重叠，等真有需求再说 |
| 块的「回收站 / 一次撤销」 | 与「导出包是唯一回退手段」的既有纪律重复 |
| 侧边栏树的「条目节点持久化」 | 条目节点应是推导结果（13.3.6），存进配置会与数据脱节 |

## 十五、架构修订 v2：栏目只在侧边栏 + 全模块化可编排的布局

> 本节**取代** §十三 13.3/13.4、§十二 12.2/12.8 的相关结论；**当前外壳以本节为准**。

### 15.1 栏目不进顶部导航

- 现状：顶部导航 = 数据驱动的**栏目 tabs**（`App.jsx:21-52`）+ 4 个静态工具页；再叠 `navGroups`/`navHidden`/`navOrder` 三套显示配置。
- **v2**：顶部栏**只留全局动作**（品牌 / 搜索 / 打码 / 面板抽屉 / 设置入口）。**栏目的唯一入口是侧边栏目录树。**
- 理由：① Notion 的页面与数据库只出现在侧边栏，顶部是全局动作区；② 栏目一多，顶部 tab 列表既挤又与分组/隐藏配置重复（第四套显示机制）；③ 顶部 tab 是「导航」概念，与「面板可编排」的新模型冲突——栏目应该是**工作区里可打开的面板**，不是一个固定 tab。
- 后果：`App.jsx` 的 nav 模型大改——栏目从「导航项」降级为「目录树的数据源」；`resolveActiveView` 的语义改为「当前打开的栏目 id」（深链 `#/栏目id` 仍有效，指向目录树里那个栏目的数据库面板）。

### 15.2 显示配置从三套合成一棵

`navGroups` + `navHidden` + `navOrder` → **`settings.navTree` 一棵**（顺序 / 嵌套 / 展开态 / compact 形态）。

**兼容**：老 store 没有 `navTree` 时，读路径**从老三套推断出一棵树**（只读推断，不写回）——老用户的显示配置不丢；用户第一次改树才落盘。→ 仍然「加法不换血」。

### 15.3 布局 = 模块化可编排（对齐 FlexLayout 的 JSON 树）

```
布局 = { global?, borders?, layout: <row 节点> }
row 节点   = { type:'row', weight, children:[ row 节点 | tabset 节点 ] }   ← 嵌套一层换方向
tabset 节点 = { type:'tabset', id, weight, active?, maximized?, children:[ tab 节点 ] }
tab 节点    = { type:'tab', id, name, component, config }
```

> **R12 纠正（原型实测）**：这里原来写的是 `{type:'row'|'col'}`——**FlexLayout 没有 `col`**。
> 顶层恒为 `row`，**嵌套一层就换方向**（row 里的 row 实际是列），方向由树的深度决定，不由字段声明。
> 面板参数也不叫 `props`，是 tab 的 **`config`**（`node.getConfig()`）。详见 §十六。

**面板 = tab**，内容由 `component` 决定；**栏目数据库本身是一个面板**（点侧边栏栏目 → 工作区新开一个 database 面板，而不是切顶部 tab）。

| 能力 | FlexLayout 语义 | nx-sk 落点 |
| --- | --- | --- |
| 拖页签到另一个 tabset | 页签合并 | 同 |
| 拖页签到边缘 | 拆分出新面板 | 同（四边高亮落点） |
| 分割条拖拽 | 调 weight | 同 |
| 双击 tabset 标题 | 最大化该面板组 | 同 |
| 添加页签 | `addTab` | 面板抽屉「＋」→ 选面板类型 |
| 面板浮动 / 新窗口 | popout | 同（可编排的一部分） |
| 任意 component 放进任意 tabset | factory 查表渲染 | 侧边栏本身就是一个 tab（`component:'sidebar'`） |

- 布局 JSON 存 `ui.workspace`（localStorage，跨会话有意义）。
- 面板可带 `config`：`database` 带 `section`/`viewId`，`detail` 带 `entryId` → **同一个栏目可以同时开多个面板**（不同视图、不同条目）。
- `active` / `maximized` 是**模型级单例**（整个布局只有一个 active tabset、一个 maximized tabset），不是每个节点各自的布尔。

### 15.4 侧边栏是一个面板，不是壳的一部分

- 侧边栏 = tabset 里的一个 tab（`component:'sidebar'`），因此它**可以被拖到任何位置**：拖到右边 → 右侧目录；拖出 → 浮动窗口。
- 「栏目只在侧边栏」是**默认布局的约定**（出厂布局把目录面板放最左），不是硬编码的壳——但**栏目条目本身只从目录树进入**（工作区面板里不再有第二处栏目列表，避免两个入口分叉）。

### 15.5 修订对照

| 原（§十三/§十二） | 新（本节） |
| --- | --- |
| 顶部导航含栏目 tabs | 顶部只留全局动作；栏目 tab 概念取消 |
| 侧边栏 = 壳的固定部分 | 侧边栏 = 可拖的面板（默认在左） |
| 工作区 = 数据库页 + side-peek 两段固定结构 | 工作区 = 布局树，面板自由编排；「side-peek」降级为「用户自己拖出来的第二个面板」 |
| navGroups + navHidden + navOrder 三套 | `navTree` 一棵（老三套读时推断，不丢） |
| 无面板抽屉 | ＋ → 选面板类型（数据库 / 详情 / 附件 / 导出 / 设置 / 看板 / AI） |

### 15.6 对原型与实施计划的影响

- 七个原型**全部换外壳**：顶部无栏目、侧边栏目录树、内容作为工作区里的面板。
- 实施计划 S3 触点表改写：`App.jsx` 的 nav 逻辑、`navModel.js` 的角色（从「头部导航模型」降为「目录树数据源」）、`settings` 的 navTree 推断逻辑（老三套 → 树）。

## 十六、原型落地修订 v3：原型真跑 FlexLayout（R12）

> 本节**追加**在 §十五 之后，不取代 §十五；只做两件事：
> ① 记录 R1–R11 那套「静态 HTML 原型」为什么必须整体作废；
> ② 把 `.claude/repo/FlexLayout` 的**实测**语义钉进设计，纠正 §十五 里的三处推断错误。

### 16.1 为什么推翻静态原型

R1–R11 的原型是**手写 CSS/JS 模拟**的一个「像 FlexLayout 的壳」：自己发明了布局 JSON 的形状
（`{type:'row'|'col', weight, active, maximized}`），自己仿了拖拽与停靠，README 里自陈「编排是**视觉模拟**」。

问题不在于画得糙，在于**它验证不了任何东西**：
原型里「拖页签到四边会拆出新面板」是自己写的假动作，而真实 FlexLayout 的停靠语义
（`DockLocation` + 嵌套换方向 + `Actions.addTab`）与假动作**并不一致**——
按原型实现，到了实现期照样要返工。原型骗得过眼睛，骗不过实现。

**R12 起原型换成真跑 `flexlayout-react@0.11.1` 的应用**（`plan/block-refactor/prototype/`，独立 vite root）：
模型、动作、停靠、分割、最大化、浮动、撤销——全是参考仓库自己的代码。
原型跑得动 = 实现期不用再猜 FlexLayout 的行为。

### 16.2 对 §十五 的三处纠正（原型实测）

| §十五 原写法 | 实测正确写法 | 依据 |
| --- | --- | --- |
| 布局节点 `{type:'row'\|'col'}` | **没有 `col`**：顶层恒 `row`，嵌套一层换方向 | `src/model/IJsonModel.ts` `IJsonRowNode`；`RowNode` 的方向由深度决定 |
| 面板参数 `props` | tab 的 **`config`**（`node.getConfig()`） | `src/model/IJsonModel.ts` `ITabAttributes.config` |
| 「侧边栏是一个面板」= 自造 tabset 里的一个 tab | **对**（保留），但要补一条：FlexLayout 的 `borders`（左/右/上/下的边界栏）是**另一套机制**，「活动栏 + 侧边内容」形态用它；nx-sk 的目录是**可拖走的面板**，所以走 tabset 而不是 border | `src/view/layout/BorderContainer.tsx`（border = 窄条 tab 轨 + 内容区） |

另补两条实测结论：
- `active` / `maximized` 是**模型级单例**，不是每节点布尔；
- 撤销/重做不是自己写的——`useUndo`（`src/view/useUndo.ts`）已实现「整段拖拽折叠成一步」，
  顶层直接用，不要另造。

### 16.3 FlexLayout 能力清单 → nx-sk 落点（原型逐条验过）

| 能力 | 参考实现 | nx-sk 落点 |
| --- | --- | --- |
| 模型 = 唯一真源 | `Model.toJson/fromJson` | `ui.workspace` 存 `model.toJson()`；「布局 JSON」面板摊开给人看 |
| 改动只走 Actions | `Actions.*` + `model.doAction` | 面板抽屉 / 目录树的一切布局动作 |
| 停靠语义 | `DockLocation`（center/left/right/top/bottom） | 抽屉「停靠位置」chips → `Actions.addTab(..., DockLocation.getByName(loc), -1, true)` |
| 拖页签到四边拆分 | `DragDropManager` | 原生，不重写 |
| 分割条调权重 | `Splitter` | 原生 |
| 面板组最大化 | `Actions.maximizeToggle` | 原生（tabset 标题 ⤢） |
| 撤销/重做 | `useUndo` | 顶栏按钮直接用 |
| 浮动 / 新窗口 | `Actions.popoutTab/popoutTabset` | `global.tabEnableFloat/tabEnablePopout = true` |
| 属性继承 | `Attributes`（`global.tabXxx`） | `GLOBAL_ATTRS` |
| 主题 = CSS 变量 | `style/_themes.scss` | 全量覆写 `--flexlayout-*`（浮窗/子布局一起变） |

### 16.4 对实施计划的影响

- **依赖提前**：S3 才要加的 `flexlayout-react` / `@dnd-kit/*`，为了原型先行加进根 `package.json` 的 **devDependencies**
  （只做加法；主应用 `src/web/frontend` 暂不 import，产物体积不受影响）。S3 落地时把它从 devDependencies 移到 dependencies。
- **S0 的产出物换了**：从「一次性静态 HTML」换成「`plan/block-refactor/prototype/` 下的真实应用」；
  S0 仍**不落盘**（数据在内存），验证的是「值形状当块够不够 + 壳的手感对不对」。
- **S3 的触点表要加**：撤销/重做（`useUndo`）、`ui.workspace` 的落点、`DockLocation` 的面板抽屉、
  以及「目录树两类拖拽语义」的实现位置（侧边栏面板内，不是工作区内）。

## 十七、全局搜索（R15）

> 此前全文**没有一处定义搜索**（顶栏那个搜索框一直是占位）。R15 的原型把语义定下来了，
> 这一节把它写死——**搜索是唯一会把数据「摊开给人看」的功能，所以它的边界必须比别的功能更严**。

### 17.1 搜什么（四类）

| 类 | 搜什么 | 命中后打开 |
| --- | --- | --- |
| **栏目名** | 栏目标题 | 该栏目的**数据库面板** |
| **条目名** | `entry.title`（= 栏目的 titleField 值） | 该条目的**详情面板** |
| **字段值** | 标量字段（text / textarea / select / number / date / month / tags / bool）；`table` 与 `entrylist` 搜**非敏感列**的单元格 | 该条目的详情面板 |
| **块正文** | `entry.body` 里 paragraph / heading / md 的文本；table 块的非敏感单元格 | 该条目的详情面板 **+ 定位到那个块** |

排序：**条目名 > 字段 > 正文**（同名优先）；同一条目最多出 N 条命中，避免一个长条目刷屏。

### 17.2 密文不参与搜索（最重要的一条）

- `secret` 字段与 `secret` 块**一律跳过**；
- `entrylist` 的 **sensitive 子列**、`table` 的 sensitive 列同样跳过；
- 搜索结果里**永远不出现密文明文**——连片段都不给。

理由：搜索框是**唯一一个会把内容摊到屏幕上的输入口**。如果它能搜出密文明文，
那么「随手搜一下」就等于把密钥写在屏幕上（还会进截图、进录屏、进剪贴板历史）。
→ **搜索框不是泄露口**。这条比「搜得全」重要。

（对照：`secret` 的**名称**照常可搜——`DB_PASSWORD` 这个名字不是秘密，值才是。）

### 17.3 命中 → 打开什么（定位提示不是面板身份）

- 栏目名命中 → 开该栏目的数据库面板；
- 其余命中 → 开该条目的详情面板；**正文命中还要定位到具体那个块**（滚动 + 闪一下）。

**定位提示不进面板的 `config`**：`config` 是面板身份的一部分（同一个条目不该因为带了定位提示
就开出第二个面板），而且放进去会把时间戳写进 `ui.workspace` 布局 JSON。
→ 定位提示走**应用级的一次性导航状态**（带 nonce，保证「同一个块再定位一次」也会重新触发）。

### 17.4 实现期的落点

- 原型阶段数据在内存，所以**在浏览器里扫**（`prototype/src/search.js` 是纯函数，可直接单测）；
- **实现期应落到服务端**：新增 `entry search <query>` action（`src/modules/entries/`），
  服务端全量扫 store 并返回命中；前端只负责渲染与跳转。
  理由：① 数据在服务端才能跨栏目全量扫而不必把整库塞进前端；② 密文边界**必须在服务端兜住**
  （前端过滤是第二道防线，不是唯一防线）；③ CLI 与面板同源（agent 也能搜）。
- 深链联动：命中应能生成 `#/栏目id/条目id`（§十二 12.4 的深链形态）→ 见下一版（B7）。

## 十八、浮窗与弹出（R16）

### 18.1 浮窗与弹出：两条入口

| 入口 | 位置 | 动作 |
| --- | --- | --- |
| **可见入口** | 每个面板组标题栏右侧的「浮窗」「弹出」图标 | `Actions.popoutTab(tabId, 'float' / 'window')` |
| **右键菜单** | 右键页签 / 面板组 | 同上（菜单条目由官方 `getNodeContextMenuItems` 生成） |

两条都开着才叫「有引导」：图标给不找菜单的人，菜单给熟手。

### 18.2 右键菜单是**应用的责任**（实测纠正）

参考实现的 `LayoutController.showContextMenu` 是这样：

```js
showContextMenu(node, event) {
    if (this._props.onContextMenu) { this._props.onContextMenu(node, event); }
}
```

**不传 `onContextMenu` 就右键什么都不会发生**——FlexLayout 不自带右键菜单，
它只提供零件（`getNodeContextMenuItems` 建条目、`showPopupMenu` 弹面板）。
→ 实现期必须在 `<Layout>` 上接 `onContextMenu`，用这两个官方函数拼出菜单。

### 18.3 出厂全局属性每次加载都要补

`toJson()` 只写**与默认值不同**的项，所以存盘里的 `global` 是「用户改过的差量」，
不是「完整配置」。一份旧布局里可能压根没有 `global` 段，或缺了新加的几项。

→ **加载后必须把出厂全局属性重新盖上去**（`model.updateAttrs(GLOBAL_ATTRS)`），
否则「老布局 + 新入口」= 新入口不出现（R16 实测：加了浮窗/弹出图标后，老布局里看不见）。

### 18.4 弹出成新窗口需要宿主页

`popout` 需要**同位置有一个空的 `popout.html`**（内容由主窗口用 React Portal 注入，
样式在运行时被复制过去）。构建上要多页产物（`index.html` + `popout.html`）。

## 十九、视图与面板身份（R17）

> §八 8.2 定义了 `ViewConfig` 的形状，但没说清「视图与面板是什么关系」。R17 的原型把这条补上。

### 19.1 四种视图 ↔ `ViewConfig.type`

| 面板上的 chip | `type` | 说明 |
| --- | --- | --- |
| 表格 | `table` | 全部可投影列 |
| 精简 | `table` | **仍是 table**，只是列少（标题字段 + 第一个 select） |
| 看板 | `board` | `groupBy` = 某个 select 字段 |
| KV | `kv` | 整栏目的键值读法（KV 栏目的 `type` 限 `kv`） |

「精简」不是第四种类型，是**同一种 table 的另一个投影**——所以它不该另立一个 type。

### 19.2 视图是**面板身份的一部分**

面板身份 = `component` + `config`，而 `config` 里带 `viewId`
→ **同一个栏目可以同时开多个面板**（不同视图），这是 §十五 15.3「同一个栏目可以同时开多个面板」的落地。

**切视图 = 改这个面板自己的 `config`**（FlexLayout 的 `config` 是 tab 的属性，
改它要走 `Actions.updateNodeAttributes(tabId, { config })`——参考实现 `src/model/TabNode.ts:92` 明写）。

### 19.3 缺省推断的具体形状（**只读路径，不落盘**）

| 栏目 | 推断出的视图 |
| --- | --- |
| 非 KV 栏目 | 表格（**除 source 外的全部字段**）／精简（标题字段 + 第一个 select）／看板（第一个 select 分组，若无 select 则不出） |
| KV 栏目 | 一条 `kv` |

密文字段照常进列——**值默认打码，列本身不是秘密**。

### 19.4 投影降级的表现

view 引用的字段被删 → **列还在**，表头写「已删字段」（弱占位），单元格写「—」。
不炸、**也不静默消失**——用户能看出「这里曾经有一列，现在它的字段没了」。

### 19.5 看板拖卡是**写操作**

拖卡 = 改条目的 select 字段值。它改的是**数据源**，所以**别的视图立刻能看到**
（侧边栏的紧凑表会同步变）。这不是本地态——别把它做成「只改这一屏的临时状态」。

## 二十、老配置推断（R18）

> §十五 15.2 定了原则（「从老三套推断出一棵树，只读推断，不写回」），但没定**规则**。
> R18 的原型把规则跑通了，这里写死——推断必须**和老实现显示得一样**，否则老用户会看到界面变了。

### 20.1 推断规则（口径对齐 `src/modules/settings/service.js:193-212` 与 `App.jsx` 的 nav 构造）

| # | 规则 | 老实现对应 |
| --- | --- | --- |
| ① | 隐藏的栏目 → **不进树**，进隐藏区 | `navHidden` |
| ② | 分组里的栏目 → 进**分组节点**；组顺序 = `navGroups` 顺序，组内顺序 = 列出的顺序 | `navGroups` |
| ③ | 其余可见栏目 → 平铺在根层；顺序 = `navOrder` 优先，没列进去的按栏目自身 `order` 跟在后面 | `navOrder` |
| ④ | **平铺在前、分组在后** | 老实现的渲染顺序就是「平铺 → 分组 → 工具」 |
| ⑤ | 栏目不存在 / 空组 → **跳过**（整组不显示） | `coerceNavGroups` 的校验口径 |

### 20.2 树节点有两种

- **栏目节点** `{ kind:'section', id, expanded, compact, children:[] }`
- **分组节点** `{ kind:'group', id:'group:<标题>#n', title, expanded, children:[栏目节点…] }`

老三套只能表达「**一层**分组」；**任意嵌套**是显式 `navTree` 才有的能力。
所以推断出来的树必然比显式树浅——这不是缺陷，是「加法不换血」的代价。

### 20.3 只读推断，不写回；用户第一次改树才落盘

- 推断发生在**读路径**：不写 store、不改 `settings`。
- 用户**第一次动树**（拖拽重排 / 嵌套）→ 把推断出来的树**固化成显式 `settings.navTree`**，此后推断让位。
- **「隐藏」仍然走老的 `navHidden`** —— 老三套能表达的事就别急着换机制（换机制 = 老用户的显示配置要迁移）。

### 20.4 面板上要**说清当前用的是哪一套**

侧边栏顶部常驻一行「目录树来源：推断（老三套，未写回）／显式 navTree」。
不写这一行，用户会以为「分组」是系统自动的；写上，才知道**它是从哪来的、什么时候会变**。

## 二十一、深链在新壳里的语义（R19）

> 老壳的深链指向「哪个 tab 显示」；新壳**顶栏没有栏目 tab**了（§十五 15.1），
> 所以深链必须改指「**工作区里开哪个面板**」。

### 21.1 形态

| 深链 | 打开 |
| --- | --- |
| `#/栏目id` | 该栏目的**数据库面板** |
| `#/栏目id/条目id` | 该栏目的数据库面板 **+** 该条目的**详情面板** |
| （没有深链） | 用存下来的工作区布局（`ui.workspace`）——**不兜底到某个栏目** |

老壳的解析顺序是「深链 > 本次选择 > 默认栏目 > 第一个 tab」；
新壳里「默认栏目」那一级**由持久化的布局接手**（布局本身就是用户上次留下的样子），
所以只剩两级：**深链 > 布局**。

### 21.2 缺失的处置（不许开坏面板）

| 情况 | 处置 |
| --- | --- |
| 栏目不存在 | **不开任何面板**，明确报「深链指向的栏目「X」不存在」 |
| 条目已被删 | **只开栏目面板**，报「深链里的条目已不存在，只开了栏目面板」 |

### 21.3 地址栏 = 当前打开的面板

应用内导航（点目录里的栏目、点表格里的行、搜命中）**都写 hash**。
好处：地址栏可复制、可分享、可后退；坏处是 hash 成了「导航的唯一真源」，
所以**读 hash 的地方必须只有一处**（`resolveDeepLink`）。

### 21.4 纪律：抄老实现的「一处实现 + 纯函数 + 断言」

老实现 `src/web/frontend/activeView.js` 的文件头写着为什么：**「兜底不该兜的时候兜了」**
在这项目里反复出过同一种错（早先 `DEFAULT_UI.view` 写死 `'job'`，删掉栏目后首屏落在不存在的 id 上）。
→ 深链解析必须是**纯函数**（`parseHash` / `buildHash` / `resolveDeepLink`），不许散在组件里的三元表达式。

## 二十二、块编辑（R20）

> §九 9.2 已定义块的五条 action，但**面板上的编辑动作与它们的对应关系**没写过。R20 补上。

### 22.1 面板动作 ↔ action 的对应

| 面板动作 | action | 说明 |
| --- | --- | --- |
| 尾部加块 / 在某块后加 | `entry.block.add --type <t> [--after <blockId>]` | **新块是空块**（text 为空串）——空块才有「打 / 选类型」的意义 |
| 块内文字可编辑 | `entry.block.update`（PATCH） | 双击进入；Enter 提交、Esc 取消 |
| **转类型**（斜杠菜单） | `entry.block.update`（PATCH，**整块替换**） | **没有 `entry.block.convert`** —— 转类型就是 PATCH 一份新形状的块 |
| 上移 / 下移 | `entry.block.move --to <index±1>` | 与拖拽是**同一动作的两个入口**（都落 `moveBlock`） |
| 删除块 | `entry.block.remove` | 块删除属条目内编辑（§十三 13.8，不需要先导出） |

### 22.2 转类型是**有损的，必须标出来**

只有文本型的块（paragraph / heading / md）转过去能**保留原文**；
转成结构型（table / entrylist / file / secret / section / column）**文本会丢**。
→ 菜单里必须给这类项标「文本会丢」——**不能让用户以为转换是无损的**。

### 22.3 转类型是**整体替换**，不是合并

实现上如果用「PATCH 合并」，旧类型的残留字段会留在块里
（比如 table → paragraph 之后块里还挂着 `columns`/`rows`）。
→ 转换必须**整块替换**（保留 id），旧形状的字段一个不留。

### 22.4 斜杠菜单

空块里打 `/` → 直接开块类型菜单（Notion 的习惯）。
**只有空块才触发**——非空块里 `/` 是正文的一部分。
空块要给**占位提示**（「空段落 · 双击编辑，输入 / 选类型」），否则用户看不见它。

## 二十三、附件指派（R21）

> 口径来自 `assets/nx-sk/references/40-files.md`；R9 曾抓过「上传入口放附件中心 → 条目里看不到」，
> §十三 13.8 已定「上传入口在块编辑器里」。R20/R21 把这条真正落到原型。

### 23.1 块的值 = **附件 id 的列表**

`file` 块与 `file` 字段的值都是**附件 id 的列表**——不是文件名、不是路径、不是文件对象。
同一个原件可以被多个块/多条条目挂上，两边指的是同一条记录。
渲染时从附件库解析出名字与大小（库里没有的 id 渲染成「未知附件 <id>」，不静默消失）。

### 23.2 选择面板，**不是下拉框**

| 规矩 | 说明 |
| --- | --- |
| **可搜索** | 按名称 / 标签过滤——库里几十个附件时下拉框根本没法挑 |
| **未引用优先** | 没有引用的原件排前面；已引用的排后面并标「已被 N 处引用」——**仍然可选** |
| **点一行即追加** | 可以连点多个；已挂上的**从列表里消失**（它已经在这个块里了） |
| 逐行移除 | 每个附件一个 ×；移除 = 从块上摘掉，**附件本身还在库里** |

### 23.3 两种引用都算

「已被 N 处引用」的 N 来自两处：**file 块**里的 id + **file 字段**值里的 id。
→ 引用关系**不存库**，每次从块/字段里**算出来**——存了就会和块里的 id 脱节
（块里摘掉了、库里还记着「被引用」，「清理未引用」就会删错东西）。

### 23.4 上传 = 先进库，再挂到块

`上传文件`（多选）→ 新附件进库 → 立刻挂到当前块。
真实实现对应 `file add` + `entry block update`；原型在内存里完成这两步。
**上传入口在块编辑器里**，附件中心只做库存展示与「只看未引用」的筛选（§十三 13.8）。

## 二十四、键位、无障碍与布局导入导出（R22）

### 24.1 键位（默认关的三条要开）

FlexLayout 默认只有「关闭页签（Ctrl+Delete）/ 重命名（F2）/ 关闭浮层（Escape）」；
**焦点在面板组之间移动的三条默认是关的** —— 不开它们，键盘用户进了面板就出不来。

| 键 | 动作 |
| --- | --- |
| `Ctrl+Delete` | 关闭聚焦的页签 |
| `F2` | 重命名聚焦的页签 |
| `F6` | 焦点在「选中的页签按钮 ↔ 面板内容」之间切换 |
| `Ctrl+F6` / `Ctrl+Shift+F6` | 焦点移到下/上一个面板组（循环） |
| `Escape` | 关闭打开的浮层 |

键位表要**写在设置面板里**——快捷键没人知道就等于没有。

### 24.2 「假控件」纪律

**可点击的东西必须是真按钮**：`role="button"` + `tabIndex=0` + Enter/Space 触发。
裸 `<span onClick>` 鼠标能点、键盘到不了、屏幕阅读器也不念——那是「看着像按钮、用起来不是」的假控件。
原型里所有 chips（视图切换 / 列设置 / 停靠位置 / 筛选片）统一走一个 `Chip` 组件，一次改对。

### 24.3 布局导入导出 = `Model.fromJson` / `toJson` 的直接应用

- **导出**：`model.toJson()` → 复制；**导入**：粘贴 → `Model.fromJson` → `setModel` → 落盘。
- **坏 JSON 必须明确报错**（语义红显示解析错误），**不吞掉整台应用**、也不静默忽略；
  校验失败时**当前布局保持不变**。
- 导入是**整体替换**当前布局——粘贴的是「快照」，应用即回到那个快照。

## 十四、块级 AI 状态机（R8，与 `{status}` 契约对齐）

### 14.1 状态机

```
idle ──suggest──▶ requesting ──成功──▶ pending ──apply──▶ applied
                    │失败                  │              └─ 块已被改 → conflict
                    ▼                      └──reject──▶ rejected
                  failed（pending 不落盘，不留痕）
```

**`pending` 是业务状态，不是失败**——与项目既有契约一致（`conflict`/`blocked`/`skipped` 都是正常返回，agent 看 `status` 不看退出码）。因此 `entry ai suggest` 成功时返回 `{status:'pending', pendingId, changes:N}`，退出码 0。

### 14.2 与 demo 的对应

demo（`state.dart:255-266` 的 `_computePendingDiffs`）把差异拆成**三组**：已存在块的字符级 diff、新增块、删除块 id。本设计同构：

| demo | nx-sk |
| --- | --- |
| `_pendingBlockDiffs: blockId → segments` | pending 文件里的 `diffs[]`（blockId + 字符级 segments） |
| `_pendingNewBlocks: List<Block>` | pending 里的 `newBlocks[]` |
| `_pendingRemovedBlockIds: Set` | pending 里的 `removedIds[]` |
| `_pendingModifiedById`（接受时用真实 content 覆盖） | 应用时用 `blocks[]` 的最终内容覆盖（不从 segments 重组——重组会丢精度） |

### 14.3 冲突检测（防止覆盖用户已改的块）

pending 记录每个块的 **`baseHash`**（应用前的块内容哈希）。应用时若块当前内容的哈希 ≠ `baseHash` → 返回 `CONFLICT`（409），**不覆盖**，让用户决定（`--force` 可强推，仍要显式）。

### 14.4 pending 的存放位置（解决「不落盘」与「跨进程」的矛盾）

§十 10.7 要求 pending 不进 `store.json`（可能含明文密钥）；但 CLI 是无状态进程，pending 必须跨进程可见才能让 agent 与面板共用同一套语义。

→ **pending 落独立运行态目录 `~/nx-sk/pending/`**（一个 pending 一个文件，目录 0700）：不进 `store.json`、不进导出包、不进备份；CLI 与 HTTP 服务端读同一目录（同一台机器）；删目录即清空。**目录常量进 `src/core/paths.js`**（A07 第 8 处：路径不散落）。

### 14.5 CLI 等价物（三条，与面板同源）

| action | CLI | HTTP | 返回 |
| --- | --- | --- | --- |
| `entry.ai.suggest` | `entry ai suggest <ref> --prompt "<指令>" [--block <id>]` | `POST /api/entries/:ref/ai` | `{status:'pending', pendingId, changes}` |
| `entry.ai.apply` | `entry ai apply <pendingId> [--block <id>] [--force]` | `POST /api/ai/:pendingId/apply` | `{status:'ok'}` / `{status:'conflict'}` |
| `entry.ai.reject` | `entry ai reject <pendingId>` | `POST /api/ai/:pendingId/reject` | `{status:'ok'}` |

**AI 永远不直接改数据**：suggest 只产生 pending，apply 才写 store —— 与 demo 一致，也与「破坏性写操作要有唯一回退手段」的纪律一致（apply 前可先 `transfer export`）。

### 14.6 R14 补四条（原型的可运行副本实测出来的，原文没写死的地方）

| # | 原文含糊处 | 修订 | 实测依据 |
| --- | --- | --- | --- |
| 1 | 「pending 记录每个块的 baseHash」——**谁算**没说 | **服务端算**：suggest 时服务端拿**自己那份**当前块内容算哈希，客户端**不许自带 baseHash** | 原型实测：客户端自带 baseHash 时，服务端副本落后一步 → baseHash 算成 `null` → 冲突检测形同虚设 |
| 2 | 「服务端读同一目录」——服务端怎么知道「当前内容」没说 | 服务端持有**当前块内容**（真实实现直接读 store）；客户端推的是**副本**。且副本必须**整份批量推**，不能按条目推 | 原型实测：按条目推时，服务端手上是哪个条目取决于「哪个详情面板恰好挂载着」——挂载顺序一变就丢块，baseHash 又变成 `null`。改成整份批量推后稳定 |
| 3 | 「目录 0700」——**Windows 上不成立** | 0700 是 **POSIX 语义**：类 Unix 上 `chmod` 生效；Windows 上 `chmod` 改不了 POSIX 位（实测 `stat` 恒为 `666`），真正的隔离要靠 **NTFS ACL**（`icacls`） | 原型实测：`chmodSync(dir, 0o700)` 在 Windows 上无效。→ 实现期二选一：用 ACL，或在文档里写明「0700 仅类 Unix 生效」 |
| 4 | 「不进 store.json / 不进导出包」——**怎么验**没说 | 隔离自检要**两层**：① 文本层：pending 的特征串不出现在 store / 导出包里；② **结构层**：pending 独有的字段名（`baseHash` / `segments` / `removedIds` / `newBlocks` / `finalText`）不出现在 store / 导出包里 | 原型实测：结构层比文本层硬得多——文本可能碰巧不重复，字段名一旦出现就是记录漏进去了 |

> **顺带定下一条纪律**：pending 列表按**新 → 旧**排（面板上刚生成的那条在最上面）；
> 「应用」与「拒绝」都**删文件**（reject 不是标记，是真删）——pending 是运行态，不是历史。
