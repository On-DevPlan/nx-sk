# 栏目结构：怎么设计才「新手照着能做完」

## 不要照抄 PDF 的目录

手册目录是给**已经会的人**翻的；新手需要的是「我现在该干什么」。
所以结构要按**操作流**重排，而不是按文档作者的章节划分。

聚合类信息源（平台指南、SOP 手册）的标准六段：

| 字段 | 类型 | 为什么必须有 |
| --- | --- | --- |
| 简介 | md | 这是什么、能干什么、文档版本 —— 让新手知道自己在哪 |
| **准备材料** | md | **动手前要准备什么**：登录哪些网站、认证哪几层、装哪些工具、各环境用哪个执行器 |
| 入口与地址 | md | 所有 URL 一条一行，避免到处找链接 |
| 操作手册 | md | 图文 SOP 主体，按任务分步骤，每步配图 |
| 常见问题 | md | 报错原文 → 原因 → 处理，新手卡住时先查这里 |
| 自检清单 | md | `- [ ]` 可勾选项，做完打勾，确认真的完成了 |

**「准备材料」是最容易漏、又最影响成功率的一段。** 新手按操作手册做到第三步
才发现「原来要先装 VPN」，整份文档的可信度就没了。

## 账号体系怎么拆

三类账号各自一个 `sensitive` 字段，别混在一起：

```jsonc
{
  "keys": [
    { "key": "平台账号",     "label": "容器平台账号", "type": "text", "sensitive": true },
    { "key": "平台密码",     "label": "容器平台密码", "type": "text", "sensitive": true },
    { "key": "认证账号",     "label": "川农 e 认证账号", "type": "text", "sensitive": true },
    { "key": "认证密码",     "label": "川农 e 认证密码", "type": "text", "sensitive": true },
    { "key": "堡垒机账号",   "label": "堡垒机账号",   "type": "text", "sensitive": true },
    { "key": "堡垒机密码",   "label": "堡垒机密码",   "type": "text", "sensitive": true }
  ]
}
```

在「准备材料」里**点名引用**：

```markdown
## 动手前先确认

- 容器平台：用〈容器平台账号〉/〈容器平台密码〉登录
- 川农统一认证：用〈川农 e 认证账号〉/〈川农 e 认证密码〉，与平台账号**不是同一套**
- 堡垒机（校外必须）：先连 UniVPN，再用〈堡垒机账号〉/〈堡垒机密码〉
```

## 分组（groups）怎么用

把六段放进 2–3 个分组，条目列表才不糊：

- **入门**：简介、准备材料、入口与地址
- **操作**：操作手册（可以按任务拆成多个条目）
- **排错**：常见问题、自检清单

条目多于一个时（一份 50 页手册通常要拆），
**一条 = 一个完整任务**（「怎么部署一个服务」比「部署」有用），
而不是「一条 = PDF 的一章」。

## 多页长文档：主条目 + 子条目

- 一个**总览条目**放简介、准备材料、入口与地址、自检清单 —— 新手从这里开始；
- 每个大任务一个**子条目**放各自的图文步骤。

这样新手先读总览就知道整体要干什么，再按需进子条目，不必一次读完 50 页。

## 可直接粘贴的建栏目命令

```bash
nx-sk section add <栏目id> --title "<标题>" --description "<一句话说明>" --json

# 建字段（分组 / 类型 / 是否密文）
nx-sk section update <栏目id> \
  --add-field '{"key":"简介","label":"简介","type":"md","group":"g1","groupTitle":"入门"}' \
  --add-field '{"key":"准备材料","label":"准备材料","type":"md","group":"g1","groupTitle":"入门"}' \
  --add-field '{"key":"入口与地址","label":"入口与地址","type":"md","group":"g1","groupTitle":"入门"}' \
  --add-field '{"key":"操作手册","label":"操作手册","type":"md","group":"g2","groupTitle":"操作"}' \
  --add-field '{"key":"常见问题","label":"常见问题","type":"md","group":"g3","groupTitle":"排错"}' \
  --add-field '{"key":"自检清单","label":"自检清单","type":"md","group":"g3","groupTitle":"排错"}' \
  --json

# 账号类字段一律 sensitive: true（密文落盘）
nx-sk section update <栏目id> \
  --add-field '{"key":"平台密码","label":"平台密码","type":"text","group":"g0","groupTitle":"账号","sensitive":true}' \
  --json
```

`--add-field` 遇到同名 key 会报冲突；先 `nx-sk entry fields --section <栏目id> --json`
看已有字段，别重复登记。

## 写 md 字段的实操

md 内容往往几百行、有反引号和换行，直接 `--set` 会被 shell 折腾。用文件传：

```bash
SOP="$(cat /tmp/sop.md)"
nx-sk entry update <条目名> --set "操作手册=$SOP" --json
```

Windows（Git Bash）下多行内容推荐：

```bash
SOP="$(cat /tmp/sop.md)"
nx-sk entry update <条目名> --set "操作手册=$SOP" --json
```

同一段内容要同时进多个字段时，写一次变量复用，别手抄三遍 —— 抄错一处两边就不一致了。
