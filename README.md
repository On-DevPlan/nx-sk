# nx-sk · 本机个人资源管理器

把你的信息按**栏目**存起来。CLI 与 Web 面板是同一条业务链，敏感字段密文落盘，
数据全在你自己机器上 —— 默认 `~/nx-sk/`。

```
nx-sk serve          # 打开面板（http://127.0.0.1:7866）
```

![结构](https://img.shields.io/badge/node-%3E%3D18.17-informational) ![license](https://img.shields.io/badge/license-MIT-informational)

## 安装

命令名就是包名。**推荐做成全局垫片**（全局 node_modules 里是指向本项目的软链，
改代码立刻生效，不用重新安装）：

```bash
cd <本项目>
pnpm install          # 只为构建面板；CLI 侧零依赖
pnpm run build        # 产出 src/web/public，serve 才有面板可服务
npm link              # → 全局多了 nx-sk / nx-sk.cmd / nx-sk.ps1
nx-sk version         # 从任何目录都能跑
nx-sk serve           # 打开面板
```

取消：`npm unlink -g nx-sk`（只删全局垫片，不动项目）。

> **npm 的全局 prefix 不在你的 PATH 里怎么办**（用 Volta / nvm 管理 node 时很常见）：
> `npm link` 会把垫片放进 npm 的 prefix 目录，而那个目录可能不在终端的 PATH 上，
> 于是你敲 `nx-sk` 会 command not found —— 但某些 shell（比如被别的工具注入过 PATH 的）却能跑。
> 这种情况自己做一个垫片，放进**你自己的 bin 目录**（确认它在 PATH 里）：
>
> ```sh
> # ~/.local/bin/nx-sk（Git Bash / sh）
> #!/bin/sh
> MSYS_NO_PATHCONV=1; export MSYS_NO_PATHCONV   # 不开这个，MSYS 会把 /d/... 按当前盘符改写成 d:\d\...
> exec node "<项目绝对路径>/bin/nx-sk.mjs" "$@"
> ```
>
> ```bat
> :: ~/.local/bin/nx-sk.cmd（cmd.exe / PowerShell）
> @echo off
> node "D:\a_js\js_proj\nx-sk\bin\nx-sk.mjs" %*
> ```
>
> 别忘了 `chmod +x ~/.local/bin/nx-sk`。验证：`cd / && nx-sk version`。

> 不想污染全局也行：`node bin/nx-sk.mjs <子命令>` 等价，或 `npx --no-install . <子命令>`。

### skill：用**软链垫片**（推荐）

`skill install` 装出去的是**副本**，不会跟着源码走 —— 改了 `assets/nx-sk/` 就变旧版手册。
日常开发应该用**软链**指向项目里的源，改完立刻生效、永远不会漂移：

```bash
# Windows（cmd / 终端里，目录软链）
mklink /D "%USERPROFILE%\.claude\skills\nx-sk"      "D:\a_js\js_proj\nx-sk\assets\nx-sk"
mklink /D "%USERPROFILE%\.workbuddy\skills\nx-sk"   "D:\a_js\js_proj\nx-sk\assets\nx-sk"
# Windows（Git Bash，需要原生软链）
MSYS=winsymlinks:nativestrict ln -s "D:/a_js/js_proj/nx-sk/assets/nx-sk" "$HOME/.claude/skills/nx-sk"

# macOS / Linux
ln -s "$(pwd)/assets/nx-sk" "$HOME/.claude/skills/nx-sk"
ln -s "$(pwd)/assets/nx-sk" "$HOME/.workbuddy/skills/nx-sk"
```

建好之后 `nx-sk skill install` 会变成 no-op（内容一致 → 跳过），因为目标就是源本身。

> 软链建不出来？退回到复制式安装（适合分发给别人 / 跨机器，但**改完记得重装**）：
>
> ```bash
> nx-sk skill install                           # → ~/.claude/skills/nx-sk（三态：安装/跳过/冲突）
> nx-sk skill install --to ~/.workbuddy/skills  # WorkBuddy 侧的 agent 也读得到
> nx-sk skill install --force                   # 改了 assets/nx-sk/ 之后必须重装，否则是旧版
> nx-sk skill get nx-sk --json                  # 外部 agent 一键拿全上下文（四元：skillName/ref/content/contentBytes/install）

## 它是什么

一个「本机工具类」项目的标准骨架实现（server-cli-web）：**serve 驱动 CLI 与 Web，
CLI 与 API 同源，skill 驱动 agent**。落到具体功能上：

| 栏目 | id | 内容 |
| --- | --- | --- |
| 求职 | `job` | 求职用的个人信息档案：9 个分组 / 75 个字段（姓名、学历、联系方式、求职意向、紧急联系人…）。模板只是**建议清单**，`--set 任意键=值` 直接写 |
| 密钥 | `secret` | **一张 KV 表**（`kv: true`）：面板上就是两列表格（名称 / 值），一行一个键。落盘是 **AES-256-GCM** 密文，读出来默认是原文（`--mask` 才打码） |

栏目不是写死的：字段字典是**数据**，加字段、加栏目都不用改代码。

## 三条核心不变量

1. **一条 action 同时声明 CLI 与 HTTP。** 面板上能做的，CLI 都能做；参数名与错误码两端一致。
2. **依赖只能向下**：`core ← modules ← runtime ← bin`，模块之间不许互相 import（lint 强制）。
3. **失败抛异常（退出码 1），业务结果返回 `{ status }`（退出码 0）。**
   `conflict` / `blocked` / `skipped` 都是正常返回 —— agent 看 `status`，不看退出码。

## 命令总表

平台命令（`runtime/cli.js` 的 BUILTINS）：

| 命令 | 作用 |
| --- | --- |
| `nx-sk serve [--port N] [--no-open]` | 起 Web 面板（唯一常驻命令；默认只绑 `127.0.0.1`） |
| `nx-sk help [主题]` | 命令表（由 action 声明生成，不是手写） |
| `nx-sk version` | 裸输出版本号 |

模块命令（`src/modules/*/index.js` 声明，`nx-sk routes` 可双向查）：

| 命令 | 作用 |
| --- | --- |
| `nx-sk bootstrap [--json]` | 一次拿齐上下文：版本 / 存储路径 / 栏目 / 设置 / 命令表 |
| `nx-sk health` | 存活与存储可达性检查 |
| `nx-sk routes [--module M] [--http "POST /api/entries"]` | 命令 ↔ 路由双向对照 |
| `nx-sk section list \| get \| add \| update \| remove` | 栏目 CRUD |
| `nx-sk section dump <id> [--mask]` | **一个栏目的全部信息**：字段台账 + 全部条目 + 每个条目的未填清单 |
| `nx-sk section templates` | 内置模板（job / secret） |
| `nx-sk section sync <id> [--dry-run]` | 按模板**补齐**本栏目缺的分组与字段（只增不改不删）——模板演进后让老栏目追上 |
| `nx-sk entry list \| get \| add \| update \| remove` | 条目 CRUD（PATCH 语义） |
| `nx-sk entry fields [--section job]` | 字段字典 —— 填之前先看这个，别猜字段名 |
| `nx-sk file list \| get \| add \| update \| remove` | 附件 CRUD（原件在 `~/nx-sk/files/`，同内容去重） |
| `nx-sk file add --path <文件> [--copy] [--category C]` | 导入附件：**默认移动原件**，`--copy` 仅复制 |
| `nx-sk file list [--section <栏目\|none>] [--q 关键字]` | 列附件：按「哪些栏目在引用」筛选（`none` = 未引用）；返回栏目汇总与存储目录 |
| `nx-sk file restore <id> [--to DIR] [--copy]` | **可逆**：移回原始位置并撤销台账；`--copy` 只导出副本 |
| `nx-sk file content <id>` | 浏览器链接（内联预览 / `?download=1` 下载）；CLI 打印物理路径 |
| `nx-sk file open <id>` | 用系统默认程序打开原件 |
| `nx-sk export run [--format json\|md\|both] [--section id] [--with-secrets] [--out DIR] [--dry-run]` | 整体导出 |
| `nx-sk export list` | 历次导出与目录内文件 |
| `nx-sk backup export [--password 口令] [--out DIR] [--with-files] [--dry-run]` | 口令对称加密整库，导出单个 `.nxskbak`（口令不落盘；`--with-files` 连附件原件） |
| `nx-sk backup import --file <备份> [--password 口令] [--replace] [--dry-run]` | 解密导入：缺省「合并」（只增补、不覆盖已有值，冲突列清单），`--replace` 整份替换；动手前自动留安全快照 |
| `nx-sk setting get \| set` | 全局设置 |
| `nx-sk skill list \| install \| get` | 把内置 skill 装给 agent / 给外部 agent 取上下文 |

所有写命令都有 `--dry-run`；所有命令都支持 `--json`（标准输出**单个** JSON 值）。

## 快速上手

```bash
pnpm install
pnpm start                     # 构建前端 + 起面板
# 或开发模式（vite :5180 + serve :7866，一个 Ctrl-C 关两个）
pnpm run dev
```

用 CLI 填一份档案：

```bash
nx-sk entry fields --section job --json          # ① 看字段字典
nx-sk entry add --section job --set 姓名=张三 --set 电话=13800000000 --json
nx-sk entry update 张三 --data @补全.json --dry-run   # ② 批量补，先试运行
nx-sk entry update 张三 --data @补全.json
nx-sk section dump job --json                    # ③ 复核：完整度 + 未填清单
```

存一个大模型 key —— 密钥栏目就是**极简 KV：名称 → 值**（**值不会以明文进 store.json**）：

```bash
nx-sk key set OPENAI_KEY sk-xxxxxxxx     # 写入：不存在则新建，存在则覆盖
nx-sk key get OPENAI_KEY                 # 取值：默认就是原文
nx-sk key get OPENAI_KEY --mask           # 投屏/截图时才打码：sk-x******xxxx
nx-sk key list                            # 所有键（默认原文）
nx-sk key remove OPENAI_KEY               # 删除，写前自动留快照
```

状态与栏目一样：`key *` 只是 `entry *` 的语法糖（同模块、同一批 service 函数），
作用在 `settings.kvSection` 指向的单字段栏目上（默认 `secret`）。

统一附件管理（简历、头像、成绩单等原件都收进 `~/nx-sk/files/`）：

```bash
nx-sk file add --path "D:\简历\张三-简历.pdf"   # 默认移动原件进库
nx-sk file list                                  # 台账：按栏目汇总 + 被引用情况
nx-sk file list --section none                   # 只看还没有条目引用的
nx-sk file restore f_xxxx                        # 可逆：移回原始位置、撤销台账
nx-sk file restore f_xxxx --to "D:\资料" --copy  # 或导出副本到指定目录
```

**附件怎么被条目引用**：条目的 `file` 字段存的是**附件 id 的列表**——一个字段可以挂**多个**
附件（简历多版本、头像多张）。id 全局唯一，所以每条条目各有各的附件、互不串台；
同一份原件也能被多条条目引用（sha256 去重后是同一条）。
**上传 / 选择发生在栏目条目的字段里**（求职 → 张三 → 「简历附件」直接上传或从库里选），
不在附件中心做指派：

```bash
FID=$(nx-sk file add --path "D:\简历\张三-简历.pdf" --json | 取 id)
nx-sk entry update 张三 --set resumeFile=$FID       # 挂一个（存成单元素数组）
nx-sk entry update 张三 --set resumeFile=$FID,f_xxx # 逗号分隔挂多个
nx-sk entry get 张三 --section job              # 每个附件各占一行：附件名 + 物理路径
nx-sk file get $FID                             # 反查「被引用：求职 / 张三 / 简历附件」
```

**「附件」中心由栏目驱动、不预定义任何分类或槽位**：它只展示当前库里存在的原件，
筛选片按「哪些栏目在引用附件」生成（外加「未引用」），每张卡片显示被哪个栏目/条目/字段引用。
工作台支持拖拽 / 点按钮上传、本机路径导入、搜索、图片缩略图、内联预览、下载、复制物理路径 / 链接、
编辑名称与备注、还原。求职条目表单的「附件资料」组里，
**简历附件 / 头像图片 / 成绩单 / 证书扫描件** 直接就地「上传文件」或从库里选。

> **看不到这些上传框？** 栏目的字段字典是**持久化数据**：栏目在实例化时把模板字段**深拷贝**下来，
> 此后独立演化，所以**模板后来新增的字段不会自动出现在已建好的栏目里**。
> 若你的求职栏目是很早建的，跑一次 `nx-sk section sync job`（或面板「栏目 → 编辑 → 同步模板字段」）
> 就能把模板新增的「附件资料」组与 4 个 `file` 字段补进来，且不改动你已有的字段与数据。

**头部导航分组**（栏目多了以后收拢头部，一眼分得出主次）：在设置里把同域栏目归成一组，
头部只显示组名，**悬浮展开上下列表**选具体栏目；不归组的栏目保持平铺。

```bash
# 面板：设置 → 头部导航分组（勾选栏目 / 改名 / 排序 / 增删组），保存后头部立即生效
nx-sk setting set --set 'navGroups=[{"title":"求职","sections":["projects","internships","campus"]}]'
nx-sk setting set --set 'navGroups=[]'   # 清空 = 全部栏目恢复平铺
```

分组只是**显示配置**（存在 `settings.navGroups`）：不动栏目与条目的数据，删掉栏目时头部自动略过。

整体导出（凭据默认**含明文**——本机自己用；要分享给别人时加 `--no-secrets` 打码）：

```bash
nx-sk export run --format both --out D:/备份/nx-sk
nx-sk export list
```

加密备份 / 恢复（口令对称加密，AES-256-GCM；导出设口令、恢复输口令）：

```bash
nx-sk backup export --password '你的备份口令'            # 写成 ~/nx-sk/backup/*.nxskbak
nx-sk backup export --password '你的备份口令' --with-files  # 连附件原件一起打包
nx-sk backup import --file ~/nx-sk/backup/xxx.nxskbak --password '你的备份口令' --dry-run  # 先看合并计划
nx-sk backup import --file ~/nx-sk/backup/xxx.nxskbak --password '你的备份口令'            # 缺省「合并」导入
nx-sk backup import --file ~/nx-sk/backup/xxx.nxskbak --password '你的备份口令' --replace  # 才是整份替换
# 口令也可用环境变量 NX_SK_BACKUP_PASSWORD 提供
```

**导入缺省是「合并」**：只增补（补缺失的栏目/条目/附件、补空字段、结构只增不减），
不覆盖你已填过的值——两边都有值且不同时保留本地、列入冲突清单由你处理；
导入完成给出完整报告。`--replace` 才整份替换（灾难恢复 / 跨机器迁移用）。
两种方式都先自动留安全快照。

Web 面板的「导出与备份」页同样支持：导出在浏览器下载 `.nxskbak`（可勾选连附件一起打包），
导入选择文件并输入口令、报告以弹窗呈现；口令错误或文件损坏会明确报错、不改动当前数据。

## 数据与安全

| 项 | 位置 / 做法 |
| --- | --- |
| 数据目录 | `~/nx-sk/`，可用 `NX_SK_HOME` 覆盖 |
| 状态文件 | `~/nx-sk/store.json`，可用 `NX_SK_STORE` 覆盖；**原子写**（临时文件 + rename） |
| 密文密钥 | 环境变量 `NX_SK_PASSPHRASE`（scrypt 派生 + 盐）优先，否则 `~/nx-sk/.vaultkey`（32 字节随机，0600） |
| 快照 | 每次破坏性写入前整库备份到 `~/nx-sk/backup/`（最多 20 份），拷回即回滚 |
| 导出 | `~/nx-sk/export/`，默认不含凭据明文 |
| 附件 | `~/nx-sk/files/` 存二进制原件，元数据在 `store.json` 的 `files`（sha256 去重；条目 `file` 字段存附件 id 即建立链接；`file restore` 可逆） |
| 加密备份 | `.nxskbak`：整库经 scrypt(口令)+AES-256-GCM 加密，口令不落盘；附件台账恒随包（`--with-files` 连原件）；导入缺省「合并」只增不减，`--replace` 整份替换；动手前自动留安全快照 |
| 服务绑定 | 默认 `127.0.0.1`，不暴露到局域网；写操作校验 `Origin` |
| 数据损坏 | `store.json` 解析失败会先被改名为 `.corrupt-<时间戳>.json`，不会静默覆盖 |

换成口令模式更安全（口令不落盘）：

```bash
export NX_SK_PASSPHRASE='你的长口令'      # 之后所有密文都用它派生
```

注意：**换口令或删掉密钥文件后，旧密文解不开**（这是设计，密文指纹 `kid` 会明确报错）。

## 给 agent 用

```bash
nx-sk skill install                 # 装到 ~/.claude/skills/nx-sk（三态，不静默覆盖）
nx-sk skill get nx-sk --json        # {skillName, ref, content, contentBytes, install}
nx-sk skill get nx-sk 10-sections-entries   # 裸名 → references/10-sections-entries.md
```

内置 skill 的 ref 路由表：

| ref | 何时读 |
| --- | --- |
| `00-design` | 为什么这么分层、错误码与 `{status}` 的分工 |
| `10-sections-entries` | 填/改信息的完整命令与 AI 补全流程 |
| `20-secrets` | 密文机制、密钥来源、排查「解不开」 |
| `30-export-backup` | 导出、快照与回滚 |
| `40-files` | 附件库：导入（默认移动）与还原、`file` 字段与条目的链接、附件中心由栏目驱动 |

## 开发

```bash
pnpm test        # = lint + build + 冒烟（109 项断言） + 单测（140 项）
```

| 目录 | 职责 |
| --- | --- |
| `bin/nx-sk.mjs` | 唯一入口，只转发 argv + 兜异常 |
| `src/core/` | 零业务语义：paths / errors / store / fsx / crypto / vault / fields / attachments / render / ids / open |
| `src/modules/<域>/` | `index.js`(action 声明) + `service.js`(业务) + `view.jsx`(面板) |
| `src/runtime/` | registry / spec / cli / api / server —— 装配层，不写业务 |
| `src/web/frontend/` | React 壳 + 组件 + 视图注册表 |
| `assets/nx-sk/` | 随包分发的 skill（SKILL.md + references/） |
| `tests/unit/` · `tests/smoke.mjs` | 一致性断言 + 端到端冒烟 |

**加一个功能域要碰的 12 处**（其中 3 处没有任何断言会替你发现）属于**开发规范、不属于随包分发的
agent 手册** —— 它写在创建本项目的脚手架 skill `server-cli-web-scaffold` 的
`references/A07-extension-loop.md`，`assets/nx-sk/` 里只放「怎么用 nx-sk」。

## License

MIT
