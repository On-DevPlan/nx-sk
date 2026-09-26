# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/)，中文正文。

## [Unreleased]

## [0.3.4] - 2026-09-26

### Added

- **多行值的可靠通道**：`key set <名> -`（stdin）与 `key set <名> --data @文件.json`
  （也接受 `-` 与 JSON 字面量）。对象含 `value` 键时取它，只含一个键时取那个键，
  多键且无 `value` 直接报错而不是猜。

### Fixed

- **Git Bash 下多行参数不再被静默截断**（原始事故）：转发器里 `exec node` 走的是
  PATH 上的 node，而它可能是 Volta 之类的中转 shim，那一跳会把 `$'l1\nl2\nl3'`
  截成 `l1` 且**不报错**——一次性凭据就这么丢掉大半。改为直连本进程的
  `process.execPath`，并带路径失效回退（node 升级换目录时退回 PATH，重跑
  `link:local` 即恢复）。
- **恢复被删的 `references/40-extend.md`**：它与 SKILL.md 路由表里的条目被**同时**
  删掉，于是「路由表 ↔ 目录双向对账」两边一起变空、照样通过——这个 ref 就这样被
  删了两次。新增断言钉住「ref 体系整体不被削掉」（必存 ref 下限 + 编号升序唯一），
  已做反向验证（删文件时确实变红）。

### Notes

- **`.cmd` 那条路修不了**：实测直连真实 `node.exe` 与走 shim 结果**完全相同**
  （多行都截断、尖括号都失败），瓶颈是 cmd.exe 解析 `.cmd` 内容时的 `%*` 展开。
  cmd / PowerShell 下多行值必须走 `-` 或 `@文件`。
- 原计划要在 CLI 里做「检测到含换行就拒绝」，实测后**放弃**：损坏后 CR 是被删掉而非
  保留（`$'a\rb'` 实际落盘 `"ab"`），零真阳性；而 `@文件` 读入的合法 CRLF 多行值含
  CR，会被自己的检测拦住（高假阳性）。LF 截断后与合法单行值不可区分——可靠信号不存在。

## [0.3.3] - 2026-09-26

### Fixed

- **自定义栏目在 Web 面板整页空白**：栏目的分组元数据有两条读取路径——CLI 从字段
  **推导**（`groupFields(fields)`），面板按**声明数组**（`section.groups`）渲染。
  用 `section add --fields '{…"group":"basic"…}'` 建栏目而没同时给 `--groups` 时，
  `groups` 是空数组：CLI 显示正常、面板的字段表单整组消失，而页面本身不报错，
  看起来就像「这个栏目不存在」。
- 修复：新增 `syncSectionGroups()` 把「分组声明 ⊇ 字段引用」钉成**栏目不变量**，
  规则只写一份，在 `normalizeSection`（store 读写的唯一收口）与 `section add` 的
  草稿两处调用——**存量数据读一次即自愈**，此后 `--add-field` / 面板加字段引用到
  未声明的分组也会自动补齐声明。

### Changed

- CHANGELOG 中 0.3.1 那条安全说明不再复述被清除的原文（说明「清理了 PII」的句子
  本身不该再带上那份 PII）。

## [0.3.2] - 2026-09-25

### Fixed

- **密钥页 CRUD 全挂**：`guard` 返回的包装函数不透传参数，所有 `guard(async (row) => …)`
  形式的行级操作拿到 `undefined`，读 `row.name` 抛
  "Cannot read properties of undefined (reading 'name')"。改值/改名/删除、
  栏目页 8 个操作、导出 dry-run 全部中招；blur 触发的改名让「点一下别处就报错」。
- `kvTable.rename`：改名成功后 `draft` 的键同步迁移到新名（原先留在旧键下，
  值输入框显示为空、blur 会把值写回旧键名）。

## [0.3.1] - 2026-09-25

### Security

- **清除文档与帮助文本中的真实个人信息**：真实姓名与邮箱拼音样例统一替换为占位符
  （姓名→`张三`、邮箱前缀→`zhangsan`），涉及 skill 文档示例（`assets/nx-sk/references/`）、
  CLI 帮助文本（`help entry`）、面板 toast 提示与单测夹具；提交作者身份统一为
  `nx-sk <nx-sk@local>`。已用 `git filter-repo` 重写全部历史并 force-push。
- 0.3.0 因包含上述信息已在 npm 标记 deprecated（unpublish 被 granular token
  2FA 政策拦截，需官网手动删除）。

## [0.3.0] - 2026-09-25

### Added

- **字段填写策略 `fill`：`normal` / `optional` / `avoid`** —— 有些格子填了反而减分
  （应届生的「上一家公司」、政治面貌为「群众」时的「入党时间」），这次把这种判断做成**数据**。
  - `optional`（不必填）与 `avoid`（不填）**既不计入完整度的分子、也不计入分母**。
    完整度这个数字是用来导航「还该补什么」的，被一批主动跳过的字段长期压着就失效了。
  - 它们不会被藏起来：`serializeEntry` 新增顶层 `excluded[]`，与 `missing[]` **并列**
    （「主动跳过」和「还没填」是两件事）；`completeness` 新增 `excluded`（个数）与
    `excludedFilled`（标了不填却仍然填了的个数，非 0 就说明策略该更新了）。
    CLI 的 `entry get` / `entry list` 把两者分开报，面板在字段标签上打中性标签。
  - 新增 `section update --fill <字段>=normal|optional|avoid`（可重复，label 或 key 都认；
    改回照常填传 `normal`）。`entry fields` / `section dump` 的字段字典输出带上
    `fill` 与 `fillLabel`。
  - `validateFieldDef` 放行 `fill` —— 该函数是**白名单**，漏了会静默丢弃新属性，
    后果是「用户设了不填、完整度照旧算它」，很难查。非法策略报错而非忽略；`normal` 是缺省、不落盘。
  - **非破坏性**：没有任何字段带 `fill` 时，行为与之前完全一致，旧 store 无需迁移。

### Fixed

- **「面板无 emoji / 不使用原生弹窗」这条守卫覆盖不全**：它只 `readdir` 了
  `src/web/frontend/` 的**直接子文件**，于是 `frontend/components/`（`fieldEditor.jsx`、`ui.jsx`）、
  `App.jsx`、`main.jsx`、`api/` 全都没被扫到 —— 等于**面板规则不覆盖面板**；
  `src/core/`、`bin/`、`scripts/` 同样漏了。改为递归收集并补齐这几处，
  顺手清掉 `core/render.js`、`core/store.js` 里两处漏网的 emoji。
  已按项目「改完规则必须反向测试」的要求验证：往原先扫不到的 `components/fieldEditor.jsx`
  注入 emoji，测试如期变红，还原后恢复全绿。

## [0.2.0] - 2026-09-24

### Changed

- **【破坏性】密文字段默认原文显示**，打码改成显式选项：
  `--reveal` 全部换成 `--mask`（`key get/list`、`entry get`、`section dump`、`GET /api/keys?mask=1`）；
  导出默认也含明文（`settings.includeSecretsInExport` 默认 `true`，要打码加 `--no-secrets`）。
  理由：本机单人工具，数据是给自己看的，默认打码等于每次先拦自己一道。
  **落盘仍然是 AES-256-GCM 密文**——「store.json 泄露」不等于「凭据泄露」这一点没变。
  面板里的勾选框从「显示密文字段明文」翻成「打码显示（投屏/截图时用）」，默认不勾。
- **【破坏性】skill 不再出现在 Web 面板**：删掉 Skill tab 与它的视图；`skill install` / `skill get`
  仍完整保留在 CLI（用户明确要求，偏离了骨架 ref「三条最高优先级命令要有 Web 入口」的建议）。
- **【破坏性】密钥栏目从 8 字段缩成极简 KV**：只保留「名称（条目名）→ 值」。
  删掉了服务商 / 接口地址 / 模型 / 用途 / 有效期 / 额度 / 备注 ——
  存一个 key 不该先填一张表；「这个 key 干什么用」写进键名里就够了。
  - **自动迁移**：`store.json` 版本升到 `2`。首次读盘时把旧 `keyValue` 的值搬到 `value`，
    并**先留一份迁移前的原始文件快照**到 `~/nx-sk/backup/…-migrate-v1-to-v2.json`；
    其余旧值**不删除**（不再显示 ≠ 删掉），`bootstrap --json` 的 `migration` 字段会报告迁移结果。
  - 迁移幂等：`version` 落盘后不再触发。

### Added

- **README 补「安装」节**：`npm link` 做成全局垫片（全局 node_modules 是指向项目的软链，
  改代码即刻生效）、skill 的**软链垫片**做法、以及 `npm unlink -g nx-sk` 的回退方式。
- **skill 在本机改成软链**：`~/.claude/skills/nx-sk` 与 `~/.workbuddy/skills/nx-sk`
  现在都软链到项目 `assets/nx-sk`（与 `server-cli-web-scaffold` 同一种做法）。
  `skill install` 装的是**副本**，只在分发/跨机器时用；日常用软链才不会让 agent 拿到旧版手册。
- **【破坏性】KV 栏目在面板里就是一张表**：`secret` 标了 `kv: true`，面板渲染成
  「名称 / 值」两列表格（改值即改、加行即加键、行内重命名、一键复制），
  **不再有**条目列表、字段表单、完整度百分比 —— 那些只对「一族同构条目」的栏目（求职）有意义。
  CLI 侧 `key *` 缺省作用在标了 `kv` 的栏目上，并新增 `--section`；
  `settings.kvSection` 这个间接层**删掉**（哪个栏目是 KV，由栏目自己说了算）。
- **KV 栏目拒绝加字段**：往里塞字段会让「值在哪一列」变得不确定，所以直接报错并指出
  该用 `key set`。这条是真实事故换来的：早先面板那行「KV 直填」把 `3123312=xxx`
  登记成了字段，用户看到的是一堆无意义的「模板建议」。
  配套 v2 → v3 迁移：把误当字段用的值搬进值列，字段收成一个，旧键一律不删，迁移前留原始快照。
- **`entry update` 改名时挡住重名**（同栏目已有同名条目报 `CONFLICT`）——
  重名会让「按名字取」变成二义。
- **字段台账不再拦写入**：`--set 任意键=值` 一律能存，没见过的键自动登记
  （键名就是字段名，**中文也可以**；类型按值推断：`是/否` → bool、数组 → tags、其余 → text）。
  `--allow-new-field` 随之取消（它现在是默认行为）。
  **刻意不推 number**：18 位身份证号这类长数字超过 2^53，推成数字会静默丢精度。
- **面板加「KV 直填」行**：敲 `字段=值` 回车即写入，不再必须先在分组表单里找到那一格；
  「未填 N 项」也从告警口吻改成中性的「模板建议里还有 N 项没填（不影响使用）」。
- `assertFieldKey` 放宽到允许中文（仍挡空白 / 路径分隔符 / `..`），
  这样 `--set 微信号=xxx` 存下去就是 `微信号`，不必再记一个英文别名。
- **`key` 系列命令（KV 直通）**：`key set <名称> <值>` / `key get <名称> [--reveal]` /
  `key list [--reveal]` / `key remove <名称>`，对应接口
  `PUT /api/keys/:name` / `GET /api/keys/:name` / `GET /api/keys` / `DELETE /api/keys/:name`。
  - `key *` 是 `entry *` 的**语法糖**，与 `entry` 同模块、共用同一批 service 函数
    （加解密 / 打码 / 快照 / `--dry-run` 只有一份实现），有一致性测试钉住「不许另起一套」。
  - `key set` 是 **SET 语义**（同名覆盖，返回值带 `created`）。这是它与 `entry add`
    （同名报 `CONFLICT`）唯一刻意的差别。
  - 重复写同一个值 → `{ status: 'skipped', unchanged: true }`，不重写密文、不留快照。
  - 作用栏目由新设置项 `settings.kvSection` 决定（默认 `secret`）。
- CLI 位置参数与 flag 的优先级明确为**显式 flag 覆盖位置参数**，
  于是 `key set K <值>` 与 `key set K --value=<值>` 等价 ——
  后者是值以 `-` 开头时唯一可用的写法。

### Fixed

- `cli.js` 的 `parseArgs` 原本让位置参数覆盖同名的显式 flag，导致 `--value=` 被静默忽略。
- `key set` 的「值没变」判定原本只比明文，面板原样回传打码值时会被误判成覆盖
  （多写一次密文 + 多留一份快照）。现在明文相同与掩码相同都算「未改动」。

## [0.1.0] - 2026-09-24

首个版本：本机个人资源管理器（server-cli-web 骨架的完整实现）。

### Added

- **栏目化数据模型**：栏目 = 一组同构条目 + 一份字段字典（字典是数据，不是代码分支）。
  内置两个模板：`job`（求职 / 个人信息，9 分组 75 字段）、`secret`（密钥，8 字段）。
- **CLI**（26 条命令）：`serve` / `help` / `version` 三个平台命令，
  以及 `bootstrap` / `health` / `routes` / `section.*` / `entry.*` / `export.*` / `setting.*` / `skill.*`。
- **HTTP API**：由 action 声明同源编译，路由按「字面量段优先」排序（`/api/sections/templates`
  不会被 `/api/sections/:ref` 遮蔽）。写操作校验 `Origin`。
- **Web 面板**：栏目动态 tab、按分组渲染的字段表单、PATCH 语义保存（只发改动过的字段）、
  密文字段一键揭示、完整度与未填清单、派生式 CLI 提示、页内 toast / dialog / 错误边界。
- **密文存储**：敏感字段 AES-256-GCM 落盘，密钥来源支持 `NX_SK_PASSPHRASE`（scrypt + 盐）
  或本机 `~/.vaultkey`；密文带密钥指纹 `kid`，换来源时给明确的 `BLOCKED` 而不是乱码。
  打码值原样回传会被识别为「不修改」，直接写入打码占位会被拒绝。
- **整体导出**：JSON + Markdown，支持按栏目、指定目录、`--dry-run`；凭据默认打码，
  `--with-secrets` 才出明文并在导出文件里标记 `withSecrets`。
- **快照与回滚**：每次破坏性写入前整库快照到 `~/nx-sk/backup/`（最多 20 份）。
- **损坏保护**：`store.json` 解析失败先改名为 `.corrupt-<时间戳>.json`，不静默覆盖。
- **内置 skill**：`skill install` 装到 `~/.claude/skills`（三态，不静默覆盖），
  `skill get` 输出「prefix → 文档 → install 状态」三段，`--json` 为四元契约。
- **测试**：40 项单测（含一致性断言：模块目录 ↔ 注册表 ↔ 前端视图表 ↔ 视图里的 `/api` 字面量、
  CRUD 五操作与路由形状、CLI 路径可解析回自身、eslint 互依禁列覆盖、文档漂移防护、
  装载期自检的负向反证）+ 56 项端到端冒烟断言。

### Notes

- 数据默认落在 `~/nx-sk/`（骨架 ref 的默认是 `~/.<主题名>/`，本实现按项目要求改成可见目录）。
- 存储路径支持 `NX_SK_HOME` / `NX_SK_STORE` 覆盖 —— **不是可选项**：没有它测试会写脏真实数据。
- eslint 的模块互依禁列是**逐模块枚举**的：新增模块必须补一行，漏补是静默的
  （已由 `tests/unit/consistency.test.mjs` 兜住）。
