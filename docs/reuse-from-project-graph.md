# 从 project-graph 借鉴什么、不借鉴什么

> 调研对象：`D:\a_other\nxkvrepo\project-graph`（画布类应用，前端 TS + Rust 壳）。
> 只讨论**组件组织与扩展点**，不讨论画布功能。
> 每条都指到实际文件与行号；「nx-sk 落点」是本仓库的具体文件。

---

## 0. 一句话结论

project-graph 值得学的是**「按类型拆分文件 + 独立的渲染器/服务对象 + 单一自注册表」**这套骨架；
不值得学的是**中心分发文件里的 `instanceof` 长链、两套并存的扩展机制、`any` 型注册表、以及注册与类型双维护**。
nx-sk 的注册表方案正是「保留骨架、替换掉分发与注册的坏味道」。

---

## 1. 值得照搬

### 1.1 一种类型一个文件，集中分发表只做转交

- project-graph：`app/src/core/render/canvas2d/entityRenderer/` 下按类型分目录
  （`textNode/`、`svgNode/`、`urlNode/`、`section/`、`edge/concrete/`），每个渲染器是独立类；
  上层只负责「拿到实体 → 调用对应渲染器」。
- nx-sk 落点：
  - `src/shared/fields/<type>.ts`（一种字段一个行为体）
  - `src/web/frontend/components/fields/<type>.tsx`（一种字段一个控件）
  - `FIELD_BEHAVIOR` / `FIELD_CONTROLS` 只做 `Record` 查表，不写业务。
- 差别（也是改进）：它用 `instanceof` 链（见 §2.1），nx-sk 用 `Record<FieldType, …>`，漏一个实现编译期报错。

### 1.2 领域模型保持纯数据，交互状态不混进去

- project-graph：`app/src/core/stage/stageObject/README.md:3-9` 明确「纯类型与概念，不含业务」；
  交互态单独放在 `Controller.tsx:39,52-84`（`pressingKeySet` / `isMouseDown` / `mouseLocation`）
  与 `stageMouseInteractionCore.tsx:8-62`（hover 集合、惰性 flush）。
- nx-sk 落点：
  - 字段定义、条目值保持 JSON（`docs/design-intent.md` §1.2 已拒绝富血值对象）；
  - `ui.mask` / `ui.listW` / `ui.treeOpen` 等交互态留在 `store.jsx:7-15`，**不得**写进 `store.json`；
  - 条目草稿 `draft`、选中集合 `selected` 留在视图层（`modules/entries/view.jsx:39,51`）。
- 照搬要点：重构时**不要**为了"类型好看"把 `mask`、`selected`、`draft` 塞进领域模型。

### 1.3 扩展只改一处：插件式注册的正例

- project-graph：`extension-more-shape-entity/src/extension.ts:224-243,358-395` 在**一个文件**里
  注册了 circle / diamond / square 三种图形；对照内建类型要改约 10 处（见 §2.3）。
- nx-sk 落点：目标是把「加一种字段类型」压缩为
  ① `FIELD_TYPES` 加一项；② 写行为体；③ 写控件；④ 两处各注册一行。
  第 ① 步之后不补齐 ②③④ 就编译失败——这正是把「插件式只改一处」做成可验证的形态。

### 1.4 注册表要能「反查缺失」，而不只是「写入条目」

- project-graph：`packages/serializer/src/index.ts:29,44` 用装饰器副作用把类写进 `classes` Map；
  反序列化时查不到类直接 **throw**（同文件 127-130），不会静默降级。
- nx-sk 落点：
  - `assertFieldRegistry()`：键集双向、7 钩子齐全、三探针不抛；
  - `assertModuleRegistry()`：`readdirSync(src/modules)` 与 `MODULES` 双向比对（`refactor-plan.md` P3）。
- 照搬要点：缺注册必须是**响亮的失败**，不能靠默认值掩盖。

### 1.5 同一份命令清单服务多个入口

- project-graph：`KeyBindsUI.tsx:207-287` 维护唯一键位表，
  `CommandPalette.tsx:70-91` 直接复用同一列表执行 `kb.onPress(tab)`，不存在第二份命令表。
- nx-sk 落点：`boot.commands`（后端行动作清单）→ `CliHints`（`components/ui.jsx:131-148`），
  已经是「一处声明、多处分发」。P3 的 `MODULE_META` 要继续保持这一点：后端 module 与前端 tab 都从
  `src/shared/modules.ts` 取 `title/order`，禁止两边各写一份。

---

## 2. 不照搬

### 2.1 `instanceof` 长链 + 静默兜底

- 位置：`EntityRenderer.tsx:170-211`（178→198 的 9 段 `else if`），链尾**没有 else、没有 assertNever**，
  新类型漏写就是「不渲染、不报错」；`renderer.tsx:756-767` 对边同样三分支。
- 为什么不学：这正是 nx-sk 三次事故的同构版本（`docs/design-intent.md` §1.1）。
  多一个类型就要改中心文件，且漏改没有任何信号。
- nx-sk 做法：`Record<FieldType, …>` + 每类型独立文件，中心表不含业务、漏项编译报错。

### 2.2 两套扩展机制并存

- 位置：内建走 `instanceof` 链（`EntityRenderer.tsx`），扩展走 `ExtensionObjectRegistry.tsx:12-49`
  的 `Map`；两者能力、错误处理、注册方式都不同。
- 为什么不学：同一个问题两条路径，必然出现「内建能做的扩展不能做」。
- nx-sk 做法：**只有一个** `FIELD_BEHAVIOR` / `FIELD_CONTROLS`，内建与新增类型走同一条路。

### 2.3 注册与类型双维护

- 位置：`Project.tsx:528-607` 手写 79 行 `declare module` 服务属性；
  `loadAllServices.tsx:86-182` 手工 85 行 `project.loadService(...)`。
- 为什么不学：加一个服务要改两处，且两处不一致时 TS 不会报错。
- nx-sk 做法：模块元数据只在 `src/shared/modules.ts` 声明一次；
  后端 index `{ ...MODULE_META.<id>, actions }`，前端 `VIEWS` 取同一份 meta；
  目录与声明的一致性交给 `assertModuleRegistry()`，而不是再抄一份类型。

### 2.4 `any` 型注册表键

- 位置：`ExtensionObjectRegistry.tsx:13-15,21-30`（`Map<string, (data: any, …)>`），
  `ExtensionEntity.tsx:31,52` 同样是 `any`。
- 为什么不学：`any` 让注册表失去全部约束，等于回到字符串拼写。
- nx-sk 做法：键是字面量联合 `FieldType` / 模块 id；值有明确接口（`FieldBehavior`、`ActionSpec`）。

### 2.5 反射式自动注入

- 位置：`Controller.tsx:133-142` 用 `import.meta.glob("./concrete/*.tsx")`，
  按类名是否含 `Class` 猜属性名再注入。
- 为什么不学：隐式、IDE 不可跳转、改名即失联；与「注册表可静态审查」的目标相反。
- nx-sk 做法：前端 `VIEWS` 保持显式 `lazy(() => import('./modules/<id>/view.tsx'))`
  （Vite 静态分析的硬约束，见 `registry.js:10`），不做 glob 魔法。

### 2.6 全量快照撤销 / 巨型快捷键表

- 位置：`StageHistoryManager.tsx:44-60` 撤销靠 `serialize(project.stage)` 整存；
  `shortcutKeysRegister.tsx:382-4485` 是约 4000 行的单一键位数组，`onPress` 内联业务。
- 为什么不学：nx-sk 没有撤销需求；键盘行为只有控件内的少量局部处理
  （`fields/table.tsx:81-85`、`fields/source.tsx:365`、`entries/view.jsx:530`），
  引入全局命令总线属于过度设计。

### 2.7 把 UI 状态挂到领域对象上

- 位置：`StageObject.tsx:33-41` 的 `isSelected` 直接是实体字段。
- 为什么不学：选中态是视图关切，序列化时要么被写盘、要么要特殊排除。
- nx-sk 现状本来就是分开的（`selected` 在 `entries/view.jsx:51`），重构不要退化。

---

## 3. 画布专有、与本仓库无关

以下概念一律不引入：`Camera.tsx:11-18,36-45`（惯性/缩放）、
`renderer.tsx:909-926`（世界↔视图变换）、`renderer.tsx:192-194`（视口剔除）、
`Tab.tsx:121-144`（rAF 渲染循环）、`collisionBox/*` 与命中测试、
MSDF/SDF 字形图集、`render/3d` 与 `render/svg` 多后端。
nx-sk 是表单/列表型资源管理器，没有坐标、没有渲染循环、没有命中测试。

---

## 4. 对本次重构的直接约束

| 约束 | 来自 | 落到哪一步 |
| --- | --- | --- |
| 中心分发表只做查表，不含业务分支 | §1.1、§2.1 | P2：`FIELD_BEHAVIOR` / `FIELD_CONTROLS` |
| 一种类型一个文件，文件内只做这一种类型 | §1.1、§1.3 | P2：`shared/fields/<type>.ts`、`components/fields/<type>.tsx` |
| 交互态不进入数据模型 / 不落盘 | §1.2、§2.7 | P2/P3 全程；`store.jsx` 的 `ui` 保持原样 |
| 缺注册必须响亮失败 | §1.4 | P2 `assertFieldRegistry()`；P3 `assertModuleRegistry()` |
| 元数据只声明一次 | §1.5、§2.3 | P3：`src/shared/modules.ts` |
| 注册表键必须是有类型的联合，禁止 `any` | §2.4 | P2/P3 类型签名 |
| 不做 glob 自动注入、不建全局命令总线 | §2.5、§2.6 | P3：`VIEWS` 仍显式 `lazy` |

---

## 5. 与「使用体验不变」的关系

以上借鉴全部发生在**代码组织层**：文件拆分、查表方式、声明位置。
不涉及任何文案、布局、交互顺序、快捷键或空态。
P2/P3 的对账依据见 `docs/behavior-parity.md`。
