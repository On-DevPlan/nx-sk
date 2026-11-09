# 行为等价清单（重构对账用）

> 硬约束：重构只允许改变**代码组织**，不允许改变**使用体验**。
> 交互、布局、文案、快捷键、空态、错误提示、持久化语义、CLI 输出，全部按本清单对账。
>
> 基线：只读快照 `.claude/repo/project/2026-11-09-09fa9be/`（commit `09fa9be` 的完整拷贝）。
> 每阶段结束必须附：`pnpm lint` / `pnpm typecheck` / `pnpm test`（含 build + smoke + unit）的实际输出摘要，
> 外加本阶段触及条目的逐项核对结果。

---

## 0. 怎么对账

| 阶段 | 额外对账动作 |
| --- | --- |
| P2 字段注册表 | 逐类型填写/保存/回读一遍（14 种），对照 §2.C；`nx-sk section dump` 与基线打码输出逐字节比对 |
| P3 模块注册 | 导航顺序、分组悬浮、隐藏栏目深链，对照 §2.A、§2.E |
| P4 后端 TS | `nx-sk --help`、`section list`、`entry get`、`export/import` 输出与基线比对；退出码与 stderr 文案 |
| P5 收口 | 全链路手测一遍 §2 全部小节 |

文案对账以**字符级**为准，包括全角括号、「…」（单个省略号字符）、全角空格「　」。

> 路径说明：P6 起前端全部是 `.ts/.tsx`，下文「位置 / 路径」列已改为现行文件名；
> 「证据」列的行号仍沿用迁移前基线文件的编号（改名后行号有偏移，按 `className` / 文案搜索定位）。

---

## 1. 冻结项

1. **文案**：所有按钮、提示、空态、错误、toast、placeholder、title/aria-label。
2. **布局结果**：工具栏顺序、左右栏宽、字段宽窄（wide 字段）、表格栅格、弹层位置策略。
3. **键盘**：Enter / Esc / Alt+↑↓ / Ctrl+Enter / Ctrl+V 的行为与作用域。
4. **空态与加载态**：触发条件、文案、出现的容器。
5. **错误提示**：来源（toast / 块级 / modal）、文案、是否 `bad` 样式。
6. **持久化**：`localStorage` 键 `nx-sk-ui`、只存选择不存数据、`view` 不落盘、`#/<id>` 深链规则。
7. **HTTP / CLI 契约**：响应键集与 CLI 人类可读输出（由 `tests/unit/contract.test.ts` 钉住的部分）。

允许的差异见 §3。

---

## 2. 逐面清单

### A. 外壳（`src/web/frontend/App.tsx`）

| # | 行为 | 证据 |
| --- | --- | --- |
| A1 | 头部：logo + `nx-sk` + `本机个人资源管理器` + `v{version}` + 存储路径（title=`存储目录：…`，可点击复制）+ `刷新数据` | App.jsx:95-111 |
| A2 | 导航顺序：未分组栏目（`navOrder` 优先，其次 `order`，默认 50）→ 分组（配置顺序）→ 细分隔线 → 静态工具（order） | App.jsx:23-52,116-134 |
| A3 | 栏目 tab 显示条目数角标；静态工具 tab 不显示角标 | App.jsx:117-132 |
| A4 | `navHidden` 只隐藏入口；`#/栏目id` 直达仍然渲染 | App.jsx:27-28 |
| A5 | 分组 hover 展开延迟 130ms、离开收起延迟 180ms；`(hover: hover)` 才启用 hover | App.jsx:172-180,203-215 |
| A6 | 分组同一时刻只开一个；外点 `pointerdown` 关闭；Esc 关闭；点击 pill 切换 | App.jsx:86-88,227-237,246-256 |
| A7 | 分组角标 = 组内栏目数；title=`{组名}：{n} 个栏目`；展开行显示各自条目数 | App.jsx:195-197,251,267 |
| A8 | 深链 `#/<id>` 优先；兜底选出的 tab **不**补 hash；hashchange 写回 `ui.view` | App.jsx:8-12,63-83 |
| A9 | 空态：导航无条目「正在装载…」；boot 前「正在装载…」；懒加载「加载中…」 | App.jsx:133,144,147 |
| A10 | boot 失败：块级「读不到后端上下文」+ 原始错误 + hint「确认 nx-sk serve 正在运行；或点右上角「刷新数据」重试。」 | App.jsx:137-143 |
| A11 | 视图崩溃：ErrorBoundary「这个视图崩了」+ message + hint「切到别的 tab 仍然可用；修好之后本页会自愈。」 | components/ui.tsx:50-60 |
| A12 | toast 2600ms 自动消失；`bad` 用红样式 | store.tsx:67-71 |
| A13 | 弹窗：Esc 关闭；点遮罩空白关闭；标题「确认」/「危险操作」；按钮「取消」「确定」（可覆盖） | components/ui.tsx:74-126 |

### B. 栏目详情（`src/web/frontend/modules/entries/view.tsx`）

| # | 行为 | 证据 |
| --- | --- | --- |
| B1 | 工具栏：标题、id Tag、`{count} 条 / {fields} 字段`、描述、`打码显示（投屏/截图时用）`、`刷新`、`更多`、`新建条目` | view.jsx:392-427 |
| B2 | 「更多」三项：`导出选中 N 条（含凭据）`/`导出 ZIP（含凭据）`、对应「打码」、`导入 ZIP…` | view.jsx:402-413 |
| B3 | 左右栏：默认 300px，拖动范围 240–560，双击分隔条恢复 300，松手才落盘 `ui.listW` | view.jsx:56-90,473-478 |
| B4 | 列表头：全选（title「全选 / 取消全选（只影响导出与批量操作）」）、`已选 N / M` + `清空` | view.jsx:432-441 |
| B5 | 每条：勾选框、标题（空显示「（无名）」）、完整度 `N%` 或 `已填满`、`⧉` 复制条目定位 | view.jsx:443-467 |
| B6 | 复制定位文本含栏目/条目 id 与 `nx-sk entry get …`、`nx-sk entry update …` 两行命令；失败时回退 execCommand 并去掉「贴给 agent 即可」 | view.jsx:16-22,248-264 |
| B7 | 条目头：面包屑（可点复制）、id、`完整度 N%`、`N 处改动未保存`、`保存` | view.jsx:487-506 |
| B8 | 标题输入：label 取 `titleLabel`，默认「名称」 | view.jsx:510-518 |
| B9 | 「＋ 直接加字段」默认收起；Enter 写入；按钮在无 `=` 时禁用；错误文案两条 | view.jsx:204-216,521-534 |
| B10 | 底部：`保存（N 处改动）`、`放弃改动`、`删除条目`；missing/skipped 提示的截断（5/6 + `…`） | view.jsx:546-556 |
| B11 | 保存无改动 → toast「没有改动」；成功 →「已保存 N 处改动」 | view.jsx:180-189 |
| B12 | 有未保存改动时注册 `beforeunload` | view.jsx:193-202 |
| B13 | 版式拖拽/改宽高：700ms 防抖自动保存，toast「版式已保存」；字段保存不得回滚未保存版式 | view.jsx:148-167 |
| B14 | ZIP 导出 toast：含凭据「开始下载（含凭据，请妥善保管）」/ 打码「开始下载（凭据已打码）」 | view.jsx:267-281 |
| B15 | 导入：明文先试 → 缺口令再弹口令；口令 modal 标题 `这个包已加密 · {文件名}`，按钮 `取消` / `解密中…`/`打开预览` | view.jsx:283-334,568-593 |
| B16 | 导入预览：来源→目标、导出时间、含凭据/打码、条目/新增/冲突/附件、将补字段、冲突明细、三种冲突处理单选、warnings | view.jsx:595-657 |
| B17 | 导入完成 toast：`导入完成：新增 X，另存 Y，覆盖 Z，跳过 W` | view.jsx:336-355 |
| B18 | 整个栏目区可拖入 ZIP，遮罩文案「松开导入栏目 ZIP」 | view.jsx:359-368,564-566 |
| B19 | 空态：无条目「还没有条目。点右上角「新建条目」，或用 CLI：nx-sk entry add --section {id} --set ...」；未选条目「左边选一条，或新建一条」 | view.jsx:468,482 |
| B20 | 读失败：块级「栏目读不到」+ 错误 + hint「如果这个栏目刚被删掉，切到「栏目」tab 看看现有栏目。」 | view.jsx:370-378 |
| B21 | 加载中/无数据：「加载中…」/「暂无数据」 | view.jsx:379 |

### C. 字段控件（P2 核心，`components/fieldEditor.tsx`）

所有控件都吃 `{ def, value, onChange }`；`FieldControl` 对 `null/undefined` 先归一为 `''`（`fieldEditor.tsx` 的 `FieldControl`）。
控件分派自 P2-B 起是 `fields/index.ts` 的 `FIELD_CONTROLS`（一种类型一个 `.tsx`），运行时 `?? TextControl`。

| 类型 | 控件与可见行为 | 证据 |
| --- | --- | --- |
| `text` | `<input type="text">`，值 `String(v)` | components/fields/text.tsx |
| `number` | `<input type="number">` | components/fields/number.tsx |
| `date` | `<input type="date">` | components/fields/date.tsx |
| `month` | `<input type="month">` | components/fields/month.tsx |
| `textarea` | 自适应高度 textarea，`minRows=2`，无 placeholder，`resize:none`、`overflow:hidden` | components/fields/textarea.tsx + autoTextarea.tsx |
| `bool` | checkbox + 文本「是」/「否」；真值判定 `true`/`'true'`/`'是'` | components/fields/bool.tsx |
| `select` | 首项「（未填写）」；当前值不在候选时追加 `{值}（当前值，不在候选里）`，选中它写入空串 | components/fields/select.tsx |
| `tags` | 显示 `join('、')`；输入按 `[,，、;；]+` 拆分、trim、去空；placeholder 带 `maxItems` | components/fields/tags.tsx |
| `secret` | `type="text"`，placeholder「密文落盘；原样保留占位则视为不修改」，**唯一**透传 `disabled` 的控件 | components/fields/secret.tsx |
| `entrylist` | 列头（`密文` tag）+ 行输入；`ui.mask` 时敏感列为 password；`＋ 添加一行`；行尾 `⠿` 拖拽 + `×` 删除；无子字段时给专门提示；底部「N 行 / 还没有行　·　变长，空行保存时自动剔除　·　拖 ⠿ 可调顺序」 | components/fields/entrylist.tsx |
| `table` | 见 §2.D | components/fields/table.tsx（P3.5 起自包含；原 tableField.jsx 已删除） |
| `source` | `SourceControl`（引用/文本两种形态；文本 Ctrl+Enter 入袋；Esc 关闭弹层） | components/fields/source.tsx:583（控件本体 :525；抽屉 :68；Ctrl+Enter :365；Esc :538） |
| `file` | 多值附件列表；缺失引用提示「引用的附件已不存在（id）—— 重新上传，或移除。」；>5 行显示「展开全部 / 收起到 5 行」；「从附件库选…」「上传文件」「附件中心」；picker 搜索与空态；`maxItems` 上限提示；支持拖拽上传 | components/fields/file.tsx |
| `md` | 有内容默认阅读态，`编辑正文` 切换；编辑态 `插入图片`、`从附件库插入…`、`完成`；预览 + 图库；待办可勾；IP 点击复制；空态「（还没有内容）」；gallery 仅在「有图或编辑态」出现 | components/fields/md.tsx |

共同约定：

- `def.hint` 在每个复杂控件末尾渲染（file/md/entrylist/table）。
- `FieldGroup` 给 `textarea/file/md/entrylist/table/source` 加 `wide`（`fieldEditor.tsx`）。
- 字段标签区：`label` + 敏感 `密文` tag + `def.fill` 策略 tag（`fillLabel || fill`）+ `key`（`fieldEditor.tsx`）。
- 未知类型：落到 `controlOf()` 的 `?? TextControl`（`fields/index.ts`）——见 §4-D2。

### D. 表格字段（`components/fields/table.tsx`）

| # | 行为 | 证据 |
| --- | --- | --- |
| D1 | 单元格键盘：Enter 下移同列，末行则新建一行并聚焦；Alt+↑/↓ 同列上下移动 | :81-85,368-378 |
| D2 | 单元格控件：bool checkbox（`是/否` title）、select（「（未选）」+ 非法值「（不在候选里）」）、number、date、month、其余 text；敏感列在打码态用 password | :88-137 |
| D3 | 表头：类型字形、列名、单位、`密` 标记、`⋮` 列设置、末尾 `＋` 加列；拖表头移动列 | :390-425 |
| D4 | 列菜单全部项与文案（列名/类型/key/公式/单位/默认值/选项/统计/密文/左移/右移/左右插入/复制属性/删除属性） | :546-659 |
| D5 | 改列 key 连值一起搬；key 删空忽略；删列连值一起删 | :292-359 |
| D6 | 行：行号、`⋮` 行菜单（上方插入/下方插入/复制/删除）、`⠿` 拖拽 | :429-456,662-672 |
| D7 | 统计行默认开启；总开关关闭写 `summary:false`；统计方式 11 个选项 | :44-56,237-246,528-531 |
| D8 | 公式错误：格子显示 `#错误`，title 带错误；底部最多 3 条 + 「另有 N 处」 | :450-458,539-546 |
| D9 | 空态：无列「这张表还没有列。先「添加列」，或一次把整份数据写进来（CLI 的 columns + rows）。」+ `＋ 添加列`；无行「还没有行」 | :516,520-527,533-536 |
| D10 | 弹层：点外关闭、Esc 关闭（捕获阶段）、靠近底部自动上翻 | :142-190 |
| D11 | 已知缺陷：列选项输入触发未定义标识符 `setOptsTick`（:624，`declare` 仅为让 TS 编过，运行期仍 ReferenceError） | 见 §4-D1 |

### E. 栏目管理（`src/web/frontend/modules/sections/view.tsx`）

| # | 行为 | 证据 |
| --- | --- | --- |
| E1 | 工具栏：`栏目`、`{count} 个 · {totalEntries} 条条目`、搜索、`展开`、`收起`、`刷新`、`导入 ZIP`、`新建栏目` | :383-409 |
| E2 | 树：栏目行（展开箭头、三态勾选、标题/id/KV/template/描述、N 字段 · N 条目、编辑/信息/删除）；条目行（勾选、标题、id、完整度、×） | :565-637 |
| E3 | 勾栏目 = 连带条目；勾条目不影响栏目；三态用原生 `indeterminate` | :99-117,581-587 |
| E4 | 搜索：栏目命中整棵保留；仅条目命中时只留命中项并 `forcedOpen`；清空恢复原展开态 | :70-83 |
| E5 | 展开态持久化到 `ui.treeOpen` | :45-46,85-91 |
| E6 | 批量删除条：未选中时只显示说明；删除确认含 detail，超 1600 字符截断 | :411-431,148-163 |
| E7 | 新建 modal：id 校验正则与错误文案、模板下拉、排序、描述；`创建` | :639-675 |
| E8 | 编辑 modal：栏目属性、同步模板字段、分组增删改序（内置组不可删、非空组不可删）、字段字典（key 只读、类型下拉、分组、hint、fill 策略、上下移、删除）、新增字段（entrylist/table 列编辑） | :725-1199 |
| E9 | 全部 toast 文案（创建/更新/新增字段/同步/删字段/改组等） | :224-325 |
| E10 | 空态：无栏目、搜索无结果、组内无字段、无字段、无分组、未声明分组、栏目无条目 | :456-464,632,858,909,932,935 |

### F. 其它页面（触及才逐项对账）

| 页面 | 必查要点 |
| --- | --- |
| `modules/files/view.tsx` | 分页、筛选片、未引用清理、缺失原位置提示、重命名/移动、分页删空回退 |
| `modules/export/view.tsx` + `components/transferPanel.tsx` | 整库/按栏目导出、口令（两次输入）、导入预览、冲突策略、`Empty`/空态 |
| `modules/settings/view.tsx` + `navManager.tsx` | 默认栏目、导航分组编辑、导航排序、校验错误文案、隐藏栏目 |
| `modules/entries/kvTable.tsx` | 一行一键值；Enter 失焦提交；新增键名校验；删除确认；空态 |
| `components/fields/source.tsx` | 引用 vs 文本、Ctrl+Enter 入袋、Esc 关闭、图片粘贴、焦点归还 |
| `components/blockBoard.tsx` | 拖拽/缩放布局、`reconcileLayout` 对齐、空态「这个栏目还没有可显示的字段。」 |
| `components/lightbox.tsx` | Esc 关闭、滚轮缩放、拖动 |

### G. CLI 与后端可见契约

| # | 行为 | 证据 |
| --- | --- | --- |
| G1 | 入口异常统一 `nx-sk: {message}` 写 stderr，退出码 1；`NX_SK_DEBUG` 才打 stack；dist 缺失时提示 `pnpm build` | bin/nx-sk.mjs |
| G2 | `--help`、子命令 help、`--json` 输出形状 | `src/runtime/cli.ts` + `tests/unit/contract.test.ts` |
| G3 | 响应键集：bootstrap / section dump / entry list / entry get / file list | tests/unit/contract.test.ts |
| G4 | `section dump` 打码输出与基线逐字节一致（P2 验收） | `src/core/render.ts` |
| G5 | 错误码与 HTTP 状态映射不变 | `src/core/errors.ts`、`src/runtime/api.ts` |
| G6 | 命令清单与 CLI 提示（`boot.commands` → `CliHints`）不变 | components/ui.tsx:131-148 |

---

## 3. 显式允许的差异

1. 文件扩展名、目录内文件拆分（`.js/.jsx` → `.ts/.tsx`）、类型注解、`import type`。
2. DOM 包裹层与 class 名称的**内部**调整，前提是渲染结果的布局、层级、间距不变。
3. 新增测试、脚本、文档。
4. `engines.node`、`bin` shim、发布产物形态（已批准）。
5. 编译期新增的错误（例如漏写控件）——这是设计目标，不是行为变化。

不允许用「顺手优化」解释任何差异：文案改一个字、placeholder 改标点、按钮顺序变化、空态消失，都算违规。

---

## 4. 待裁决（不自行修）

### D1. `setOptsTick` 未定义（缺陷）

- 位置：`src/web/frontend/components/fields/table.tsx:624`（P3.5 前为 `components/tableField.jsx:583`，同一处代码）
- 现象：在表格列菜单里编辑「下拉框」的选项时执行 `setOptsTick((n) => n + 1)`，该标识符全仓库只出现这一处 → `ReferenceError`。
- **实测结论（静态确认，P2 未修）**：这是 `onChange` 事件处理器里的异常，React 的错误边界**不捕获**事件处理器异常
  （`ErrorBoundary` 只管渲染期，见 `components/ui.jsx:40`），所以**不会**整页变成「这个视图崩了」。
  因为 `patchColumn` 在抛错之前已经执行，选项状态与界面都**照常更新**；每次按键在控制台留一条未捕获 `ReferenceError`。
  影响范围仅此一个输入框，可恢复（刷新并非必需），属于「噪音级」缺陷。
- 基线对照：只读快照同文件同行为同一内容 → **重构前就存在**，不是本次引入。
- 选项：
  - (a) 严格 1:1 迁移，保留缺陷，另开 issue；
  - (b) 作为独立缺陷修复提交（与 P1.5 同性质），补一条测试。
- **默认按 (a) 执行，等确认。**

### D2. 未知字段类型的兜底

- 位置：`src/web/frontend/components/fields/index.ts` 的 `controlOf()`（P2-B 前为 `fieldEditor.jsx:703` 的最终 `<input type="text">`）。
- 设计文档（`design-intent.md` §3）要求删除兜底、改为 `Record<FieldType, Control>` 查表。
- 冲突点：编译期穷举只能保证「14 种已知类型都有控件」，挡不住**存量数据里出现未知 type**（手改 `store.json`、降级安装）。直接查表会从「退化成文本框」变成「渲染 undefined 组件报错」，属于可见行为变化。
- 建议：保留运行时兜底（`FIELD_CONTROLS[type] ?? TextControl`），编译期穷举仍然是硬约束；这样两者都不牺牲。
- **裁决（已采纳）**：两条同时满足——`FIELD_CONTROLS` 用 `Record<FieldType, Control>` 编译期穷举，运行时 `?? TextControl` 兜底，**不删兜底**。

### D3. 顶层 `select` 写入不校验

- 位置：`src/modules/entries/service.ts` 的 `normalizeValue`（无 `select` 分支）。
- 设计文档把它列为三次事故之一；但「修」= 以前能写入任意字符串，之后被拒绝 → **行为变化**。
- 选项：(a) 本次不修，仅补测试钉住现状；(b) 单独立项修复。
- **裁决：维持现状**，只补测试固定当前行为（`tests/unit/fields.test.ts` 的「顶层 select 写入不校验候选」）。

### D4. `transfer.plainValues` 缺 `table` 分支

- 位置：`src/modules/transfer/service.ts`。
- 已在计划中列为 P1.5 独立修复（导出含敏感列的表格时密文出包）。
- 这是**已批准的缺陷修复**，单独提交、单独汇报；除此之外不改语义。
- **已修复（`fc4b9e2`，单独提交，只含 transfer/service.js 与该用例）**。用例：
  `tests/unit/transfer.test.mjs` 的「表格的敏感列在导出包里是明文」——建带敏感列的表格 → 导出 → 断言 manifest 里是明文；
  同时先断言落盘仍是密文，避免在「本来就没加密」时假通过（临时关掉修复分支时该用例确实变红，已实测）。

### D5. `disabled` 只对 `secret` 生效

- 现状：`FieldControl` 收到 `disabled` 只传给 secret；其它控件忽略。
- 看起来像遗漏，但统一后会让某些场景从「可编辑」变成「不可编辑」，属于行为变化。
- **保持现状。**

---

## 5. 对账记录

| 阶段 | lint | typecheck | unit | build | smoke | 本清单核对 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | 0 error | `tsc -b` 通过 | — | — | — | — | 通过 |
| P1 | 0 error | 通过 | 350 pass / 0 fail | — | — | — | 通过 |
| P1 后 / P2 前（本轮全量） | 0 error | 通过 | 350 pass / 0 fail（2.12s） | 350 modules，1.88s | 137 项断言全过 | 文档阶段，未改行为 | 通过 |
| P2-A | 0 error | `tsc -b` 通过 | 360 pass / 0 fail（2.34s，新增 `fields.test.ts` 9 条 + transfer 1 条） | 350 modules，1.64s | 137 项断言全过 | §2.G3 / G4 / §2.C / §2.D1 / §2.D4 | 通过 |
| P2-B | 0 error | 退出 0；故意漏 `table` 时 `error TS2741: Property 'table' is missing ... Record<...14 键..., Control>`，恢复后 0 | 360 pass / 0 fail（2.24s） | 成功（1.64s） | 137 项断言全过 | §2.C 全部（14 个控件逐一落到 `.tsx`；基线可见中文 101 段 → 新代码缺失 0 段）；§2.D 未触及（`tableField.jsx` 原样，仅加注册入口）；§2.G3/G4（`valueLines` / `entryGet` 附件解析改走 `format`/`refs`，smoke 全过）；§4-D2 保留 `?? TextControl` | 通过 |
| P3 | 0 error | `tsc -b` 通过 | 366 pass / 0 fail | 成功 | 137 项断言全过 | §2.A / §2.E（导航顺序、分组交互、隐藏栏目深链、栏目管理树/搜索/批量删） | 通过 |
| P3.5 | 0 error | `tsc -b` 通过；类型擦除后与基线同管线 diff：source 12 行差（7 条 import 路径 + `onToggleTask={undefined}` + `SourceControl` 入口），table 7 行差（3 条 import + `className` 书写位置 + 控件改名 + 去掉默认导出） | 366 pass / 0 fail（2.48s） | 成功（1.59s） | 137 项断言全过 | §2.C 的 `source` / `table` 两行 + §2.D1–D11 逐条；机械对账：中文可见片段 40+74=114 段缺失 0 / 新增 0，`className` 记号 49+73 集合双向一致；真机走查（`pnpm dev` + 求职栏目）：表头 `⋮`/合计行/`＋ 新建一行`/`统计行`/空态「还没有行」可见，source 折叠条 → 抽屉「＋ 选择文件」「新的一条（markdown）」「插入图片」、placeholder 含「Ctrl+Enter 入袋」、「加入（Ctrl+Enter）」可见，Esc 关闭且焦点回到折叠条。列设置弹层用 DOM 派发点击打开并核对：列名「项目」、key「item」、类型「文本」、统计「按类型自动」、密文未勾选、六项动作齐全、首列「左移」禁用；Escape 与点外（`pointerdown`）均关闭（`[role=dialog]` 计数 1→0）。鼠标/`browser_press_key` 走不通是自动化输入通道未送达页面（DOM 派发即通过） | 通过 |
| P4 | 0 error | `tsc -b` 通过 | 366 pass / 0 fail | 364 modules | 137 项断言全过 | §2.G（`--help` / `section list` / `entry get` / `export`/`import` 输出与退出码逐项比对） | 通过（`.ts` 直跑阶段） |
| P5 | 0 error | `tsc -b` 通过 | 366 pass / 0 fail | 364 modules | 137 项断言全过 | §2 全部小节 + 真机走查 | 通过（dist 发布形态；详见下方 P5 走查记录） |
| P6 | 0 error | `tsc -b` 退出 0（已撤 `allowJs` / `checkJs`） | 366 pass / 0 fail | 364 modules | 137 项断言全过 | §2 全部小节 + 真机走查 | 通过（前端 27 个文件全部 `.ts/.tsx`，`any` 121 处集中在外数据边界与既有字段控件；详见下方 P6 走查记录） |

### P5 真机走查记录（2026-11-09）

环境：`pnpm build` 后的 `dist/` 起 `serve`，浏览器访问 `http://127.0.0.1:7888`（home 为真实数据的临时拷贝，未改线上）。

| 页面 / 场景 | 结果 | 控制台 error |
| --- | --- | --- |
| 栏目列表（demo §字段样例 1 条 / 14 字段，真实数据副本上另验项目经历 2 条 / 9 字段）→ 打开条目编辑 | 列表、字段输入框、面包屑齐全 | 0 |
| 条目增删改（新建 → 保存 → 删除） | 新建后列表 1→2 条，删除确认弹层文案完整（「删除条目「P5 走查临时条目」？删除不可恢复…」），确认后回到 1 条；（视口 0x0 下未捕获 toast 文案，状态变化即证据） | 0 |
| 14 种字段控件逐个可编辑（text/textarea/number/date/month/bool/select/tags/secret/entrylist/table/source/file/md） | 14 个控件全部识别；文本/数字/日期/月份/下拉/标签可输入，布尔可切换，表格可加行，`source` 抽屉可开 | 0 |
| 表格：列设置弹层 / 键盘移动 / 统计行 | 列菜单项齐全（列名/key/类型/统计/密文 + 左移/右移/插入/复制/删除），Esc 关闭（dialog 1→0）；Enter 下移同列实测通过；Alt+↑↓ 按代码是**同列焦点移动**（`arrowFrom → focusCell`），自动化仅复验到 Enter，Alt 分支按代码走查确认；统计行「合计 1/2 7 1400 元」「完成率 50%」 | 0（列选项输入触发的 `setOptsTick` 为已知缺陷 D1，未修） |
| 资料袋（source 抽屉） | 折叠条「▸ 原始资料 0（空）整理前先乱入这里」→ 抽屉含「＋ 选择文件」「新的一条（markdown）」「Ctrl+Enter 入袋」，Esc 关闭 | 0 |
| 附件（files 页） | 空态 → CLI 导入 2 个附件后列表显示 2 条；「编辑附件」弹层预填原名，Esc 关闭 | 0 |
| 导出 / 导入 | 「导出 ZIP」点击后发出 `POST /api/bundle/export.zip`；导入往返由 smoke 的 export→import 用例覆盖，未在浏览器里走完整导入 | 0 |
| 设置页导航 | 「本机配置与运行状态」「栏目管理」「存储与运行」等分区齐全，切回「字段样例」后 URL → `#/demo` 且列表正常 | 0 |
| 深链 `#/demo` / 未知 id `#/no-such-section` | 深链直达渲染；未知 id **保持原视图且不改写 URL**（与 `App.tsx` 注释「刻意不补 hash」一致），无白屏 | 0 |

### P6 真机走查记录（2026-11-09）

环境：`pnpm build` 后的 `dist/` 起 `serve`（`http://127.0.0.1:7891`），home 指向临时目录 `D:\Temp\nxsk-p6-walk`（demo「字段样例」1 条 / 14 字段），未触碰真实数据。

| 页面 / 场景 | 结果 | 控制台 error |
| --- | --- | --- |
| `#/demo` 条目编辑 | 14 个字段块全部渲染，标题/日期/数字等输入框可编辑，面包屑与保存按钮齐全 | 0 |
| 资料袋（source 抽屉） | 折叠条「▸ 原始资料 0（空）整理前先乱入这里」→ 点击展开，抽屉含「＋ 选择文件」「新的一条（markdown）」 | 0 |
| 栏目编辑弹层（`#/sections`） | 字段字典 14 项齐全；新增字段把类型切到「表格」后出现「列 key / 列名 / 列类型」行；关闭弹层正常 | 0 |
| 表格列设置弹层 | 真实鼠标点击仍未命中（与 P3.5 相同），用 DOM 派发点表头最后一个 `⋮` 成功：弹层含列名与 key；Esc 后 `[role=dialog]` 计数 0 | 0 |
| `#/files` 附件页 | 空态「0 个 · 0 B」与上传入口正常 | 0 |
| `#/export` 导出导入 | 面板文案「选栏目（全选即整库）→ 设口令 → 下载」与「整库 / 清空 / 字段样例」控件齐全；未实际触发下载 | 0 |
| `#/settings` | 分区齐全，切回「字段样例」后 URL → `#/demo` 且列表正常 | 0 |
| 深链兜底 `#/<不存在>` | 回落到「字段样例」，不白屏 | 0 |

> 说明：其中一次会话在根文档导航上留下过一条 `net::ERR_ABORTED http://127.0.0.1:7891/`；换一次干净加载后控制台与网络列表均为空，判定为导航中断而非应用异常，未复现。

