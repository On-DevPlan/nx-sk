# nx-sk · 本机个人资源管理器

把你的信息按**条目**存起来，用**目录树**组织；**条目模板只负责初始化**，建完就与条目脱钩。
CLI 与 Web 面板是同一条业务链，敏感字段密文落盘，数据全在你自己机器上 —— 默认 `~/nx-sk/`。

```
nx-sk serve          # 打开面板（http://127.0.0.1:7866）
# 敲 nx-sk 提示找不到命令？在仓库目录直接跑：node bin/nx-sk.mjs serve
# （npm/pnpm 的全局 bin 目录不一定在 PATH 上，见「安装」后面的说明）
```

![结构](https://img.shields.io/badge/node-%3E%3D18.17-informational) ![license](https://img.shields.io/badge/license-MIT-informational)

## 安装

**要求 Node.js >= 18.17。** 包内是构建好的 `dist/`（纯 JS），运行时不需要 TypeScript。

```bash
npm i -g nx-sk        # 命令名就是包名
nx-sk version
nx-sk serve           # 打开面板
```

## 开发

**开发/测试需要 Node >= 22.18**（单测用 `node --test` 直接跑 `.ts`，依赖 Node 原生类型剥离）；
运行 CLI 与面板仍只需 >= 18.17。改了后端要重新构建——`dist/` 是运行时唯一入口。

命令名就是包名。**推荐做成全局垫片**（全局 node_modules 里是指向本项目的软链，
改代码立刻生效，不用重新安装）：

```bash
cd <本项目>
pnpm install          # 只为构建面板；CLI 侧零依赖
pnpm run build        # tsc → dist/**/*.js，vite → dist/web/public
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

> 不想污染全局也行：先 `pnpm build`，再 `node bin/nx-sk.mjs <子命令>`，或 `npx --no-install . <子命令>`。

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
| `nx-sk backup export --password 口令` | `nx-sk transfer export <条目模板> --passphrase 口令 --out x.zip` |
| `nx-sk backup import --file x.nxskbak` | `nx-sk transfer import-new --file x.zip` |
| `nx-sk export run --format both --out DIR` | `nx-sk transfer bundle-export --out x.zip`（ZIP，不是可读副本） |
| `nx-sk export list` | ——（已删；文件由你放到哪就在哪） |
| 面板「导出与备份」 | 面板「导出导入」（条目树选择，全选即整库；设置页「全量备份」） |

仍然可用的命令：`transfer export` / `transfer import` / `transfer bundle-export` /
`transfer bundle-import` / `transfer import-new`。

- **旧的 `.nxskbak` 文件不再可导入。** 升级前请先在 0.11.x 下导出一份
  （`nx-sk transfer bundle-export --out x.zip`），升级后用 `transfer import-new --file x.zip` 导回。
- 破坏性删除（删条目模板 / 条目 / 附件）**不再自动留快照** —— 删之前先导一份。
- `transfer export --no-secrets` 移除：包里恒为明文，保护只靠 `--passphrase`。
- 加密包格式变了（外层是合法 ZIP、内含 `payload.enc`），旧包仍可导入；
  但 Windows 上不再报「压缩文件夹错误」了。

## 它是什么

一个「本机工具类」项目的标准骨架实现（server-cli-web）：**serve 驱动 CLI 与 Web，
CLI 与 API 同源，skill 驱动 agent**。落到具体功能上：

**首次运行只播种一个「字段样例」条目模板**（`demo`），连一条示例条目一起——把能力直接摆给你看：

| 组 | 字段 |
| --- | --- |
| 基本字段（标量） | 单行文本 / 多行文本 / 数字 / 是否 / 下拉框 / 日期 / 月份 / 标签 |
| 组合字段（值有形状） | **结构清单**（变长行 + 密文列）、**表格**（列在数据里 + 计算列 + 表尾合计/平均/计数） |
| 富内容 | **图文**（markdown + 贴图 + 待办）、**对齐确认**（Grill & Ack：AI 提问 / Web 逐条回答 / ack 回执）、**附件**、**密钥**（AES-256-GCM 密文） |

外加每个条目模板自带的「原始资料」袋。示例条目把这些都填好了——打开面板就能试，
改坏了自己删（`entry remove 示例条目`），或按条目模板重建（`entry add --template demo --title 示例条目`）。

**其它 8 个条目模板不再自动播种**，要用时建（条目模板只是**建议清单**，`--set 任意键=值` 直接写）：

| 条目模板 | id | 内容 |
| --- | --- | --- |
| 求职 | `job` | 求职用的个人信息档案：10 个分组 / 80 个字段（姓名、学历、联系方式、求职意向、紧急联系人…） |
| 项目经历 | `projects` | 一个项目一个条目：名称 / 角色 / 时间 / 技术栈 / 职责与亮点 |
| 实习/工作经历 | `internships` | 一段经历一个条目：公司 / 岗位 / 时间 / 职责 |
| 校内职务/实践 | `campus` | 一条职务或实践一个条目：职务 / 组织 / 时间 / 职责 |
| 密钥 | `secret` | **普通条目模板里的一个安全 list&lt;kv&gt; 字段**：`keys` 结构清单，一行一个「名称 → 值」，值列用 **AES-256-GCM** 密文落盘，读出来默认原文（`--mask` 才打码）。第一次 `key set` 没有它时会自动补建 |
| 部署配置 | `deploy` | **一份配置文件一个条目**（Dockerfile / docker-compose / k8s 清单）：正文即文件原文，外加「放哪 / 哪些值要替换 / **这个场景自己的凭据清单** / 何时用」，好让它在别的项目里照着用 |

条目模板不是写死的——
条目模板只是**初始化蓝图**：`entry add --template <条目模板>` 时把字段结构深拷贝进条目，
此后这条条目按自己的结构行演化；条目模板再改也不会回刷存量条目。条目 id 已是唯一键——
`entry get/update/remove <id>` 不需要 `--template`，该参数只在用标题定位、需要消歧时可选。
条目模板可加（`template add`，不给字段就是空白条目模板）、可改（`template update --add-field`）、
可删除（`template remove`，条目回落到空白条目模板，不删条目）；也可以把一条已经填好的条目
`entry save-as-template` 直接存成新条目模板。面板里同样能在条目页顶栏点「存为模板」——
弹窗预填模板 id、名称和说明，保存的是这条条目当前的字段结构（只抄结构，不抄值）。
加字段/删字段不会改代码。

面板「条目模板管理」是这套能力的 Notion 式入口：每行只留一个「更多」菜单（改名 / 编辑字段与结构 / 看信息 / 删除），
左侧 `⠿` 把手能拖动排序（插入线表示落在谁前谁后）；新建的条目模板排到末尾，再拖到想要的位置。
批量删除默认收起，从顶部「更多」里的「批量删除…」进入后才出现勾选框与「删除选中」，删完自动退出。

内置条目模板共 **9 个**——除 `demo` 与上面 6 个外还有 `platform`（容器平台：控制台链接 / 账号 / 密码 / 镜像）
与 `thesis`（毕业论文规范字段化），需要时 `template add <id> --preset platform|thesis` 建。

## 条目、条目模板与目录（0.43）

**条目是唯一内容节点**：一条条目自己持有字段结构（分组 + 字段 + 值），可以独立增删字段。

**条目模板只用于初始化**：建条目时按条目模板深拷贝一份结构；建完两者就没有关系了。
条目模板后续怎么改，都不会回刷已有条目（要补结构用条目自己的 `--add-field`，或显式迁移）。

**目录就是条目父子关系**：没有独立的 folder 实体。一条条目有子条目，它就是文件夹；
没有子条目，它就是文件。左侧导航就是这棵树，支持展开/折叠、按标题搜索、右键新建子条目、
拖动条目调整层级与同级顺序（拖到条目中央 = 收成子条目，拖到行上/下缘 = 插到它前/后）。

**Web 新建条目**：根目录按钮、树节点「＋」、条目模板页的「新建条目」都走同一个创建弹窗，
可以在创建时选模板或空白条目。子条目默认空白——父条目只决定目录位置，不会把父条目的模板
继承给子条目；模板只把字段结构深拷贝进新条目，建完后两边互不影响。

```
templates / template_fields   条目模板蓝图（只读来建新条目）
entries + folders             内容和目录（folders 表只存 parent_id + sort）
```

旧版「每组条目挂在容器下」的模型在 v7 迁移时变成一条空 folder 条目，原来的条目全部挂到它下面；
`template remove` 删除条目模板时只把条目回落到空白条目模板 `__blank__`，不删条目。

> 术语：命令组叫 `template *`，操作的是**条目模板**；现在没有独立的容器实体，
> 分组关系只存在于条目的父子目录里。

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
| `nx-sk status [--limit N]` | **默认条目上下文（agent 首选入口）**：默认条目 + 它这一支的条目（广度优先，按 `settings.entryScopeLimit` 截断，默认 5）+ 一段可直接执行的提示词 |
| `nx-sk bootstrap [--json]` | 一次拿齐上下文：版本 / 存储路径 / 条目模板 / 目录树 / 设置 / 命令表 |
| `nx-sk health` | 存活与存储可达性检查 |
| `nx-sk routes [--module M] [--http "POST /api/entries"]` | 命令 ↔ 路由双向对照 |
| `nx-sk template list \| get \| add \| update \| remove` | 条目模板 CRUD（条目模板只用于初始化条目；删除不删条目） |
| `nx-sk template dump <id> [--mask]` | **一个条目模板的全部信息**：字段台账 + 用它初始化过的条目 + 每条未填清单 |
| `nx-sk template tree` | **条目模板视图**：每个条目模板 + 用它初始化过的条目索引（名称 / 完整度）——管理页用；导航树走 `entry tree` |
| `nx-sk template reorder <ids>` | 按给定顺序重排条目模板（拖动排序的落盘入口；未列出的排在后面） |
| `nx-sk template remove-many <ids>` | 批量删除条目模板（条目不删，回落到空白条目模板；空白模板不可删）。找不到的跳过并报告 |
| `nx-sk entry remove-many <ids>` | 批量删条目（ids 逗号分隔）；找不到的跳过并报告，一个都找不到才报错 |
| `nx-sk template presets` | 内置条目模板预置（job / secret / projects / internships / campus / deploy / platform / thesis） |
| `nx-sk template sync <id> [--dry-run]` | 按预置**补齐**本条目模板缺的分组与字段（只增不改不删）——预置演进后让老条目模板追上 |
| `nx-sk template update <id> --add-group / --rename-group / --move-group / --remove-group` | 改**分组骨架**：新增 / 改名（可换 id，字段引用跟着改）/ 上下挪 / 删（空的才让删） |
| `nx-sk template update <id> --set-field / --move-field` | 改**字段**：改标签 / 类型 / 分组 / 提示 / 必填策略，组内上下挪（key 不可改）。面板「编辑条目模板」同源 |
| `nx-sk entry list \| get \| add \| update \| remove` | 条目 CRUD（PATCH 语义）；`add --parent` 建子条目，删有子条目的条目会删整棵子树。`--tags` 读写条目标签，`entry list --tag` / `--tag-mode all` 按标签过滤。`--desc` 是条目的一句话说明（给 agent / 人认条目用，不是字段、不进完整度）；`entry list --missing-desc` 专找还没写的 |
| `nx-sk entry get \| update \| table \| history \| context`（省略 `<ref>`） | 作用在 `settings.defaultEntry` 上；删除 / 移动 / 改标题仍必须显式给 id |
| `nx-sk entry search [--q] [--tag] [--tag-mode all|any] [--template] [--parent] [--limit]` | 轻量搜索：标题 / 模板标题 / tag / 字段标签 / 非敏感字段值；只返回命中定位信息，不返回完整 values |
| `nx-sk entry add --tags` / `entry update --tags` | 新建时从模板继承默认 tags，显式 `--tags` 只追加；更新时整体替换条目标签 |
| `nx-sk entry tree [--parent <父>] [--depth N]` | **目录树**：扁平节点（id / 标题 / parent / sort / 子节点数），左侧导航的唯一来源 |
| `nx-sk entry context <条目>` | 一条条目的祖先链 + 直接子条目（agent 读层级关系用） |
| `nx-sk entry move <条目> --parent <父\|root>` | 移动条目（拒绝成环）；`--before <兄弟>` / `--after <兄弟>` 精确插到前/后（面板拖拽落点），`entry move-many` 批量移动 |
| `nx-sk entry save-as-template <条目> [--id X] [--title Y]` | 把条目当前结构存成条目模板（只抄结构，不抄值） |
| `nx-sk entry fields [--template job]` | 字段字典 —— 填之前先看这个，别猜字段名 |
| `nx-sk file list \| get \| add \| update \| remove` | 附件 CRUD（原件在 `~/nx-sk/files/`，同内容去重） |
| `nx-sk file add --path <文件> [--copy] [--category C]` | 导入附件：**默认移动原件**，`--copy` 仅复制 |
| `nx-sk file list [--template <条目模板\|none>] [--q 关键字]` | 列附件：按「哪些条目模板在引用」筛选（`none` = 未引用）；返回条目模板汇总与存储目录 |
| `nx-sk file cleanup [--dry-run]` | **一键清理未被任何条目引用的附件**（孤儿附件，物理原件一并删）；`--dry-run` 先看清单 |
| `nx-sk file restore <id> [--to DIR] [--copy]` | **可逆**：移回原始位置并撤销台账；`--copy` 只导出副本 |
| `nx-sk file content <id>` | 浏览器链接（内联预览 / `?download=1` 下载）；CLI 打印物理路径 |
| `nx-sk file open <id>` | 用系统默认程序打开原件 |
| `nx-sk transfer export <条目模板> [--entries 条目,条目] [--passphrase 口令] [--out 文件]` | 条目模板/选中条目 + 引用附件打成 ZIP，可设口令加密（条目模板页「更多」里同源下载） |
| `nx-sk transfer import <条目模板> [--file ZIP] [--on-conflict skip\|copy\|overwrite] [--dry-run]` | 预览/导入到指定条目模板；附件按 sha256 复用 |
| `nx-sk transfer import-new [--file ZIP] [--dry-run]` | **零配置**：按包内结构新建条目模板（id 冲突加序号） |
| `nx-sk transfer bundle-export [--templates 条目模板,条目模板] [--passphrase 口令] [--no-files] [--out 文件]` | 多条目模板/整库打包成 ZIP（`bundle.json + templates/<id>.zip`），可设口令加密 |
| `nx-sk transfer bundle-import [--file ZIP] [--on-conflict skip\|copy\|overwrite] [--dry-run]` | 整库包解密导入；缺省「合并」只增补不覆盖 |
| `nx-sk transfer import-new [--file ZIP] [--dry-run]` | **零配置**：自动识别单条目模板包 / 整库包，按包内结构新建（id 冲突加序号） |
| `nx-sk setting get \| set` | 全局设置（含 `defaultEntry` 默认条目、`entryScopeLimit` status 上下文条数 1–50、`defaultTemplate`） |
| `nx-sk skill list \| install \| get` | 把内置 skill 装给 agent / 给外部 agent 取上下文 |

所有写命令都有 `--dry-run`；所有命令都支持 `--json`（标准输出**单个** JSON 值）。

## 快速上手

```bash
pnpm install
pnpm start                     # 构建前端 + 起面板
# 或开发模式（vite :5180 + serve :7866，一个 Ctrl-C 关两个）
pnpm run dev
```

让 agent 接手时先跑一条：

```bash
nx-sk setting set --set defaultEntry=<条目>        # ① 指定「当前工作条目」
nx-sk status                                       # ② 拿到默认条目 + 子条目 + 该怎么动的提示词
nx-sk entry update --set 字段=值                    # ③ 省略条目 = 改默认条目
```

用 CLI 填一份档案：

```bash
nx-sk entry fields --template job --json          # ① 看字段字典
nx-sk entry add --template job --set 姓名=张三 --set 电话=13800000000 --json
nx-sk entry update 张三 --data @补全.json --dry-run   # ② 批量补，先试运行
nx-sk entry update 张三 --data @补全.json
nx-sk template dump job --json                    # ③ 复核：完整度 + 未填清单
```

存一个大模型 key —— 密钥只是普通条目模板里的**一个安全 list&lt;kv&gt; 字段**（名称 → 值，**值不会以明文进库**）：

```bash
nx-sk key set OPENAI_KEY sk-xxxxxxxx     # 写入：不存在则新建，存在则覆盖
nx-sk key get OPENAI_KEY                 # 取值：默认就是原文
nx-sk key get OPENAI_KEY --mask           # 投屏/截图时才打码：sk-x******xxxx
nx-sk key list                            # 所有键（默认原文）
nx-sk key remove OPENAI_KEY               # 删除，写前自动留快照
```

状态与条目模板一样：`key *` 只是 `entry *` 的语法糖（同模块、同一批 service 函数），
默认作用在 `secret` 模板的 `keys` 字段上；旧的「一条一键」单值模板仍可按 `--template` 读写。

旧库如果还是「一个密钥一个条目」，可以一次性合并成一个 `keys` 清单条目（先备份；`--dry-run` 只算不改）：

```bash
nx-sk key consolidate --dry-run   # 看要合并多少条
nx-sk key consolidate             # 落到一个承载条目；重复跑是幂等的
```

`key consolidate` 会把旧单值字段按密文边界重新加密到 `keys` 清单里，并删除旧的单值子条目；
如果旧条目都挂在同一个空白容器下，容器本身会成为承载条目，树上最终只剩一个节点。

### 凭据自动化：账号密码跟着场景走，直接渲染成配置文件

**密钥条目模板只放跨场景通用的 key**（`OPENAI_KEY` 这种要 `export` 给各种工具用的）。
**一个场景的账号密码写在那个场景自己的条目模板里** —— 场景换了凭据就换，取的时候一眼知道是谁的。

```bash
# 键名像凭据（密码 / 口令 / 密钥 / 账号 / token / apiKey…）→ 自动登记成**密文字段**
# 不必先声明 schema，也不必绕路；落盘是 AES-256-GCM 密文，读出来默认原文
nx-sk entry update "阿里云" --template deploy --set 账号=ops@example.com --set 密码='P@ss…'

# 一个场景多组账号 → 结构清单（密码 / 令牌列密文落盘；列名用 key 或中文标签都认）
nx-sk entry update "阿里云" --template deploy --data '{"凭据清单":[{"名称":"registry","账号":"ci","令牌":"tok-…"}]}'

# 跨条目模板对账：所有条目模板里的链接 / 账号 / 密码 / 令牌 / 镜像
nx-sk entry keys --reveal

# 出成品配置：取真值 → 替换模板里的 ${VAR} → 落盘
nx-sk entry get "阿里云" --template deploy --json > /tmp/e.json
node assets/nx-sk/scripts/render-config.js /tmp/e.json ./docker-compose.local.yml
```

`deploy` 预置自带「凭据清单」字段；`content` 里只写 `${VAR}` 占位（那份正文是要进 git 的**模板**），
真值放在**凭据清单**里（**场景数据**，密文落盘）—— 模板与实例本来就是两种东西。

**安全边界只有三个出口**：① 推送到 git / 上传云端；② 打进日志或交给第三方；
③ 导出包外发（包里恒为明文，外发必须 `--passphrase`）。
除此之外——本机落盘、密文、数据在仓库之外、面板只听 `127.0.0.1`——都是安全的，
所以「大胆写」不必自我审查密码本身。

统一附件管理（简历、头像、成绩单等原件都收进 `~/nx-sk/files/`）：

```bash
nx-sk file add --path "D:\简历\张三-简历.pdf"   # 默认移动原件进库
nx-sk file list                                  # 台账：按条目模板汇总 + 被引用情况
nx-sk file list --template none                   # 只看还没有条目引用的
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
  长条目模板滚到一半也看得见，不必翻到表单最底；关标签页前还会拦一下。
**上传 / 选择发生在条目的字段里**（求职 → 张三 → 「简历附件」直接上传或从库里选），
不在附件中心做指派：

```bash
FID=$(nx-sk file add --path "D:\简历\张三-简历.pdf" --json | 取 id)
nx-sk entry update 张三 --set resumeFile=$FID       # 挂一个（存成单元素数组）
nx-sk entry update 张三 --set resumeFile=$FID,f_xxx # 逗号分隔挂多个
nx-sk entry get 张三 --template job              # 每个附件各占一行：附件名 + 物理路径
nx-sk file get $FID                             # 反查「被引用：求职 / 张三 / 简历附件」
```

**「附件」中心由条目引用驱动、不预定义任何分类或槽位**：它只展示当前库里存在的原件，
筛选片按「哪些条目在引用附件」生成（外加「未引用」），每张卡片显示被哪个条目、哪个字段引用；
条目模板只负责解释字段结构，附件本身始终挂在条目上。
工作台支持拖拽 / 点按钮上传、本机路径导入、搜索、图片缩略图、内联预览、下载、复制物理路径 / 链接、
编辑名称与备注、还原。求职条目表单的「附件资料」组里，
**简历附件 / 头像图片 / 成绩单 / 证书扫描件** 直接就地「上传文件」或从库里选。

> **看不到这些上传框？** 条目在创建时把条目模板字段**深拷贝**下来，此后独立演化，
> 所以**条目模板后来新增的字段不会自动出现在已建好的条目里**。
> 若你的求职条目是很早建的，跑一次 `nx-sk template sync job`（或面板「条目模板 → 编辑 → 同步预置字段」）
> 就能把预置新增的「附件资料」组与 4 个 `file` 字段补进来，且不改动你已有的字段与数据。

**条目模板只负责初始化，不做分组**：左侧导航是条目树，模板页只管字段结构与「新建条目」时的初始值。
旧版的头部导航分组配置（`settings.navGroups` / `navHidden` / `navOrder`）保留为兼容读取，
面板不再提供管理入口，也不再拿模板当导航容器。

### 表格字段（table）：结构在**数据里**的表单表格

`entrylist`（结构清单）是「变长的几列文本」。**表格字段**再往前一步：每格有类型
（勾选 / 下拉 / 数字 / 日期），还能有**计算列**和**表尾统计**——但**列定义、行、公式、
统计配置全在条目数据里**，不在条目模板字典里。所以「这条想多一列」不必改 schema，
也不会影响同一条目模板下的其它条目。

```bash
# 建字段：只给类型 + **初始列**（新建条目时表格长什么样；初始列也可以不写）
nx-sk template update mysec --add-field '{"key":"tasks","label":"任务表","type":"table","group":"main","columns":[
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

形状、列的每个键、公式内建表、错误对照表：`nx-sk skill get nx-sk B02-字段类型与格式`
（同一篇也讲了 `entrylist` / `md` / `file` / `source` / `secret` 这几种「值不是标量」的字段）。

### 对齐确认（grill）：AI 提问，你在 Web 里逐条答，agent 读 ack

这是给「必须让用户拍板、不能由 AI 猜」的场景用的字段。值是一份 JSON 表单，
端着问题、答案和确认状态；Web 上它只露一个**很小的状态按钮**，点开才是
`Peek` 的三种形态（侧边 / 居中 / 整页，默认整页）。AI 写问题，用户填写，
点「确认并回写」后整份 JSON 留在条目里，agent 下次 `entry get` 直接读。

```bash
# 1) 建字段（已有字段就跳过；类型必须是 grill）
nx-sk template update mysec --add-field \
  '{"key":"grill","label":"对齐确认","type":"grill","group":"main"}'

# 2) AI 写问题。最小形状只需要 questions；schema / intro / prompt 可选
nx-sk entry update 周报 --set 'grill={
  "schema":"nx-sk/grill@1",
  "title":"周报范围对齐",
  "intro":"这是我替你做的假设，逐条确认或否定。",
  "prompt":"先别写，等我确认范围。",
  "questions":[
    {"id":"scope","type":"single","title":"范围包含哪些？",
     "options":[{"value":"core","label":"只做核心"},{"value":"all","label":"全做","recommended":true}]},
    {"id":"checks","type":"multi","title":"验收要看哪些证据？",
     "options":[{"value":"tests","label":"测试全绿"},{"value":"manual","label":"手动验证"}]},
    {"id":"note","type":"text","title":"还有什么必须一起确认的？","required":false}
  ]
}'

# 3) 用户在 Web 里答完并点确认后，agent 这样读回执
nx-sk entry get 周报 --json
```

**答案形状**由问题类型决定：`single` 存候选的 `value` 字符串；`multi` 存 `value` 数组；
`confirm` 存 `true/false`；`text` 存字符串。每题的 `note` 是用户补充的理由，建议 AI
写问题时把「为什么需要这条确认」放进 `detail`，不要让用户面对一条没有上下文的问题。

**`ack` 不是装饰，也不能由 AI 伪造**：只有所有 `required` 问题都有答案时，
服务端才允许 `status: "acknowledged"`；必答没答完会被强制退回 `pending`。
确认后再改任何一格，Web 会自动把状态退回 `pending` 并要求重新确认。回执长这样：

```json
"ack": {
  "status": "acknowledged",
  "at": "2026-11-20T10:38:52.278Z",
  "by": "web",
  "answered": 3,
  "total": 3
}
```

agent 的判据只有一条：**`ack.status === "acknowledged"` 才继续执行**；`pending`
说明用户还没拍板，不要把「问题存在」当成「已经对齐」。

### 全局导出 / 导入（条目树）

**项目里只有一个导出导入模块，没有独立的「备份」模块。** 导出的包就是唯一回退手段：
删条目 / 附件之前先导一份。设置页另有「全量备份」页，复用同一面板、范围固定为全部条目。

「导出导入」页左侧直接显示**条目树**：勾一个条目 = 连同全部嵌套子条目一起导出，支持多选；
顶部「全选」= 整库，「清空」= 取消选择；每行右侧还有「快速导出这个条目及全部子条目」的图标。
不再按条目模板分栏——模板只负责创建条目时的字段初始化，不是聚类维度。
选好内容 → 输两次口令（可留空）→「导出 ZIP」浏览器直接下载。
把 ZIP 拖进右侧框即预览（条目/字段结构、新增/冲突、附件新增/复用），选冲突策略后确认。

目录层级会跟包走：单包 manifest 每条带 `parent/sort`；整库 `bundle.json` 的 `tree`
记录跨模板父子边（文件夹常在 `__blank__`，子条目在各自模板），导入后统一挂回父。

口令用**对称加密（AES-256-GCM）**：实现是「内部数据先加密，再套一层合法 ZIP」，
所以外层始终能正常打开（只看到一个 `payload.enc`），不会报「文件夹无效」；
缺口令时明确提示要口令，不会误报成坏包。

整库包结构 `bundle.json + templates/<id>.zip`，与单条目模板包同构；导入时逐条目模板复用同一套逻辑。

```bash
nx-sk transfer bundle-export --templates job,projects --out all.zip
nx-sk transfer bundle-import --file all.zip --dry-run
nx-sk transfer bundle-import --file all.zip --on-conflict copy
nx-sk transfer import-new --file all.zip      # 零配置：自动识别单条目模板包 / 整库包
```

### 只搬一个模板定义（CLI 兼容）

面板不再提供「按条目模板导出」入口：搬内容统一去「导出导入」页按条目树选。
条目模板页只保留「把 ZIP 拖进来」的快捷导入（导入到当前模板），不再摆导出菜单。

CLI 仍保留按模板打包的兼容路径（含条目、模板定义、实际引用到的附件），适合脚本与批量迁移：

```bash
nx-sk transfer export deploy --out D:/tmp/deploy.zip            # 含凭据明文
nx-sk transfer export deploy --passphrase 口令 --out D:/tmp/share.zip # 设口令再给别人
nx-sk transfer export deploy --entries "k8s-deployment,compose" --out D:/tmp/part.zip  # 只导选中条目
nx-sk transfer bundle-export --templates job,deploy --passphrase 口令 --out D:/tmp/enc.zip # 整包加密
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --dry-run # 先预览：新增/冲突/补字段/附件
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip           # 条目模板不存在就新建
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --on-conflict copy      # 另存
nx-sk transfer import deploy2 --file D:/tmp/deploy.zip --on-conflict overwrite # 覆盖字段
nx-sk transfer import-new --file D:/tmp/deploy.zip               # 零配置：按包内结构新建
```

包里有条目时，层级仍按 `parent/sort` 还原；附件按 sha256 去重（本机已有就复用），`file` 字段与 `md` 图文里的旧 id 会自动重映射。

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

**随包只有一个 skill**：`assets/nx-sk/`（A 序列 = 动作，B 序列 = 知识：`A07-把PDF转成图文SOP` 是「做这件事」，`B02-字段类型与格式` 是「查这条知识」），
脚本与论文模板也在同一个目录里跟着走。

```bash
nx-sk skill list                    # 内置 skill 清单（现在只有 nx-sk 一个）
nx-sk skill install                 # 装到 ~/.claude/skills/nx-sk（三态，不静默覆盖）
nx-sk skill get nx-sk --json        # {skillName, ref, content, contentBytes, install}
nx-sk skill get nx-sk A01-填一条信息   # 裸名 → references/A01-….md
```

### A 序列：动作（do something，照着做）

| ref | 场景 |
| --- | --- |
| `A01-填一条信息` | 记录/更新信息、填求职档案、扩字段；先看台账再写值 |
| `A02-整理一堆乱资料` | 一团输入（话/链接/表格/截图清单）→ 先查后建条目模板 → 定字段 → 填值 |
| `A03-把原件回写进条目` | 原件先入 `source` 袋 → 映射字段 → 标 `mapped` 留痕 → 冲突留旧的 |
| `A04-存密钥和凭据` | 安全 list&lt;kv&gt; 字段 + 场景凭据归属 + 把真值渲染成 compose/k8s/.env |
| `A05-收一份附件` | 简历头像成绩单：导入（默认移动）、挂 `file` 字段、清理与还原 |
| `A06-存一份部署配置` | 存/取 Dockerfile、compose、k8s 清单：一份配置一个条目 |
| `A07-把PDF转成图文SOP` | 手册 PDF → 图文 SOP 条目模板（抽取脚本 + 挑图 + 条目模板结构） |
| `A08-排一篇论文格式` | 信息工程学院 2022 版格式、模板生成、交稿自检 |
| `A09-搬走一个条目模板` | 条目 / 子树 ZIP 导出导入（条目树选择、层级保留）、设置页全量备份、三种冲突策略 |

### B 序列：格式与字段的知识（查，不是动作）

| ref | 内容 |
| --- | --- |
| `B01-概念与放置` | 条目模板=结构 / 条目=数据 / 分组=组字段；东西该往哪儿放 |
| `B02-字段类型与格式` | 全字段值形状、table 公式与统计、entrylist 列、md 图片、file id… |
| `B03-踩坑合集` | PDF、论文、归档三组真实踩坑 |

### 脚本与模板（都在这一个 skill 里）

```bash
python assets/nx-sk/scripts/pdf_probe.py   book.pdf       # 先探查：有没有图、是不是扫描件
python assets/nx-sk/scripts/pdf_extract.py book.pdf --out /tmp/out
python assets/nx-sk/scripts/make_thesis_template.py \
  --out assets/nx-sk/templates/毕业论文模板-设计开发类.docx
node assets/nx-sk/scripts/render-config.js entry.json ./docker-compose.local.yml
```

`A07` 的 ref 里还写着「为什么必须按版面坐标取图」（顺序错 = 图全配错步骤）；
`A08` 的 ref 里是页边距/字号/标题层级/图表/参考文献的全部数值与章节骨架。
毕业论文条目模板本身用 `nx-sk template add thesis --preset thesis` 建，`template get thesis` 查硬指标。

## 开发

```bash
pnpm test        # = lint + build + 冒烟 + 单测
```

| 目录 | 职责 |
| --- | --- |
| `bin/nx-sk.mjs` | 唯一入口，只转发 argv + 兜异常 |
| `src/core/` | 零业务语义：paths / errors / store / fsx / crypto / vault / fields / attachments / render / ids / open |
| `src/modules/<域>/` | `index.js`(action 声明) + `service.js`(业务)。**不声明视图** |
| `src/runtime/` | registry / spec / cli / api / server —— 装配层，不写业务 |
| `src/web/frontend/` | React 壳 + 组件 + `modules/<域>/view.jsx` + 视图注册表（视图只住这里） |
| `assets/nx-sk/` | 随包分发的 skill（SKILL.md + references/） |
| `tests/unit/` · `tests/smoke.mjs` | 一致性断言 + 端到端冒烟 |

**加一个功能域要碰的 12 处**（其中 3 处没有任何断言会替你发现）属于**开发规范、不属于随包分发的
agent 手册** —— 它写在创建本项目的脚手架 skill `server-cli-web-scaffold` 的
`references/A07-extension-loop.md`，`assets/nx-sk/` 里只放「怎么用 nx-sk」。

### 设计取舍与踩坑记录（开发侧）

> 这节原本在随包分发的 `assets/nx-sk/references/B01-概念与放置.md` 里。
> 那份文档随包发到用户机器，而**代码分层、接口路由、lint 规则用户装了也用不上**——
> 所以开发侧内容归位到仓库，设计思想（条目模板=结构 / 条目=数据 / 动态条目模板+动态条目 / 聚合所有信息）
> 留在 `assets/nx-sk/references/B01-概念与放置.md`，那里只讲心智模型与用法。

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
| 路由只按声明顺序匹配 | `GET /api/templates/templates` 被 `GET /api/templates/:ref` 遮蔽，命中哪条取决于 actions 数组顺序 | 路由按「字面量段优先」排序，让声明顺序无关（`runtime/spec.js` 的 `compareRoutes`） |
| 把打码值当成新值写回去 | 密钥字段被写成 `sk-1****cdef` 这串掩码，**原凭据永久丢失** | 写入前比对掩码：相等就当成「未改动」保留原密文；含 `******` 的值直接拒绝 |
| 删条目/条目模板没有留退路 | 误删即不可逆；这是用户的**唯一一份**个人信息 | 破坏性写操作一律先 `transfer export` 导出，导出的包就是唯一回退手段 —— 不另设本地备份模块 |
| store.json 解析失败就当空库继续 | 下一次写入把用户数据永久覆盖 | 先把损坏文件改名为 `store.json.corrupt-<时间>.json`，再降级返回空结构 |
| 前端 import 了 `node:*` 或 `core/` | Vite 把 Node 侧代码打进浏览器包，dev 模式白屏 | lint 的 `files` 覆盖整个 `src/web/frontend/**`（视图都在这里），禁掉 `node:*` / `core` / `runtime` / `service.js` |
| 新增模块忘了往 eslint 互依禁列里补一行 | **静默**：新模块变成「谁都可以依赖」，且规则随模块数增加持续衰减 | 在禁列旁留注释说明它是**逐模块枚举**的、漏补是静默的；加模块前先读 `eslint.config.js` |
| 代理前缀 `/api` 与前端源码目录 `api/` 撞车 | 只在 dev 模式整页白屏，报错却是 404 / ECONNREFUSED，离根因很远 | vite 代理加 `bypass`，按「是不是前端资源」分流；并用测试钉住 `shouldServeLocally` |
| 把「上传 / 选择」放到附件中心，再让条目去引用 | 条目里看不到上传入口，用户不知道该在哪儿加文件；附件中心还被迫预定义分类与槽位，跟条目脱节 | **上传 / 选择发生在条目里**（`file` 字段的值 = 附件 id）；附件中心只按条目引用做统一展示与库存管理，**不预定义分类、不做指派** |
| 字段字典只在模板里、条目模板不落盘 | 模板后来新增的字段永远不出现在老条目模板里（求职没显示上传框），且没有任何报错 | 条目模板实例化时**深拷贝**模板字段；模板演进用 `template sync`（只增不改不删）补 |
| 清单的行只认列 key | 人写的是「密码」，声明的是 `pass` —— agent 按文档写就报错 | 列名**key 与 label 都认**，与顶层 `--set` 同一口径 |

**开发环境：TypeScript LSP**（详见 `docs/dev-lsp.md`）

LSP 由本地 plugin `ts-lsp@local` 提供：hover / 定义跳转 / 引用查找 / 文档符号 / 工作区符号 / 重命名。

| 坑 | 后果 | 正确做法 |
| --- | --- | --- |
| 把 `lspServers` 写进 `settings.json` | **不报错，也不生效**——这个键只存在于 plugin manifest | 走 plugin：`marketplace add` → `plugin install`，见 `docs/dev-lsp.md` |
| 装了 plugin 就在当前会话用它 | 旧会话不热加载新注册的 server，工具报「No LSP server available」 | 开**新会话**再验 |
| tsserver 索引没建完就看引用数 | 引用数偏少（2 个 vs 预热后 7 个），被误判成「LSP 配错」 | 判断配置对不对看**定义能否跨文件跳转**，不是看引用数 |

## License

MIT



