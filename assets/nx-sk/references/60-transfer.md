# 栏目导出 / 导入（ZIP）

**什么时候读**：要把栏目连同附件搬到另一台机器、发给同事、或做局部备份/迁移时。
它只处理**选中的栏目与条目**（不碰没选中的东西），零配置即可在另一台机器导入。

项目里**只有一个导出导入模块**：没有独立的「备份」模块了。回退手段就是先导出再删。

## 面板操作（一个面板：选 → 设口令 → 倒出去 / 倒回来）

「导出导入」页就是这一个面板，左右两栏：

- **左栏 · 选内容**：栏目**横向排**成 chips（名称 + 已选/总数；当前栏目深色描边，已选加粗），
  指针移上去会自动把该栏目的条目**纵向展开**在下面（点击/键盘同样可以，不只靠悬浮）；
  顶部两个预设按钮：**「整库」= 所有栏目全选**、「清空」。
- **头部常驻主操作**：已选计数 + 口令（输两次）+「导出 ZIP」。条目再多也不用滚动去找按钮。
- **右栏 · 解密导入**：拖入或点击选择 ZIP → 先预览 → 再应用。

**没有「按栏目 / 整库」两个模式**：栏目的全选就是整库导出，「整库」按钮只是全选的快捷方式，
产物与逐栏勾选完全同一个包（整库时是 `bundle.json + sections/<id>.zip`，逐栏时是单个 zip）。

栏目页右上角「更多」里是**同一个栏目**的快捷入口：导出该栏目 ZIP（支持条目勾选）、
导入 ZIP、把 zip 拖到栏目页任意位置也能导入。

**精确导出**：条目列表左侧有复选框，表头可全选/清空。选中若干条后只带这些条目
**和它们引用的附件**（不会带无关文件）。不选 = 导出整个栏目。

导入会先弹**预览**：来源/目标栏目、条目新增与冲突、将补哪些字段、附件新增/复用。
选冲突策略后才写盘：

| 策略 | 行为 |
| --- | --- |
| `skip`（默认） | 同 id 或同名的条目**保留现有**，不导入 |
| `copy` | 另存为新条目，标题加「（导入）」；标题是 CLI 定位键，所以必须唯一 |
| `overwrite` | 用包里的值覆盖现有条目的字段（没带的字段保持本地值） |

冲突预览**逐条列出**：同 id / 同标题分别标明，`copy` 策略会直接显示将产生的新标题。

## CLI

```bash
# 导出（可设口令；不设 = 明文包）
nx-sk transfer export deploy --out ~/deploy.zip
nx-sk transfer export deploy --passphrase 口令 --out ~/deploy-share.zip
nx-sk transfer export deploy --no-files --out ~/meta.zip      # 只带元数据，不带附件原件

# 整库/多栏目（逗号分隔；全选 = 不传 --sections）
nx-sk transfer bundle-export --out ~/all.zip
nx-sk transfer bundle-export --sections deploy,secrets --passphrase 口令 --out ~/two.zip

# 导入
nx-sk transfer import deploy2 --file ~/deploy.zip --dry-run   # 先预览，不写盘
nx-sk transfer import deploy2 --file ~/deploy.zip --on-conflict skip
nx-sk transfer import-new --file ~/all.zip                    # 零配置：自动识别单栏目/整库包
```

`--entries` 精确指定条目（id 或标题，逗号分隔）：`nx-sk transfer export deploy --entries "k8s-deployment,docker-compose" --out ~/part.zip`

`--json` 可用于预览结果（`section.fieldsToAdd`、`entries.conflicts`、`files.new/reused`）。

## 包里有什么

单栏目：

```
manifest.json            栏目定义（groups/fields/kv/titleField）+ 条目 + 附件清单（sha256）
README.txt               给人看的说明
attachments/<id><ext>    附件原件（--no-files 时没有这些）
```

整库：

```
bundle.json              包清单：包含哪些栏目、整体口令说明
sections/<id>.zip        每个栏目一个上面的单栏目包（逐栏目复用同一套逻辑）
```

- 只打包**条目实际引用**的附件：`file` 字段的 id + `md` 正文里的 `![…](f_x)`。
- 导入时附件按 **sha256 去重**：本机已有同一份文件就复用，不会存两份。
- 条目里的旧 file id 会**自动重映射**到新 id（`file` 字段数组与 md 图片引用都改）。
- `import-new` 会看包结构自动判断是单栏目包还是整库包，不用手动挑命令。

## 口令加密（transfer 层）

- 实现是**「内部数据先加密，再套合法 ZIP」**：

  ```
  README.txt         说明这个包是什么（明文，不含数据）
  payload.enc        真正的包内容，AES-256-GCM 加密
  ```

  这样外层始终是合法 ZIP —— 系统「压缩(zipped)文件夹」能正常打开，只看到一个看不懂的
  `payload.enc`，不会弹「文件夹无效」；判定加密与否只需看条目名，不用嗅探 magic。
- 信封 = magic + salt(16) + iv(12) + tag(16) + 密文；密钥由口令经 scrypt 派生
  （与密钥库同一套参数），每次导出盐与 IV 都重新随机 —— 同一个包加密两次密文不同。
- 缺口令时导入会明确说「这个包已加密，请输入导出时设置的口令」，**不会**误报成「包坏了」。
- CLI：`--passphrase`，也认环境变量 `NX_SK_TRANSFER_PASSPHRASE`
  （命令行上的口令会出现在进程列表里，脚本/CI 里用 env 更稳）。
- 旧格式（0.11.x 把整个文件做成密文、magic `NXSKENC1`）**仍可导入**，只是不再产出。

## 凭据怎么处理

包里**恒为明文**，保护只靠口令 —— 没有「打码 / 明文」二选（0.11.0 之前的 `--no-secrets` 已移除）。
要发给别人的包就设口令；不设口令的包自己收好，别当分享件用。

读取侧仍兼容旧打码包：遇到 `******` 会跳过该字段并计数，不会把打码串当新密码存进去。
导入后敏感字段用**本机 vaultKey** 重新加密落盘，与手填的字段没有区别。

## 限制与坑

- 上限：2000 个 zip 条目、单文件 100MB、上传 body 64MB；超过会明确报错。
  大包请用 CLI（本地直接读文件，不走 HTTP）。
- 导入到**同一个栏目**一定会命中冲突（同 id），需要显式选 `copy` 或 `overwrite`；
  默认 `skip` 时预览会显示「冲突 N」而不是静默成功。
- 栏目不存在时用包里的定义新建（字段/分组一起建）；存在时只**补缺失字段**，不覆盖已有字段定义。
- zip 内路径做了安全校验（拒绝绝对路径与 `..`），不要手改包里路径后指望能导入。
