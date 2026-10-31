# 10 · 栏目与条目

> 归属 `nx-sk` skill 主文档。**动手填/改信息时读这篇。**

## 一、数据模型

```
store.json（~/nx-sk/store.json 或 $NX_SK_STORE）
├─ settings                 全局配置（可读 JSON/Markdown 导出见 60-transfer）
├─ sections[]               栏目：id / title / order / template / titleField / groups[] / fields[]
└─ entries[]                条目：id(e_xxx) / section / title / tags[] / values{字段key: 值} / 时间戳
```

- **结构与值分家**：栏目持有**结构**（`groups[]` 分组 + `fields[]` 字段定义），条目只持有**值**
  （`values{字段 key: 值}`）。所以「这个栏目有哪些字段」永远只有一个答案，在栏目里；
  条目里的每一把键都能在那儿找到。
- 一个**栏目** = 一组同构条目 + 一份字段字典（**固定的结构**）。
- 一个**条目** = 一行数据，值放在 `values` 里，键是字段 `key`；写台账里没有的键会**自动登记**
  （见第五节）——**登记过的键面板才渲染得出来**，没登记的值在界面上看不见。
- **头部分组是显示配置**：`settings.navGroups`（`[{title, sections:[栏目id…]}]`，设置页可配）只决定
  头部怎么摆——同域栏目可收拢成一个分组入口（悬浮展开上下列表）；**不动**栏目与条目的任何数据。
- 定位方式都放宽：栏目与条目**都接受 id 或名字**。条目名重名时报 `CONFLICT` 让你改用 id。

## 二、栏目命令（集合资源，五操作齐备）

| 操作 | 命令 |
| --- | --- |
| 列表 | `nx-sk section list` |
| 单条 | `nx-sk section get <id或标题>` |
| 新增 | `nx-sk section add <id> --title <标题> --template job` |
| 修改 | `nx-sk section update <id> [--title …] [--add-field '{…}'] [--remove-field a --remove-field b]` |
| 删除 | `nx-sk section remove <id> [--force]` |
| **全量** | `nx-sk section dump <id> [--mask]` |
| **同步模板** | `nx-sk section sync <id> [--dry-run]` |
| 模板 | `nx-sk section templates` |

- **`remove` 在栏目非空时会被 `blocked` 挡住**（除非 `--force`）——防止一键抹掉全部档案。
- `remove` 目标不存在时**报 `NOT_FOUND`**（不静默成功），就是为了让「打错一个字」当场暴露。
- `dump` 是「快速获得一个栏目的全部信息」的正解：字段字典 + 全部条目 + 每个条目的完整度与**未填清单**。
- **`sync` 按模板补齐字段**：栏目字段字典是**持久化数据**——实例化时深拷贝模板字段，此后独立演化，
  所以模板**后来**新增的分组与字段不会自动出现在老栏目里（典型症状：求职没显示附件上传框）。
  `section sync <id>` 把模板有、本栏目还缺的分组与字段补进来（**只增不改不删**，保持模板顺序；
  已有字段含改过的 label / hint / fill 原样保留），带 `--dry-run`；面板侧是「栏目 → 编辑 → 同步模板字段」。
  - **它还会报告「漂移」**：同名字段在「栏目 vs 模板」之间哪些属性不同（`changedFields`，含 diff 属性名）。
    这是**只提示、不动手**——因为定义归栏目，你可能就是刻意改过。要换成模板的新定义得手动来：
    `section update <id> --fields '<整份字段数组>'`，或先 `--remove-field` 再 `--add-field`（`--add-field` 遇到同名会报冲突）。

内置模板 8 个：`job`（求职 / 个人信息，约 80 字段 / 10 分组——含「附件资料」组：简历附件 / 头像图片 / 成绩单 / 证书扫描件）、`projects`（项目经历）、`internships`（实习/工作经历）、`campus`（校内职务/实践）、`secret`（密钥，**单字段 KV**——细节见 `20-secrets`）、`deploy`（部署配置：Dockerfile / compose / k8s 清单，**一份文件一个条目**，自带「凭据清单」——细节见 `50-deploy`）、`platform`（容器平台：控制台链接 / 账号 / 密码 / 镜像，一个平台一个条目）、`thesis`（毕业论文规范字段化）。三类经历栏目（projects / internships / campus）**一个项目 / 一段经历 = 一个条目**，角色、时间、技术栈都是独立字段——不要往 job 栏目里塞经历。

首次运行只**播种 1 个**：`demo`（字段样例 / 能力边界——每种字段一格、连示例条目一起，见 `15-special-fields`）。
其余模板（job / projects / internships / campus / secret / deploy / platform / thesis）需要时用
`section add <id> --template <模板id>` 建；没有 KV 栏目时第一次 `key set` 也会自动补建 `secret`。

## 三、条目命令

| 操作 | 命令 |
| --- | --- |
| 列表 | `nx-sk entry list [--section job] [--q 关键字]` |
| 字段字典 | `nx-sk entry fields [--section job]` |
| 单条 | `nx-sk entry get <id或名字> [--mask] [--section job]` |
| 新增 | `nx-sk entry add --section job --set 姓名=张三 [--set 电话=…]` |
| 修改 | `nx-sk entry update <ref> --set 期望城市=北京、上海 [--unset 微信]` |
| 删除 | `nx-sk entry remove <ref>` |

### 参数要点

| 参数 | 说明 |
| --- | --- |
| `--set 字段=值` | 可重复。键**可用字段 key 或中文标签**。值按字段 type 强转（bool 认`是/否/true/false`；tags 用 `、` 或 `,` 分隔；number 认数字串） |
| `--data <json>` / `--data @file.json` | 一次写多字段。`--data` 优先被 `--set` 覆盖 |
| `--unset a,b` | 清空若干字段（**这才是清空的正确姿势**，不是 `--set a=`） |
| （已取消）`--allow-new-field` | 现在**默认就是自动登记**，不必再带这个 flag |
| `--title` | 条目名。不传则取栏目的 `titleField`（求职栏目是 `name`/姓名） |
| `--dry-run` | 试运行：返回 `wouldCreate` / `wouldChange`，不落盘 |
| `--mask` | 读命令专用：密文字段**打码**显示（默认是原文；投屏/截图时用） |

### 三个容易踩的坑

1. **`--set 字段=`（空值）等于清空，与 `--unset` 等效**；但把**打码后的值**（含 `******`）写回去会被拒绝——那通常意味着「不修改」，什么都不传即可。
2. **`entry add` 同栏目同名直接报 `CONFLICT`**，不会静默再插一条。要改就用 `entry update`。
3. **`--section` 是栏目过滤，不是条目参数**。`entry update` 的 `--section` 只用来消歧同名条目。

## 四、AI 补全个人信息的推荐流程（本 skill 的主场景）

```bash
# ① 看现在有什么、缺什么
nx-sk section dump job --json
#    → entries[].missing[] 就是「还差哪些字段」的清单

# ② 看字段字典（key / label / type / options / hint），别猜字段名
nx-sk entry fields --section job --json

# ③ 批量补：先试运行，确认后再落盘
nx-sk entry update 张三 --data @补全.json --dry-run
nx-sk entry update 张三 --data @补全.json
#    补全.json 形如：{"身份证号":"…","英语等级":"CET-4","期望城市":["北京"]}

# ④ 复核
nx-sk entry get 张三 --json
```

**纪律**：

- 只写用户提供或已确认的值。不确定的字段**留空**，不要编造。
- 身份证号、手机号、紧急联系人电话这类字段，写之前跟用户确认一次来源。
- 每次批量写之前先 `--dry-run`。

## 五、块正文与 AI 提议（entry.body / entry ai）

条目除了结构化字段还有**块正文**（`entry.body`，可选键）：段落 / 标题 / 图文 / 表格 / 清单 /
附件 / 密钥七种叶块，加内嵌栏目（`section`）与分栏（`column`)两种容器块。

```bash
# 建块 / 看块
nx-sk entry block add <ref> --type paragraph --data '{"text":"第一段"}'
nx-sk entry block list <ref>          # secret 块默认原文，--mask 打码
nx-sk entry block update <ref> <块id> --data @块.json
nx-sk entry block move <ref> <块id> --to 0

# AI 提议：**AI 永不直接改数据**
#   ① 你（agent / 外部模型）产出提议正文 = 该条目的最终块数组
#   ② suggest 只落一条 pending（~/nx-sk/pending/，运行态，不进 store / 导出包）
#   ③ 人或你在面板/CLI 上 apply（才写 store）或 reject（只删文件）
nx-sk entry ai suggest <ref> --prompt "把自我介绍改短" --from @proposal.json
nx-sk entry ai list <ref>
nx-sk entry ai apply <pendingId>      # 块被改过 → CONFLICT，--force 才覆盖
nx-sk entry ai reject <pendingId>
```

**纪律**：

- proposal.json 是 `{"blocks":[…]}` 或直接块数组；给**最终正文**，不是补丁。
- 建议先 `nx-sk entry block list <ref> --json` 拿现正文再改，块 id 保持不变
  （同 id 不同内容 = 一次「修改」，出现新 id = 「新增」，缺了的 id = 「删除」）。
- 密钥块在提议里是明文——pending 落在本机运行态目录（0600），这是有意设计；
  但**不要**把 pending 文件内容贴进对话或日志。
- 应用前想留底就先 `transfer export`（apply 写 store，与手改同一条边界）。

## 六、数据库视图（section.views / section view）

视图是**同一批条目的多种投影**：表格（列 = 字段投影）、精简（两列）、看板（按 select 字段分列）、
KV 栏目的键值面。配置存在 `section.views` / `section.defaultView`（可选键）。

```bash
nx-sk section view list <id>            # 没配过时给缺省推断（provisional: true，不落盘）
nx-sk section view add <id> --type board --title 按状态 --groupby status
nx-sk section view update <id> <viewId> --set col.状态.width=180 --sort 状态:desc
nx-sk section view set-default <id> <viewId>
nx-sk section view remove <id> <viewId>
```

**语义**：

- **缺省视图是推断的、不落盘**：非 KV 栏目给「表格 / 精简 / 看板」，KV 栏目给「KV」。
  第一次改视图才固化（把当时生效的那套推断视图一起写进去——只写用户新建的那条，
  其余 chips 会凭空消失）。`views: []` 与「没配过」行为一致，都走推断。
- 投影只存 `key / width / hidden`；标签与类型回查字段字典。引用的字段被删 → 列还在，
  表头写「已删字段」、单元格「—」（不炸、也不静默消失）。
- **看板的拖卡 = 写操作**：等于 `entry update --set <groupby字段>=<列值>`；
  空值与候选外的值落「未分组」列——展示可以，**不是拖拽落点**（拖进去等于写一个不存在的值）。
- **没有筛选 DSL**（`--filter` 明确不做）：存一个不生效的配置比没有更糟。
- 视图随导出包往返；导入只在「新建栏目」或「目标没配过视图」时应用——
  目标已有视图说明用户自己配过，不静默覆盖（预览里给警告）。

## 七、扩字段字典（不写代码）

**最省事的做法：直接写。** 字典里没有的键会自动登记（键名就是它本身），类型按值推断
（`是/否` → bool，数组 → tags，其余 → text）。

```bash
nx-sk entry update 张三 --set 期望行业=互联网 --set 技术博客=https://example.com
```

**刻意不推 number**：18 位身份证号这类长数字超过 2^53，推成数字会静默丢精度。

**键名像凭据的，自动登记成密文字段**：密码 / 口令 / 密钥 / 账号 / 帐号 / 凭据 / 凭证 /
token / apiKey / accessKey / secretKey / password / passphrase… 这些词出现在键名里，
新登记的字段就直接是密文字段（落盘 AES-256-GCM 密文，读出来默认原文）。
所以「直接写账号密码」是安全的——不必先声明 schema，也不会明文躺在 `store.json` 里。
完整口径与凭据归属见 `30-credentials`。

需要给字段配上候选值 / 提示文案 / 密文标记时，再显式声明：

```bash
nx-sk section update job --add-field '{"key":"blog","label":"技术博客","type":"text","group":"contact","hint":"URL"}'

# 删字段：只影响台账，已填的值留在条目里（不再显示 ≠ 删掉）
nx-sk section update job --remove-field blog

# 整体替换字典（少数场景）
nx-sk section update job --fields @fields.json
```

字段定义支持：`key`（字母开头）、`label`、`type`（`text|textarea|number|date|month|bool|select|tags|entrylist|table|source|secret|file|md`）、
`group`、`hint`、`options`（候选项）、`sensitive`（true 则密文落盘）、`maxItems`（tags / file 上限）、
`fill`（填写策略，见下）。

> `type: 'file'` 是**附件字段**：值 = 附件 id 的**列表**（一个字段可挂多个；不是路径），
> 导入原件、附件库台账、以及「文件统一放 `~/nx-sk/files/`」的完整口径见 `40-files`。
>
> `type: 'md'` 是**图文字段**：值是一段 markdown 正文，里面用 `![说明](f_xxx)` 引用附件库里的图片。
> 面板里可以直接 Ctrl+V 粘截图 / 拖入 / 从库里选，图片统一列在正文下方、点开可缩放拖动看细节；
> 正文里的 `http(s)` 网址（裸网址或 `[文字](https://…)`）在预览里会变成**可直接点开的链接**
> （新标签页打开），便于把控制台、文档地址嵌进 SOP；`![说明](https://…)` 这样的外链图片也会直接显示
> （不进附件库，需要联网）。`entry get` 会把本地图片引用还原成「[图片: 说明] 本地路径」，
> 外链图片则给「[外链图片: 说明] 地址」。写部署 SOP 这类「说明 + 截屏」的内容用它，口径见 `50-deploy`。

> `type: 'entrylist'` 是**结构清单字段**：值 = 行对象的**数组**，行数不限（变长）；列（子字段）
> 在字段定义的 `fields` 里声明。适合「一个条目挂多组 链接/账号/密码」这类密集结构——
> tags 存不了结构，拆成多个字段又不知道会有几组。声明 `sensitive: true` 的列与顶层敏感字段
> 同一条边界：密文落盘、默认原文、`--mask` 打码。面板渲染成密集迷你表，直接增删行。
>
> ```bash
> # 建字段（面板「新增字段」选「结构清单」会预填 名称/链接/账号/密码(密文) 四列）
> nx-sk section update mysec --add-field '{"key":"accounts","label":"账号清单","type":"entrylist","group":"main","fields":[{"key":"name","label":"名称"},{"key":"url","label":"链接"},{"key":"user","label":"账号"},{"key":"pass","label":"密码","sensitive":true}]}'
>
> # 写入：值是行数组（--data 直接给 JSON；--set 认 JSON 串）；`--set 字段=` 清空
> nx-sk entry update 张三 --data '{"账号清单":[{"名称":"主控台","链接":"https://…","账号":"ops","密码":"…"}]}'
> ```
>
> 规矩：全空行写入时自动剔除；行里的键必须是声明的清单列（写错当场报，不静默丢）；
> **列名用 key 或中文标签都认**（`密码` 与 `pass` 等价，与顶层 `--set` 同一口径）；
> 没登记过的键直接写行数组会**自动登记**成 entrylist 并从行推断列。`entry get` 里清单一行一条：
> `名称=主控台 · 链接=https://… · 账号=ops · 密码=…`（--mask 时密码列打码）。

> `type: 'table'` 是**表格字段**：`entrylist` 的进阶版 —— 每格有类型（勾选 / 下拉 / 数字 / 日期），
> 还能有**计算列**（JS 表达式）与**表尾统计**。最根本的差别是**结构归数据**：列定义、行、公式、
> 统计配置全部存在**条目值里**（`{v, columns, rows, totals?, summary?}`），字段定义里的 `columns`
> 只是「新建时的初始列」。所以「这一条想多一列」不必改 schema，也不影响同栏目其它条目。
>
> ```bash
> nx-sk section update mysec --add-field '{"key":"tasks","label":"任务表","type":"table"}'
> nx-sk entry update 周报 --data '{"任务表":{"columns":[…],"rows":[…]}}'
> nx-sk entry table 周报 --field 任务表        # 只看这张表：数据 + 合计 + 公式报错
> ```
>
> 形状、公式作用域与内建、统计两个轴、**写入即体检**（语法 / 列名 / 单值不通过就不保存）、
> 空值与默认值、常见错对照表 —— 全在 [[15-special-fields]]，这里不重复一份（两份必然漂移）。

> `type: 'source'` 是**原始资料袋**：每个栏目都自带一个的「乱入区」。值 = 一组资料条目
> （`{id, kind, name, text|fileId|url, addedAt, note, mapped}`，kind = text/file/url）。
> 杂乱资料（邮件、截图、PDF 摘录、手抄的表）先**原样**丢进袋里，之后由 agent 或人
> 按字段字典整理进上面的字段——「先乱入、后整理」因此成立：没有这个袋子，用户只有
> 把乱数据硬塞进结构化字段（把结构搞脏）或干脆不存（信息丢了）两个坏选择。
> - 面板上：条目表单底部一条**折叠条**「原始资料 · N 条」，点开是右侧抽屉——
>   左清单、中间正文，文件可拖进去（也给了「选择文件」按钮与粘贴框：拖拽不能是唯一入口）。
> - CLI：`nx-sk source list / get / add / update / remove / ensure`（细节见 `sk-source` skill）。
> - 三条纪律：**原文不改写**（整理结果写进字段或新的一条）、**不确定就留空**、
>   **敏感内容不进袋**（袋是明文的；密码走**场景栏目里的密文字段**，不进袋也不进密钥栏目）。
> - 袋**不计完整度**（`fill: optional`）：它是暂存区，不是「该填的格子」。
> - **冲突以新的为准，旧的留痕**：同名即冲突，时间新的那条是「当前版本」，
>   旧的标「已被取代」但**不删**（原始证据要能翻回去看）；`--at` 记资料自身的时间
>   （如邮件时间），缺省用入袋时间；名字不同但同一件事用 `--supersedes <旧id>` 显式指明。
> - 老栏目是模板实例化时建的、当时还没有这个字段 → `nx-sk source ensure` 一次补齐。

> `select` 的 `options` 是**候选项不是白名单**：真实值（如某个少数民族）不在候选里也允许写入。

### 栏目结构：分组也是数据，面板里就能改

栏目 = 分组（`section.groups`）+ 字段字典（`section.fields`），两样都只是**数据**：
分组是条目表单里的小标题，**顺序就是它们出现的先后**。面板「编辑栏目」里能直接增删改序，
CLI 用同一批 action —— 不存在「哪一边功能少一点」。

```bash
nx-sk section update job --add-group '{"id":"contact","title":"联系信息"}'
nx-sk section update job --rename-group '{"id":"contact","title":"联系方式"}'
nx-sk section update job --rename-group '{"id":"contact","title":"联系方式","newId":"reach"}'  # 换 id：组里字段的 group 跟着改
nx-sk section update job --move-group '{"id":"reach","dir":"up"}'
nx-sk section update job --remove-group reach                        # 空组才能删
nx-sk section update job --set-field '{"key":"phone","label":"手机号","group":"reach"}'
nx-sk section update job --move-field '{"key":"phone","dir":"up"}'   # 在自己的分组内换位置
```

每次改动都会把**新旧值**打进输出（`字段 phone：分组 contact → reach`）——
「已更新栏目 job：fields」这种输出等于没说，改错了没法回溯。

三条规矩，全是**拦下来**而不是悄悄做：

| 规矩 | 为什么 |
| --- | --- |
| 分组 id 唯一 | 重复报 CONFLICT，绝不覆盖同名分组（改名用 `--rename-group`） |
| 非空分组不给删 | 字段上挂着每个条目的值；先把字段挪走（改它的「分组」）或删掉 |
| 字段 key 不可改 | 值按 key 存在条目里，改 key = 已有值读不出来。要换就新增字段再搬值 |

另外两条边界：内置的「原始资料」分组与字段**删不掉**（每个栏目自带，删了下回读又补回来）；
清单类字段（`entrylist` / `table`）的列是字段自己的结构，所以**不提供就地换类型**——
要建就在「新增字段」里连列一起建。

### 填写策略 `fill`：有些格子填了反而减分

不是每个格子都值得填。应届生的「上一家公司」、政治面貌为「群众」时的「入党时间」——
填上去不是补充，是噪音。`fill` 把这种判断**变成字段字典里的数据**，不用每次靠人记：

| 值 | 含义 | 计入完整度 |
| --- | --- | --- |
| `normal` | 照常填（**默认**——字段上不写 `fill` 就是它） | 是 |
| `optional` | 不必填：填了不亏，没填也不算「缺失」 | 否 |
| `avoid` | 不填：填了可能反而减分 | 否 |

```bash
# 一次标几个，可重复；label 或 key 都认
nx-sk section update job --fill 入党时间=avoid --fill 上一家公司=avoid --fill 兴趣爱好=optional

# 改回照常填
nx-sk section update job --fill 入党时间=normal
```

被排除的字段**既不计入分子也不计入分母**，所以完整度反映的是「你真正该填的那些」。
但它们不会被藏起来——`missing`（欠着的）和 `excluded`（主动跳过的）是分开报的：

```bash
nx-sk entry get 张三
#   张三（e_…）· 栏目 job · 完整度 8/9 = 89% · 另有 3 项已标不填
#   未填（1）: 高考科目(gaokaoSubjects)
#   不填（3）· 主动跳过、不计入完整度: 入党时间(partyJoinDate｜不填)、…
```

`--json` 里对应 `completeness.excluded`（个数）、`completeness.excludedFilled`
（标了不填却仍然填了的个数——非 0 就说明策略该更新了）、以及顶层的 `excluded[]` 数组。
`entry fields` / `section dump` 的字段字典会带上 `fill` 与 `fillLabel`，面板据此打标签。

> **给 agent 的三条**：① `fill: 'avoid'` 的字段**不要主动填**，`optional` 可填可跳过；
> ② 两者都**不要**出现在「还缺什么」的清单里；③ 用户说「这个不用填」时，
> 用 `--fill <字段>=avoid` 记下来，而不是靠下一轮上下文记住。

## 八、Web 面板

`nx-sk serve` 打开的是**可停靠的工作区**（Notion 式壳），不是一栏一页：

- **目录树**（左侧面板）：栏目 + 分组 + 条目子节点。拖拽重排与嵌套——第一次拖动会把
  「从旧导航配置推断出的树」固化成显式 `settings.navTree`（`settings get` 里
  `navTreeSource: explicit`，之前始终 `inferred` 只读不写回）；隐藏的栏目收在树底，一键恢复。
- **布局 = FlexLayout 模型**：数据库 / 资料 / 文件 / 导出 / 设置都是面板，可拖到任意一边拆分、
  弹出成浮窗；布局存 localStorage（`nx-sk-ui.workspace`），跨会话恢复，顶栏可撤销/重做。
- **两段深链**：`#/栏目` 开该栏目的数据库面板，`#/栏目/条目` 再定位到条目；
  栏目 / 条目缺失时明确提示是哪一级没了。
- 栏目页（数据库面板）顶部是**视图 chips**（表格 / 精简 / 看板 / KV，见 §六）；
  左侧条目列表带完整度，右侧按分组渲染的字段表单。
- 密文字段默认显示原文；顶栏「打码」等价于 `--mask`（选择持久化在 localStorage）；
- **栏目结构自己能搭**：栏目面板里点某个栏目的「编辑」，弹窗里分组可新增 / 改名（含换 id）/
  上下挪 / 删（空的才让删），字段可改标签 / 类型 / 分组 / 提示 / 必填策略、组内上下挪、删除
  —— 一次改动一次落盘，与 CLI 的 `--add-group` 等是同一批 action（见 §七「栏目结构」）。
- 保存是 **PATCH**：只有被你改动过的字段才会发出去（面板会显示「N 处改动」）；
- 详细页下半部分是**块面板**（见 §五），AI 提议是评审条：渲染 diff + 应用 / 拒绝。

面板上没有 CLI 做不到的事——两边共享同一套 action 声明。
