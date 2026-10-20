# 10 · 双向同步手册

> `sk-source` skill 的详细页。**什么时候读**：袋里有东西要整理（第 3 步）、
> 或要把字段值回写进袋（第 4 步）时。

## 两种方向，先分清

| 方向 | 什么时候用 | 命令 | 结果落在哪 |
| --- | --- | --- | --- |
| **source → 字段** | 袋里有杂乱资料，要整理成结构化值 | `entry update --data` | 栏目的**字段** |
| **字段 → source** | 字段值已确认，想留出处/回溯 | `source add --mapped` | 袋里的**新一条** |
| **标锚点**（双向闭环） | 某条资料已经整理过了 | `source update --mapped` | 该 item 的 `mapped` |

**别把三件事混成一件**：
「字段里已经填了值」不等于「袋里那条已经用掉」。
`mapped` 是**袋这一侧**的账，写在 item 自己身上——所以「哪些资料还没被整理过」永远查得出来。

## 整理前的映射表

一次整理一张表就够（写在回复里给用户过目也行）：

| item（id） | 内容摘要 | 目标字段 | 把握 | 处理 |
| --- | --- | --- | --- | --- |
| s_abc | 「VPN 账户：14611」 | vpnAccount | 高 | 写 |
| s_abc | 「Lj198900@#」 | vpnPassword | 高 | 写（sensitive 字段自动加密）|
| s_def | 截图里的一串端口号 | registry | 低 | **不写**，note 里记「疑似端口，待确认」|

「把握」这一列是纪律的核心：
- **高** = 原文直给，没有歧义 → 写
- **中** = 需要推断但只有一种解释 → 写，但在回复里点名说明
- **低** = 多种解释 / 缺上下文 / OCR 可能错 → **不写**，留空 + note 记疑点

**留空比写错好**：完整度会告诉你「这个字段还没填」，但错误的值会被当成事实一路传下去。

## 写回的形状

`整理.json`（`--data @file.json`）：

```json
{
  "vpnAccount": "14611",
  "vpnPassword": "Lj198900@#",
  "accessUrl": "https://qcloud.sicau.edu.cn/login"
}
```

键用 **field key** 或**中文标签**都认（与 `entry update --set` 同一套规矩）。
一次只改要整理的字段——`entry update` 是 PATCH 语义，没出现在 JSON 里的字段不动。

**先 dry-run**：

```bash
nx-sk entry update <条目> --data @整理.json --dry-run
```

返回 `wouldChange.fields` 是要写的字段 key、`newFields` 是这次顺带登记的新键
（字典里没有的键会自动登记，**注意看**——它常常意味着你写错了字段名）。

## 回写（字段 → source）

什么时候要回写：字段里的值是**从别处来的**（邮件、手抄、别人告诉你的），
需要在袋里留一份带出处的副本。

```bash
nx-sk source add <条目> --text "14611" --name "VPN 账号（李晶老师邮件）" \
  --mapped vpnAccount --note "整理自 vpnAccount 字段"
```

回写出来的 item 长这样（`mapped` 让它和字段互相指认）：

```json
{
  "id": "s_xyz",
  "kind": "text",
  "name": "VPN 账号（李晶老师邮件）",
  "text": "14611",
  "addedAt": "2026-10-20T…",
  "note": "整理自 vpnAccount 字段",
  "mapped": ["vpnAccount"]
}
```

**别回写敏感值**：`sensitive` 字段的明文不该出现在袋里（袋是明文的）。
密码/token 留在密文字段里，袋里只记「见〈某字段〉」。

## 标锚点

```bash
nx-sk source update <条目> --id s_abc --mapped vpnAccount,vpnPassword
```

`--mapped` 接受逗号分隔。想清掉就传空：`--mapped ""`。

`source update` **不改正文**——它只改名字、备注、锚点。
要改内容就删掉重加（`source remove` + `source add`）：
原文一旦被就地改写，「原始」这个词就不成立了。

## 冲突：以新的为准，旧的留痕

资料会**更新**：老师又发一封邮件说密码改了、同一个链接换了地址。这时候**不要覆盖、不要删**。

### 规则

| 情形 | 判定 | 动作 |
| --- | --- | --- |
| 两条同名 | 冲突 | 时间新的 = 当前版本；旧的自动标「已被取代」，仍留在袋里 |
| 时间用哪个 | `at`（资料自身时间，如邮件时间）优先，缺省用入袋时间 | 加资料时用 `--at 2026-10-19` 写清 |
| 名字不同但同一件事 | 人工判定 | 新条加 `--supersedes <旧id>`，旧条同样被标取代 |
| 手动标记 | 任意 | `nx-sk source update <条目> --id <旧id> --superseded` |

### 为什么「留痕」比「覆盖」重要

密码改过三次之后，**「现在的密码」和「它为什么是这个」一样重要**。
覆盖掉旧资料，就再也说不清「当时为什么发的那封邮件里写的是另一个值」——
而这类问题（密码到底哪个是对的、哪个已失效）恰恰是**事后**才会冒出来的。
所以：字段里放**当前值**，袋里留**全部版本**（旧的折叠但可查）。

### 整理时怎么处理冲突

1. `nx-sk source get <条目> --json` → 看 `items[]`，`superseded: true` 的是旧版。
2. 写字段时用**当前版本**（没被取代的、时间最新的那条）的值。
3. 写完给用上的 item 打锚点：`source update --id <id> --mapped 字段key`。
4. 旧版**不用管**（它已经被自动标取代），但也别删。

```bash
# 又来一封邮件（同名 + 新时间）→ 新的自动成为当前版本，旧的自动留痕
nx-sk source add <条目> --text "密码改成 NewPass2 了" --name "分配邮件" --at 2026-10-19
# 字段跟着更新
nx-sk entry update <条目> --data @更新.json --dry-run && nx-sk entry update <条目> --data @更新.json
# 给新条打锚点
nx-sk source update <条目> --id <新条id> --mapped vpnPassword
```

## 查「还有哪些没整理」

```bash
nx-sk source get <条目> --json
```

然后看每个 item 有没有 `mapped`：

```bash
nx-sk source get <条目> --json | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j=JSON.parse(s);
  const un=(j.items||[]).filter(i=>!(i.mapped||[]).length);
  console.log('未整理:', un.length, un.map(i=>i.name||i.id).join('、'));
})"
```

## 一次性整理多个条目

袋是**按条目**分的，所以「整理一批」= 对每个条目各走一遍第 2–4 步。
批量写盘时**每个条目一次 `--dry-run`**（`entry update` 没有跨条目的批量模式）：
逐条 dry-run、逐条确认、逐条写。写错了也只错一条。
