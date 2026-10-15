# 30 · 导出与备份

> 归属 `nx-sk` skill 主文档。要「整体导出 / 拿走数据 / 回滚」时读这篇。

## 一、整体导出

```bash
nx-sk export run                                   # 全部栏目 → ~/nx-sk/export/<时间戳>-nx-sk.{json,md}
nx-sk export run --format json                     # 只要 JSON（md | json | both）
nx-sk export run --section job                     # 只导「求职」栏目
nx-sk export run --out D:/备份/nx-sk               # 指定输出目录
nx-sk export run --dry-run                         # 试运行：只告诉你将写哪些文件、多大
nx-sk export run                                   # 默认就含密钥明文（本机自己用）
nx-sk export run --no-secrets                      # 打码后再导出（要分享给别人时用）
nx-sk export list                                  # 历次导出 + 输出目录里的文件
```

| 参数 | 说明 |
| --- | --- |
| `--format` | `json` / `md` / `both`，缺省取 `settings.exportFormat` |
| `--section` | 只导一个栏目 |
| `--out` | 输出目录，缺省取 `settings.exportDir`，再缺省 `~/nx-sk/export` |
| `--with-secrets` / `--no-secrets` | 是否含密文字段明文。两个都不给时取 `settings.includeSecretsInExport`（默认 **true**——本机自己用，不拦自己） |
| `--dry-run` | 不写盘 |

导出文件里 `withSecrets` 字段会明确标出这份文件是不是含明文——**分享前先看这个字段**。

JSON 结构（稳定契约，脚本可依赖）：

```json
{
  "app": "nx-sk", "version": "0.1.0", "generatedAt": "…", "storePath": "~/nx-sk/store.json",
  "withSecrets": false,
  "counts": { "sections": 2, "entries": 1 },
  "sections": [ { "id":"job","title":"求职","groups":[…],"fields":[…] } ],
  "entries":  [ { "id":"e_…","section":"job","title":"张三","completeness":{…},"values":{…} } ]
}
```

> 未填字段导出成 `null`（不是空串），方便消费方区分「没填」与「填了空」。

## 二、快照（自动，不用手动）

**每一次破坏性写入之前**都会把整库快照写到 `~/nx-sk/backup/<时间戳>-<原因>.json`：

| 触发点 | 快照名 |
| --- | --- |
| 改设置 | `…-setting-set.json` |
| 加/改/删栏目 | `…-section-add.json` / `…-section-update.json` / `…-section-remove-<id>.json` |
| 改/删条目 | `…-entry-update-<id>.json` / `…-entry-remove-<id>.json` |

最多保留 20 份（自动清理最旧的）。在 `nx-sk bootstrap --json` 的 `snapshots` 字段能看到最近 5 份；
面板的「设置」页有完整列表。

**回滚 = 把那份 JSON 拷回 `store.json`**：

```bash
cp ~/nx-sk/backup/20260924-144238-entry-remove-e_xxx.json ~/nx-sk/store.json
```

快照里含**密文**（不是明文），所以恢复后仍需要同一个密钥才能解——这正是我们要的：
快照本身不是泄露面。

## 三、store.json 的意外保护

如果 `store.json` 解析失败（手工编辑打错了逗号），服务**不会**把它当作空库继续跑并覆盖掉：

1. 先把原文件改名为 `store.json.corrupt-<时间戳>.json`；
2. 再以降级的空结构启动；
3. 面板「设置」页会显示这条提示，`bootstrap --json` 的 `corrupt` 字段也有。

## 四、导出 vs 快照，别搞混

| | 导出（export） | 快照（backup） |
| --- | --- | --- |
| 谁发起 | 用户显式命令 | 系统在每次破坏性写入前自动 |
| 目的 | 带走 / 备份 / 交给别人 | 误操作回滚 |
| 内容 | 结构化 + 可读的 Markdown；凭据默认含明文（`--no-secrets` 可打码） | 原样的整库 JSON（含密文） |
| 位置 | `~/nx-sk/export/`（可改） | `~/nx-sk/backup/`（固定） |
| 回滚用 | 不能直接回滚（形状不同） | 能，拷回 store.json 即可 |

## 五、口令加密备份 / 恢复（导入导出）

整份数据用**口令派生密钥 + AES-256-GCM** 对称加密为单个 `.nxskbak` 文件；口令不落盘。
附件**台账**始终随包；`--with-files` 再把原件本体也嵌进包里（v3 格式）。

```bash
nx-sk backup export --password '备份口令'                 # → ~/nx-sk/backup/nx-sk-backup-<时间>.nxskbak
nx-sk backup export --password '备份口令' --with-files    # 连附件原件一起打包（体积显著变大）
nx-sk backup export --password '备份口令' --out D:/备份    # 指定输出目录

nx-sk backup import --file <备份>.nxskbak --password '口令' --dry-run  # 只解密 + 出合并计划，不改动
nx-sk backup import --file <备份>.nxskbak --password '口令'            # 缺省「合并」导入
nx-sk backup import --file <备份>.nxskbak --password '口令' --replace  # 整份替换（旧行为）
```

- 导出时文件内写入**随机盐**，密钥由 `scrypt(口令, 盐)` 派生；恢复时用同一口令派生同一把密钥。
- **口令错误 / 文件被篡改**：GCM 认证失败、明确报 BLOCKED，且不改动当前数据。
- **导入（缺省 = 合并）只增不减**：补缺失的栏目/条目/附件台账、补空字段、把备份多出的分组与字段补进已有栏目；**两边都有值且不同 → 保留本地**、列入冲突清单由你处理；本地已有数据与结构**永不删改**。报告会列出新增/补空/冲突/结构差异的完整明细。
- **`--replace` 才是整份替换**（灾难恢复 / 跨机器迁移用）：当前数据被备份整体覆盖。
- 两种方式都会**先自动留安全快照**（`…-before-import.json` / `…-before-restore.json`），可回滚。
- 敏感字段在包内是明文（靠口令保护），导入时自动用**本机 vaultKey** 重新加密落盘——报告里的值一律打码，密钥明文不进报告。
- 带 `--with-files` 的包导入时自动还原附件原件（sha256 校验；磁盘已有且内容不同则以磁盘为准）；v2 旧包可导入，但不含原件，报告会如实列出缺哪些文件。
- 口令也可用环境变量 `NX_SK_BACKUP_PASSWORD` 提供；Web 面板「导出与备份」页提供同样能力（浏览器下载 / 选择文件导入；超大包建议走 CLI）。
