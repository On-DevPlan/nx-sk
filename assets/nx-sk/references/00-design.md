# 00 · 设计思想

> 骨架级文档：回答「为什么这么设计」。**不放场景级 SOP** —— 怎么调命令看 `10-sections-entries` / `20-secrets` / `30-export-backup`。

## 一、驱动关系

```
        ┌──────────────────────────────────────────┐
        │  serve（唯一常驻入口，默认 127.0.0.1:7866）  │
        └───────────────┬──────────────────────────┘
                        │ 静态面板 + /api
        ┌───────────────┴──────────────┬────────────┐
        ▼                              ▼            │
   Web 面板                        HTTP API         │
        └──────────────┬───────────────┘            │
                       ▼                            │
              action 声明（唯一真相源）               │
                       ▼                            ▼
                service 层（业务）              CLI（同一条链）
                       ▼                            │
         core（存储 / 密文 / 字段字典 / 渲染）          │
                                                    ▼
                          skill install ──► ~/.claude/skills ──► agent
```

三条驱动链，一条比一条向上一级：serve 驱动 CLI 与 Web；CLI/Web 驱动 skill；skill 驱动 agent。

**第 3 条是这个骨架跟普通 CLI 工具的分水岭**：nx-sk 不只是给人用的，也是给 agent 用的。
一旦承认这点，`--json` 的稳定性、错误码、幂等性就从「锦上添花」变成硬契约。

## 二、分层与依赖方向

```
core/       零业务语义：paths / errors / store / fsx / crypto / vault / fields / render / ids / open
modules/    功能域，每个自包含：index.js(声明) + service.js(业务) + view.jsx(面板)
runtime/    装配层：registry / spec / cli / api / server —— 不写业务
web/frontend/  React 壳，只 import 各模块的 view.jsx
```

| 允许 | 禁止 |
| --- | --- |
| `core` ← `modules` ← `runtime` ← `bin` | 反向依赖（core 不许 import 上层） |
| `web/frontend/*` 与 `view.jsx` import 组件、api 客户端、store | 前端 import `core/`、`runtime/`、`node:*`、任何 `service.js` |
| 任意模块 → `../settings/service.js`（单向只读，基础模块） | 其它模块之间互相 import |
| `view.jsx` → `../../web/frontend/components/*` | `core` / `runtime` / `service.js` → 任何 `.jsx` |

**例外只有一处**：`settings` 是基础模块，允许被单向只读依赖。它的落地方式是——
eslint 的模块互依禁列**逐模块枚举**，"例外"就等于**不把它列进去**。

**模块要 runtime 的数据怎么办**（如 `system` 需要命令表）：用**函数体内的动态 import** 破环。
静态 import 会成环，动态 import 不会——这是全项目唯一需要用到它的地方。

## 三、关键不变量

### 1. 字段字典是数据，不是代码分支

栏目自己带一份 `fields[]`（key / label / type / group / options / sensitive），
条目按它存取。所以：

- CLI 与面板的字段集合不可能分叉——它们读的是同一份；
- 写入**不受字典限制**：没见过的键自动登记（键名即字段名），agent 与用户都不必先改 schema；
- `--set` 的键同时接受 `key` 与中文 `label`，人机都顺手。

*违反会怎样*：如果字段写死在代码里，面板加一个字段就要改前端 + 后端 + 文档三处，
而漏改任何一处都不会报错——只是「面板上有、CLI 里没有」。
反过来，如果把它做成写入门禁，用户每见一个新表单就得先扩一次字典——那是把成本推给了用户。

### 2. 一条 action 同时声明 cli 与 http

```js
{ id: 'entry.update', cli: ['entry','update'], http: ['PATCH','/api/entries/:ref'], run, render }
```

CLI 命令表、HTTP 路由表、`help` 文本全部由此派生。
**方向刻意不对称**：`cli` 必填，`http` 可为 `null`（纯 CLI 命令）。
这样「Web 上能做的 CLI 都能做」是结构保证，而不要求反向。

*违反会怎样*：两份清单必然分叉 —— 面板上有按钮、CLI 里没命令，且没人发现。

### 3. 失败抛异常，业务结果返回 `{ status }`

判据是**「调用方要不要处理它」**：

| 情形 | 表达 | 例子 |
| --- | --- | --- |
| 调用方无从处理，只能中断上报 | `throw` | 字段名打错、条目不存在、密钥解不开 |
| 调用方要拿它做决策 | `return { status }` | 栏目非空需 `--force`（`blocked`）、技能安装冲突（`conflict`）、已是期望状态（`skipped`） |

**冲突不是错误。** 面板要拿它弹窗让用户决策，所以不能抛。
CLI 侧这四个取值分别渲染成不同的可读提示，退出码只有「抛异常」才是 1。

## 四、错误契约

| code | 判据 | HTTP |
| --- | --- | --- |
| `INVALID_INPUT` | 输入本身不合法 | 400 |
| `NOT_FOUND` | 指定的目标不存在 | 404 |
| `CONFLICT` | 目标存在且与期望状态冲突，需要用户选一侧 | 409 |
| `BLOCKED` | 操作合法但被前置条件挡住（或密钥不一致） | 409 |
| `EXTERNAL` | 外部命令/端口失败 | 502 |
| `INTERNAL` | 兜底 | 500 |

映射**只写一处**（`core/errors.js`）。`--json` 的错误对象向后兼容：`error` 保持字符串，`code` 是新增字段。

## 五、错误案例表（都实测踩过）

| 错误操作 | 实际后果 | 正确做法 |
| --- | --- | --- |
| 把「读命令的过滤 flag」照抄写命令的 `default` | 参数层无条件注入默认值 → 「不传 = 全部」的分支**永远走不到**，不报错、不崩，只是永远返回半个结果 | 写命令的 flag 可带 `default`；读命令的过滤 flag 一律不带 |
| 路由只按声明顺序匹配 | `GET /api/sections/templates` 被 `GET /api/sections/:ref` 遮蔽，命中哪条取决于 actions 数组顺序 | 路由按「字面量段优先」排序，让声明顺序无关（`runtime/spec.js` 的 `compareRoutes`） |
| 把打码值当成新值写回去 | 密钥字段被写成 `sk-1****cdef` 这串掩码，**原凭据永久丢失** | 写入前比对掩码：相等就当成「未改动」保留原密文；含 `******` 的值直接拒绝 |
| 删条目/栏目不留快照 | 误删即不可逆；这是用户的**唯一一份**个人信息 | 所有破坏性写操作先 `snapshotStore()` 到 `~/nx-sk/backup/` |
| store.json 解析失败就当空库继续 | 下一次写入把用户数据永久覆盖 | 先把损坏文件改名为 `store.json.corrupt-<时间>.json`，再降级返回空结构 |
| 前端 import 了 `node:*` 或 `core/` | Vite 把 Node 侧代码打进浏览器包，dev 模式白屏 | lint 的 `files` 同时覆盖 `view.jsx`，禁掉 `node:*` / `core` / `runtime` / `service.js` |
| 新增模块忘了往 eslint 互依禁列里补一行 | **静默**：新模块变成「谁都可以依赖」，且规则随模块数增加持续衰减 | 在禁列旁留注释说明它是**逐模块枚举**的、漏补是静默的；加模块前先读 `eslint.config.js` |
| 代理前缀 `/api` 与前端源码目录 `api/` 撞车 | 只在 dev 模式整页白屏，报错却是 404 / ECONNREFUSED，离根因很远 | vite 代理加 `bypass`，按「是不是前端资源」分流；并用测试钉住 `shouldServeLocally` |
