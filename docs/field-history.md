# 字段历史版本机制（设计稿）

> 任务 #26 的规划部分。目标：每个 `field_data` 上都有一份可查、可恢复的历史；
> 面板与 CLI 都能看到「这个字段改过几次、每次是什么、能回到哪一版」。
> 本文只定方案，不改变现有行为；落地按文末里程碑分批做。
> **实现状态（2026-11-12，任务 #27）**：M1（v5 迁移 + 写入 diff + 字段历史命令）、
> M2（恢复 + 面板入口）已完成；与本文初稿的差异见第 13 节（合并窗口未采用、
> 保留策略落到设置项、无 `field_data.rev` 列）。

## 1. 目标与非目标

**要做的**

- 字段值每次真正变化时留一条历史（含旧值、时间、来源）。
- 每个字段有单调递增的版本号（rev），能按版本号查看/恢复。
- 面板在字段块上提供「历史」入口；CLI 提供对称命令。
- 恢复本身也进历史（可再撤销），不是静默覆盖。
- 有保留策略，库不会无限膨胀。

**不做的（本期）**

- 不做跨条目的「栏目级时间旅行」。
- 不记录字段结构的变更史（`entry_fields` 的增删改），只记值。
- 不在运行时兼容旧结构；历史表是新表，升级时刻起开始记。

## 2. 现状与约束

- schema v4：条目结构在 `entry_fields`（一字段一行，`id = ef_<sha1(entry_id:key)>`），
  值在 `field_data`（`entry_field_id UNIQUE`，`value` 是 JSON 文本，`NOT NULL`）。
- 「没填」= 没有数据行，不是有一行 NULL。
- `repo.writeStore` 是**全量重写**：单事务里清空投影再整份插入。这意味着
  不能在「插入 field_data」时无脑追加历史——每次保存都会重插所有行，噪声会淹没真实改动。
- id 是确定性派生的（`identity.ts`），同一 (条目, 键) 永远同一行，适合做历史外键。
- `entry_fields` 删除时 `field_data` 随 CASCADE 走；扩展字段硬删，模板字段「脱离」只改 meta、值仍在。
- 任务 #26 加入「编辑后自动保存」后会显著提高写入频率（停手 800ms 一次），
  历史机制必须能扛住高频写，否则一个字段一天能攒出几百条无意义版本。

## 3. 数据模型（schema v5，纯增量）

```sql
-- 实际落盘的 v5.sql（无外键：全量重写会 CASCADE 清空 entry_fields）
CREATE TABLE field_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_field_id TEXT NOT NULL,
  rev            INTEGER NOT NULL,
  value          TEXT NOT NULL CHECK (json_valid(value)),
  prev_value     TEXT CHECK (prev_value IS NULL OR json_valid(prev_value)),
  op             TEXT NOT NULL CHECK (op IN ('set', 'clear', 'restore')),
  source         TEXT NOT NULL DEFAULT 'ui',
  at             TEXT NOT NULL,
  UNIQUE (entry_field_id, rev)
);
CREATE INDEX ix_field_history_field ON field_history (entry_field_id, rev DESC);
CREATE INDEX ix_field_history_at ON field_history (at);
```

- `value` 存**变化后的完整值**（快照）。查看历史时直接展示，不必回放 diff；
  存储成本用保留策略控制。`prev_value` 冗余一份旧值，便于「只看这一跳改了什么」。
- `rev` 是「版本号」的唯一来源：某字段当前版本 = `MAX(rev)`；恢复某版 = 拿到该行 value 写回。
- 恢复生成**新的一行**（`op='restore'`），rev 继续递增——历史只追加，不改写，恢复也可再撤销。
- 条目标题历史（初稿里的 `entry_history`）**本期未做**：标题改动暂不进历史；
  条目时间线只覆盖字段值（需求原文也是「这个条目涉及到的字段变化」）。

## 4. 写入路径：diff + 合并

`writeStore` 全量重写，历史必须在**应用层**做 diff，而不是在 SQL 层：

1. 进入写事务前，读出现有 `field_data` 的 `entry_field_id → value` 映射（同一次 SELECT）。
2. 重写完成后，对新值做**规范化 JSON**（键排序、数字归一）再与旧值比较。
3. 只对「真正变化」的键追加历史；值相同但行被重插的，不产生版本。
4. 删除值（`value` 行消失）记 `op='clear'`，`value` 落 `'null'`，保持 NOT NULL 约束；
   读侧仍按「缺行 = 没填」处理，`clear` 行只进历史，不复活数据行。
5. 全部动作在**同一个事务**里完成（`tx.ts` 现有边界），失败一起回滚。

### 4.1 逐次记录（v1 的裁决，不做时间窗合并）

初稿设想的「5 分钟合并窗口」没有实现，原因：

- 需求要的是「切换版本号」——把用户手动存过的中间状态悄悄合并掉，会让
  「为什么只有 3 版、我明明存了 5 次」无法解释；
- 自动保存的噪声用**保留策略**（最近 N 版 / N 天）控制更直观，也不丢最近的历史；
- 少一个合并分支，恢复语义更简单：每行历史就是一个真实落盘过的值。

### 4.2 批量写入

导入 / 迁移仍会按普通 diff 逐字段记录（一次导入 = 每个字段一版），
`import` 的整批摘要留作后续（见里程碑 M4）。

## 5. 查看与恢复

### 5.1 CLI

```text
nx-sk field history <条目> <字段> [--limit 20] [--json]
nx-sk field history <条目> <字段> --at <时间点>      # 找该时间点之前的最后一版
nx-sk field restore <条目> <字段> --rev <版本号> [--dry-run]
nx-sk field history prune [--keep 50] [--days 90] [--dry-run]
```

- `<条目>` 复用现有 ref 解析（id / 标题）；`<字段>` 用 key 或中文标签。
- `restore` 默认打印「当前 → 将恢复」的值对比；`--dry-run` 只预览不落盘。
- 恢复后输出新 rev 与来源，提示「这次恢复也进了历史」。

### 5.2 HTTP

```text
GET  /api/entries/:ref/fields/:key/history?limit=20
GET  /api/entries/:ref/fields/:key/history/:rev
POST /api/entries/:ref/fields/:key/history/:rev/restore   { dryRun?: boolean }
```

路由挂在 entries 模块下，权限/Origin 校验沿用现有写接口规则。

### 5.3 面板

- **入口**：字段块头「⋯」菜单（任务 #24 已有 `view / edit / remove`）加一项「历史」，
  不新增常驻按钮，避免每个块多一个图标。
- **抽屉**：右侧滑出，列表按 rev 倒序：版本号、时间、来源、值摘要（长文本截断）；
  点开某版看完整值；底部「恢复到此版本」，二次确认后调 restore。
- **顶部提示**：块头显示「v3 · 2 分钟前」，让用户不打开抽屉也知道改过。
- **条目详情**：底部动作条旁加「本条目历史」入口，列出所有字段的最近变化（跨字段时间线）。
- 所有新文案与交互都是**新增**，不改动现有按钮、className 与流程。

## 6. 恢复语义

- 恢复只写 `field_data.value`；**不重建结构**——已删的扩展字段不会因恢复而复活，
  已「脱离」的模板字段保持脱离状态（值写回但不显示）。
- 恢复前校验：目标 rev 属于该 `entry_field_id`；值能通过该字段类型的反序列化。
- 恢复后：`field_data.rev = 新 rev`，面板重读该条目；活跃的自动保存计时器必须先取消，
  避免刚恢复就被一次防抖保存覆盖（前端 restore 走同一 guard/save 链路，先清 timer）。
- 删除整条条目 → 结构行消失 → writeStore 重建后
  `DELETE FROM field_history WHERE entry_field_id NOT IN (SELECT id FROM entry_fields)`
  把历史一起清掉（v5 没有外键，等价于 CASCADE 的语义）；扩展字段硬删同理。
  这是既有语义（删除不可恢复），历史不提供绕过。

## 7. 保留策略与容量（已实现）

设置项（`nx-sk setting set` / 设置页「默认行为 → 字段历史保留」）：

- `historyMode = count（默认）| time`
- `historyCount = 50`（每个字段最多留多少版，1–1000）
- `historyDays = 90`（按时间保留时留多少天，1–3650）

裁剪时机：**每次追加历史后按当前策略裁该字段**；改设置项保存后立即全库裁一次
（`pruneHistoryNow`），不必等下一次写入。恢复版本与普通版本一视同仁参与裁剪
（初稿的「恢复锚点永不清理」未实现：按 N 版保留更可预测）。

粗算：100 条目 × 40 字段 × 50 版 × 平均 200B ≈ 40 MB；嫌大可把 `historyCount` 调到 10–20。

## 8. 兼容与迁移

- v5 迁移是**纯增量**：建表 + 索引，不加列、不回填历史——升级前的改动无从得知。
- `version.ts` 升到 5，`migrations/index.ts` 注册 `{ from: 4, to: 5, file: 'v5.sql' }`。
- 降级不保证：历史表保留即可，旧版本忽略它。
- 导入导出：ZIP 里**不带历史**（历史是本机审计数据，跨机搬运会带上别人的编辑轨迹）。

## 9. 与任务 #26 自动保存的关系

- 自动保存把「一次编辑」拆成多次 PATCH，每次落盘的值都进历史（不做合并）；
  嫌版本太多时用「最近 N 版 / N 天」收紧。
- 自动保存触发的写入同样记 `source='ui'`；手动点保存不特殊处理（同一路径）。
- 恢复写完会 bump `meta.rev`：拿着恢复前 Store 对象的自动保存会撞 BLOCKED（重试后
  读到的已是恢复值），不会把刚恢复的版本静默覆盖。

## 10. 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | v5 迁移 + repo 写入 diff + `entry field-history` 只读命令 | ✅ 已实现 |
| M2 | restore（CLI + HTTP）+ 面板「⋯ → 变化历史」+ 条目时间线 + 保留策略设置 | ✅ 已实现 |
| M3 | 条目标题历史 + `entry history prune/stats` 独立命令 | 未做（时间线已覆盖字段；标题未记） |
| M4 | 导入压缩、`--with-history` 导出、大值分档保留 | 未做 |

## 11. 测试计划

- 单测（`tests/unit/history.test.mjs`）：默认保留策略、新建 = v1、同值重写不记、
  时间线倒序、恢复往返 + 恢复进历史、dry-run 不落盘、count/time 裁剪与非法值报错。
- 迁移测试：空库升到 v5、v3→v4 保真、v2→v5 快照命名按当前版本。
- 回归：全套单测 + 142 项冒烟保持绿（历史是旁路写入，不改变读路径）。

## 12. 备选方案与取舍

- **SQLite trigger 写历史**：能保证不漏，但拿不到 source/actor，导入与全量重写会产生
  海量噪声，且恢复语义（写回也触发）难控。不选。
- **每条目整份 JSON 快照**：实现最简单，但重复存储大、字段级恢复要全量重放，
  且与 v3 的「一字段一行」模型相悖。不选。
- **应用层 diff journal（本方案）**：写入点唯一（`writeStore`），能拿到来源与操作语义，
  合并与保留策略都在应用层可控。选它。

## 13. 实现与初稿的差异（2026-11-12）

| 初稿 | 实际 | 原因 |
| --- | --- | --- |
| `REFERENCES entry_fields ON DELETE CASCADE` | 无外键，writeStore 重建后清理孤儿历史 | 全量重写每次 DELETE sections，CASCADE 会把历史整份清空 |
| 5 分钟合并窗口 | 不做合并，逐次记录 | 版本号要能解释「我存了几次」；噪声交给保留策略 |
| `field_data.rev` 当前版本指针 | 未加列，按需 `MAX(rev)` | 避免动热表；本地规模聚合查询成本可忽略 |
| `actor` / `source` 枚举 | 只留 `source`（默认 `ui`，恢复为 `restore`） | 当前写入路径拿不到可靠来源，先不伪造 |
| 面板「抽屉 + 块头 vN 提示」 | 弹窗（块头「⋯ → 变化历史」+ 条目底部「变化历史」） | 复用现有 Modal 与样式，不新增常驻 UI |
| 恢复锚点永不清理 | 按保留策略统一裁剪 | 保留行为可预测，避免「有的版本删不掉」 |
| 条目标题历史 | 未做（只做字段变化时间线） | 本期需求聚焦 field_data |

