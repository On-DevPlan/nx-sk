# nx-sk 设计意图

> 这份文档回答「为什么这样设计」，不是变更记录。
> 后来者（包括 agent）改代码前先读它；与它冲突的实现，要么改实现，要么先改这份文档并说明理由。
>
> 配套文档：
> - `docs/behavior-parity.md`：行为等价清单（重构对账依据，硬约束）
> - `docs/reuse-from-project-graph.md`：组件解耦的借鉴与不借鉴（指到具体文件）
> - `docs/refactor-plan.md`：分阶段执行计划

---

## 0. 一句话

**类型是数据，行为是注册表。**

栏目、字段定义、条目值全部是 JSON 数据；所有「按类型分叉」的逻辑集中在注册表里，调用方不认识类型，只调用能力。
加一种字段类型 = 加一个行为体 + 加一个控件；其余出口自动跟随。加一个模块 = 加一个元数据条目 + 一个 action 清单。

---

## 1. 为什么是注册表，不是 if/else

### 1.1 三次真实事故（都在本仓库发生过）

| 事故 | 位置 | 根因 |
| --- | --- | --- |
| 导出时 `table` 的敏感列没被解密，密文出包后换机器永久不可解 | `src/modules/transfer/service.js` 的 `plainValues` 只处理 `entrylist` | 同一语义有 20 个分派点，漏一个不报错 |
| 面板遇到未知字段类型静默退化成单行文本框 | `src/web/frontend/components/fieldEditor.tsx`（P2-B 前的兜底 `return <input type="text">`，现已收进 `components/fields/index.ts` 的 `controlOf()`） | 前端没有「必须覆盖所有类型」的约束 |
| 顶层 `select` 写入不校验候选值，而表格单元格校验 | `entries/service.js` 的 `normalizeValue` 没有 `select` 分支 | 两套并行类型系统各自演化 |

共同点：**分派点数量 × 没有穷举检查**。类型系统能解决一半，注册表能解决另一半，两者缺一不可：

- 注册表把「漏一个分派点」变成「结构上不可能」——调用方遍历所有类型，而不是自己判断类型；
- `Record<FieldType, X>` 把「漏一个实现」变成编译错误。

### 1.2 明确拒绝的做法

- **富血值对象**（`TableValue` 类实例）：值必须能无损进出 JSON、能在加密边界上原样回传、能被 `section dump` 直读。类实例三个都破坏。
- **动态 `registerField()` 插件 API**：字段类型是封闭集合（15 种），静态对象字面量可被静态分析、可被编译期穷举、不依赖 import 顺序。
- **为内部消费 codegen JSON Schema**：`validateFieldDef` 已是权威校验，`section dump` 已是 agent 可读结构；再生成一份只会产生第二个真相。

---

## 2. 不变量（每条都必须可被机器检验）

| # | 不变量 | 检验方式 |
| --- | --- | --- |
| I1 | 每种 `FieldType` 在 `FIELD_BEHAVIOR` 中恰好有一项，且 8 个钩子齐全 | TS `Record<FieldType, FieldBehavior>` + `assertFieldRegistry()` |
| I2 | 每种 `FieldType` 在前端 `FIELD_CONTROLS` 中恰好有一个控件 | TS `Record<FieldType, Control>` |
| I3 | 每种 `FieldType` 在 `FIELD_SEAL` 中有确定项（可显式 `null`，`null` 表示「没有类型级封装逻辑」） | TS `Record<FieldType, SealHook \| null>`（P2-B 已落地） |
| I4 | `section.fields` 的每个 key 在 `serializeEntry` 输出里恰好出现一次 | 契约测试：键集相等 |
| I5 | 对每种类型跑 `coerce → seal → reveal → dump` 不抛异常 | 契约测试：类型遍历往返 |
| I6 | 后端注册的模块目录集合 = `MODULES` 声明集合 = 前端 `VIEWS` 目录集合 | 启动断言 + `consistency.test.mjs` |
| I7 | 任何模块不得自行判断字段类型（`x.type === '...'`） | eslint `no-restricted-syntax` |
| I8 | 前端不得 import `src/core/**` 或 `src/modules/**` | eslint `no-restricted-imports`（对 `.ts/.tsx` 同样生效） |
| I9 | 字段定义与条目值只能是 JSON（无类实例、无函数、无 `undefined`） | 契约测试：`JSON.stringify` 往返相等 |

---

## 3. 字段类型：加一种要做什么

### 3.1 目录形态

```
src/shared/fields/types.ts                      # 词汇表 + 契约（**零依赖**，前后端共用）
src/core/fields/behaviors/<type>.ts             # 一种类型一个文件：行为实现（服务端）
src/core/fields/behaviors/common.ts             # 多类型完全相同的零件（不塞差异）
src/core/fields/registry.ts                     # FIELD_BEHAVIOR: Record<FieldType, FieldBehavior>
src/core/fields/seal/index.ts                   # FIELD_SEAL: Record<FieldType, SealHook | null>
src/core/fields/seal/<type>.ts                  # 需要 vault 密钥的封装实现（entrylist / table / secret）
src/web/frontend/components/fields/<type>.tsx   # 一种类型一个控件
src/web/frontend/components/fields/index.ts     # FIELD_CONTROLS: Record<FieldType, Control>
```

**过渡态声明（已结束，留作验收依据）**：P2-B 时 `fields/source.tsx` 与 `fields/table.tsx` 只是
**注册入口**——控件契约在这里，实现转发给 `sourcePanel.jsx` / `tableField.jsx`。**P3.5 已完成物理搬迁**：
两个控件文件现已自包含，`sourcePanel.jsx` / `tableField.jsx` 已删除（无其它调用方），包装层不存在了。
本节以下 4 条就是当时的验收标准，后续任何「把大组件先包一层」的过渡态都必须照此单独成阶段。

P3.5 的验收标准（全部满足才算搬完）：

1. `fields/<type>.tsx` 自包含：不再 import `../sourcePanel.jsx` / `../tableField.jsx` 的实现
   （表格引擎 `shared/table.js` 这类零依赖纯函数除外）；原文件若仍被别处使用，只保留非控件部分。
2. 行为等价清单 §2.C 中 `source` / `table` 两行逐条仍然成立，且补齐被搬组件的**全部**可见文案、
   交互与布局条目（source 的引用/文本两种形态、Esc 关闭、Ctrl+Enter 入袋；table 的列设置、单元格编辑、
   统计行、公式报错、行拖拽、增删行列）。
3. 机械对账：基线可见中文片段**缺失 0 段**；组件内 `className` 字面量集合与基线一致。
4. `lint / typecheck / unit / build / smoke` 全绿，并附真机页面走查结论（有差异先停下说明，不自行对齐）。

### 3.1.1 `shared` / `core` 边界（硬规则，不是建议）

**`shared` 只放零依赖的词汇表与契约**：字段类型常量与标签、`FieldDef` / `FieldValue` / 钩子签名、
以及不碰 IO 的纯函数（如 `shared/table.ts` 的单元格引擎）。`shared` 内**禁止** import `core/`、`modules/`、
`runtime/`、`node:*`，也禁止触碰 `badInput`、`fs`、`crypto`、vault 密钥、store 读写。

**任何需要 `badInput` / 原始资料归一（`core/source`）/ 表格强转与列校验（`core/fields/behaviors/table.ts`）/
vault 密钥的实现，一律放在 `core`**（`core/fields/behaviors/`、`core/fields/seal/`）。理由：
`tsconfig.web.json` 会把 `src/shared/**` 全量纳入浏览器构建，那里一旦拖进 fs/crypto，面板直接构建失败；
而这类实现必然要报错文案、要读 `source` / `table` 的规则，放在 `shared` 只会把服务端语义带进浏览器。

**前端只消费 `shared`**：

- 类型、标签、`FieldDef` / `FieldValue` 形状、控件 props 契约 —— 从 `shared/fields/types.ts` 取；
- 前端确实需要的纯计算（如表格合计 `computeTable`、Markdown 图片引用解析）—— 以零依赖纯函数形式下沉到
  `shared/`，或者在 `shared` 已存在时直接复用；
- 需要密钥、store、字段写入校验、附件引用扫描的能力 —— **只能经 HTTP API 由后端提供**，前端禁止 import
  `core/**` 或 `modules/**`（eslint `no-restricted-imports` 对 `.ts/.tsx` 生效；P6 起前端已无 `.js/.jsx`）。

这条边界在 P2-B / P3 / P6 同样适用：不许因为「前端顺手要用」就把 `badInput`、vault、source 归一搬进 `shared`。
判断方法很简单——**把 `shared` 单独交给浏览器打包，是否零 Node 依赖编译通过**；不通过就是放错了层。

`FIELD_TYPES` 必须是**唯一的类型清单**。任何地方需要「所有类型」，都从它派生：

```ts
export const FIELD_TYPES = ['text', 'textarea', 'number', /* ... */] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
```

唯一的例外是 `TABLE_CELL_TYPES`：它**保留显式数组**，因为它的顺序会被 `shared/table.ts` 的报错
`join(' / ')` 直接给用户看，改顺序等于改可见文案。防漂移的方式改成「集合相等」测试
（`tests/unit/fields.test.ts`）：`FIELD_TYPES.filter((t) => FIELD_BEHAVIOR[t].cell)` 与它必须是同一集合。

### 3.2 生命周期钩子契约

签名里的 `def` 是字段定义；返回 `unknown` 是为了让历史数据（`any` 形状）能过，类型收窄在调用点做。

| 钩子 | 签名 | 调用时机 | 失败语义 | 纯度 |
| --- | --- | --- | --- | --- |
| `normalizeDef` | `(raw, def) => void` | 保存/合并字段定义、模板实例化 | **拒绝**：抛 `badInput`，字典不写入 | 纯（会就地补 `def`，保留旧 `normalizeRows` 的行为） |
| `coerce` | `(def, raw) => unknown` | 写入强转、导入、CLI `--set` | **拒绝写入**：抛 `badInput`（表格逐格问题汇总后一次性报） | 纯、无 IO |
| `reveal` | `(def, stored, opts) => unknown` | `serializeEntry` / `dumpSection` / 导出 | **降级**：子密文走 `displaySensitive`，绝不抛 | 纯（`decrypt` 由调用方注入） |
| `refs` | `(def, value, opts?) => string[]` | 附件反查、导出打包 | **降级**：坏 item 跳过，不抛 | **必须纯** |
| `remap` | `(def, value, idMap) => unknown` | 导入换 id | 纯映射，不抛 | 纯 |
| `format` | `(def, value, ctx) => string[] \| null` | CLI 渲染、dump 摘要 | `null` = 交给通用标量/数组兜底；不抛 | 纯 |
| `sensitive` | `(def) => boolean` | 查看器、打码、序列化 | 不抛 | 纯 |
| `subFields` | `(def) => Array<{ key, label, sensitive }>` | 统一 `entrylist` 与 `table` 的「列」概念 | 不抛 | 纯 |

`cell: boolean` 是能力声明（能不能当表格列），不是钩子。

**运行时兜底**：`behaviorOf(type)` 对未知 `type` 退到 `text`，与重构前「未知类型走通用文本分支」的
可见行为一致。这不是漏实现的许可——漏实现由 `Record` 在 `tsc` 阶段拦住（P2-A 已实测报错）。

### 3.3 加一种字段类型的清单

1. `src/shared/fields/types.ts` 的 `FIELD_TYPES` 加一项（同时更新 `FieldDef` 判别联合与 `FieldValue`）；
2. `src/core/fields/behaviors/<type>.ts` 写行为体（8 个钩子一个都不能少）；
3. 在 `src/core/fields/registry.ts` 的 `FIELD_BEHAVIOR` 注册一行；
4. 若需要密钥/文件系统，写 `src/core/fields/seal/<type>.ts` 并在 `FIELD_SEAL` 注册（否则显式 `null`）；
5. `src/web/frontend/components/fields/<type>.tsx` 写控件并在 `FIELD_CONTROLS` 注册；
6. `src/shared/blockLayout.ts` 的 `WIDE_TYPES` / `DEFAULT_PX` 与 `components/fieldEditor.tsx` 的 wide 清单（两处都要改）；
7. demo 种子（`src/core/fields.ts`）补一条样例值，契约测试会遍历全部类型；
8. 在 `tests/unit/fields.test.ts` 补 `coerce` / `format` 断言，按 B03 同步三份文档。

第 1 步加完，第 3/4/5 步不补就**编译不过**。这是设计目标，不是副作用。

---

## 4. 模块：加一个要做什么

### 4.1 模块声明：目录即唯一声明

TS 不能在编译期枚举文件系统，所以模块的「存在性」只能靠装载期/测试期断言。但这不妨碍把声明点收到一个：

- **唯一声明 = `src/modules/<id>/index.ts` 的 default 导出**；`id` 必须等于目录名。
- `src/runtime/registry.ts` 用 `loadModules()` 扫描目录装载，**不再维护 import 清单/数组**——
  手写的第二份清单正是「加了目录、忘了登记，模块静默消失」的来源。
- 前端 `VIEWS` 仍是视图侧的唯一登记处（后端模块不声明视图，这是既有结论）；新增面板仍要在
  `VIEWS` 登记一行，并由 `consistency.test.mjs` 对账目录与登记。

```
src/modules/<id>/index.ts    # 唯一声明：id（=目录名）/ title / order / actions
src/runtime/module-registry.ts # 目录扫描 + 形状断言（id/title/order/重复）
src/runtime/registry.ts       # MODULES = loadModules() + action 级自检
src/web/frontend/registry.ts  # VIEWS：视图侧声明（与后端模块是否同名无关，export 就是纯前端视图）
```

### 4.2 三重断言

1. **启动期**：`loadModules()` 逐目录断言——缺 `index.ts`（构建产物为 `index.js`）、加载失败、`id` 与目录名不一致、
   缺 `title` / `order`、`id` 重复，全部在进程启动时抛；
2. **启动期**：`selfCheckActions` 查 action id / CLI 路径 / HTTP 路由重复（既有）；
3. **测试期**：`module-registry.test.mjs` 用临时目录喂「故意写坏」的模块（缺 index / id 错位 /
   缺 title·order / 重复 id）验证断言真的会红；`consistency.test.mjs` 继续查目录 ↔ `MODULES` ↔
   前端 `VIEWS`、视图里的 `/api` 字面量都能在路由表找到。

### 4.3 加一个模块的清单

1. 建 `src/modules/<id>/`，写 `index.ts`（`id` 跟目录同名，`title / order / actions`）——**仅此一步**，
   注册表自动发现；eslint 的模块互依禁列也从 `src/modules` 派生，不需要手改。
2. 需要面板：`src/web/frontend/modules/<id>/view.tsx` + `VIEWS` 登记一行。
3. 需要给 agent 用：更新 `assets/nx-sk/` 的命令文档。

漏第 1 步（目录在、`index.ts` 不在）→ 启动即抛；第 2 步是**显式决定**，不是遗忘——后端模块可以没有面板。

---

## 5. 禁止绕过注册表

以下位置**不允许**出现「按字段类型判断」的代码：

- `src/modules/**`（service 层）
- `src/core/**`（render / export / vault / attachments）
- `src/web/frontend/**`（控件之外）

允许的唯一位置：注册表自身、`src/shared/table.ts` 的单元格引擎内部。

三道防线：

1. **eslint**：`no-restricted-syntax` 禁止 `MemberExpression[property.name='type']` 出现在 `BinaryExpression[operator='===']` 的任一侧，作用域见上；
2. **eslint**：前后端边界规则必须覆盖 `ts/tsx`（否则改名即失守）；
3. **测试**：`tests/unit/no-bypass.test.ts` 扫描源码，命中即失败（allowlist 显式列出注册表文件）。

---

## 6. 怎么防止长期腐坏

| 腐坏方式 | 防线 |
| --- | --- |
| 新增类型漏实现 | 编译期 `Record` 穷举 |
| 新增类型漏某个出口（导出/索引/重映射） | 调用方遍历 + 契约测试的全类型往返 |
| 新增模块漏注册 | 启动断言 + 目录对账 |
| 有人图快写 `if (def.type === ...)` | eslint + 源码扫描测试 |
| 前端手抄一份类型清单 | 类型从 `shared` 的 `const` 派生；测试断言 bootstrap 的 `fieldTypes` 与常量深相等 |
| 契约（响应结构）漂移 | `tests/unit/contract.test.ts` 钉住面板依赖的键 |
| 文档过时 | 文档只写「意图 + 清单」，命令/字段细节由代码与 `section dump` 提供；测试禁止 skill 文档出现 HTTP 路由 |

**每次加类型/模块，先问：这次改动让上面哪一条防线变弱了？** 如果答案是「没有」，就可以合。

---

## 7. TypeScript 运行方式（已定稿）

### 7.1 决定

**后端以 `dist/**/*.js` 发布运行（`tsc -p tsconfig.build.json`，`.ts` 导入后缀在 emit 时改写成 `.js`）；
测试仍直接跑 `src/**/*.ts`，前端由 Vite 处理（P6 起前端源码全部是 `.ts/.tsx`）。**

### 7.2 理由

1. **`node_modules` 下的 `.ts` 跑不起来**：Node 明确拒绝（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），
   所以「发布 `.ts` 直跑」只在仓库内 / `npm link` 成立，`npm i -g` / `npx` 必然启动失败。发布形态必须给纯 JS。
2. **测试不 build**：`node --test` 在 Node ≥22.18 直接执行 `*.test.ts`，失败信息指向源文件行号；
   这是开发/测试的要求，与使用者无关。
3. **只保留一条运行时路径**：`bin/nx-sk.mjs` 只 import `dist/runtime/cli.js`，仓库内也不再跑 `src/*.ts`——
   避免「本地好、装上就炸」两套行为。
4. **资源路径不变**：`assets/`、`PUBLIC_DIR` 都按 `import.meta.url` 的相对深度推导，`src/` 与 `dist/` 两种布局自洽。

### 7.3 对发布形态的影响

| 项 | 变化 |
| --- | --- |
| `engines.node` | 仍是 `>=18.17`：运行时是 `dist/` 的纯 JS，不要求 TypeScript 能力 |
| `bin` | 仍是 `bin/nx-sk.mjs`：只 `import('../dist/runtime/cli.js')`；dist 缺失时提示先 `pnpm build` |
| 发布产物 | `pnpm build` 先 `tsc -p tsconfig.build.json` 产出 `dist/**/*.js`（后缀自动改写），`files` = `bin/ dist/ assets/ README CHANGELOG LICENSE` |
| 安装方式 | `npx nx-sk` / `npm i -g` 跑的都是 dist；Node ≥22.18 只是开发/测试（`node --test` 直跑 `.ts`）的要求 |
| 前端 | 不变：Vite 以 `src/web/frontend` 为 root，构建到 `dist/web/public/`（`vite.config.js` 的 `outDir: '../../../dist/web/public'`） |

### 7.4 因此必须接受的语法约束

由 `erasableSyntaxOnly` + `verbatimModuleSyntax` 在编译期强制，不允许「先写、运行时再炸」：

- 禁 `enum`（用 `as const` 对象 + 联合类型）；
- 禁 `namespace`、`import =`、构造函数参数属性；
- 类型导入必须 `import type`；
- 相对导入必须带真实扩展名（`.ts` / `.tsx`）；
- 不吃装饰器、无运行时类型元数据。

这几条与第 1 节「类型是数据」的方向一致：`const` 对象比 `enum` 更适合做注册表。

### 7.5 被否决的方案

- **`tsc` 产出 `dist/` + `bin` 指向 dist**：多一份产物、多一次构建、dev 循环需要额外 watch/loader，收益仅是保住 Node 18；而 Node 18 已 EOL。
- **`--experimental-strip-types` 兼容旧版**：该 flag 只在 22.6–22.17 存在，18/20 无论如何不支持，等于没保住兼容性，只增加启动噪音。
- **后端继续 JS + JSDoc**：`Record` 穷举与 `erasableSyntaxOnly` 这类约束都拿不到，等于放弃本次重构的核心收益。
