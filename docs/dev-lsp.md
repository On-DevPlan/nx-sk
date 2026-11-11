# 开发环境：TypeScript LSP

> 本文件讲「在这个仓库里怎么用 LSP 做代码导航」——工具链怎么装的、为什么这么装、
> 哪些坑踩过。**代码本身在 `src/` 下，规范在 `docs/` 下**；这里只管开发体验。

---

## 现状

Claude Code 通过**本地 plugin** 提供 TypeScript LSP：

```
.claude/plugins/marketplaces/local/
├── .claude-plugin/marketplace.json          # marketplace 清单
└── plugins/ts-lsp/.claude-plugin/plugin.json # LSP server 声明
```

已注册为 `ts-lsp@local`（project scope），开启 6 项能力：
hover / goToDefinition / findReferences / documentSymbol / workspaceSymbol / rename。

依赖：`typescript-language-server@6.0.3`（devDependency）。
server 用 `npx --no-install typescript-language-server --stdio` 启动——
`--no-install` 保证它用**本仓库锁定的版本**，不会去拉最新的。

## 为什么必须走 plugin，不能写进 settings.json

**Claude Code 的 `lspServers` 只存在于 plugin manifest 里，settings.json 没有这个键。**
实测确认过：`claude.exe` 二进制里 `lspServers` 的 schema 挂在 plugin.json 的
`Ja` 对象上，settings.json 的 schema（`env` / `permissions` / `hooks` / `statusLine` …）
里根本没有它。写进 `~/.claude/settings.json` 不会报错，但**也不会生效**。

所以结构必须是：

```
marketplace 目录（.claude-plugin/marketplace.json）
  └── plugins/<name>/.claude-plugin/plugin.json  ← lspServers 在这里
```

注册命令：

```bash
claude plugin marketplace add ./.claude/plugins/marketplaces/local
claude plugin install ts-lsp@local -s project
```

> `claude plugin install ./path` **不行**——它只接受 marketplace 里的插件名。
> 必须先 `marketplace add` 再 `plugin install`。

## 为什么不用官方 typescript-lsp 插件

官方插件在 `claude-plugins-official` marketplace 里，本机装不上：
Anthropic Directory 返回 **HTTP 403**（网络受限），`marketplace update` 也刷不动。

官方插件的 `lspServers` 定义可以直接从本地缓存读出来
（`~/.claude/plugins/plugin-catalog-cache.json`），本地版就是照它的形状改的。

## 三个实测踩过的坑

### 1. tsserver 会挑错 tsconfig

这个仓库有**四份 tsconfig**：

| 文件 | 作用 |
| --- | --- |
| `tsconfig.json` | solution-style（`files: []` + references），**本身不包含任何文件** |
| `tsconfig.server.json` | 后端 + tests + scripts，`types: ["node"]` |
| `tsconfig.web.json` | 前端 + `src/shared`，`jsx: react-jsx`，`types: []` |
| `tsconfig.build.json` | 发布产物 emit（`rewriteRelativeImportExtensions`） |

根 tsconfig 是 solution-style，**不含文件**。tsserver 按「离文件最近的 tsconfig」选项目，
所以 `src/core/fields.ts` 归 `tsconfig.server.json`、`src/web/frontend/**` 归 `tsconfig.web.json`——
这正是我们想要的（前端不能 import core 的边界，靠的也是这两份配置）。

实测跨文件解析正常：`sections/service.ts` 里 hover 从 `core/fields.ts` import 的
`findSection` 能出 `import findSection`，`select.tsx` 里 hover 从 `types.ts` import 的
`ControlProps` 也能出类型。

> ⚠️ **改 tsconfig 结构时 LSP 可能失灵**：如果把根 tsconfig 改成普通配置，
> tsserver 会对所有文件改用同一份配置，前端的 `types: []`（不加载 node 类型）
> 会漏掉后端。改完 tsconfig 要用下面「验收」那节验一遍。

### 2. Windows 上不能直接 spawn `node_modules/.bin/xxx`

`.bin` 下是 `.CMD` shim，`spawn` 不带 shell 时会 `ENOENT`。
plugin.json 里的 `command: "npx"` 走的是全局 shim，没这个问题；
但自己写脚本调 server 时要用 `spawn(process.execPath, ['node_modules/typescript-language-server/lib/cli.mjs', '--stdio'])`。

### 3. server 会主动发 `workspace/configuration` 请求

`typescript-language-server` 在 initialize 之后会**反问客户端**要配置。
客户端不答，它就一直等，hover / definition 全部超时（表现为「LSP 没反应」）。

这是个容易误判的失败模式：initialize 能成功、capabilities 也在，
但后续请求全挂——看起来像 tsserver 索引慢，实际是握手没走完。

### 4. tsserver 首次索引没完成时，结果是「不完整」而不是「空」

实测：`findReferences` 在 tsserver 还没建好索引时返回 **2 个**引用（都在本文件），
预热后同一个查询返回 **7 个**（跨文件）。

**所以「引用数偏少」不等于 LSP 配错了**，可能是索引还没好。
判断配置对不对要看 definition 能不能跨文件跳转，不是看引用数。

## 验收

改完 plugin.json 或 tsconfig 后，用**新会话**验（旧会话不加载新注册的 server）：

```bash
# 1. plugin 已被识别
claude plugin list
claude plugin details ts-lsp@local        # 应显示 "LSP servers (1)"

# 2. manifest 合法
claude plugin validate .claude/plugins/marketplaces/local/plugins/ts-lsp

# 3. LSP 真能用（headless 新会话）
claude -p "Use the LSP tool to get hover at src/core/fields.ts line 36. Report the exact hover text."
```

第 3 步若返回签名 + JSDoc，就是通的。

## 已知限制

- **旧会话不热加载**：装了 plugin 之后，当前会话里的 LSP 工具仍然报
  `No LSP server available for file type: .ts`。开新会话才会生效。
- **`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}`** 在 `command` / `args` /
  `initializationOptions` 里会做变量替换。本 plugin 用 `${CLAUDE_PROJECT_DIR}`
  指 `node_modules/typescript/lib`，保证用仓库里锁定的 TypeScript 版本。
- **diagnostics 会把 tsserver 的报错推进 agent 上下文**（`diagnostics: true`）。
  本仓库用 `tsc -b` 做权威类型检查，LSP 的诊断只当提示，不当门禁。
