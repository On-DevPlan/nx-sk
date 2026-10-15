# 40 · 附件库

> 归属 `nx-sk` skill 主文档。要把「简历 / 头像 / 成绩单 / 证书扫描件」这类**二进制原件**收进库、
> 挂到条目上、或还原拿走时读这篇。
> 栏目与条目的通用命令见 `10-sections-entries`；这篇只讲「文件」这一块。

## 一、数据模型

```
~/nx-sk/files/<分类>/            二进制原件（真实文件，移动/复制进来的）
~/nx-sk/store.json 的 files[]    台账：id / name / rel / ext / bytes / sha256 / 标签 / 备注
~/nx-sk/store.json 的 entries[].values[<file字段>] = [f_xxxx, …]   ← 链接：字段值 = 附件 id 列表（可挂多个）
```

- 一个**附件** = 一次导入的原件 + 一条台账记录。物理文件永远以台账 `rel` 为准。
- 条目里的 `file` 字段（如 `resumeFile` / `avatar`），**值就是附件 id 的列表**（形如 `[f_xxxx, …]`；
  一个字段可挂多个）。id 全局唯一 → 各条目的附件空间天然隔离；同一个原件（sha256 相同）**去重**后是同一条，
  可被多条条目共享，不重复占空间。
- **上传 / 选择发生在栏目条目里**；「附件」中心只负责统一展示与库存管理，不做指派。

## 二、命令

| 操作 | 命令 | 接口 |
| --- | --- | --- |
| 列表 | `nx-sk file list [--section job] [--q 关键字]` | `GET /api/files` |
| 单条 | `nx-sk file get <id>` | `GET /api/files/:ref` |
| 导入 | `nx-sk file add --path <本机文件>` | `POST /api/files` |
| 改属性 | `nx-sk file update <id> [--name …] [--tags …] [--note …]` | `PATCH /api/files/:ref` |
| 取本体 | `nx-sk file content <id> [--download]` | `GET /api/files/:ref/content` |
| 打开 | `nx-sk file open <id>`（本机默认程序） | 无（纯 CLI） |
| 还原 | `nx-sk file restore <id> [--to DIR] [--copy]` | `POST /api/files/:ref/restore` |
| 删除 | `nx-sk file remove <id>` | `DELETE /api/files/:ref` |

- `file list --section <栏目>` 只看「被某栏目引用」的附件；`--section none` 只看**还没有任何条目引用**的。
- `file content` 是浏览器链接：内联预览，加 `--download` 强制下载；CLI 侧打印物理路径与链接。
- 所有写命令都支持 `--dry-run`；`file remove` 连物理原件一起删并自动留台账快照——
  只想「拿出原件、库里留着」应该用 `file restore --copy`。

## 三、导入：默认移动，`--copy` 才复制

```bash
nx-sk file add --path "D:\简历\张三-简历.pdf"          # 默认把原件**移动**进库（原件不再留在原地）
nx-sk file add --path "D:\简历\张三-简历.pdf" --copy   # 只复制一份进库，原文件留着
nx-sk file add --path C:\扫描\成绩单.pdf --tags 成绩单 --note "教务处盖章版"
```

- **默认移动**是本工具的取舍：提交附件 = 把原件搬进 `~/nx-sk/files/` 统一管理。
  想保留原地那份就显式 `--copy`。
- 同 sha256 的文件直接复用已有记录（返回 `duplicated`），不会重复占空间。
- `file add --dry-run` 只计算落点与校验，不移动、不写台账。

## 四、链接：`file` 字段值 = 附件 id 的**列表**（可挂多个）

条目**不复制文件**，只存附件 id。把 id 写进栏目里 `file` 类型的字段，链接就建立了；
**一个字段可以挂多个附件**（简历多个版本、头像多张、证书多份），值是 id 的数组：

```bash
# 先拿到附件的 id（file add 的输出 / file list --json 里的 files[].id）
nx-sk file add --path "D:\简历\张三-简历.pdf" --category resume

nx-sk entry update 张三 --set resumeFile=f_aaa,f_bbb   # 逗号分隔 = 挂两个（也可用 --data 传 JSON 数组）
nx-sk entry update 张三 --set resumeFile=f_aaa          # 只挂一个（存下来也是单元素数组）
nx-sk entry get 张三 --section job                # 每个附件各占一行：附件名 + 物理路径

# 反查：这个附件被哪些栏目 / 条目 / 字段引用
nx-sk file get f_bbb
#   被引用: 求职 / 张三 / 简历附件
```

- 求职条目里的「简历附件 / 头像图片 / 成绩单 / 证书扫描件」就是 `file` 字段。
- **别用文件名或路径去填** —— 值只认附件 id；填了别的东西条目侧会显示成「未解析」。
- 需要限制个数时给字段配 `maxItems`（与 `tags` 同一套；不配 = 不限）。
- 老数据里存的**单个 id 字符串**原样兼容：读、反查、搜索、面板编辑都按「单元素列表」处理，
  不需要迁移；下一次在面板里编辑该字段保存后，会统一成数组。

## 五、还原（可逆）

```bash
nx-sk file restore f_xxxx                         # 移回**原始位置**并撤销台账（默认）
nx-sk file restore f_xxxx --to "D:\资料" --copy   # 或导出副本到指定目录，库里保留原件与台账
nx-sk file restore f_xxxx --to "D:\资料"          # Web 上传件没有原始位置时，必须用 --to 指定目录
```

| 形态 | 效果 |
| --- | --- |
| `restore`（移动） | 物理原件移回原始位置（或 `--to` 目录），**台账记录撤销** |
| `restore --copy` | 只**导出副本**到目标目录，库中原件与台账**都保留** |

- Web 上传进来的附件没有「原始位置」，还原时必须给 `--to`。
- 还原/删除都会先留快照（`~/nx-sk/backup/`），可回滚——见 `30-export-backup`。

## 六、Web 面板

`nx-sk serve` → 顶部「附件」页：

- 上传（拖拽 / 选文件）、本机路径导入、搜索、图片缩略图、内联预览、下载、复制物理路径 / 链接；
- **组织方式由栏目驱动、不预定义分类**：筛选片按「哪些栏目在引用附件」动态生成（外加「未引用」），
  每张卡片显示被哪个栏目 / 条目 / 字段引用；
- 编辑弹窗可改名称 / 分类 / 标签 / 备注（改分类或文件名时物理原件随之移动）；
- 条目表单里的 `file` 字段是**列表**：文件可直接**拖进字段框**（可多选）、点「上传文件」多选、
  从库里逐个追加、逐行移除；保存即建立链接。

## 七、看不到 `file` 上传字段 / 条目里解析不到附件

1. **栏目里没有这类字段** —— 栏目字段台账是**持久化数据**：栏目实例化时深拷贝模板字段，
   此后独立演化，模板**后来**新增的字段不会自动回溯到已建栏目。用
   `nx-sk section sync <栏目>`（可先 `--dry-run`）把模板新增的分组与字段补进来（只增不改不删）；
   面板侧是「栏目 → 编辑 → 同步模板字段」。
2. **字段值不是有效的附件 id** —— `file get` 确认那个 id 存在；字段值必须是被导入过的附件 id，
   不是文件名、不是路径。
