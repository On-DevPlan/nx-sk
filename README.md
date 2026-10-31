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

## 从 0.11.x 升级

**导出只剩 `nx-sk transfer` 一条路径。** 备份（0.12.0 删）与可读导出 JSON / Markdown
（0.13.0 删）都是「往本机目录再写一份副本」，而 ZIP 导出已经覆盖了这两件事。

| 原来 | 现在 |
| --- | --- |
| `nx-sk backup export --password 口令` | `nx-sk transfer export <栏目> --passphrase 口令 --out x.zip` |
| `nx-sk backup import --file x.nxskbak` | `nx-sk transfer import-new --file x.zip` |
| `nx-sk export run --format both --out DIR` | `nx-sk transfer bundle-export --out x.zip`（ZIP，不是可读副本） |
| `nx-sk export list` | ——（已删；文件由你放到哪就在哪） |
| 面板「导出与备份」 | 面板「导出导入」（栏目全选即整库） |

仍然可用的命令：`transfer export` / `transfer import` / `transfer bundle-export` /
`transfer bundle-import` / `transfer import-new`。

- **旧的 `.nxskbak` 文件不再可导入。** 升级前请先在 0.11.x 下导出一份
  （`nx-sk transfer bundle-export --out x.zip`），升级后用 `transfer import-new --file x.zip` 导回。
- 破坏性删除（删栏目 / 条目 / 附件）**不再自动留快照** —— 删之前先导一份。
- `transfer export --no-secrets` 移除：包里恒为明文，保护只靠 `--passphrase`。
- 加密包格式变了（外层是合法 ZIP、内含 `payload.enc`），旧包仍可导入；
  但 Windows 上不再报「压缩文件夹错误」了。

## 它是什么

一个「本机工具类」项目的标准骨架实现（server-cli-web）：**serve 驱动 CLI 与 Web，
CLI 与 API 同源，skill 驱动 agent**。落到具体功能上：

**首次运行只播种一个「字段样例」栏目**（`demo`），连一条示例条目一起——把能力直接摆给你看：

| 组 | 字段 |
| --- | --- |
| 基本字段（标量） | 单行文本 / 多行文本 / 数字 / 是否 / 下拉框 / 日期 / 月份 / 标签 |
| 组合字段（值有形状） | **结构清单**（变长行 + 密文列）、**表格**（列在数据里 + 计算列 + 表尾合计/平均/计数） |
| 富内容 | **图文**（markdown + 贴图 + 待办）、**附件**、**密钥**（AES-256-GCM 密文） |

外加每个栏目自带的「原始资料」袋。示例条目把这些都填好了——打开面板就能试，
改坏了自己删（`section remove demo`），或整栏重建（`section add demo --template demo`）。

**其它 8 个模板不再自动播种**，要用时建（模板只是**建议清单**，`--set 任意键=值` 直接写）：

| 模板 | id | 内容 |
| --- | --- | --- |
| 求职 | `job` | 求职用的个人信息档案：10 个分组 / 80 个字段（姓名、学历、联系方式、求职意向、紧急联系人…） |
| 项目经历 | `projects` | 一个项目一个条目：名称 / 角色 / 时间 / 技术栈 / 职责与亮点 |
| 实习/工作经历 | `internships` | 一段经历一个条目：公司 / 岗位 / 时间 / 职责 |
| 校内职务/实践 | `campus` | 一条职务或实践一个条目：职务 / 组织 / 时间 / 职责 |
| 密钥 | `secret` | **一张 KV 表**（`kv: true`）：面板上就是两列表格（名称 / 值），一行一个键。落盘是 **AES-256-GCM** 密文，读出来默认是原文（`--mask` 才打码）。第一次 `key set` 没有它时会自动补建 |
| 部署配置 | `deploy` | **一份配置文件一个条目**（Dockerfile / docker-compose / k8s 清单）：正文即文件原文，外加「放哪 / 哪些值要替换 / **这个场景自己的凭据清单** / 何时用」，好让它在别的项目里照着用 |

栏目不是写死的——
字段字典是**数据**，加字段（`section update --add-field`，或 `entry update --set 任意键=值` 自动登记）、
加栏目（`section add`，不给模板就是空栏目全自定义）、删栏目都不用改代码。
模板在实例化时被**深拷贝**，此后各栏目独立演化；模板后来的新增用 `section sync` 补（只增不改不删，
有差异时会把「模板已改、栏目保留原值」的字段列出来提示）。

内置模板共 **9 个**——除 `demo` 与上面 6 个外还有 `platform`（容器平台：控制台链接 / 账号 / 密码 / 镜像）
与 `thesis`（毕业论文规范字段化），需要时 `section add <id> --template platform|thesis` 建。

## 三条核心不变量

1. **一条 action 同时声明 CLI 与 HTTP。** 面板上能做的，CLI 都能做；参数名与错误码两端一致。
2. **依赖只能向下**：`core ← modules ← runtime ← bin`，模块之间不许互相 import（lint 强制）。
3. **失败抛异常（退出码 1），业务结果返回 `{ status }`（退出码 0）。**
   `conflict` / `blocked` / `skipped` 都是正常返回 —— agent 看 `status`，不看退出码。

## 命令总表

平台命令（`runtime/cli.js` 的 BUILTINS）：

| 命令 | 作用 |
| --- | --- |
| `nx-sk serve [--port N] [--no-open]` | 起 Web 面板（唯一常驻命令；默认只绑 `127.0.0.1`；端口上已有本面板就直接打开它，被别的服务占了就顺延到下一个空闲端口） |
| `nx-sk help [主题]` | 命令表（由 action 声明生成，不是手写） |
| `nx-sk version` | 裸输出版本号 |

端口被占不会报错退出：占用者就是**本项目自己的面板** → 不重复启动，直接把浏览器指向它；
占用者是别的服务 → 顺延到下一个空闲端口起自己的面板，并把浏览器指向新面板。
不想开浏览器：`--no-open`（只影响这一次）或 `NX_SERVE_NO_OPEN=1`（所有 nx-xx 项目通用的开关，对整个 shell 生效）。

模块命令（`src/modules/*/index.js` 声明，`nx-sk routes` 可双向查）：

| 命令 | 作用 |
| --- | --- |
| `nx-sk bootstrap [--json]` | 一次拿齐上下文：版本 / 存储路径 / 栏目 / 设置 / 命令表 |
| `nx-sk health` | 存活与存储可达性检查 |
| `nx-sk routes [--module M] [--http "POST /api/entries"]` | 命令 ↔ 路由双向对照 |
| `nx-sk section list \| get \| add \| update \| remove` | 栏目 CRUD |
| `nx-sk section dump <id> [--mask]` | **一个栏目的全部信息**：字段台账 + 全部条目 + 每个条目的未填清单 |
| `nx-sk section tree` | **栏目树**：每个栏目 + 它的条目索引（名称 / 完整度）——面板「栏目管理」一次拿齐，不必逐个 dump |
| `nx-sk section remove-many <ids> [--force]` | 批量删栏目（等同删文件夹，连带条目；有非空栏目必须 `--force`）。找不到的跳过并报告 |
| `nx-sk entry remove-many <ids>` | 批量删条目（ids 逗号分隔）；找不到的跳过并报告，一个都找不到才报错 |
| `nx-sk section templates` | 内置模板（job / secret / projects / internships / campus / deploy / platform / thesis） |
| `nx-sk section sync <id> [--dry-run]` | 按模板**补齐**本栏目缺的分组与字段（只增不改不删）——模板演进后让老栏目追上 |
| `nx-sk section update <id> --add-group / --rename-group / --move-group / --remove-group` | 改**分组骨架**：新增 / 改名（可换 id，字段引用跟着改）/ 上下挪 / 删（空的才让删） |
| `nx-sk section update <id> --set-field / --move-field` | 改**字段**：改标签 / 类型 / 分组 / 提示 / 必填策略，组内上下挪（key 不可改）。面板「编辑栏目」同源 |
| `nx-sk entry list \| get \| add \| update \| remove` | 条目 CRUD（PATCH 语义） |
| `nx-sk entry fields [--section job]` | 字段字典 —— 填之前先看这个，别猜字段名 |
| `nx-sk entry block add <ref> --type <段落\\|标题\\|图文\\|表格\\|清单\\|附件\\|密钥> [--data @x.json] [--after <块id>]` | 追加**块正文**（`entry.body`，可选键）；详细页下半部分同源 |
| `nx-sk entry block update <ref> <块id> [--data @x.json]` | 改块（PATCH 语义）；密钥块在打码态下写回会被拒（星号不能存成密钥） |
| `nx-sk entry block move <ref> <块id> --to <index>` | 移动块（拖拽落点 = 一次 move） |
| `nx-sk entry block remove \\| remove-many <ref> <块id…>` | 删块；批量时找不到的跳过并报告 |
| `nx-sk entry body <ref> [--mask]` | 读块正文（人读渲染；`--mask` 只作用于密钥块） |
| `nx-sk entry ai suggest <ref> --prompt "改短一点" --from @proposal.json [--block <块id>]` | 生成一条**AI 提议**：只落 pending，不写 store。`--from` 是 AI 给出的最终正文（nx-sk 不自带大模型） |
| `nx-sk entry ai list <ref>` | 看待审提议（新的在前）。pending 是运行态，不进 store、不进导出包 |
| `nx-sk entry ai apply <pendingId> [--block <块id>] [--force]` | 应用提议（**唯一会写 store 的一步**）；块被改过 → `CONFLICT`，`--force` 才覆盖 |
| `nx-sk entry ai reject <pendingId>` | 拒绝提议：删掉 pending 文件，数据一个字不动 |
| `nx-sk section view list <id>` | 列视图配置；**没配过时给缺省推断**（表格/精简/看板，标 provisional，不落盘） |
| `nx-sk section view add <id> --type table\\|board\\|kv [--title 名] [--columns 姓名,状态] [--groupby 字段] [--sort 字段:desc]` | 新增视图（第一次 add 把当前生效的推断视图一起固化，chips 不会凭空消失） |
| `nx-sk section view update <id> <viewId> [--title] [--columns] [--sort] [--set col.字段.width=120]` | 改视图；列宽拖拽结束 = 一次 update |
| `nx-sk section view remove <id> <viewId>` | 删视图；删光回到缺省推断态（`defaultView` 一并清掉） |
| `nx-sk section view set-default <id> <viewId>` | 设缺省视图（写 `section.defaultView` —— 是数据，不是面板设置） |
| `nx-sk file list \| get \| add \| update \| remove` | 附件 CRUD（原件在 `~/nx-sk/files/`，同内容去重） |
| `nx-sk file add --path <文件> [--copy] [--category C]` | 导入附件：**默认移动原件**，`--copy` 仅复制 |
| `nx-sk file list [--section <栏目\|none>] [--q 关键字]` | 列附件：按「哪些栏目在引用」筛选（`none` = 未引用）；返回栏目汇总与存储目录 |
| `nx-sk file cleanup [--dry-run]` | **一键清理未被任何条目引用的附件**（孤儿附件，物理原件一并删）；`--dry-run` 先看清单 |
| `nx-sk file restore <id> [--to DIR] [--copy]` | **可逆**：移回原始位置并撤销台账；`--copy` 只导出副本 |
| `nx-sk file content <id>` | 浏览器链接（内联预览 / `?download=1` 下载）；CLI 打印物理路径 |
| `nx-sk file open <id>` | 用系统默认程序打开原件 |
| `nx-sk transfer export <栏目> [--entries 条目,条目] [--passphrase 口令] [--out 文件]` | 栏目/选中条目 + 引用附件打成 ZIP，可设口令加密（栏目页「更多」里同源下载） |
| `nx-sk transfer import <栏目> [--file ZIP] [--on-conflict skip\|copy\|overwrite] [--dry-run]` | 预览/导入到指定栏目；附件按 sha256 复用 |
| `nx-sk transfer import-new [--file ZIP] [--dry-run]` | **零配置**：按包内结构新建栏目（id 冲突加序号） |
| `nx-sk transfer bundle-export [--sections 栏目,栏目] [--passphrase 口令] [--no-files] [--out 文件]` | 多栏目/整库打包成 ZIP（`bundle.json + sections/<id>.zip`），可设口令加密 |
| `nx-sk transfer bundle-import [--file ZIP] [--on-conflict skip\|copy\|overwrite] [--dry-run]` | 整库包解密导入；缺省「合并」只增补不覆盖 |
| `nx-sk transfer import-new [--file ZIP] [--dry-run]` | **零配置**：自动识别单栏目包 / 整库包，按包内结构新建（id 冲突加序号） |
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

### 凭据自动化：账号密码跟着场景走，直接渲染成配置文件

**密钥栏目只放跨场景通用的 key**（`OPENAI_KEY` 这种要 `export` 给各种工具用的）。
**一个场景的账号密码写在那个场景自己的栏目里** —— 场景换了凭据就换，取的时候一眼知道是谁的。

```bash
# 键名像凭据（密码 / 口令 / 密钥 / 账号 / token / apiKey…）→ 自动登记成**密文字段**
# 不必先声明 schema，也不必绕路；落盘是 AES-256-GCM 密文，读出来默认原文
nx-sk entry update "阿里云" --section deploy --set 账号=ops@example.com --set 密码='P@ss…'

# 一个场景多组账号 → 结构清单（密码 / 令牌列密文落盘；列名用 key 或中文标签都认）
nx-sk entry update "阿里云" --section deploy --data '{"凭据清单":[{"名称":"registry","账号":"ci","令牌":"tok-…"}]}'

# 跨栏目对账：所有栏目里的链接 / 账号 / 密码 / 令牌 / 镜像
nx-sk entry keys --reveal

# 出成品配置：取真值 → 替换模板里的 ${VAR} → 落盘
nx-sk entry get "阿里云" --section deploy --json > /tmp/e.json
node assets/nx-sk/scripts/render-config.js /tmp/e.json ./docker-compose.local.yml
```

`deploy` 模板自带「凭据清单」字段；`content` 里只写 `${VAR}` 占位（那份正文是要进 git 的**模板**），
真值放在**凭据清单**里（**场景数据**，密文落盘）—— 模板与实例本来就是两种东西。

**安全边界只有三个出口**：① 推送到 git / 上传云端；② 打进日志或交给第三方；
③ 导出包外发（包里恒为明文，外发必须 `--passphrase`）。
除此之外——本机落盘、密文、数据在仓库之外、面板只听 `127.0.0.1`——都是安全的，
所以「大胆写」不必自我审查密码本身。

统一附件管理（简历、头像、成绩单等原件都收进 `~/nx-sk/files/`）：

```bash
nx-sk file add --path "D:\简历\张三-简历.pdf"   # 默认移动原件进库
nx-sk file list                                  # 台账：按栏目汇总 + 被引用情况
nx-sk file list --section none                   # 只看还没有条目引用的
nx-sk file cleanup --dry-run                     # 一键清理未引用附件：先看会删哪些
nx-sk file cleanup                               # 真删（物理原件一起删，不可撤销）
nx-sk file restore f_xxxx                        # 可逆：移回原始位置、撤销台账
nx-sk file restore f_xxxx --to "D:\资料" --copy  # 或导出副本到指定目录
```

**附件怎么被条目引用**：条目的 `file` 字段存的是**附件 id 的列表**——一个字段可以挂**多个**
附件（简历多版本、头像多张）。id 全局唯一，所以每条条目各有各的附件、互不串台；
同一份原件也能被多条条目引用（sha256 去重后是同一条）。

面板上的三处配合：

- **字段里挑附件**：点「从附件库选…」打开的是**可搜索的选择面板**（不是下拉框）——
  按名称 / 备注 / 标签过滤，**未引用的排在前面**（刚导入还没挂上去的原件就在最上面），
  点一行即追加，可连点多个。
- **附件中心一键清理**：「清理未引用（N）」删掉所有没有任何条目引用的附件
  （判据与「未引用」筛选片同一套），物理原件一并删除，操作前弹确认。
- **条目表单的保存按钮固定在右上角**：有改动时顶栏出现「N 处改动未保存 · 保存」，
  长栏目滚到一半也看得见，不必翻到表单最底；关标签页前还会拦一下。
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

**栏目管理**（设置页）：栏目多了以后收拢头部，一眼分得出主次——把同域栏目**拖**成一个分组，
头部只显示组名、**悬浮展开上下列表**选具体栏目；不常用的栏目拖进「隐藏」容器即不进头部
（`#/栏目id` 直达仍可用）。整个管理页只有「容器 + 拖拽」一套操作：平铺 / 各分组 / 隐藏，
拖进拖出就是归组、换位、显隐；改完统一「保存」（一次存全部设置）。

```bash
# 面板：设置 → 头部导航分组（勾选栏目 / 组内排序 / 改名 / 增删组），保存后头部立即生效
nx-sk setting set --set 'navGroups=[{"title":"求职","sections":["projects","internships","campus"]}]'
nx-sk setting set --set 'navGroups=[]'   # 清空 = 全部栏目恢复平铺
```

分组只是**显示配置**（存在 `settings.navGroups`）：不动栏目与条目的数据，删掉栏目时头部自动略过。

### 表格字段（table）：结构在**数据里**的表单表格

`entrylist`（结构清单）是「变长的几列文本」。**表格字段**再往前一步：每格有类型
（勾选 / 下拉 / 数字 / 日期），还能有**计算列**和**表尾统计**——但**列定义、行、公式、
统计配置全在条目数据里**，不在栏目字典里。所以「这条想多一列」不必改 schema，
也不会影响同一栏目下的其它条目。

```bash
# 建字段：只给类型 + **初始列**（新建条目时表格长什么样；初始列也可以不写）
nx-sk section update mysec --add-field '{"key":"tasks","label":"任务表","type":"table","group":"main","columns":[
  {"key":"task","label":"任务"},
  {"key":"done","label":"已办","type":"bool"},
  {"key":"hours","label":"工时","type":"number","total":"sum"},
  {"key":"rate","label":"单价","type":"number","total":"none"},
  {"key":"cost","label":"费用","formula":"hours * rate","unit":"元"}]}'

# 写入：值是一份自描述文档（列 + 行）。计算列不用给值——给了也不落盘，读的时候现算
nx-sk entry update 周报 --data '{"任务表":{"columns":[…],"rows":[
  {"task":"写文档","done":true,"hours":2,"rate":100},
  {"task":"评审","done":false,"hours":3,"rate":100}]}}'

# 只看这张表：表头 + 数据 + 合计 + 公式报错（只读，现算）
nx-sk entry table 周报 --field 任务表
```

```
  任务    已办  工时  单价  费用(算)
  ------  ----  ----  ----  --------
  写文档  是       2   100    200 元
  评审    否       3   100    300 元
  合计    1/2      5           500 元
```

**公式就是 JS 表达式**（不发明语法），只包成 `return ( … )`，所以 `for` / `var` 这类语句写不进来：

| 想写什么 | 怎么写 |
| --- | --- |
| 同行计算 | `hours * rate`　`工时 * 单价`（**列 key 与中文列名都能当变量**） |
| 取原值 / 整表 | `row.hours`（空格子是 null）　`rows` / `表`（整张表）　`i` 行号　`n` 行数 |
| 取一列 | `col("单价")`　`sum(col("单价"))` |
| 聚合 | `sum / avg / min / max / count / countTrue / countFalse / distinct / median / first / last / join` |
| 数值 | `round / floor / ceil / abs / pct / ratio / clamp`　外加 `Math`、`Number`、`JSON`… |
| 判空 | `isBlank(row.hours)`　`ifEmpty(x, 0)`　`toNum(x)` |

- **计算列按声明顺序算**：只能引用排在它前面的列，天然不循环。算错会给出能照着改的话
  （「公式里用了不存在的名字『qty』，可用的名字：a、b…」）。
- **空格子当 0 / false / ''**（`hours * rate` 不会因为空格子变 NaN）；要判「到底填没填」用 `isBlank(row.x)`。
- **统计两层**：列上的 `total`（`sum|avg|min|max|count|countTrue|countFalse|distinct|median|none`，
  不写就按类型默认：数字求和、勾选计是）决定表尾那一格；整表表达式写在数据的 `totals` 里
  （`{"label":"完成率","expr":"pct(countTrue(col(\"done\")), n)","unit":"%"}`），`summary: false` 关掉表尾。
  统计**不落盘**，每次读现算——不会出现「存下来的合计和现在的数据对不上」。
- 面板上直接**加行 / 加列**、改列类型与公式（「列设置」），改完就是这条数据的一部分。
  敏感列（`sensitive: true`）与顶层敏感字段同一条边界：密文落盘、默认原文、`--mask` 打码。
- **写入即体检**：每条公式在保存前拿一行空值当探针跑一遍，只拦**与数据无关**的错
  （语法错 / 列名解析不到 / 结果不是单值），除零这类「这条数据不巧」留到渲染时逐格报。
  跑不起来就不保存 —— 定义阶段的错误停在定义阶段。
- **空与默认**：`--set 表=` / `[]` / `{}` 都能清空（有初始列时 `[]` 留下「列在、行空」的骨架）；
  列可以带 `default`（新增行时的初值，`0` / `false` 都算数）；数字列默认求和、勾选列默认计是。
- 求值作用域用 `with` + Proxy 封死：`window` / `document` / `process` / `fetch` 都取不到。
  这不是安全沙箱（公式是数据所有者自己写的），而是**把写错的边界前移**。

形状、列的每个键、公式内建表、错误对照表：`nx-sk skill get nx-sk 15-special-fields`
（同一篇也讲了 `entrylist` / `md` / `file` / `source` / `secret` 这几种「值不是标量」的字段）。

### 全局导出 / 导入（多栏目）

**项目里只有一个导出导入模块，没有独立的「备份」模块。** 导出的包就是唯一回退手段：
删栏目 / 条目 / 附件之前先导一份。

「导出导入」页顶部：栏目横向排成 chips，悬浮或点击展开条目可逐条勾选；
顶部「整库」按钮 = 所有栏目全选。选好内容 → 输两次口令（可留空）→「导出 ZIP」浏览器直接下载。
把 ZIP 拖进右侧框即预览（栏目、条目新增/冲突、附件新增/复用），选冲突策略后确认。

口令用**对称加密（AES-256-GCM）**：实现是「内部数据先加密，再套一层合法 ZIP」，
所以外层始终能正常打开（只看到一个 `payload.enc`），不会报「文件夹无效」；
缺口令时明确提示要口令，不会误报成坏包。

整库包结构 `bundle.json + sections/<id>.zip`，与单栏目包同构；导入时逐栏目复用同一套逻辑。

```bash
nx-sk transfer bundle-export --sections job,projects --out all.zip
nx-sk transfer bundle-import --file all.zip --dry-run
nx-sk transfer bundle-import --file all.zip --on-conflict copy
nx-sk transfer import-new --file all.zip      # 零配置：自动识别单栏目包 / 整库包
```

### 只搬一个栏目：ZIP 导出 / 导入

栏目也可以单独打包（含条目、栏目定义、实际引用到的附件）：

```bash
nx-sk transfer export deploy --out D:/tmp/deploy.zip            # 含凭据明文
nx-sk transfer export deploy --passphrase 口令 --out D:/tmp/share.zip # 设口令再给别人
nx-sk transfer export deploy --entries "k8s-deployment,compose" --out D:/tmp/part.zip  # 只导选中条目
nx-sk transfer bundle-export --sections job,deploy --passphrase 口令 --out D:/tmp/enc.zip # 整包加密
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --dry-run # 先预览：新增/冲突/补字段/附件
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip           # 栏目不存在就新建
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --on-conflict copy      # 另存
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --on-conflict overwrite # 覆盖字段
nx-sk transfer import-new --file D:/tmp/deploy.zip               # 零配置：按包内结构新建
```

面板里是栏目页右上角「更多」：导出 ZIP、导入 ZIP…；
条目列表可勾选（表头全选/清空），选中后导出**只带这些条目及其附件**。
把 zip **拖到栏目页任意位置**会导入当前栏目；拖到「栏目」tab 则**零配置新建一个栏目**。
预览会显示来源栏目、目标栏目、条目冲突、将补的字段、附件新增/复用与凭据是否打码，
选好冲突策略再确认。

附件按 sha256 去重（本机已有就复用）；`file` 字段与 `md` 图文里的旧 id 会自动重映射。

## 数据与安全

| 项 | 位置 / 做法 |
| --- | --- |
| 数据目录 | `~/nx-sk/`，可用 `NX_SK_HOME` 覆盖 |
| 状态文件 | `~/nx-sk/store.json`，可用 `NX_SK_STORE` 覆盖；**原子写**（临时文件 + rename） |
| 密文密钥 | 环境变量 `NX_SK_PASSPHRASE`（scrypt 派生 + 盐）优先，否则 `~/nx-sk/.vaultkey`（32 字节随机，0600） |
| 迁移 | 破坏性删除**不留本地快照**：先 `nx-sk transfer export` 导一份，导出的包就是唯一回退手段 |
| 导出 | `~/nx-sk/export/`，默认不含凭据明文 |
| 附件 | `~/nx-sk/files/` 存二进制原件，元数据在 `store.json` 的 `files`（sha256 去重；条目 `file` 字段存附件 id 即建立链接；`file restore` 可逆） |
| 加密导出 | `transfer` 的 `--passphrase`：内部数据经 scrypt(口令)+AES-256-GCM 加密成 `payload.enc`，再套一层**合法 ZIP**（外层能正常打开，不会报「文件夹无效」）；口令不落盘，导入时缺口令明确提示 |
| 服务绑定 | 默认 `127.0.0.1`，不暴露到局域网；写操作校验 `Origin` |
| 数据损坏 | `store.json` 解析失败会先被改名为 `.corrupt-<时间戳>.json`，不会静默覆盖 |

换成口令模式更安全（口令不落盘）：

```bash
export NX_SK_PASSPHRASE='你的长口令'      # 之后所有密文都用它派生
```

注意：**换口令或删掉密钥文件后，旧密文解不开**（这是设计，密文指纹 `kid` 会明确报错）。

## 给 agent 用

```bash
nx-sk skill list                   # 内置 skill 清单
nx-sk skill install               # 装到 ~/.claude/skills/nx-sk（三态，不静默覆盖）
nx-sk skill get nx-sk --json        # {skillName, ref, content, contentBytes, install}
nx-sk skill get nx-sk 10-sections-entries   # 裸名 → references/10-sections-entries.md
```

`nx-sk` 的 ref 路由表：

| ref | 何时读 |
| --- | --- |
| `00-design` | 为什么这么分层、错误码与 `{status}` 的分工 |
| `10-sections-entries` | 填/改信息的完整命令与 AI 补全流程 |
| `20-secrets` | 密文机制、密钥来源、排查「解不开」 |
| `40-files` | 附件库：导入（默认移动）与还原、`file` 字段与条目的链接、附件中心由栏目驱动 |
| `50-deploy` | 存/取 Dockerfile、compose、k8s 清单 |
| `60-transfer` | 栏目 ZIP：导出、预览、导入、冲突策略 |

### sk-pdf：PDF → 图文 SOP 栏目

把用户手册、操作指南转成 nx-sk 里的图文 SOP 栏目（抽正文、按版面挑截图、
上传成附件、在 `md` 字段里 `![]()` 引用），带两个已验证的抽取脚本：

```bash
nx-sk skill install sk-pdf
nx-sk skill get sk-pdf             # 全文
nx-sk skill get sk-pdf 30-pitfalls # 踩过的坑

# 不装也能用（唯一第三方依赖是 PyMuPDF）
python assets/sk-pdf/scripts/pdf_probe.py   book.pdf      # 先探查：有没有图、是不是扫描件
python assets/sk-pdf/scripts/pdf_extract.py book.pdf --out /tmp/out
```

| ref | 何时读 |
| --- | --- |
| `10-extract` | 为什么必须按版面坐标排序取图（顺序错 = 图全配错步骤） |
| `20-sop-schema` | 栏目六段结构（简介/准备材料/入口/手册/常见问题/自检）、账号怎么拆 sensitive 字段 |
| `30-pitfalls` | 占位符忘换 id、本地路径渲染不出、密码泄漏、md 图片被误判未引用… |

### sk-thesis：毕业论文格式与结构

按信息工程学院 2022 版规范（设计开发类）把格式做成**可查的字段**与**可用的 Word 模板**：
页面 2.5/2/2.5/2 cm、1.5 倍行距、宋体小四、标题黑体四号/黑体小四/宋体小四、三线表 1.5·1 磅、
目录域与分节页码（封面与目录不编、标题页起为 1）。

```bash
nx-sk section add thesis --template thesis   # 新建「毕业论文」栏目（9 组 / 59 字段）
nx-sk section get thesis                     # 全部硬指标 + 交稿自检清单
nx-sk skill get sk-thesis 10-format          # 数值速查

# 重新生成模板（本机 managed venv 已装 python-docx）
~/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
  assets/sk-thesis/scripts/make_thesis_template.py
```

| ref | 何时读 |
| --- | --- |
| `10-format` | 页边距、字号、标题层级、图表、参考文献、页码的全部数值 |
| `20-structure` | 章节骨架、每章写什么、开题与论文的格式差异、装订顺序 |
| `30-pitfalls` | 真实错法：一级标题加粗、图题「图 1」多空格、（1）自动编号带悬挂缩进、批注没删 |

## 开发

```bash
pnpm test        # = lint + build + 冒烟 + 单测
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

### 设计取舍与踩坑记录（开发侧）

> 这节原本在随包分发的 `assets/nx-sk/references/00-design.md` 里。
> 那份文档随包发到用户机器，而**代码分层、接口路由、lint 规则用户装了也用不上**——
> 所以开发侧内容归位到仓库，设计思想（栏目=结构 / 条目=数据 / 动态栏目+动态条目 / 聚合所有信息）
> 留在 `assets/nx-sk/references/00-design.md`，那里只讲心智模型与用法。

**错误契约**（映射只写一处，`src/core/errors.js`）：

| code | 判据 | HTTP |
| --- | --- | --- |
| `INVALID_INPUT` | 输入本身不合法 | 400 |
| `NOT_FOUND` | 指定的目标不存在 | 404 |
| `CONFLICT` | 目标存在且与期望状态冲突，需要用户选一侧 | 409 |
| `BLOCKED` | 操作合法但被前置条件挡住（或密钥不一致） | 409 |
| `EXTERNAL` | 外部命令/端口失败 | 502 |
| `INTERNAL` | 兜底 | 500 |

**实测踩过的坑**（每条都是真实事故，写新代码前对一遍）：

| 错误操作 | 实际后果 | 正确做法 |
| --- | --- | --- |
| 把「读命令的过滤 flag」照抄写命令的 `default` | 参数层无条件注入默认值 → 「不传 = 全部」的分支**永远走不到**，不报错、不崩，只是永远返回半个结果 | 写命令的 flag 可带 `default`；读命令的过滤 flag 一律不带 |
| 路由只按声明顺序匹配 | `GET /api/sections/templates` 被 `GET /api/sections/:ref` 遮蔽，命中哪条取决于 actions 数组顺序 | 路由按「字面量段优先」排序，让声明顺序无关（`runtime/spec.js` 的 `compareRoutes`） |
| 把打码值当成新值写回去 | 密钥字段被写成 `sk-1****cdef` 这串掩码，**原凭据永久丢失** | 写入前比对掩码：相等就当成「未改动」保留原密文；含 `******` 的值直接拒绝 |
| 删条目/栏目没有留退路 | 误删即不可逆；这是用户的**唯一一份**个人信息 | 破坏性写操作一律先 `transfer export` 导出，导出的包就是唯一回退手段 —— 不另设本地备份模块 |
| store.json 解析失败就当空库继续 | 下一次写入把用户数据永久覆盖 | 先把损坏文件改名为 `store.json.corrupt-<时间>.json`，再降级返回空结构 |
| 前端 import 了 `node:*` 或 `core/` | Vite 把 Node 侧代码打进浏览器包，dev 模式白屏 | lint 的 `files` 同时覆盖 `view.jsx`，禁掉 `node:*` / `core` / `runtime` / `service.js` |
| 新增模块忘了往 eslint 互依禁列里补一行 | **静默**：新模块变成「谁都可以依赖」，且规则随模块数增加持续衰减 | 在禁列旁留注释说明它是**逐模块枚举**的、漏补是静默的；加模块前先读 `eslint.config.js` |
| 代理前缀 `/api` 与前端源码目录 `api/` 撞车 | 只在 dev 模式整页白屏，报错却是 404 / ECONNREFUSED，离根因很远 | vite 代理加 `bypass`，按「是不是前端资源」分流；并用测试钉住 `shouldServeLocally` |
| 把「上传 / 选择」放到附件中心，再让条目去引用 | 条目里看不到上传入口，用户不知道该在哪儿加文件；附件中心还被迫预定义分类与槽位，跟栏目脱节 | **上传 / 选择发生在栏目条目里**（`file` 字段的值 = 附件 id）；附件中心由栏目驱动、只做统一展示与库存管理，**不预定义分类、不做指派** |
| 字段字典只在模板里、栏目不落盘 | 模板后来新增的字段永远不出现在老栏目里（求职没显示上传框），且没有任何报错 | 栏目实例化时**深拷贝**模板字段；模板演进用 `section sync`（只增不改不删）补 |
| 清单的行只认列 key | 人写的是「密码」，声明的是 `pass` —— agent 按文档写就报错 | 列名**key 与 label 都认**，与顶层 `--set` 同一口径 |

## License

MIT
