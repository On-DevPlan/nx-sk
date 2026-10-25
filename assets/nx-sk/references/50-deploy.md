# 50 · 部署配置（Docker / K8s 规范资源）

> 归属 `nx-sk` skill 主文档。要把 Dockerfile / docker-compose / k8s 清单**存成可复用资源**，
> 或从库里取一份去用，读这篇。字段与命令的通用部分见 `10-sections-entries`。

## 一、为什么单开一个栏目

配置文件有两种去处，别混：

| 去处 | 适合 | 不适合 |
| --- | --- | --- |
| 代码仓库（git） | 某个项目**正在用**的配置，要跟着代码一起演进、review、回滚 | 跨项目复用的"模板"——每个仓库存一份，很快就各改各的，没人知道哪份是对的 |
| 「附件」库 | 二进制原件、别人给的 zip、要原样留档的文件 | 需要**检索 / 改一个变量 / 对比两版**的东西 |
| **「部署配置」栏目** | **可复用的规范资源**：一份文件一个条目，正文可检索、可替换、可复制 | 需要 git 历史的项目内配置 |

一句话：这个栏目是**规范的"发行版"**，项目里的那份是"部署实例"。

## 二、一个条目 = 一份文件

| 字段 | 作用 |
| --- | --- |
| `name` | 条目名（资源名）。一眼看出是什么，如「node-web 多阶段 Dockerfile」 |
| `kind` | `Dockerfile` / `docker-compose` / `dockerignore` / `k8s-deployment` / `k8s-service` / `k8s-ingress` / `k8s-configmap` / `k8s-secret` / `k8s-kustomization` / `helm` / `其他` |
| `stack` | 适用技术栈：`node` / `go` / `python` / `任意` |
| `path` | 建议落盘路径，如 `deploy/k8s/base/deployment.yaml` |
| `tags` | 自由标签，如 `prod`、`多阶段`、`健康检查`、`SSE` |
| `content` | **文件正文**（整份原文，模板形态：密钥写 `${VAR}` 占位） |
| `vars` | 复用前要替换的变量，每行一个 `变量 = 说明` |
| `creds` | **凭据清单**（结构清单）：这个场景自己的账号 / 密码 / 令牌，**密码与令牌列密文落盘** |
| `usage` | 何时用、为什么这么写、坑在哪 |
| `sop` | 「说明 + 截屏」的操作步骤（`md` 类型）：直接 Ctrl+V 粘图，图片统一列在下方可放大看细节 |
| `files` | 要连真实文件一起留档时挂附件（可选） |

**一份文件一个条目**，不要把一个项目的 Dockerfile + compose + 三个 k8s 清单塞进同一个条目：
那样既没法按 `kind` 筛，改其中一份也会牵动其它。要表达"同属一个项目"，用 `tags`（如 `proj:nx-kv`）。

## 三、存一份

多行正文走 `--data @file.json` 最稳（`--set` 也吃多行，但要小心 shell 引号）：

```bash
# 1) 用一个 JSON 把字段一次给全（正文里就是文件原文）
cat > /tmp/entry.json <<'JSON'
{
  "kind": "Dockerfile",
  "stack": "node",
  "path": "Dockerfile",
  "tags": ["多阶段", "健康检查"],
  "vars": "NODE_VERSION = 基础镜像版本\nEXPOSE_PORT = 监听端口",
  "usage": "runtime 阶段不装 node_modules：服务端零 npm 依赖，镜像能压到 ~60MB。",
  "content": "FROM node:22-alpine AS build\n...\n"
}
JSON
nx-sk entry add --section deploy --title "node-web 多阶段 Dockerfile" --data @/tmp/entry.json

# 2) 嫌麻烦就直接把文件读进 --set（单行命令，注意整体加引号）
nx-sk entry add --section deploy --title "标准 k8s Deployment" \
  --set kind=k8s-deployment --set "content=$(cat deploy.yaml)"
```

## 四、取一份来用（复用流程）

```bash
# 1) 找：按类型 / 标签 / 关键词筛（q 会搜正文）
nx-sk entry list --section deploy --q Dockerfile --json

# 2) 取：拿到完整字段（正文在 .values.content，这个场景的凭据在 .values.creds）
nx-sk entry get "node-web 多阶段 Dockerfile" --json

# 3) 替换：.values.vars 里列的那些变量，逐个换成本项目的值
#    （本场景自己的凭据已经在 .values.creds 里，真值自动解密 —— 渲染见第六节）
# 4) 落盘：写到 .values.path 指向的位置
```

**别跳过第 3 步**：正文里的值（端口、镜像名、副本数）是上一份场景的取值，直接抄走就会带着别人的假设。

整栏打包成 ZIP（分享 / 归档 / 迁移都用它）：

```bash
nx-sk transfer export deploy --out deploy.zip
```

可读的 Markdown / JSON 导出已删除 —— 项目里只有 ZIP 这一条导出路径。

## 五、写操作步骤（`sop` 字段：图文 + 截屏）

部署这种东西，**文字说不清的地方基本都在截图里**：哪个按钮、哪一行日志、报错长什么样。
所以本栏目有一个 `md` 类型的 `sop` 字段：

```
1. 打开控制台，进入「工作负载」
   ![第一步](f_lq3k2j9a1b2c3d4)
2. 点「伸缩」，副本数改成 1 —— 注意 RWO 卷不能多副本
   ![第二步](f_lq3k2j9e5f6g7h8)
```

- 面板里**直接 Ctrl+V 粘截图**（也可以把图拖进字段框，或从附件库选），图会先上传到附件库，
  正文里只留 `![名字](id)`；图片统一列在正文下方，点开能放大、滚轮缩放、拖动看细节。
- 正文是**标准 markdown**：导出成 md、贴进仓库 README 都能直接渲染。
- 控制台、官方文档这类地址直接写进去就行：`https://…` 裸网址或 `[控制台](https://…)` 都认，
  预览里点一下就在新标签页打开 —— 不必先把链接抄到别处。外链图片 `![说明](https://…)` 也会显示
  （不进附件库，需要联网；内网图床换机器可能打不开，长期留档的图还是粘进来存本地）。
- 图片本身走附件库（`~/nx-sk/files/`），同内容去重，不会因为贴两次就存两份。
- CLI 侧 `nx-sk entry get <资源名>` 会把 `![…](f_x)` 还原成「[图片: 名字] 本地路径」，
  agent 因此能直接读到那张图（路径可交给自己或别的工具看）。

> 截屏里如果出现 token / 密码 / 内网地址，**先打码再贴**：正文与图片都回不到密文形态。

## 六、密钥分两层：模板层与场景层

`content` 是**会被复制进别人项目**的东西（最后进 git），所以模板层只写占位符：

```yaml
# 对：占位（模板）
stringData:
  token: ${REGISTRY_TOKEN}
```

**真值写在同一个条目的「凭据清单」里**（`creds` 字段，密码 / 令牌列密文落盘）：

```bash
nx-sk entry update "prod 部署" --section deploy --data '{"凭据清单":[{"名称":"REGISTRY_TOKEN","令牌":"tok-真值"}]}'
```

这不是「怕明文」，是**模板与实例本来就是两种东西**：
`content` 是模板（可复用、可分享、进仓库），`creds` 是这个场景的实例数据（在本机、密文落盘）。

### 出配置文件：直接给成品

用户要的是**能直接用的配置**，不是模板 + 一句「你自己填」。所以：

```bash
# 取真值（密文自动解密）
nx-sk entry get "prod 部署" --section deploy --json > /tmp/e.json

# 用 creds 里的真值替换 content 里的 ${VAR}，产出成品
node assets/nx-sk/scripts/render-config.js /tmp/e.json ./docker-compose.local.yml
```

**成品里带真值没问题**（本机文件，没人看），只要守住两条：

- **别让它进 git**：仓库里提交的是占位符版本 + `.env.example`，真值放 `.env` / `*.local.yml`，
  并让 `.gitignore` 盖住。
- **别把它打进日志或交给第三方**。

细节（多组账号怎么建清单、跨栏目台账、各类凭据放哪）见 `30-credentials`。

> 例外：`k8s-secret` 作为**资源模板**可以有条目，但正文里的值同样要写成占位符 ——
> 它描述的是"Secret 该怎么组织"，不是"密钥是多少"；真值仍然在这个条目的凭据清单里。

## 七、什么时候不放这里

- 项目**正在用**的那份配置 → 进 git（要跟着代码走）。
- 别人给的二进制 / 压缩包 / 带签名的文件 → 放「附件」库（`file add`）。
- 需要多版本并存、要 diff 的两版配置 → 正文里加 `版本` 标签或直接放仓库；本栏目只留**当前认可的规范版**。
