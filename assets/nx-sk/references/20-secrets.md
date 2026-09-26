# 20 · 密钥（KV）与密文

> 归属 `nx-sk` skill 主文档。存/取大模型 API Key、排查「解不开」时读这篇。

## 一、模型：一张 KV 表

密钥栏目标了 `kv: true` —— 它**就是一张表**，「一行一个键值对」：

- **面板**：一张两列表格（名称 / 值），改值即改、加行即加键。没有「条目列表」、
  没有字段表单、没有完整度百分比 —— 那些是「栏目 = 一族同构条目」才需要的，
  密钥不是那种东西。
- **CLI**：`key set/get/list/remove` 四条。

表长这样（值以密文落盘，读写默认给原文）：

| 键（条目名） | 值（唯一字段 `value`） |
| --- | --- |
| `OPENAI_KEY` | `sk-…`（密文落盘） |
| `DEEPSEEK_KEY` | `sk-…` |
| `OPENAI_BASE_URL` | `https://…` |

「这个 key 干什么用」写进键名里就够了 —— 存一个 key 不该先填一张表。
（早期版本有 8 个字段：服务商 / 接口地址 / 模型 / 用途 / 有效期 / 额度 / 备注。实测是负担，已删。）

## 二、四条命令（日常只用这四条）

```bash
nx-sk key set OPENAI_KEY sk-xxxxxxxx            # 写入：不存在则新建，存在则覆盖
nx-sk key get OPENAI_KEY                        # 取值：默认就是原文
nx-sk key get OPENAI_KEY --mask                  # 投屏/截图时才打码
nx-sk key list                                  # 列出所有键（默认原文）
nx-sk key remove OPENAI_KEY                     # 删除（删前自动留快照）
```

| 命令 | 接口 | 说明 |
| --- | --- | --- |
| `key list [--mask]` | `GET /api/keys[?mask=1]` | 全部键，按写入顺序 |
| `key get <名称> [--mask]` | `GET /api/keys/:name[?mask=1]` | 单个键的值 |
| `key set <名称> <值>` | `PUT /api/keys/:name` | **SET 语义**：存在即覆盖 |
| `key remove <名称>` | `DELETE /api/keys/:name` | 不存在报 `NOT_FOUND`；写前留快照 |

四条都接受 `--section <栏目>`（HTTP 侧是 `?section=` 或 body 里的 `section`），
缺省作用在**标了 `kv` 的那个栏目**上。

### 与 `entry` 的关系（重要）

`key *` **不是第二套实现**，是 `entry *` 的语法糖：它把「哪个栏目 + 哪个值字段」定好，
再调同一批 service 函数。所以加解密、快照、`--dry-run` 只有一份实现，不可能分叉。

等价关系：

```
nx-sk key set OPENAI_KEY sk-xxx
  ≡ nx-sk entry add    --section secret --title OPENAI_KEY --set value=sk-xxx   （新建时）
  ≡ nx-sk entry update OPENAI_KEY --set value=sk-xxx                            （覆盖时）
```

作用在哪个栏目？**看栏目自己的 `kv` 标记**（不再有 `settings.kvSection` 这种间接层）：

```bash
nx-sk section add mykeys --template secret   # 从密钥模板建，自带 kv: true
nx-sk section update someid --kv             # 把现有栏目标成 KV 表（取消写 --kv=false）
nx-sk section list                           # 列表里 KV 栏目带 [KV 表] 前缀
```

### KV 栏目**不许加字段**

它的形状就是「一行一个键值对」。往里塞字段会让「值在哪一列」变得不确定，
所以直接报错：

```
栏目「密钥」是一张 KV 表（一行一个键值对），不能加字段「089」。
你要加的应该是一个**键** —— 用 nx-sk key set 089 <值>，或在面板的 KV 表格里加一行。
```

> 这条是真实事故换来的：面板早先那行「KV 直填」在密钥栏目里把 `3123312=xxx` 当成了
> **新字段**登记，于是栏目字段从 1 个变成 3 个，用户在界面上看到的是一堆无意义的
> 「模板建议：089、3123312」。现在走 `key set` 才是唯一正确的加键方式。

### 两个刻意的语义差别

| | `entry add` | `key set` |
| --- | --- | --- |
| 遇到重名 | 报 `CONFLICT` | **静默覆盖**（KV 的 SET 就是覆盖） |
| 返回值 | — | `created: true/false`，调用方据此知道是哪一种 |

另外两点：

- **值以 `-` 开头时**用 `--value=<值>`（`key set K --value=--x`）——`--x` 会被当成 flag。
  显式 flag 覆盖位置参数，两种写法等价。
- **重复写同一个值不会重写密文**：返回 `{ status: 'skipped', unchanged: true }`。
  每次加密都用新 IV，无脑重写只会产生一堆无意义的新密文和新快照。

### 多行值：走 stdin 或 `@文件`（真实事故）

Windows 上命令经启动器转发时，**命令行参数里的换行会被截断**，而命令**照样报成功**——
一次性凭据（多行私钥、恢复码、证书）就这么静默丢掉后半截。同一条通道还会让含 `<` `>`
的参数整串失败（被当成重定向符，报「系统找不到指定的路径」）。

值的可靠通道有两条，任选：

```bash
printf '%s' "$KEY" | nx-sk key set OPENAI_KEY -        # stdin：值的位置参数写 -
nx-sk key set OPENAI_KEY --data @C:/Users/me/值.json    # 文件：--data @路径（含 value 键）
```

`--data` 也接受 `-`（从 stdin 读 JSON）与直接给 JSON 字面量；对象含 `value` 键时取它，
只含一个键时取那个键，多键且无 `value` 直接报错（不猜）。

**路径必须用 Windows 形式**（`C:/Users/...`）：Git Bash 的 `/tmp` 在 node 侧看不到
（实测 ENOENT），node 侧拿到的会是 `D:\tmp\...` 这种对不上的路径。

#### 哪些情况下命令行参数本身是安全的

实测（Windows 11 · Volta · Git Bash）分两种情况，**别当成一回事**：

| 你在哪敲 | 命令行多行参数 | 说明 |
| --- | --- | --- |
| **Git Bash / WSL 终端** | ✅ **安全** | 0.3.4 起转发器直连真实 `node.exe`，绕开了会截断参数的那一跳 |
| **cmd.exe / PowerShell** | ❌ **损坏** | 瓶颈是 cmd 解析 `.cmd` 文件内容（`%*` 展开），换 node 也治不了 |

所以：**cmd / PowerShell 下多行值一律走 `-` 或 `@文件`**，这是硬要求；
Git Bash 下裸参数已经能用，但脚本里要可移植的话，仍然推荐上面两条通道。

> 没有「检测到损坏就报错」这回事——**做不到**。损坏后的值里 CR 是被**删掉**而非保留
> （`$'a\rb'` 实际落盘 `"ab"`），所以「含 CR 即损坏」既抓不到真实损坏（零真阳性）、
> 又会拦住用 `@文件` 写入的**合法 CRLF 多行值**（高假阳性）。而 LF 截断后与一个合法的
> 单行值完全不可区分。可靠信号不存在，因此只能「提供可靠通道 + 修好通道本身」，
> 不能靠事后检测兜底。

## 三、密文机制

- 算法 **AES-256-GCM**（`core/crypto.js`）。每个值独立 IV，带认证标签。
- 落盘的密文对象（**明文绝不进 store.json**）：

```json
{ "v": 1, "alg": "aes-256-gcm", "kid": "9f3a1c07be22", "iv": "…", "tag": "…", "ct": "…" }
```

- `kid` 是**密钥指纹**（密钥 sha256 前 12 位）。换过密钥来源时给出明确报错，而不是解出乱码。

### 读出来是原文，落盘才是密文

**默认原文**：本机单人工具，数据是给自己看的。默认打码等于每次取值都先拦自己一道，
所以现在**不拦**——`key get` / `key list` / `entry get` / `section dump` 默认都给原文。

要打码形态（投屏、录屏、截图给别人看）时显式加 `--mask`：

```bash
nx-sk key get OPENAI_KEY --mask      # sk-x******xxxx
nx-sk key list --mask
nx-sk export run --no-secrets        # 导出文件里也打码
```

打码规则：长度 ≤ 10 全部打码；否则前 4 + `******` + 后 4。

**代价要清楚**：终端里有明文、`--json` 输出里有明文、投屏时会被看到。
密码管理器那种「默认遮住」的取舍对本机自用是净成本，但对**分享**是必要的 ——
所以外发前记得加 `--mask` / `--no-secrets`。

## 四、密钥从哪来（优先级固定）

| 优先级 | 来源 | 行为 |
| --- | --- | --- |
| 1 | 环境变量 `NX_SK_PASSPHRASE` | `scrypt(口令, ~/nx-sk/.vaultsalt)` 派生。**口令不落盘**，盐落盘 |
| 2 | `~/nx-sk/.vaultkey` | 32 字节随机密钥，首次写入密文时自动生成（权限尽力设 0600） |

```bash
# 口令模式（更安全：口令不进磁盘）
export NX_SK_PASSPHRASE='你的长口令'
nx-sk key get OPENAI_KEY

# 本机密钥文件模式（默认，零配置）
nx-sk key set OPENAI_KEY sk-xxxxxxxx
```

**同一份密文只能由同一个密钥解开**，所以换口令 / 删 `.vaultkey` 都会让旧密文报
`BLOCKED`「当前密钥与写入时的密钥不一致」——这是设计如此，不是 bug；改回去就能解开。
因此：**密钥文件要跟数据一起备份**，或者用口令模式并把口令记在别处。

查看当前来源：`nx-sk bootstrap --json` 的 `vault` 字段。

## 五、纪律（写给 agent）

- 默认原文是给**你自己看**的；一旦要把输出交给别人（日志、issue、截图、导出文件），
  先加 `--mask` / `--no-secrets`。
- 导出文件里 `withSecrets` 字段会明确标出这份文件含不含明文 —— **外发前先看这个字段**。
- 用户想「把密钥同步到云端」——做不到，也别假装能做到。nx-sk 只在本机落盘与本地导出。

## 六、写入防呆

| 情况 | 行为 |
| --- | --- |
| 值含 `******`（打码占位）且**不等于**当前值的掩码 | 报 `INVALID_INPUT` 拒绝 —— 那多半是把打码串当成了新值 |
| 值**恰好等于**当前值的掩码（面板原样回传） | 视为「不修改」，保留原密文 |
| 值为空 | 报 `INVALID_INPUT`（空密钥没有意义；要清空请用 `key remove`） |

## 七、排查「解不开」

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `BLOCKED 当前密钥与写入时的密钥不一致` | 换了口令，或删了 `.vaultkey` | 改回原来的来源（旧口令 / 恢复密钥文件） |
| `BLOCKED 解密失败：密文已损坏，或密钥不正确` | store.json 被手工改过 / GCM 认证失败 | 用 `~/nx-sk/backup/` 里的快照恢复 |
| `.vaultkey` 不见了 | 被系统清理或误删 | 有口令模式的盐文件 `.vaultsalt` 与口令还能救；否则密文不可逆 |

**密文不可逆是特性，不是缺陷** —— 代价是「忘记密钥 = 数据丢失」，
回报是「store.json 泄露不等于凭据泄露」。
