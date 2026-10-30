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
| S3 | 全域拖拽 + Notion 式壳（FlexLayout + dnd-kit + 目录树 + 容器块 + 看板） | ⬜ 未开始 |
| S4 | 块级 AI（AI Bar + pending 落盘 + 冲突检测） | ⬜ 未开始 |
| S5 | 兼容与收尾（包版本字段 + 降级提示 + 文档） | ⬜ 未开始 |

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
