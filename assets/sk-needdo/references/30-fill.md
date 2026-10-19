# 填值：一条一个 `entry add`，值走文件

## 基本形状

```bash
# 1) 先试运行：看清楚会写哪些字段
nx-sk entry add --section memo --title "10 月值班表" --data @item-1.json --dry-run

# 2) 真写
nx-sk entry add --section memo --title "10 月值班表" --data @item-1.json
```

`item-1.json` 两种写法都认：

```json
{ "kind": "待办", "due": "2026-10-20", "body": "1. 交周报\n2. 报销" }
```

```json
{ "values": { "kind": "待办", "due": "2026-10-20" } }
```

- **标题走 `--title`**，不要塞进 `--data`（否则会变成一把叫 `title` 的字段值）。
- 键可以是 `key` 也可以是**中文 label**（`--set 截止=2026-10-20` 也行），但批量时用 key 更稳。
- 没见过的键**会自动登记**进台账 —— 能存，但别指望它长得对（类型会默认成 text）。

## 重跑与去重

`entry add` 同名会报 `CONFLICT`（不会静默覆盖）。所以：

```bash
nx-sk entry list --section memo --q "值班" --json   # 先查
nx-sk entry update <条目id> --data @item-1.json     # 有就改
```

**幂等靠两件事**：标题稳定 + 一个 `source` 字段（记"贴来的/链接/文件路径/日期"）。
重跑时先按 source 查，命中就 update，没命中才 add。

## 附件：先入库，再引用

```bash
# ⚠️ --path 默认是「移动」原件；只想留副本必须加 --copy
nx-sk file add --path "D:/下载/2026值班表.pdf" --copy --category document --json
# → {"id":"f_xxx","name":"2026值班表.pdf", ...}

# 图片在 md 字段里这样引用（标准 markdown，导出/贴进 README 也能渲染）
# ![10 月值班表](f_xxx)
```

- **多图**：一个 `file` 字段可以存多个 id（数组），`md` 里就多写几行 `![说明](id)`。
- **外链图**：`![说明](https://…)` 直接写，不进附件库（要联网才显示）。
- 附件字段（`type: file`）存的是**附件 id 列表**，不是路径 —— 路径会失效，id 不会。

## `md` 字段的写法

```markdown
## 背景
一句话说清这是什么。

- [ ] 待办一（预览里能直接点勾，勾完写回正文）
- [x] 待办二

| 字段 | 值 |
| --- | --- |
| 时间 | 2026-10-20 15:00 |

![现场截图](f_abc123)
```

> **⚠️ 任何"一串要做的事"都用 `- [ ]` 写。** md 字段里的 `- [ ]` 在面板里是**可点的复选框**：
> 勾一下 = 把 `[ ]` 改成 `[x]` 并写回条目正文（行号定位，只动复选框不动其他字符）。
> 适用：待办、Action items、复现步骤、上线 checklist、验收项——任何「一串要做的事」
> +「在 md 字段里」就该用 `- [ ]`，不要用 `1./2.` 序号（序号只是字，不可点）。
> 实现细节：`mdSource.toggleTaskAtLine(text, line)` 在 `src/web/frontend/mdSource.js`，
> 由 `MdView` 里 `TaskCheckbox` 的 onClick 触发，回到调用方（`fieldEditor`）写回 store。

- 单个换行会保留（渲染成 `<br>`），但**结构还是靠空行分段**。
- 代码块用三反引号；`md` 里不要写密码（明文渲染）。
- 待办勾选状态只有正文一份 —— 用户勾完记得点面板的「保存」，否则只改了 UI 状态没改 store。

## 日期与数字

- `date`：`YYYY-MM-DD`；`month`：`YYYY-MM`
- 原始输入是"下周三""月底"这种 → **先换算成具体日期再写**，把原话放进 `hint` 或备注
- `number`：纯数字（`300`），单位写进 label（"金额（元）"）

## 批量填值的脚本姿势

```bash
# 生成一堆小 JSON，再逐条 add；先全跑一遍 --dry-run 看输出
for f in /tmp/items/*.json; do
  nx-sk entry add --section memo --data "@$f" --dry-run
done
```

失败**不要整批重来**：`CONFLICT` 是"已经有了"，跳过或改 update 即可；
`INVALID_INPUT` 是这条数据本身有问题，单独修。

## 写完的自检三连

```bash
nx-sk section dump memo --json            # 条目数、每条缺什么
nx-sk entry get <id> --json               # 值真的进去了吗
nx-sk file list --section memo --json     # 附件挂上了吗
```
