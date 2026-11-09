# nx-sk 分阶段重构计划

> 目标：字段 / 模块的扩展变成「注册一处、编译期兜底、生命周期自动跑」。
> 铁律：**每一阶段结束时 `pnpm lint && pnpm typecheck && pnpm test` 全绿；不顺手改功能语义。**
> 唯一例外是明确标注的缺陷修复（P1.5），单独提交、单独汇报。
>
> 对账依据：`docs/behavior-parity.md`（每个阶段结束逐项核对该清单）。
> 解耦参考：`docs/reuse-from-project-graph.md`（照搬 / 不照搬，均指到具体文件）。

---

## 阶段总览

| 阶段 | 内容 | 产出 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 工具链与基线 | tsconfig / eslint / typecheck 脚本，全 JS 时零报错 | 低 | 已完成 |
| P1 | 契约测试先行 | 钉住现有响应形状 + 全类型往返 | 低 | 已完成 |
| P1.5 | 修复 `table` 敏感列导出（独立提交） | 一处分支 + 一条测试 | 低 | 已完成 |
| P2 | 字段注册表 + 首批控件 | shared 行为表 + 每类型一个 `.tsx` | 中 | 已完成 |
| P3 | 模块注册式扩展 | 目录即声明 + 装载期形状断言 | 低 | 已完成 |
| P3.5 | 字段控件物理搬迁（`source` / `table`，独立实施） | 两个 `.tsx` 自包含，包装层删除 | 中 | 已完成 |
| P4 | 后端 TS 化 | `src/**/*.ts`，`dist/` 发布 | 中高 | 已完成 |
| P5 | 收口与发布验证 | engines / bin / 文档 / 全链路 | 中 | 已完成 |
| P6 | 前端 TS 化（27 个 `.js/.jsx` → `.ts/.tsx`） | 前端零 JS、`allowJs`/`checkJs` 撤销、边界规则覆盖 `.tsx` | 中 | 已完成 |

---

## P0 工具链与基线

**做什么**

1. 记录基线：`pnpm test` 的通过项与耗时，作为后续对照。
2. 加 `typescript`（固定 5.9.3，需要 `erasableSyntaxOnly`）、`@types/node@22`、`@types/react@18`/`@types/react-dom@18`、`typescript-eslint` 为 devDependency。
   `@types/react*` 必须是**直接依赖**：它原先只存在于 pnpm store 的子路径，`composite` 的声明推断会报 TS2742「类型不可命名」。
3. tsconfig：
   - `tsconfig.base.json`：`strict`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmit`、`skipLibCheck`、`module/moduleResolution: nodenext`、`allowImportingTsExtensions`、`isolatedModules`；
   - `tsconfig.server.json`：`composite`，`lib: ES2023`，`types: ["node"]`，**不含 DOM**；
   - `tsconfig.web.json`：`composite`，`lib: ES2023 + DOM`，`jsx: react-jsx`，`types: []`（**无 node 类型**，从类型层面挡住越界）；
   - 根 `tsconfig.json`：solution 文件（`files: []` + `references`），`typecheck: tsc -b`。
   - 两份 project 的 `include` 都**同时列 js/jsx 与 ts/tsx**：`composite` 要求 project 列出全部被 import 的文件，只列 ts 会报 TS6307。
4. **过渡期例外**：`allowJs: true, checkJs: false`（**P5 已删除**：后端与 shared 已无 `.js`；
   仅 `tsconfig.web.json` 保留给前端 JS/JSX，`checkJs` 仍为 false）。
5. `package.json` 脚本：`"typecheck": "tsc -b"`，并把 `typecheck` 插到 `test` 的 `lint` 之后。
6. `test:unit` 从 `node --test`（无参）改为显式 glob `tests/**/*.test.{mjs,ts}`。理由：无参会把仓库里任何 `*.test.*` 都扫进来——包括 `.claude/repo/` 下的**只读 JS 基线快照**，等于把旧代码的测试跑两遍。
7. eslint：引入 `typescript-eslint`，**先把所有 `files` 通配从 `{js,mjs,jsx}` 扩成 `{js,mjs,cjs,jsx,ts,tsx}`**，再逐个确认边界规则仍然命中；`no-unused-vars` 换成 `@typescript-eslint/no-unused-vars`；`ignores` 补 `.claude/**`（只读快照）、`.tmp/**`、`.tool/**`。

**为什么先做**：扩 eslint 通配必须在任何 `.tsx` 出现之前，否则会有一段时间新文件掉出边界规则且无人发现。

**基线快照**：`D:\a_js\js_proj\nx-sk\.claude\repo\project\2026-11-09-09fa9be\` 是 commit `09fa9be` 的干净拷贝（完整 `src/ bin/ tests/ scripts/`、无 `node_modules`、无构建产物、带只读 `.git`）。它与重构起点的已跟踪内容**逐字节一致**；起点工作树相对它只多了（a）另一会话改的 `.gitignore`、（b）本目录 `docs/`。快照只作只读参照，不入库、不清理、不参与 lint/typecheck/test。

**验收**

- 此时仓库仍是全 JS（新增 `.ts` 只有契约测试与 `vite-env.d.ts`）；`tsc -b` 通过。
- `pnpm lint && pnpm typecheck && pnpm test` 全绿（350 条单测）。
- 已实测：新建 `src/web/frontend/__probe.tsx` 里 `import '../../core/paths.js'` → eslint `no-restricted-imports` 报错；新建 `__probe2.ts` 里 `const n: number = 'x'` → `tsc -b` 报 TS2322。两个探针均已删除。

**回滚**：删 tsconfig 与脚本改动，无代码影响。


---

## P1 契约测试先行

**做什么**：新增 `tests/unit/contract.test.ts`，只钉**面板真正依赖**的键（依据 `consistency.test.mjs` 目前的盲区）：

1. `section.dump`：`section.id` / `fields[].key` / `fields[].type` / `entries[].values` / `entries[].completeness.ratio` / `entries[].missing` / `entries[].excluded`；
2. `entry.list`：`count` / `total` / `entries[].id`；
3. `entry.get`：`values` / `fieldTypes` / `tables` / `files`；
4. `file.list`：`files` / `page.total` / `page.hasMore` / `unlinked` / `rootRaw`；
5. `bootstrap`：`fieldTypes` 与 `src/shared` 的字段常量深相等（P2 之后生效，先写成对 `core/fields.js` 的导入，P2 改导入路径）；
6. **全类型往返**：遍历 `FIELD_TYPES`，各造一个最小值，跑 `prepareValue → serializeEntry → dumpSection`，断言不抛且值不丢；
7. **键集断言**：`serializeEntry(...).values` 的键集合恒等于 `section.fields` 的 key 集合。

**验收**：新测试全绿，且能证明它们有效——临时把 `serializeEntry` 里某个键改名，测试必须红。

**已落地**：`tests/unit/contract.test.ts`（6 条）。一个踩到的坑记在这里：首次运行的播种（demo 栏目 + 示例条目）**只活在内存里**，`store.json` 不存在时每次 `loadStore()` 都会重新播种、条目 id 随之变化；所以测试开头必须先 `saveStore(await loadStore())` 落盘一次，否则「先 list 再 get」永远找不到同一条。

**为什么**：`consistency.test.mjs` 只查「路由存在」，不查「响应形状」。这是 P2 之后所有重构的安全网。

---

## P1.5 修复 `table` 敏感列导出（独立提交，需单独汇报）

**做什么**：`plainValues` 增加 `table` 分支（按列定义解密），补一条「导出含敏感列的表格 → 包内是明文」的测试。

**为什么单独**：这不是重构，是缺陷修复。`CHANGELOG.md` 已声称修过但代码里没有；混在重构里会让人误以为是类型问题导致的。

**约束**：只改这一处，不动 `prepareTable` / `revealTable` 的语义。

---

## P2 字段注册表 + 首批控件

**做什么**

1. 把字段类型清单搬出 `core/fields.js`：
   - `src/shared/fields/types.ts`：`FIELD_TYPES`（`as const`）、`FieldType`、`FieldDef` 判别联合、`FieldValue` 联合；
   - `core/fields.ts` 改为 `export * from '../shared/fields/types.ts'`（保持旧导入点不破）。
2. 每个类型一个纯行为文件 `src/shared/fields/<type>.ts`，实现 `normalizeDef / coerce / reveal / refs / remap / format / sensitive / subFields`；`table` 委托 `src/shared/table.ts`。
3. `src/shared/fields/index.ts` 导出 `FIELD_BEHAVIOR: Record<FieldType, FieldBehavior>` 与 `assertFieldRegistry()`（键集双向、7 钩子齐全、三探针不抛）。
4. 服务端唯一副作用钩子 `src/core/fields/seal/index.ts`：`FIELD_SEAL: Record<FieldType, SealHook | null>`，`entrylist` / `table` / `secret` 有实现，其余显式 `null`。
5. 前端每类型一个控件 `src/web/frontend/components/fields/<type>.tsx` + `FIELD_CONTROLS: Record<FieldType, Control>`；`fieldEditor.jsx` 改为查表，**保留** `?? TextControl` 的运行时兜底（见 `behavior-parity.md` §4-D2 裁决：编译期穷举 + 运行时兜底两条同时满足）。
6. 接入点逐个换成注册表调用：`normalizeValue`、`prepareValue`（查 `FIELD_SEAL`）、`serializeEntry`、`attachments.fileReferences`、`transfer.plainValues / referencedFileIds / remapFileIds`、`valueLines`、`subFieldsOf`、`sensitiveViewer`。
7. `TABLE_CELL_TYPES` 保留显式数组（顺序进错误文案），测试断言它与行为体 `cell` 标记的集合一致（见 P2-A 记录）。

**验收**

- `FIELD_TYPES` 加一项、不写行为体 → `tsc -b` 报错（**这就是本阶段的验收证据，需在汇报里贴出来**）。
- `FIELD_TYPES` 加一项、不写控件 → `tsc -b` 报错。
- P1 的契约测试全绿；`pnpm test` 全绿。
- `nx-sk section dump` 输出与 P0 基线逐字节一致（敏感值除外，用打码后的输出对比）。

**风险与对策**

- 顶层与单元格 `coerce` 合并会改变边界行为（`对/有`、千分位、`2026/10/30`）：**取并集**，并加「旧字面量在新实现下仍通过」的表驱动测试。
- `normalizeDef` 不得改入参：现有 `normalizeRows` 会就地改 `def.fields`，迁移时保留原行为，只做包装。

**执行记录（P2-A，已完成）**

- 落地位置与计划有一处偏离，原因写在这里：行为体在 `src/core/fields/behaviors/<type>.ts`，**不在** `src/shared/fields/`。
  `src/shared/**` 被 `tsconfig.web.json` 全量纳入且必须零依赖（浏览器要打包），而 `coerce` / `normalizeDef`
  需要 `core/errors` 的 `badInput`、`core/source` 的归一、`shared/table` 的强转。`src/shared/fields/types.ts`
  只保留词汇表与契约（零依赖，前后端都能 import），行为实现放服务端目录，分层不破。
- `TABLE_CELL_TYPES` **保留显式数组**，没有改成 `filter(cell)`：它的顺序会被 `shared/table.js` 的报错
  `join(' / ')` 给用户看，改了顺序就是改了可见文案。新增测试断言它与 `cell` 标记**集合一致**，防止漂移。
- 已接入：`normalizeValue`（coerce）、`validateFieldDef`（normalizeDef）、`serializeEntry`（reveal + sensitive）、
  `vault.subKeysOf`（subFields）。待 P2-B：`refs / remap / format / seal` 与 `attachments`、`transfer`、`valueLines`。
- 为解「render ↔ 注册表」的循环，新增 `src/core/values.ts`（isBlank / isStoredEmpty / isPlainRow）与
  `src/core/sensitive.ts`（displaySensitive）；`render.js` 继续 re-export，老导入点不变。
- `prepareTable` 仍直接调用行为体导出的 `normalizeTable`，**不经过** `coerce` 的「必须是行数组」前置校验：
  面板保存的是 `{columns, rows}` 文档、`{}` 表示清空，这是既有语义（见 `table.test.mjs` 的空表用例）。

**执行记录（P2-B，已完成）**

- 前端控件逐一落到 `src/web/frontend/components/fields/<type>.tsx`（14 个），`FIELD_CONTROLS` 在
  `fields/index.ts`，`fieldEditor.jsx` 只剩 `controlOf(type)` 查表 + 值归一。`AutoTextarea` 抽到
  `fields/autoTextarea.tsx`（textarea 与 md 共用，行为逐字未改）。
- `source` / `table` 先以**注册入口包装**落地（`fields/source.tsx`、`fields/table.tsx` 转发给
  `sourcePanel.jsx` / `tableField.jsx` 的原实现）：P2-B 只做注册表，不动这两个大组件的渲染；
  真正的拆分留给 P3/P5，避免这一轮引入像素级风险。
- 运行时兜底**不能**省：存量数据可能带未知 type。`controlOf()` 里保留 `?? TextControl`，与 D2 裁决一致。
- 编译期证据（实测）：临时删掉 `table: TableControl,` 一行，`tsc -b` 报
  `error TS2741: Property 'table' is missing ... but required in type 'Record<...14 个键..., Control>'`；
  恢复后退出码 0。`FIELD_SEAL` 同样用 `Record<FieldType, SealHook | null>`，`entrylist / table / secret`
  非 null、其余显式 `null`（显式的「没有类型级逻辑」，不是遗漏）。
- 后端收口：`FIELD_SEAL` 落 `src/core/fields/seal/{index,common,entrylist,table}.ts`，
  `entries/service.js` 的 `prepareEntryList` / `prepareTable` / 内联标量封装全部删除，
  `prepareValue` 只剩「查表 → 敏感标量分支 → coerce」。**语义逐字保留**，包括表格打码值
  先按行、再按整列比对的原逻辑。
- `refs / remap / format` 接入点：`attachments.fileReferences`（默认口径：资料袋正文图**不算**）、
  `collectFileSections`（改为问行为体「有没有可能引用」的探针，不再维护类型清单）、
  `transfer.referencedFileIds`（导出口径：`sourceTextImages: true`，正文图**算**）、
  `transfer.remapValues`、`entries.entryGet` 的附件解析、`entries.valueLines`。
- `valueLines` 的通用分支（值本身是已解析附件 / 行数组 / 布尔 / 多行正文）保留在 `format` **之前**：
  与重构前顺序一致，`md` 的值若恰好是一个附件 id，仍按附件路径显示（文案零差异）。
- 自检（本轮实测）：`pnpm lint` 0 error；`pnpm typecheck` 退出 0；`pnpm test:unit` 360 pass / 0 fail；
  `pnpm build` 成功；`pnpm test:smoke` 137 项断言全过。
- 文案对账：把基线 `fieldEditor.jsx` 的可见中文片段（去注释后 101 段）逐段在新代码里查，
  **缺失 0 段**（脚本临时跑完即删，未入库）。

---

## P3 模块注册式扩展

**做什么**

1. `src/runtime/module-registry.js`：扫描 `src/modules` 逐目录装载 `<id>/index.js`；装载期断言缺 `index.js` /
   加载失败 / `id` 与目录名不一致 / 缺 `title`·`order` / `id` 重复。
2. `src/runtime/registry.js` 删除手写 import 清单与数组，改为 `MODULES = (await loadModules()).sort(...)`；
   action 级 `selfCheckActions` 原样保留。
3. eslint 的模块互依禁列改为**从 `src/modules` 派生**（settings 除外），删除手写清单。
4. `tests/unit/module-registry.test.mjs`：用临时目录喂「缺 index / id 错位 / 缺 title·order / 重复 id」，
   钉住每条断言真的会红；`consistency.test.mjs` 的 eslint 检查改为验证「派生集合 == MODULES」。

**验收**：新建一个没有 `index.js` 的模块目录 → 进程启动直接抛；`id` 与目录名不一致 → 抛；
新增模块不需要改 `registry` / `eslint`。

**不改**：前端 `VIEWS` 仍是视图侧唯一声明（后端模块不声明视图）；「新模块要不要面板」是显式决定，
不是重复声明。

**执行记录（P3，已完成）**

- 真实目录与注册表自动对齐：`listModuleIds()` 的 7 个目录 == `MODULES` 的 7 个 id（单测断言）。
- 实测启动断言：临时建 `src/modules/_probe/`（空目录）后执行
  `node --input-type=module -e "await import('./src/runtime/registry.js')"`，进程退出码 1，报
  `Error: src/modules/_probe 缺少 index.js——模块目录必须 default 导出模块对象，否则它不会出现在 help / 路由里`；
  删除该目录后恢复正常。
- 反例单测：`module-registry.test.mjs` 6 条（真实对账 / 缺 index / id 错位 / 缺 title / 缺 order / 重复 id / 正常装载），
  全量单测 366 pass / 0 fail。
- 少一处手写：`eslint.config.js` 的 `SIBLING_MODULES` 由 `readdirSync('src/modules')` 派生，新增模块漏补的
  可能性被结构性消除；对账测试仍保留（验证派生结果与 `MODULES` 一致）。

---

## P3.5 字段控件物理搬迁（独立阶段）**已完成**

**做什么**：把 `SourceFieldControl`（`sourcePanel.jsx`）与 `TableFieldControl`（`tableField.jsx`）
搬进 `fields/source.tsx` / `fields/table.tsx`，让两个控件文件自包含；原文件只保留非控件部分
（资料管理面板、表格调用方），包装层删除。

**实际结果**：

- 两个原文件**没有其它调用方**（`git grep` 只命中包装层），因此整文件删除，不存在「保留非控件部分」。
- 控件改名：`TableFieldControl → TableControl`（与注册表命名一致）；`SourceFieldControl` 变为文件内私有，
  对外只留 `SourceControl`，它仍做 `def + ctx` 合并（与旧包装层逐字相同）。`table.tsx` 的默认导出删除。
- `setOptsTick` 缺陷 1:1 保留：用 `declare const` 只为让 `tsc` 编过，不产生运行时代码，运行期仍是
  `ReferenceError`（`behavior-parity` §4-D1）。
- 机械对账（临时脚本，跑完删除）：基线可见中文片段 40（source）+ 74（table）=114 段，新文件缺失 0 / 新增 0；
  `className` 记号 49 / 73，集合双向一致。类型擦除后与基线同管线 diff：source 12 行差、table 7 行差，
  全部落在 import 路径、类型擦除所需写法、控件改名与导出形态，无逻辑差异。
- 五项自检全绿（lint 0 / `tsc -b` 0 / unit 366 pass / build 1.59s / smoke 137 断言）。
- 真机走查：表格表头/合计行/新建一行/统计行/空态与 source 抽屉（含 Esc + 焦点归还）均正常；
  列设置弹层自动化点击未命中，留人工复核一次。

**验收**：`design-intent.md` §3「过渡态声明」的 4 条——自包含、等价清单逐条成立（含全部可见文案/交互/布局）、
文案片段与 `className` 集合机械对账、五项自检全绿 + 真机走查。

**约束**：单独实施、单独汇报；不与 P4/P5 或任何功能改动夹在一起。

---

## P4 后端 TS 化

**顺序**（由叶子到根，每步都能独立跑测试）：

1. `src/shared/**` 已完成（P2）。
2. `src/core/**`：`errors / ids / paths / store / vault / render / attachments / fields`。
3. `src/modules/**`：sections → entries → files → transfer → skill → settings → system。
4. `src/runtime/**`：`spec / registry / api / server / cli`。
5. `bin/nx-sk.mjs` → 保持 `.mjs` 入口，但**只 import 构建产物**（最终形态见下方执行记录；最初设想的
   「版本预检 + `import('../src/runtime/cli.ts')`」已被 `node_modules` 禁跑 `.ts` 推翻）。

**做法**：先改名 `.js → .ts`，用 `tsc -b` 的错误清单驱动补类型；`any` 只允许出现在明确的边界（JSON 入参、`res` 对象），且必须带 `// eslint-disable-next-line` 说明理由。

**约束**

- 所有相对导入补 `.ts` 扩展名（`allowImportingTsExtensions`）。
- 类型导入必须 `import type`（`verbatimModuleSyntax`）。
- 禁 `enum`（`erasableSyntaxOnly`）。
- ~~`engines.node` 改 `>=22.18.0`，`bin/nx-sk.mjs` 增加版本预检与可读错误。~~（已推翻：最终
  `engines` 保持 `>=18.17`，bin 改为 dist 缺失提示；理由见执行记录「发布形态定稿」。）

**验收**

- `node bin/nx-sk.mjs --help`、`nx-sk section list`、`nx-sk entry get ...` 与 P0 基线输出一致。
- `node --test` 直接发现 `*.test.ts` 并通过。
- `pnpm lint && pnpm typecheck && pnpm test` 全绿。

**风险**

- `node:test` 对 `tests/**` 的收集范围：已验证 `node --test` 在 v24.18.0 会自动发现 `*.test.ts`。
- 循环依赖在 TS 下不会更安全，但 `import type` 会掩盖运行时环：迁移后跑一次 `node bin/nx-sk.mjs --help`，确保没有「类型能过、启动就炸」。

### P4 执行记录（2026-11-09）

- 事故：一个定时巡检会话越权直接写仓库——向 20 个 `.ts` 批量注入 `// @ts-nocheck` + BOM（`src/runtime/*` 6 个、`src/modules/**/*` 14 个），并擅自把 14 个模块 `.js` 改名 `.ts`、改 `module-registry` 装载器、跑 build。`tsc -b` 因此显示为绿，属**假绿**。
- 处置：先整树存档到 `.claude/repo/project/2026-11-09-2125-rogue-wip/`（不含 `node_modules`、`src/web/public`、`.git`），再回退模块改名与 `@ts-nocheck`；回退后 `lint / typecheck / test:unit(366) / build / test:smoke(137)` 全绿。
- 教训（并发执行者 + 类型压制）：`// @ts-nocheck` 的文件不参与类型检查，会让 typecheck 变成假绿；批量改名或怀疑被外部写入后，必须 `grep -r "@ts-nocheck" src bin tests` 复核，且以 `git status --porcelain` + mtime 快照判断是否有非自身写入。
- 教训（巡检类定时任务）：必须**只读**，禁止写仓库；一旦需要改代码，只能产出建议或开独立分支，不得直接改工作树。
- `engines.node` 收紧到 `>=22.18.0`（2026-11-09）：`src/**` 已是 TypeScript 源码直跑，依赖 Node 22.18 起的原生类型剥离；
  `bin/nx-sk.mjs` 相应改为「先版本预检、后动态 `import('../src/runtime/cli.ts')`」——静态 import 会在预检前被模块加载器解析，
  低版本只会抛裸栈。不满足 `>=22.18.0` 时打印当前版本、要求版本与 nvm/fnm 升级提示并 `exit 1`。
  同步留痕：`package.json` 的 `engines`、`CHANGELOG.md` 顶部 Breaking、`README.md` 安装要求（本文件即第四处）。
- 发布形态定稿（2026-11-09，推翻上一条的临时方案）：Node 拒绝对 `node_modules` 下的 `.ts` 做类型剥离
  （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以「发布 `.ts` 直跑」在 `npm i -g` / `npx` 形态必然启动失败。
  改为单一运行时路径：`tsconfig.build.json`（`outDir: dist`、`rewriteRelativeImportExtensions: true`）产出
  `dist/**/*.js`（`.ts` 后缀在 emit 时改写成 `.js`，不动全仓 import）；`bin/nx-sk.mjs` 只 import
  `dist/runtime/cli.js`；面板产物落到 `dist/web/public`（`PUBLIC_DIR` 按 `import.meta.url` 的相对深度推导，
  源码布局与 dist 布局自洽）。`engines.node` 回退 `>=18.17`——运行时是纯 JS，Node ≥22.18 只是开发/测试
  （`node --test` 直跑 `.ts`）的要求；`files` 收窄为 `bin/ dist/ assets/ README CHANGELOG LICENSE`。

---

## P5 收口（已完成，2026-11-09）

1. 删除临时的 `allowJs` / `checkJs` 例外与 eslint 兼容层。✅ 从 `tsconfig.base.json` 移除
   （`tsconfig.web.json` 当时单独保留 `allowJs`，因为前端还是 JS/JSX；**P6 已撤销**，见下）；`src/index.js` 改为 `src/index.ts`；
   `tests/helpers.d.mts` 补最小声明，`tests/**/*.mjs` 仍可被 `.ts` 测试 import。
2. `README.md` 更新安装/开发两段 Node 版本要求（运行时 ≥18.17，开发/测试 ≥22.18）。✅
3. `CHANGELOG.md` 记发布形态变更（`Unreleased / Changed`，明确对使用者非破坏）。✅
4. 全链路验证：全局安装形态、`dev`、`build`、`serve`、导出/导入往返、密钥往返。✅
5. 清理探针文件与临时脚本。✅
6. `TODO(P5)`：收紧 `src/core/render.ts` 的读取侧形状。✅ `SectionLike` 除 `layout` 外全部必填；
   `EntryLike` 的 `tags / createdAt / updatedAt / values` 与 `SerializedEntry` 的 `createdAt / updatedAt`
   一并收必填；`sections/service.ts` 的两处 `as unknown as` 已删除（类型直接兼容），未新增任何强转。

### P5 执行记录（2026-11-09）

- 契约兜底：`tests/unit/contract.test.ts` 断言 `dumpSection` 每条条目都有非空 `id`、对象 `values`、
  数值 `completeness.ratio`；类型若再放宽或出口漏写，测试先红。
- 单测 366 / build 364 modules / smoke 137 / lint 0 / typecheck 0，与 P4 基线一致。
- 真机走查：栏目列表、条目增删改、14 种字段控件、表格（列设置/键盘/统计）、资料袋、附件、
  导出导入、设置页导航、深链与非深链兜底，控制台 error 0（详见 `docs/behavior-parity.md` §5）。

---

## P6 前端 TS 化（已完成，2026-11-09）

**做什么**：把 `src/web/frontend` 下 27 个 `.js/.jsx` 全部改成 `.ts/.tsx`。只做改名 + 类型标注 + 必要的收窄，
不改 JSX 结构、`className`、文案、交互与 hook 顺序。

**批次**（按边界由外到内；每批 `pnpm typecheck && pnpm build`，并记录 `any` 变化）

| 批次 | 文件 | 说明 |
| --- | --- | --- |
| 1–5 | 16 个：`api/{client,files,zip}`、`store`、`activeView`、`listSort`、`md{Smart,Inline,Source}`、`components/{navModel,mdView,blockBoard,fieldEditor,listDrag,lightbox,ui}` | 顺序：`api/client` → `store` → `components`（ui → fields → 其余） |
| 6 | `components/transferPanel`、`modules/{files,export}/view` | 面板组件与域视图 |
| 7 | `modules/settings/{view,navManager}`、`modules/entries/kvTable` | 设置域 |
| 8 | `modules/entries/view`、`modules/sections/view` | 两个最大视图 |
| 9 | `App`、`main`、`registry` | 入口与视图注册表；同批撤 `allowJs/checkJs`、同步 eslint 与一致性测试 |

**关键决定**

1. **`any` 记账**：批次 1 前 117 → 批次 1–5 后 121 → 批次 6/7/8/9 各 **+0 / −0**。121 处里 110 处集中在 P2-B/P3.5
   就已存在的字段控件（`table` 36 / `source` 30 / `md` 22 / `file` 13 / `entrylist` 7 / `types` 3 / `autoTextarea` 2）；
   新增的 4 处全在外部数据边界（`api<T = any>`、`postZip<T = any>`、`FieldGroup.onPatch` 的透传）。
   全程没有为编译通过写 `as any`。（另有 2 处非类型位：`table.tsx` 的 `step="any"`、`api/client.ts` 注释。）
2. **`SerializedEntry` 下沉 `shared/model.ts`**：原在 `core/render.ts`，面板的 dump 预览与后端共用；
   `core/render.ts` 改为 `import type` + `export type` 重导出，老导入点不变。
3. **不手写第二份清单**：`FIELD_CONTROLS: Record<FieldType, Control>` 保持；`Section` / `FieldDef` / `Entry` / `boot`
   全部从 `shared/` 引入。
4. **`react-grid-layout` 的 d.ts 依赖 `@types/react@19`**（其 `ReactNode` 含 `bigint`），与项目的 `@types/react@18`
   冲突：加本地 shim `src/web/frontend/types/react-grid-layout.d.ts` + `tsconfig.web.json` 的 `paths`，运行时不改。
5. **`tsconfig.web.json`**：删 `allowJs` / `checkJs`，`include` 收为 `src/web/frontend/**/*.ts`、`**/*.tsx`、
   `src/shared/**/*.ts`。
6. **eslint**：前后端边界规则的 `files` 覆盖 `src/web/frontend/**/*.{js,jsx,ts,tsx}`，禁列补 `.ts`/`.tsx`
   （`**/modules/*/index.{js,ts}`、`**/modules/*/service.{js,ts}`、`**/runtime/**`、`**/core/**`）；
   `import '../../core/**'` 仍被 `no-restricted-imports` 拦住。
7. **一致性测试**：`tests/unit/consistency.test.mjs` 的视图路径改 `registry.ts` / `view.tsx`，源码扫描集合改 `.ts`/`.tsx`。

**验收（实测）**

- 五连：`pnpm lint` 0 error / `pnpm typecheck` 退出 0 / `pnpm test:unit` 366 pass / `pnpm build` 364 modules /
  `pnpm test:smoke` 137 项断言全过。
- 前端已无 `.js/.jsx`；`allowJs` 撤销后 `tsc -b` 仍为 0，说明类型不是靠 `checkJs:false` 混过的。
- 行为口径：批次 8/9 用 `git diff -M --unified=0` 过滤「删除行里的 `className` 或中文可见文案」→ 0 命中。
- 真机走查（临时 home `D:\Temp\nxsk-p6-walk`，demo「字段样例」14 字段）：见 `behavior-parity.md` §5 的 P6 记录，
  全部场景控制台 error 0。

**已知既有缺陷（未修，保持 1:1）**

- `modules/sections/view.tsx` 的 `GroupRow.onMove` 实际只以 `'up'` 调用（`moveGroup` 的 `dir` 为可选）。
  重构前就是这个写法，P6 只补类型、不修行为，待单独裁决。

---

## 明确不动

- 加密格式、`maskValue` 规则、`kid` 语义；
- `store.json` 结构与迁移；
- 表格公式引擎（只做委托）；
- 模板合并 / 漂移比较；
- CLI flag 类型（`runtime/spec.ts` 的 `string|number|boolean|array|json|kv`，与字段类型无关）；
- 任何响应字段改名（`count/total`、`createdFields/newFields` 等，见 API 评估结论）。
