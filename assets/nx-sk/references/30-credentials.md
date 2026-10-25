# 30 · 凭据自动化（场景凭据 → 可用配置）

> 归属 `nx-sk` skill 主文档。**要存账号密码、要把凭据变成配置文件时读这篇。**
> 密文机制本身见 `20-secrets`，字段与命令见 `10-sections-entries`。

## 一、模型：凭据跟着场景走

**一条原则**：凭据存在**它所属的场景**里，不要为了存它去动全局「密钥」栏目。

| 凭据 | 归属 | 形状 |
| --- | --- | --- |
| 某个云平台 / 容器平台的账号密码 | 该平台所在的栏目条目（`platform` 模板，或自建栏目） | 普通字段（密码列密文） |
| 某个部署场景的仓库令牌 / 数据库密码 | 该场景的 `deploy` 条目（自带「凭据清单」字段） | 结构清单（一行一组） |
| 跨场景复用的 API Key（`OPENAI_KEY`…） | `secret` 密钥栏目（KV 表） | 一行一个键值对 |
| 简历 / 证书原件 | `job` 栏目的 `file` 字段 | 附件 id 列表 |

为什么这么分：**凭据的寿命跟着场景**。场景下线了凭据跟着删；场景换了凭据只改一处。
把所有凭据堆进一个 KV 表，时间一长就分不清「这条是给谁的」——
到那时唯一的办法是给键名加前缀（`aliyun_prod_password`），那等于把场景结构塞进了键名里。

**KV 表仍然有用**：它的定位是「环境变量表」——那些要 `export OPENAI_KEY=…` 的通用 key。
判断口径：**这条凭据只服务于一个场景 → 场景栏目；处处要用 → 密钥栏目。**

## 二、三种写法（按需要挑，不必都学）

### 1. 直接写（最常用）——键名像凭据就自动加密

```bash
nx-sk entry update "阿里云" --section deploy --set 账号=ops@example.com --set 密码='P@ss…'
```

- 键名**在台账里没有**就自动登记；**键名像凭据**（密码 / 口令 / 密钥 / 账号 / 帐号 / 凭据 /
  token / apiKey / accessKey / secretKey / password / passphrase…）就**建成密文字段**。
- 结果：落盘是 AES-256-GCM 密文（`store.json` 里看不到明文），读出来默认原文。
- 不像凭据的键（`技术博客`、`端口`）仍然是普通文本字段 —— 不会把整个栏目加密成噪音。

**这就是「大胆写」的实现方式**：不需要先声明 schema，密码也不会明文裸奔。

### 2. 显式声明密文字段（要固定形状、要出现在面板表单上时）

```bash
nx-sk section update deploy --add-field '{"key":"registryToken","label":"仓库令牌","type":"secret","group":"cred","hint":"推镜像用的 token"}'
nx-sk entry update "阿里云" --section deploy --set registryToken=xxxxxxxx
```

`type: 'secret'` 与 `sensitive: true` 等价（后者可用于任意类型）。
面板会把它渲染成密码框并默认显示原文，可勾选「打码显示」。

### 3. 结构清单（一个场景多组账号 / 一份配置多套凭据）

```bash
# 自建栏目：先建栏目，再声明「凭据清单」字段
nx-sk section add mycloud --title "我的云平台"
nx-sk section update mycloud --add-field '{"key":"creds","label":"凭据清单","type":"entrylist","group":"main","fields":[{"key":"name","label":"名称"},{"key":"user","label":"账号"},{"key":"pass","label":"密码","sensitive":true},{"key":"token","label":"令牌","sensitive":true},{"key":"note","label":"备注"}]}'

nx-sk entry update "阿里云" --section mycloud --data '{"凭据清单":[{"名称":"控制台","账号":"ops","密码":"P@ss…"},{"名称":"镜像仓库","账号":"ci","令牌":"tok-…"}]}'
```

> `deploy` 模板**自带**这个字段（分组「凭据」），直接用即可；
> 老栏目用 `nx-sk section sync deploy` 补上。`--add-field` 遇到**同名**字段会报冲突 ——
> 那说明这个栏目已经有了，换个 key 或删了重加。

- 行里的列名**用 key 或中文标签都认**（`密码` 与 `pass` 等价）；写错的列当场报错，不静默丢。
- 声明 `sensitive: true` 的列与顶层敏感字段同一条边界：密文落盘、`--mask` 打码。

## 三、跨栏目台账

凭据散在各个栏目里，用这一条命令对账：

```bash
nx-sk entry keys                          # 全部栏目；值默认打码
nx-sk entry keys --reveal                 # 明文（喂脚本 / 给自己看）
nx-sk entry keys --section deploy         # 限定栏目
nx-sk entry keys --q 密码                 # 关键字过滤（栏目/条目/字段/值）
```

命中规则：字段 key / label 命中「链接 / 账号 / 密码 / 令牌 / 镜像」启发式，
或字段类型是 `secret` / 标了 `sensitive`。值策略：链接类明文、账号密码令牌类打码（`--reveal` 才出原文）。

**改密码 / 找入口 / 迁移机器前，先跑一遍 `entry keys`** —— 少一把就少一个惊喜。

## 四、把凭据渲染成配置文件（主用途）

用户要 compose / k8s / .env / Dockerfile 时，**直接给成品**，不要只给模板让人自己填。

### 标准流程

```bash
# ① 取真值（密文字段自动解密；--mask 反而会挡住你）
nx-sk entry get "阿里云" --section deploy --json > /tmp/e.json

# ② 渲染：模板正文里的 ${VAR} 用这个场景的凭据替换
node assets/nx-sk/scripts/render-config.js /tmp/e.json ./docker-compose.local.yml

# ③ 真值副本另存一份 .env（同样不进 git）
```

脚本的规则：`creds` 里每行的**「名称」= 变量名**（值取密码 / 令牌 / 账号）；
条目其它**标量**字段按**字段 key** 也当变量；正文取 `content`；
占位符支持 `${VAR}` 与 `${VAR:-默认值}`。跑完会报**替换了哪些、哪些没解析**
（没解析通常是「名称」与占位符名没对齐）。已装 skill 的话脚本在
`~/.claude/skills/nx-sk/scripts/render-config.js`。

> 为什么是脚本而不是一行 `node -e`：**多行 `node -e` 在 Windows 终端里会被吃掉引号**
> （实测是「静默不执行、退出码 0」）。渲染这段逻辑固化成文件才跑得稳 ——
> 跟 20-secrets 里「多行值走 stdin / @文件」是同一个坑的两面。

### 模板（进 git）与实例（不进 git）的分工

| | 内容 | 去处 |
| --- | --- | --- |
| **模板** | `content` 正文里写 `${VAR}` 占位；`vars` 列出每个变量该填什么 | 可复用、可分享、进仓库 |
| **实例** | 占位符换成本场景真值 | 本机文件，**不进仓库** |

`content` 是**会被复制进别人项目**的东西，所以里面只放占位符；
真值放在同一个条目的「凭据清单」里（密文落盘），出实例时现场替换。
这不是「怕明文」，是**模板与实例本来就是两种东西**。

### 仓库里该怎么提交

```bash
# 提交的：占位符版本 + 示例
docker-compose.yml        # 里 ${REGISTRY_TOKEN} / ${DB_PASSWORD}
.env.example              # 键名齐全，值留空
# 不提交的（.gitignore 里盖住）
.env
docker-compose.local.yml
```

`.gitignore` 至少盖住：`.env`、`.env.*`（但放行 `.env.example`）、`*.local.yml`、
以及 nx-sk 自己的 `store.json` / `.vaultkey` / `.vaultsalt`。

## 五、安全边界：只有三个出口

本机单人工具，密文落盘、面板只听 `127.0.0.1`、数据在仓库之外。
所以「敢不敢大胆写」的答案取决于**这三个出口有没有开**：

| 出口 | 判断 | 动作 |
| --- | --- | --- |
| **推送到 git / 上传云端** | 真值进了版本库 = 凭据公开 | 仓库里只放占位符 + `.env.example`；真值文件加进 `.gitignore` |
| **打进日志 / issue / 聊天 / 给第三方的输出** | 明文离开本机 | 输出前 `--mask`，或手工替换；导出包外发必须 `--passphrase` |
| **导出包外发** | 包里是**明文凭据**（没有打码导出选项） | `nx-sk transfer export <栏目> --passphrase 口令` 整包加密，只发给可信对方 |

没开这三个出口时，**不必再自我审查一遍密码本身**：
本机文件里带真值是正常的，`--mask` 是给「投屏 / 截图 / 贴给别人看」用的，不是给「自己用」用的。

## 六、常见场景怎么放

| 场景 | 放哪 | 大致写法 |
| --- | --- | --- |
| 云平台（阿里云 / 腾讯云 / AWS） | 自建栏目「云平台」，或 `platform` 模板 | `--set 账号=… --set 密码=… --set AccessKeyId=… --set AccessKeySecret=…`（后两个自动加密） |
| 容器平台（KubeSphere / Rancher） | `platform` 模板 | 控制台链接 / 账号 / 密码 / 命名空间 / 镜像 |
| 镜像仓库 | `deploy` 条目的凭据清单 | 名称 `registry`、账号、令牌 |
| 数据库 / 中间件 | `deploy` 条目的凭据清单 | 名称 `mysql`、账号、密码 |
| 大模型 API | `secret` 密钥栏目 | `nx-sk key set OPENAI_KEY sk-…`（跨场景复用） |
| CI / 发布凭据 | `deploy` 条目的凭据清单 | 名称 `ci`、账号、令牌 |

## 七、排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 写进去的值在 `store.json` 里能搜到明文 | 键名不像凭据（`pwd` 之外的自由词） | 声明一个密文字段重写，或把键名改成带 `密码/token/口令` 的 |
| `BLOCKED 当前密钥与写入时的密钥不一致` | 换了口令 / 删了 `.vaultkey` | 见 `20-secrets` 第四节 |
| 值被拒：「收到的是打码占位而非明文」 | 把 `--mask` 后的串写回去了 | 传完整值，或什么都不传（= 不修改） |
| 面板里看不到刚写的字段 | 字段没进台账（老栏目 + 模板后加） | `nx-sk section sync <栏目>` |
| 渲染出来的配置里 `${VAR}` 没替换 | 凭据清单里的「名称」与占位符名不一致 | 名称对齐（`${REGISTRY_TOKEN}` ↔ 名称 `REGISTRY_TOKEN`） |
