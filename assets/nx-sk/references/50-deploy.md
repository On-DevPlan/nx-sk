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
| `content` | **文件正文**（整份原文） |
| `vars` | 复用前要替换的变量，每行一个 `变量 = 说明` |
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

# 2) 取：拿到完整字段（正文在 .values.content）
nx-sk entry get "node-web 多阶段 Dockerfile" --json

# 3) 替换：.values.vars 里列的那些变量，逐个换成本项目的值
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

## 六、明文密钥不写在这里

`content` 里**只写占位符**，真值放「密钥」栏目（那里是密文落盘）：

```yaml
# 对：占位
stringData:
  token: ${REGISTRY_TOKEN}
```

```bash
nx-sk key set REGISTRY_TOKEN <真值>     # 密文落盘，读出来是原文
```

理由：配置文件是最容易被**整份复制粘贴分享**的东西（发同事、贴 issue、进聊天记录），
而密钥栏目的落盘是 AES-256-GCM 密文。把两者混在一起，等于给凭据开了一条最宽的出口。

> 例外：`k8s-secret` 作为**资源模板**可以有条目，但里面的值同样要写成占位符 ——
> 它描述的是"Secret 该怎么组织"，不是"密钥是多少"。

## 七、什么时候不放这里

- 项目**正在用**的那份配置 → 进 git（要跟着代码走）。
- 别人给的二进制 / 压缩包 / 带签名的文件 → 放「附件」库（`file add`）。
- 需要多版本并存、要 diff 的两版配置 → 正文里加 `版本` 标签或直接放仓库；本栏目只留**当前认可的规范版**。
