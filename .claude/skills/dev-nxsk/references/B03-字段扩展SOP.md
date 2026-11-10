---
name: B03-字段扩展SOP
description: 按步骤给 nx-sk 新增一种字段类型（0.28.0 起的注册表架构）——shared 词汇表、core/fields/behaviors 的八个钩子、FIELD_SEAL 封装、前端 FIELD_CONTROLS、表格单元格分支、blockLayout 默认尺寸、契约/往返测试与三份文档的同步点。当要「加一个 field 类型」、照 checklist 核对、或排查「type 加了但启动就崩 / 面板退化成文本框 / 敏感值明文落盘」时读它。
---

# B03 — 扩展一个字段类型的 SOP

> 架构前提：0.28.0 起字段是**三张注册表**，不是 if/else。
> `tsc` 只保证「键没漏」，**钩子语义、封装、控件行为、表格分支都靠这份 SOP 与测试兜**。
> 所有路径已按 0.28.0 代码逐条核对（2026-11-10）。

## 0. 先判：该不该新增 type

| 需求 | 做法 |
| --- | --- |
| 只是候选值/单位不同 | 复用 `text` / `number` + `options` / `hint`，别加 type |
| 名称·链接·账号的多行 | `entrylist` |
| 带类型/公式/统计的二维表 | `table` |
| 交互形态本质不同（评分、色板、坐标、关系引用） | 才新增 type |

> 新增 type 会同时改：store 里已有栏目的字段字典、面板下拉顺序、表格列可选类型、以及所有读出口。
> 能用现成类型组合出来的，不要加。

## 1. 词汇表：`src/shared/fields/types.ts`（第一处，必改）

```ts
// ① 追加到尾部——顺序是可见行为（bootstrap 下发 + 面板下拉顺序），不要插队
export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags',
  'entrylist', 'table', 'source', 'secret', 'file', 'md', 'rating',
] as const;

// ② 中文标签（Record 漏一个键 tsc 就红）
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  /* …既有… */ rating: '评分（1-5）',
};

// ③ 定义形状：无结构 → 并入 ScalarFieldDef 的 type 联合；
//    有结构 → 新建 interface 并入 FieldDef 联合（与 EntryListFieldDef / TableFieldDef 同构）
export interface RatingFieldDef extends FieldDefBase {
  type: 'rating';
  max?: number;
}
export type FieldDef = ScalarFieldDef | EntryListFieldDef | TableFieldDef | RatingFieldDef;

// ④ 新的值形态（对象/数组）追加到 FieldValue 联合，否则读取侧类型对不上
```

- 本文件必须**零依赖**（浏览器也打包它）：不许 `import fs/crypto`。
- 有结构就**必须在 `FieldDef` 里有自己的 interface**，不要往 `ScalarFieldDef` 里塞 `columns` 之类的可选键。

## 2. 后端行为：`src/core/fields/registry.ts` + `behaviors/<type>.ts`

新建 `src/core/fields/behaviors/rating.ts`，八个钩子**全部实现**（可复用 `./common.ts`）：

```ts
import { badInput } from '../../errors.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields } from './common.ts';

export const ratingBehavior: FieldBehavior = {
  cell: false,                            // 能否当表格列，见第 5 节
  normalizeDef: () => {},                 // 定义校验：有结构/约束才写，非法直接 badInput
  coerce(def, raw) {                      // 写入强转：抛错文案要带 def.label
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 1 || n > 5) throw badInput(`字段「${def.label}」是 1-5 的评分`);
    return Math.round(n);
  },
  reveal: identityReveal,                 // 读出口；有子密文才自己实现
  refs: noRefs,                           // 引用哪些附件 id
  remap: identityRemap,                   // 导入时附件 id 重映射
  format: () => null,                     // null = 走通用兜底；要人读文本才返回 string[]
  sensitive: isSensitiveDef,              // 顶层是否按密文处理
  subFields: noSubFields,                 // 清单类的子列（密文判据），标量返回 []
};
```

注册（两行）：

```ts
// src/core/fields/registry.ts
import { ratingBehavior } from './behaviors/rating.ts';
export const FIELD_BEHAVIOR: Record<FieldType, FieldBehavior> = { /* … */ rating: ratingBehavior };
```

- `registry.ts` 末尾有 `assertFieldRegistry()` 自调用：键集不一致/缺钩子/空值探针抛错 → **进程直接起不来**。
- 不要用 `as any` 绕过 `Record`；`behaviorOf()` 的 text 兜底只服务历史脏数据，不是漏实现的许可。

## 3. 写入封装：`src/core/fields/seal/index.ts`（必改，一行）

`FIELD_SEAL: Record<FieldType, SealHook | null>`，键必须存在：

| 新类型 | 取值 | 含义 |
| --- | --- | --- |
| 标量，可能被标 `sensitive: true` | `null` | 走 entries 的 `sealScalar` 通用分支 |
| 永远是密文 | `sealScalar` | 同 `secret` |
| 数组/对象，内部有敏感子值 | 新写 `src/core/fields/seal/<type>.ts` | 逐格/逐行封，参考 `seal/entrylist.ts` / `seal/table.ts` |

漏这一步：`tsc` 会红（`Record` 缺键）；若你强行补 `null` 但类型其实有敏感子值，**敏感值会明文落盘且没有任何报错**。

## 4. 面板控件：`components/fields/<type>.tsx` + `index.ts`

```tsx
// src/web/frontend/components/fields/rating.tsx
import type { ControlProps } from './types.ts';
export function RatingControl({ value, onChange }: ControlProps) {
  /* 根节点不要固定高度；值可能来自历史数据，宽松读（Number(value)） */
}
```

```ts
// src/web/frontend/components/fields/index.ts
import { RatingControl } from './rating.tsx';
export const FIELD_CONTROLS: Record<FieldType, Control> = { /* … */ rating: RatingControl };
```

- 契约只有 `{ def, value, onChange, disabled?, ctx? }`（`./types.ts`），不要给单个控件加私有必填 prop。
- 敏感字段要跟随 `ui.mask`；多值/附件复用现有控件的交互范式。

## 5. 表格单元格分支（仅当 `cell: true`）

六处（表与函数混列），缺一不可：

1. `behaviors/<type>.ts` 的 `cell: true`
2. `src/shared/table.ts:24` 的 `TABLE_CELL_TYPES` **追加到末尾**（报错文案会 `join(' / ')` 给用户看，顺序不能变）
3. `src/shared/table.ts` 的 `coerceCell()` 加分支——**永不抛**，坏值返回 `{ value, error }`
4. `looseValue()` 决定公式里的空格子语义（number→0 / bool→false / tags→[] / 其余 ''），漏了公式会得 `NaN`
5. `formatCellValue()` 决定表格在 CLI/导出里的显示
6. `src/web/frontend/components/fields/table.tsx:58` 的 `TYPE_LABEL` 补中文名（漏了列设置里显示英文 id）

`tests/unit/fields.test.ts` 有一条断言：`FIELD_TYPES.filter(cell).sort()` 必须等于 `TABLE_CELL_TYPES.sort()`；
只改一处会红。列定义本身在 `sanitizeColumns()` 里按 `TABLE_CELL_TYPES` 校验。

## 6. 版式默认值：**两处**都要改

```ts
// src/shared/blockLayout.ts
const WIDE_TYPES = new Set([..., 'rating']);   // 横向多元素 / 表格 / 图片 / 多行 → 加
const DEFAULT_PX: Record<string, number> = { ..., rating: 66 };  // 落不到就退回 text 高度

// src/web/frontend/components/fieldEditor.tsx（第二份 wide 清单，容易漏）
className={`field ${['textarea', 'file', 'md', 'entrylist', 'table', 'source', 'rating'].includes(def.type) ? 'wide' : ''}`}
```

漏了不会报错：高度偏大/偏小，或宽控件挤在半宽块里换行；只改一处则 grid 版式与老的单列表单
（`fieldEditor.tsx`）wide 判定不一致——同一字段在两个入口一个半宽一个整行。

## 7. 测试：钉住「往返」，不只钉注册

改/加这几处（按成本从低到高）：

| 文件 | 加什么 |
| --- | --- |
| `tests/unit/fields.test.ts` | `coerce` 合法/非法/空；`format` 人读；`sensitive`/`subFields` 判据 |
| `tests/unit/contract.test.ts` | 已自动遍历 `FIELD_TYPES`：label 齐全、demo 栏目覆盖全部类型（新类型要进 demo 种子） |
| 新建 `tests/unit/<type>.test.mjs` | `section update --add-field` → `entry add --set` → `entry get --json` → `section dump --json` 往返形状不变 |
| `tests/smoke.mjs` | CLI 写一条 + HTTP 读一条（两条出口都要覆盖） |

> **demo 种子的值必须写成 `coerce` 的输出形状**（包括 `coerce` 自动补的 id / 默认键）。
> `contract.test.ts` 的「全类型往返」拿种子值走一遍 `addEntry` 再逐键 `deepEqual`：
> 种子里少了 `id`、多了不会被保留的键、或 combo 顺序与归一结果不同，都会红。
> 快捷字符串（如 `"Ctrl+R"`）**不能**直接写进种子——先归一再抄结果。

```bash
cd D:/a_js/js_proj/nx-sk
node --test tests/unit/fields.test.ts        # 注册表 + 强转
node --test tests/unit/<type>.test.mjs       # 往返
node bin/nx-sk.mjs section dump demo --json  # 人工复核 values 形状
pnpm test                                    # 五连：lint / typecheck / build / smoke / unit
```

## 8. 文档同步（漏了不算完成）

| 文件 | 改什么 |
| --- | --- |
| `docs/design-intent.md` | 字段注册表与「前端只消费 shared」的边界描述 |
| `docs/behavior-parity.md` | 新控件的行为/文案对账行；走查记录补一条 |
| `assets/nx-sk/references/15-special-fields.md` | **用户向**：类型是什么、值形状、CLI 怎么写 |
| `CHANGELOG.md` | 用户可见变化 |

`tests/unit/consistency.test.mjs` 会校验文档里出现的命令真实存在；不要在文档里编命令。

## 9. Checklist（漏一步会怎样）

- [ ] `FIELD_TYPES` 追加到尾部 → 漏：`--add-field` 报「type 非法」；面板下拉无此项
- [ ] `FIELD_TYPE_LABELS` 加键 → 漏：`tsc` 红（Record）
- [ ] `FieldDef` 联合（有结构必须新建 interface）→ 漏：结构键进不了类型，读取侧只能 `any`
- [ ] `FieldValue` 加值形态 → 漏：读出口类型不符，容易顺手 `as any`
- [ ] `behaviors/<type>.ts` 八钩子 + `FIELD_BEHAVIOR` 一行 → 漏：`assertFieldRegistry()` 启动即抛，CLI/面板全起不来
- [ ] `coerce` 覆盖非法输入 → 漏：脏值静默入库，排序/公式错
- [ ] `format` → 漏：`entry get` / `section dump` 显示 `[object Object]` 或空
- [ ] `FIELD_SEAL` 加键（有子密文就写 hook）→ 漏键：`tsc` 红；该写 hook 却填 `null`：**敏感值明文落盘**
- [ ] `subFields` / `sensitive` 判据 → 漏：vault 不加密子值、`--reveal` 不打码
- [ ] `refs` → 漏：附件中心「谁引用它」查不到；清理未引用附件会误删；导出漏文件
- [ ] `remap` → 漏：导入到新库后附件 id 指向旧库
- [ ] `FIELD_CONTROLS` + `<type>.tsx` → 漏：`tsc` 红；用 `as` 绕过则面板静默退化成单行文本
- [ ] 表格 6 处（若 `cell`）→ 漏：`fields.test.ts` 红，或列设置下拉出现非法 type
- [ ] `blockLayout` 两处 + `fieldEditor.tsx` 的 wide 清单 → 漏：不报错，只是难看/挤或两个入口宽窄不一致
- [ ] 单测 + smoke 两条出口 → 漏：CLI 能写面板不能读这类分叉不会有人发现
- [ ] 三份文档 + CHANGELOG → 漏：用户向文档与实现对不上

## 10. 已知坑（按踩中的概率排序）

1. **`controlOf()` 的兜底会掩盖漏注册**：`components/fields/index.ts` 对未知 type 返回 `TextControl`，
   面板照常渲染、不报错。看到「新字段显示成单行文本」先查 `FIELD_CONTROLS`，别查 CSS。
2. **`FIELD_SEAL` 填 `null` ≠ 安全**：`null` 表示「没有类型级封装，走标量分支」。
   数组/对象类型内部若有敏感子值，必须写自己的 seal hook；否则明文落盘且无异常。
3. **`assertFieldRegistry()` 在模块加载时执行**：注册表少了键，`nx-sk` 任何命令都在 import 阶段崩，
   报错是「字段注册表与 FIELD_TYPES 不一致」。这不是 store 坏了，别去修数据。
4. **`behaviorOf()` / `controlOf()` 的兜底不是兼容承诺**：它们只防历史脏数据；新代码路径上漏实现，测试要能红。
5. **`FIELD_TYPES` 顺序是可见行为**：bootstrap 原样下发、下拉框照此排序；只许追加。
6. **`TABLE_CELL_TYPES` 顺序也是可见行为**：`sanitizeColumns` 的报错会把数组 join 给用户看。
7. **序列化兼容**：不要改既有类型已落盘的形状；真要改，先在 `src/core/store.ts` 的 `normalize*` 里读时兼容，
   再补一条「老 store 能读」的单测（`tests/unit/spec.test.mjs` 有快照范式）。
8. **CLI/HTTP 不需要各写一份**：两者共用 action 的 `run`；但 `format()` 决定 CLI 文本，
   `inferFieldType()`（`src/modules/entries/service.ts`）决定「写一个没登记的键」自动建成什么类型——
   新类型若期望被自动推断，要显式加分支。

## 11. 最小验证命令

```bash
cd D:/a_js/js_proj/nx-sk
pnpm typecheck && node --test tests/unit/fields.test.ts && node tests/smoke.mjs
pnpm test
```
