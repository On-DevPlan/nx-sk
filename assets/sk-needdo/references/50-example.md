# 完整示例：一段混乱输入 → 一个栏目 → 四条条目

## 用户丢来的东西

```
明天下午三点在 3 楼会议室开季度复盘会，记得带 Q4 预算表
另外报销单周五截止，别忘了
服务器 10.0.0.8 的证书 11 月 3 号到期
https://example.com/2026-q4-plan
```

## 第 0 步：清点

| # | 内容 | 类型 |
| --- | --- | --- |
| 1 | 季度复盘会（时间/地点/要带的材料） | 待办 |
| 2 | 报销单周五截止 | 待办 |
| 3 | 证书 11/3 到期 | 待办（运维） |
| 4 | Q4 计划链接 | 资料 |

注意第 1 条里"记得带 Q4 预算表"是会议的**属性**，不单独拆。

## 第 1 步：侦察

```bash
nx-sk section list --json
```

现有栏目是求职/项目/实习/校内/服务器/密钥/部署配置 —— **没有"随手记"这一类**，
硬塞进"项目经历"会把结构搞坏。结论：新建。

## 第 2 步：设计

```
栏目：备忘（memo，新建）
  名称    text     必填  一眼知道是什么
  类型    select   必填  待办 / 资料
  截止    date     可选  过期就不显眼
  正文    md       可选  细节、链接、截图
  来源    text     可选  贴来的 / 链接（去重用）
```

`groups.json`：

```json
[{ "id": "main", "title": "基本信息" }, { "id": "detail", "title": "细节" }]
```

`fields.json`：

```json
[
  { "key": "name", "label": "名称", "type": "text", "group": "main" },
  { "key": "kind", "label": "类型", "type": "select", "group": "main", "options": ["待办", "资料"] },
  { "key": "due", "label": "截止", "type": "date", "group": "main", "fill": "optional" },
  { "key": "body", "label": "正文", "type": "md", "group": "detail", "fill": "optional" },
  { "key": "source", "label": "来源", "type": "text", "group": "detail", "fill": "optional",
    "hint": "贴来的 / 链接 / 文件路径，用于去重" }
]
```

## 第 3 步：拍板

> 新建栏目「备忘」（memo），5 个字段：名称/类型/截止/正文/来源。
> 预计 4 条：复盘会、报销截止、证书到期、Q4 计划链接。
> 原始输入是「明天下午三点」「周五」—— 我按今天（2026-10-18）换算成 10-19 与 10-23，原话留在正文里。

用户：「行」

## 第 4 步：建结构

```bash
# --titleField 指定"用哪个字段的值当条目名"：不给的话 entry add 必须逐条 --title
nx-sk section add memo --title "备忘" --description "随手记：待办、通知、临时资料" \
  --titleField name --titleLabel 名称 \
  --fields @fields.json --groups @groups.json
```

如果漏了 `--titleField`（或想改），事后补：

```bash
nx-sk section update memo --titleField name
```

## 第 5 步：填值

`item-1.json`：

```json
{
  "name": "季度复盘会",
  "kind": "待办",
  "due": "2026-10-19",
  "body": "明天下午三点，3 楼会议室。\n\n- [ ] 带 Q4 预算表",
  "source": "贴来的 2026-10-18"
}
```

`item-4.json`：

```json
{
  "name": "Q4 计划",
  "kind": "资料",
  "body": "https://example.com/2026-q4-plan",
  "source": "链接 2026-10-18"
}
```

```bash
nx-sk entry add --section memo --data @item-1.json
nx-sk entry add --section memo --data @item-2.json
nx-sk entry add --section memo --data @item-3.json
nx-sk entry add --section memo --data @item-4.json
```

（`--title` 可省：`titleField` 指向 `name`，会自动取该字段的值当条目名。）

第 3 条的正文里写 `10.0.0.8` 就够了 —— 预览会把它渲染成「点击即复制」。

## 第 6 步：自检

```bash
nx-sk section dump memo --json
```

```
4 条 / 5 字段
季度复盘会      100%  （截止 2026-10-19）
报销单截止      100%  （截止 2026-10-23）
证书到期        100%  （截止 2026-11-03）
Q4 计划         100%
```

面板打开 `#/memo`：待办能勾、链接能点、`10.0.0.8` 能复制。

## 第 7 步：汇报

> 建了「备忘」栏目，4 条已入库（3 待办 + 1 资料）。「明天下午三点」「周五」按今天换算成
> 10-19 / 10-23，原话留在正文里。Q4 计划只存了链接，没抓正文 —— 要的话我再补。
