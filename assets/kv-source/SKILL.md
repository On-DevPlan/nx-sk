---
name: kv-source
description: 在 nx-sk 的栏目里做「原始资料 ↔ 结构化字段」的双向同步——把杂乱资料（邮件、聊天记录、截图、PDF 摘录、手抄的表、网址）先原样收进条目的「原始资料」袋，再按栏目字段字典整理成结构化字段；也支持反向把已确认的字段值回写进袋子留痕。当用户说"把这些乱的整理进 nx-sk"、"这堆资料归到字段里"、"source 和字段同步一下"、"把邮件/截图/文档存下来并归档"、"原始资料整理成表"、"回写一下出处"，或给来一堆没格式的内容却已经指定了栏目/条目时使用。触发词：source、原始资料、乱入、整理、同步、归档、乱数据、收件箱、字段同步、资料袋。不适用：用户已经说清要写哪个字段（直接 entry update 即可）、栏目结构本身还没定（先走 sk-needdo 定结构）、PDF 要转成图文 SOP（用 sk-pdf）。
---

# kv-source · 原始资料 ↔ 字段 的双向同步

一句话：**先原样收下，再按字典整理；整理完留痕，两头能对回去。**

每个栏目都自带一个「原始资料」袋（`source` 字段）。它是**乱入区**：
真实数据几乎从不是一次填对的——邮件、截图、PDF 摘录、一段手抄的表，全都先有个
「还没整理」的阶段。没有这个袋子，用户只有两个坏选择：把乱数据硬塞进结构化字段
（把结构搞脏），或者干脆不存（信息丢了）。

## 三条铁律

1. **原文不改写。** 袋里的东西是**原始证据**：摘要是可以重写的，原文不能只剩摘要。
   整理的结果写进**字段**（或写进**新的一条**），不就地改写原件——否则「原始」这个词就没意义了。
2. **不确定就留空。** 袋里的资料经常是半截的、含糊的、有歧义的。
   拿不准的值**不写进字段**（留空比写错好：写错会被当成事实传下去），把猜测写进该条的 `note`。
3. **敏感内容不进袋。** 袋是**明文**的（不加密），密码/token 走「密钥」栏目或 `sensitive` 字段。
   往袋里贴明文密码 = 把凭据从密文降级成明文，这是不可逆的降级。

## 冲突：以新的为准，旧的留痕

同一件事有了新版本（又来一封邮件、密码改了）——**不要覆盖、不要删**：

- **同名即冲突**。时间新的那条是「当前版本」；旧的被标成「已被取代」但**仍留在袋里**
  （原始证据要能翻回去看）。面板默认把旧的收起，点「已被取代的 N 条（留痕）」可展开。
- **时间以 `--at` 为准**：`--at 2026-10-19` 记的是**资料自身的时间**（邮件时间），
  缺省用入袋时间。所以「谁更新」看的是资料的时间，不是你什么时候加进去的。
- 名字不同但确实是同一件事（如「分配邮件」vs「李晶老师的邮件」）：用
  `--supersedes <旧id>` 显式指明——旧条同样被标成已取代。
- **字段也要跟着更新**：新资料覆盖字段里的旧值（`entry update --data`），
  旧资料留在袋里 ——「现在的值」与「它是怎么来的」同时成立。
- 手动标：`nx-sk source update <条目> --id <旧id> --superseded`。

```bash
nx-sk source add <条目> --text "新密码…" --name "分配邮件" --at 2026-10-19
nx-sk source add <条目> --text "…" --name "李晶老师的邮件" --supersedes s_abc123
```

## 命令速查

```bash
nx-sk source list                       # 各栏目的袋概况（多少条目有袋、袋里多少条）
nx-sk source get <条目> --json          # 看某个条目的袋（item 明细 + 附件信息）
nx-sk source add <条目> --text "…"      # 加一条文字（原样存）
nx-sk source add <条目> --file <路径>   # 加一个文件（先进附件库，原件保留不搬走）
nx-sk source add <条目> --url <网址>    # 加一个网址
nx-sk source update <条目> --id <itemId> --mapped 字段key    # 标注「这条已整理到哪些字段」
nx-sk source remove <条目> --id <itemId> # 删一条（默认不动，删之前先确认）
nx-sk source ensure                    # 给缺 source 字段的栏目补上（KV 表除外）
```

带时间与取代关系的写法：

```bash
nx-sk source add <条目> --text "…" --name "分配邮件" --at 2026-10-19      # 记资料自身的时间
nx-sk source add <条目> --text "…" --name "李晶老师的邮件" --supersedes s_abc   # 显式取代旧的
nx-sk source update <条目> --id s_abc --superseded                        # 手动标「已被取代」
```

## 流程（五步）

### 第 0 步：找到落点

```bash
nx-sk source list                       # 哪个栏目有袋、哪些条目有袋
nx-sk entry list --section <栏目>       # 找目标条目（同名用 id）
```

用户没指定条目时：**先问**（是新建一条，还是并进已有条目？）。
并进已有条目前先 `nx-sk source get <条目>` 看一眼袋里已经有什么，避免重复收。

### 第 1 步：原样收下（先别整理）

一份资料一条 item。文字、文件、网址各是一个 kind：

```bash
nx-sk source add <条目> --text "邮件原文照抄……" --name "李晶老师的分配邮件"
nx-sk source add <条目> --file "D:\截图\控制台.png" --name "控制台首屏"
nx-sk source add <条目> --url "https://qcloud.sicau.edu.cn/login"
```

- `--file` **默认复制不搬走**原件（这是「加一条资料」，不是 `file add` 的搬运语义）。
- 一次要收很多份：面板里在「原始资料」抽屉中**多选文件**拖进去，或用 `--file` 重复调用。
- 文件分发细则（PDF 怎么拆、截图怎么批量进、表格怎么变成清单行）见 [[20-intake]]。

### 第 2 步：读袋子

```bash
nx-sk source get <条目> --json
```

返回的 `items[]` 形如 `{id, kind, name, text|fileId|url, addedAt, note, mapped}`。
`file` kind 的 item 要读内容就看 `files[fileId].path`（物理路径）或 `files[fileId].downloadUrl`。

### 第 3 步：映射（source → 字段）

先看**目标栏目的字段台账**（不要凭印象猜字段名）：

```bash
nx-sk entry fields --section <栏目> --json
```

逐条 item → 字段的映射表（心里列出来，或写进回复给用户过目）：

| item | 内容 | 目标字段 | 把握 |
| --- | --- | --- | --- |
| 分配邮件 | VPN 账户 14611 / Lj198900@# | `vpnAccount` / `vpnPassword` | 高（原文直给）|
| 截图 | 控制台地址 | `accessUrl` | 中（OCR 有误风险）|

**把握不足的字段不写**——留空，并在该 item 的 `note` 里写清「疑似是什么、为什么没填」。

写入（**先 dry-run**）：

```bash
nx-sk entry update <条目> --data @整理.json --dry-run   # 先看会改什么
nx-sk entry update <条目> --data @整理.json             # 确认后真写
```

`整理.json` 形如 `{"vpnAccount":"14611","vpnPassword":"Lj198900@#"}`
（键用字段 key 或中文标签都行；敏感字段是 `sensitive` 的话值照写，加密由服务端做）。

### 第 4 步：留痕（字段 → source，双向闭环）

**整理完给用上的 item 打锚点**，这样下一次同步知道「这条已经用过」，不会重复整理：

```bash
nx-sk source update <条目> --id <itemId> --mapped vpnAccount,vpnPassword
```

反过来（**字段 → source**）：把已确认的字段值也回写进袋子，出处留痕：

```bash
nx-sk source add <条目> --text "14611" --name "VPN 账号（已确认）" --mapped vpnAccount --note "整理自 vpnAccount 字段"
```

这样「哪个字段的值是从哪条原始资料来的」永远能反查回来。

### 第 5 步：自检

```bash
nx-sk entry get <条目> --json            # 字段值对不对
nx-sk source get <条目> --json           # 袋里每条的 mapped 对不对
nx-sk section dump <栏目> --json         # 完整度与未填清单（袋子不计入完整度）
```

## 面板里怎么用

条目表单底部有一条**折叠条**「原始资料 · N 条」（暂存区不该在日常填表时占地方）。
点开是右侧抽屉：左边清单、中间正文。

- 拖文件进左栏 → 自动上传并入袋
- 「＋ 选择文件」按钮 → 同样的事（**拖拽不是唯一入口**：WCAG 2.2 AA 要求键盘/单指针也能完成）
- 粘贴框 + Ctrl+Enter → 加一条文字
- 左栏点一条 → 右边看内容；「移除」删掉这一条

## 常见坑

- **同名条目**：一个栏目里两条同名时 `entry get` 会报 CONFLICT，用 id 定位。
- **袋里没有 source 字段**：老栏目是模板实例化时建的，source 字段是后加的 → `nx-sk source ensure` 补齐。
- **KV 栏目（密钥）没有袋**：它的形状就是一行一个键值对，加字段会散掉。密钥走 `nx-sk key set`。
- **`--mapped` 是数组**：可以 `--mapped a,b`（逗号分隔），也可以重复给。
- **别用 `entry update --set source=...` 手写整袋 JSON**：那是给程序用的口子，人用 `source add` 更安全（少写错一个括号就毁掉整袋）。
