---
name: dev-nxsk
description: nx-sk 的开发知识库（仓库 D:/a_js/js_proj/nx-sk）。讲清「栏目/分组/字段/条目」的概念与数据模型、模块与 action 的工程契约与扩展方式，以及正文块版式（react-grid-layout）的拖拽实现、解耦与保存链。当要改 nx-sk 的数据形状或 store、加模块 / action / 面板 tab / 字段类型、调块布局与拖拽手感、排查「面板与 CLI 不一致」「改了字段不生效」「版式拖不动」时才用；不适用于只查数据怎么填（那是 assets/nx-sk 这个用户向 skill 的职责）。
---

# dev-nxsk — nx-sk 开发知识库

> **本 skill 仅适用于 nx-sk**（仓库根 `D:/a_js/js_proj/nx-sk`，Node ≥ 18.17，ESM，React 18 + Vite 6）。
> 下面所有路径都是仓库内的真实路径（相对仓库根），模块名、action id、字段类型都是真实值——
> 不要把它们当成占位符套到别的项目上。

## 这个项目一句话

**本机个人资源管理器**：`store.json` 里按「栏目 → 分组 → 字段 → 条目」存个人信息与凭据；
**CLI 与 Web 面板是同一套业务**（同一份 action 声明同时编译出命令行与 HTTP 路由），
敏感字段密文落盘（AES-256-GCM），正文用块面板（一个分组 = 一块面板、一个字段 = 一个块）。

## 触发条件

- 要改**数据形状 / store 结构 / 字段类型 / 版式 JSON**
- 要加**模块 / action / 面板 tab / CLI 命令**
- 要动**正文块布局、拖拽、宽度调整、内容驱动高度**
- 排查这些现象：「面板和 CLI 行为不一致」「改完字段保存不上」「新增字段面板不显示」
  「版式拖不动 / 拖拽卡手」「一致性测试红了」「加模块后启动就崩」

## 序列总览

| 序列 | 回答什么 | 成员 |
| --- | --- | --- |
| **A · 项目本身** | 这个项目是什么、代码怎么分层、往哪儿加东西 | [[A01-概念与数据模型]] · [[A02-模块与工程契约]] · [[A03-扩展方式]] |
| **B · 正文与拖拽** | 块版式与拖拽怎么实现、怎么加一个新字段类型 | [[B01-拖拽与版式实现]] · [[B02-扩展新字段类型]] |

## 路由表（先按信号选 ref）

| 你要做的事 / 看到的信号 | 读 |
| --- | --- |
| 「栏目 / 分组 / 字段 / 条目 / values 是什么关系」「store.json 长什么样」「改了字段为什么不生效」 | [[A01-概念与数据模型]] |
| 「action 怎么声明」「为什么加了模块启动就崩」「面板 tab 从哪来」「一致性测试红了」 | [[A02-模块与工程契约]] |
| 「加一条 CLI 命令」「加一个面板页」「加一次 store 版本迁移」 | [[A03-扩展方式]] |
| 「块怎么排的」「高度为什么跟内容」「版式存在哪」「拖拽为什么这样设计 / 卡手」 | [[B01-拖拽与版式实现]] |
| 「加一个字段类型」「新控件怎么接进来」「type 加完面板不渲染」 | [[B02-扩展新字段类型]] |

## 开工前先跑这三条

```bash
cd D:/a_js/js_proj/nx-sk
node bin/nx-sk.mjs bootstrap --json          # 版本 / 存储路径 / 栏目 / 命令表（零知识起手）
node bin/nx-sk.mjs section dump <栏目> --json # 字段字典 + 条目 + 已对齐的版式
node --test && node tests/smoke.mjs           # 单测 + 端到端冒烟（都是临时 HOME，不碰真实数据）
```

改动前的完整门禁（提交前必须全绿）：

```bash
npx eslint . && npx vite build && node --test && node tests/smoke.mjs
```

## 四条硬约束（违反必红）

1. **能力只写在 action 里**：`src/modules/<id>/index.js` 的 `actions[]` 同时声明 `cli` 与 `http`，
   CLI 与面板共用同一份 `run`/`render`。**不许在 `view.jsx` 里另写一套 `/api` 调用去干 action 没做的事**——
   `tests/unit/consistency.test.mjs` 会核对视图里出现的 `/api` 字面量都能反查到 action。
2. **结构是数据**：分组、字段字典、版式都是 store 里的数据，改它们一律走 `section update` 那批 action；
   前端不许硬编码「某个栏目有某个字段」。
3. **归一化收口在 `src/core/store.js`**：任何新字段/新结构都要在这里被读时修正（老 store 必须能读），
   而不是让各页面各自兜底。
4. **测试门禁**：`consistency.test.mjs` 钉死「模块目录 ↔ 后端注册表 ↔ 前端 VIEWS ↔ 视图里的 /api」四张表，
   并禁止面板源码里出现 emoji（注释里也不行）。

## 检查清单（收尾自查）

- [ ] 改动落在 action 层，CLI 能做的面板也能做（反之亦然）
- [ ] 数据形状变了 → `src/core/store.js` 的 `normalize*` 已兼容老数据
- [ ] 新模块/新视图已在 `src/runtime/registry.js` 与 `src/web/frontend/registry.js` 两处登记
- [ ] `npx eslint . && npx vite build && node --test && node tests/smoke.mjs` 全绿
- [ ] 用户可见行为变了 → 同步 `CHANGELOG.md` 与 `assets/nx-sk/references/*.md`（后者是用户向文档）
- [ ] 新增/修改的模块没有跨模块 `import`（只能依赖 `core/`、`shared/`、`../settings/service.js`）
