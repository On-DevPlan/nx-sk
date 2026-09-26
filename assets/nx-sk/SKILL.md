---
name: nx-sk
description: 本机个人资源管理器——栏目化存储个人信息（求职档案等）与大模型 API Key，CLI 与 Web 面板同源，敏感字段密文落盘。当用户要"记录/更新我的个人信息"、"填一份求职档案"、"存一个大模型 key"、"管理我的密钥"、"导出我的资料"、"起一个个人资料面板"，或需要在填表单/网申时批量取用个人字段、用 CLI 快速设置某个栏目内容时使用。触发词：nx-sk、个人资源管理器、个人信息、求职档案、栏目、条目、密钥、API key、密文、导出、面板、serve。不适用：纯问答、不需要落盘的临时讨论；也不适用于把密钥同步/上传到远程服务的场景——nx-sk 只在本机落盘，不做任何上传。
---

# nx-sk · 本机个人资源管理器

一句话：**把「你的信息」按栏目存起来，CLI 与 Web 面板是同一套业务，敏感字段密文落盘。**

数据落在 `~/nx-sk/`（可用环境变量 `NX_SK_HOME` / `NX_SK_STORE` 覆盖）。默认两个栏目：

| 栏目 | id | 内容 |
| --- | --- | --- |
| 求职 | `job` | 求职用的个人信息档案（姓名/学历/求职意向…约 70 个字段） |
| 密钥 | `secret` | **一张 KV 表**（`kv: true`）：一行一个键值对。面板渲染成表格，值以 AES-256-GCM 密文落盘 |

## 核心不变量

1. **栏目 = 一组同构条目 + 一份字段台账。台账是数据，不是代码。**
   字典随栏目存在 store 里，所以 agent 与面板看到的字段永远一致。
   **它不拦写入**：`--set 任意键=值` 一律能存，没见过的键会自动登记（键名就是它本身，
   中文也可以）。台账的用处是「模板建议 + 你实际写过什么」，不是门禁。
   *违反会怎样*：如果把它做成门禁，用户每换一个表单就要先改一次 schema ——
   而那正是「只想存个 kv」时最不想付的成本。

2. **一条 action 同时声明 CLI 与 HTTP。** 面板上能做的，CLI 都能做；两边参数名、错误码一致。
   *违反会怎样*：只能靠字符串匹配猜错误，无法可靠分支。

3. **失败抛异常（退出码 1），业务结果返回 `{ status }`（退出码 0）。**
   `conflict` / `blocked` / `skipped` 都是**正常返回**，agent 要看 `status` 字段而不是退出码。
   *违反会怎样*：把一个「等用户决策」的冲突当成失败去重试。

## 命令面（先跑这一条）

```bash
nx-sk bootstrap --json        # 版本 / 存储路径 / 栏目 / 设置 / 命令表，一次拿齐
```

零知识时的主力命令：

```bash
nx-sk entry fields --section job --json              # ① 看台账：模板建议字段 + 你写过什么
nx-sk entry update <条目id或条目名> --set 字段=值     # ② 直接写：字典里没有的键会自动登记
nx-sk section dump job --json                        # ③ 一个栏目的全部信息 + 每个条目的未填清单
```

**键就是键**：`--set 微信=xxx` 存下去就是 `微信`，不需要先翻译成英文 key。

`--set` 的键**可以用 key 也可以用中文标签**（`--set 电话=138…` 与 `--set phone=138…` 等价）。
一次写很多字段用 `--data @file.json`（`--data` 也接受内联 JSON）。

存/取密钥（KV）走这四条，别用 `entry --set value=` 绕一圈：

```bash
nx-sk key set OPENAI_KEY sk-xxxxxxxx     # 写入（存在即覆盖，返回 created 告诉你是哪种）
nx-sk key get OPENAI_KEY                 # 取值：默认就是原文
nx-sk key get OPENAI_KEY --mask           # 投屏/截图时才打码
nx-sk key list                            # 所有键（默认原文）
nx-sk key remove OPENAI_KEY               # 删除，写前自动留快照
```

`key *` 是 `entry *` 的**语法糖**（同模块、同一批 service 函数），缺省作用在标了 `kv` 的栏目上
（`--section` 可指定）。区别只有一个：`key set` 遇到同名是**覆盖**，`entry add` 是报 `CONFLICT`。

**KV 栏目不许加字段**：它的形状就是一行一个键值对。想加东西就用 `key set <名称> <值>`
（在 KV 栏目里 `entry update --set 新键=值` 会被拒绝并告诉你该用哪条命令）。

## ref 路由表（按需加载）

| ref | 何时读取 |
| --- | --- |
| `00-design` | 想搞清楚「为什么这么设计」、分层与依赖方向、错误码与 `{status}` 的分工时 |
| `10-sections-entries` | **动手填/改信息时必读**——栏目与条目的完整命令、AI 补全个人信息的推荐流程、字段字典怎么扩、读命令与写命令的参数陷阱 |
| `20-secrets` | 存/读大模型 key、密文机制、密钥来源（环境变量 vs 本机密钥文件）、什么时候会解不开 |
| `30-export-backup` | 整体导出、只导出某个栏目、快照与回滚、明文密钥的取舍 |

取 ref 全文（外部 agent 用这条，不必进终端翻文件）：

```bash
nx-sk skill get nx-sk                          # SKILL.md 全文
nx-sk skill get nx-sk 10-sections-entries      # 裸名 → references/10-sections-entries.md
nx-sk skill get nx-sk references/20-secrets.md # 也可写完整路径
nx-sk skill get nx-sk --json                   # 四元 JSON：{skillName, ref, content, contentBytes, install}
```

## 什么时候不用

- 用户只是随口问一句、不需要落盘 —— 别动数据。
- 想找「面板上的 skill 页」—— 没有：**skill 只走 CLI**（`nx-sk skill install` / `nx-sk skill get`），
  面板里不呈现它。
- 用户要把密钥**同步到云端/团队** —— nx-sk 只做本机落盘与本地导出，不做上传。
- 只是要看一眼面板 —— 提示 `nx-sk serve`，别用 CLI 重放一遍。

## 硬约束（动手前先记住）

- 所有写命令都有 `--dry-run`，先试运行再落盘；删除类命令**自动留快照**在 `~/nx-sk/backup/`。
- 密文字段**落盘是密文，读出来默认是原文** —— 本机单人工具，自己看的东西不先拦一道。
  要打码形态（投屏 / 截图）显式加 `--mask`。
- 把打码后的值（含 `******`）当新值写回去会被拒绝 —— 那通常意味着「不修改」，什么都不传即可。
- 导出默认**含明文**；要分享出去时加 `--no-secrets`。
- **绝不把密钥明文打进日志、提交进 git、或写进给第三方的输出里。**
