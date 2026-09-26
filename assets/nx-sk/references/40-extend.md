# 40 · 扩展：改这个项目本身

> 归属 `nx-sk` skill 主文档。**要加栏目模板、加功能域、改对外契约时读这篇。**
> 只填数据的话不用看——那走 `10-sections-entries` 的「扩字段字典」一节就够。

## 一、加一个栏目模板（最常见）

1. `src/core/fields.js` 的 `TEMPLATES` 里加一个 `{ id, label, description, titleField, titleLabel, groups, fields }`。
2. 完成。`section templates` / 面板的「新建栏目」会自动列出它。

不需要动任何别的文件——模板是**数据**。

## 二、加一个功能域（`src/modules/<域>/`）

按闭环表逐条对。**第 6、7、11 项没有任何断言会替你发现**，是真正会漏的地方：

| # | 落点 | 漏了会怎样 | 谁会发现 |
| --- | --- | --- | --- |
| 1 | `modules/<域>/service.js` | —（业务本身） | — |
| 2 | `modules/<域>/index.js` | 命令不存在 | 装载期自检 / 一致性测试 |
| 3 | `modules/<域>/view.jsx` | 声明了 view 却没文件 → **构建期报错** | `vite build` |
| 4 | `runtime/registry.js` 的 `MODULES` | 模块整个不生效 | 一致性测试（目录 ↔ 注册表对账） |
| 5 | `web/frontend/registry.js` 的 `VIEWS` | 后端有 view、前端没登记 | 一致性测试（两侧视图表对账） |
| 6 | `src/index.js` 的 `export * as <域>` | 库用方拿不到该 service | ❗**无任何断言，纯静默** |
| 7 | `eslint.config.js` 的 `SIBLING_MODULES` 加 `'../<域>/*'` | 新模块悄悄变成「谁都可以依赖」 | ❗**无任何断言，纯静默** |
| 8 | `core/paths.js` / `core/fields.js` 新增常量（如有） | 散落字面量 | 靠 review |
| 9 | `tests/unit/` 纯逻辑断言 | 算法只被端到端覆盖 | 靠自律 |
| 10 | `tests/smoke.mjs` 只读断言 | 端到端坏了没人知道 | 无断言 |
| 11 | **`assets/nx-sk/references/`** | agent 永远不知道这条命令存在 | ❗**单向断言**（只保证「文档提到的命令一定存在」，反方向不强制） |
| 12 | `README.md` 命令总表 / `CHANGELOG.md` | 文档漂移 | 无断言 |

第 7 项的禁列是**逐模块枚举**的，不是通配——这是刻意的：加一行就等于提醒「你在加一个可能有依赖的模块」。
但代价是漏补**完全静默**，且规则随模块数增加持续衰减（加 5 个漏 3 次，规则就废了一半）。

## 三、四条硬纪律

1. **一条 action 同时声明 `cli` 与 `http`**（`http` 可为 `null`）。别在别处再抄一份命令表。
2. **写命令的 flag 可以有 `default`；读命令的过滤 flag 一律不带。**
   带了就会让「不传 = 全部」的分支永远走不到——不报错、不崩，只是永远返回半个结果。
3. **每个写命令都要 `--dry-run`；破坏性写之前 `snapshotStore()`。**
   `remove` 类要选定幂等语义（本项目选 **`NOT_FOUND` 报错**，不静默成功）并写进 `summary`。
4. **集合资源才凑 CRUD 五动词**（`list/get/add/update/remove`）。
   单例配置退化成 `get/set`；动作集合按动作命名（`export run` / `skill install`）；
   聚合模块（`system`）不必有视图。**别硬凑** —— `system add` 这种一看就知道是凑的。

## 四、验证闸门（改完必须跑）

```bash
pnpm test            # = lint + build + 冒烟 + 单测
```

四道闸各自拦什么：

| 闸 | 拦什么 | 怎么确认它真的会触发 |
| --- | --- | --- |
| 装载期自检（`registry.js`） | 重复 action id / CLI 路径 / HTTP 路由；缺 `cli`；`http` 既不是数组也不是 `null` | 故意加一条重复命令，确认启动即抛错 |
| 模块目录 ↔ 注册表对账 | 写了目录忘登记（反之亦然） | 建一个空模块目录，跑单测看是否报「没有登记」 |
| 后端模块 ↔ 前端视图对账 | 有 view 却没登记 tab，或登记了不存在的视图 | 删掉前端 `VIEWS` 里某一行，跑单测 |
| 视图里的 `/api` 字面量 | 面板调了不存在的端点 | 把某个 `api('/api/x')` 改成不存在的路径，跑单测 |
| CLI 路径可解析回自身 | 命令匹配算法被改坏 | 靠既有断言 |
| lint 分层 | 越层 import / 前端 import `node:*` / 模块互依 | **必须做一次反向测试**：临时写个违例文件，确认 lint 退出码非 0 |

最后一条特别值得做：**lint 规则写错了不会报错，只会永远通过——一个从没红过的规则等于不存在。**

## 五、几个不该改的地方

| 别做 | 为什么 |
| --- | --- |
| 给 `.card` 加 `box-shadow` | 容器投影 = 一堆岛屿，用户 0.3 秒找不到按钮 |
| 把 `.row` 改成靠 padding 定高 | 高度不可控，行间距不一致；本项目是**行 28px / 按钮 32px** 的两级密度 |
| 把 `.btn` 高度改成 36px「更好按」 | 破坏 4px 差的密度二元性 |
| 给 `.tab.active` 再叠一层 `--shadow` | tab 浮起来抢焦点 |
| 用 `font-size: 14px` 让文字「看得清」 | 破坏 12px 的信息密度节奏 |
| 在前端 `import` 任何 `core/` 或 `runtime/` | 会把 Node 侧代码打进浏览器包 → dev 白屏 |
| 用变量拼 `lazy(() => import(x))` | Vite 静态分析不了，失去代码分割 |
