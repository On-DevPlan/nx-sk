# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/)，中文正文。

## [Unreleased]

**任务 #28：「新建条目」从栏目工具条挪到侧栏——每个栏目行右侧一个「＋」。**

### Changed

- 侧栏栏目行计数后面新增「＋」（悬停/键盘聚焦才显形，`title` 是「在「X」新建条目」）：
  不用先打开栏目，点它直接在那个栏目下建条目——读一次该栏目 dump 拿名字标签/名字字段 →
  弹窗问名字 → `POST /api/entries`（名字同时写进名字字段）→ 侧栏缓存乐观补一条 →
  跳到新条目；省掉一次打开栏目的往返。
- 栏目工具条的「新建条目」改为兜底：只在**侧栏收起**（`sidebarCollapsed`，侧栏的「＋」够不着）
  时出现，两种入口不会同时出现。`ViewProps` 因此新增可选 `sidebarCollapsed`。
- 顺手修掉一个被这次入口暴露的老问题：`SectionView.load` 的闭包里读的是挂载时的 `ui.entry`
  （deps 刻意不含它），当新建条目落在**已打开**的栏目里（sectionId 没变、组件不重挂）时，
  重拉 dump 会「兜底选中 entries[0]」，把刚建好的条目踢走。改成用 ref 取最新 `ui.entry`，
  并在创建后广播一次 `REFRESH_EVENT` 让当前栏目重拉 dump。

### 验证

- lint 0 error（6 条 600 行提醒）· typecheck 通过 · unit **472/472** · build 成功 · smoke **142/142**
- 真机走查（Chrome headless + 独立 walk28 沙箱 home，15 项断言全过）：悬停显形、title 文案、
  侧栏展开时工具条无重复「新建条目」、弹窗文案带栏目名、创建后跳转并选中新条目、
  名称字段同值、侧栏树立刻可见、刷新后仍在库里、侧栏收起后兜底按钮出现/展开后消失、无 console 报错
- 走查只动了自己新建的测试条目（结束时已删除），未触碰其它数据

**任务 #30：栏目工具条的「刷新」与顶栏「刷新数据」合并成一个入口。**

### Changed

- 刷新只在顶栏留一个「刷新数据」：点它先重拉 `bootstrap`（侧栏计数 / 设置），再广播
  `REFRESH_EVENT`（`store.tsx` 导出），栏目页收到后重拉自己的 `/dump`——原来工具条那个
  「刷新」删掉，两个按钮做的事现在合成了一步。
- 事件广播不绑定具体模块：工具页（设置 / 导入导出）没有订阅者，点刷新只做 bootstrap 重拉。

### 验证

- lint 0 error（6 条 600 行提醒）· typecheck 通过 · unit **472/472** · build 成功 · smoke **142/142**
- 真机走查（Chrome headless）：全页只剩 1 个「刷新」类按钮；点它同时发出 `/api/bootstrap`
  与 `/api/sections/accounts/dump` 两个请求，刷新后仍选中原条目且内容不变；设置页点刷新无报错。

**任务 #29：条目详情里重复的面包屑合并为一条。**

### Changed

- 条目详情卡片头不再重复「栏目 › 条目」这条面包屑（窗口顶栏已经有了「分组 › 栏目 › 条目」）；
  原先挂在这条面包屑上的「点击复制定位」改为顶栏常显的 `⧉` 按钮，复制文本与 toast 文案不变，
  `.crumb-sec/-sep/-ent/-copy` 四条只为它存在的样式一并删除。

### 验证

- lint 0 error（6 条 600 行提醒）· typecheck 通过 · unit **472/472** · build 成功 · smoke **142/142**
- 真机走查（Chrome headless，1440×950）：全页只剩一条 antd 面包屑，卡片头无 `›`、保留 id 与
  `⧉`；点 `⧉` 出现「已复制条目定位」toast，剪贴板内容为 `nx-sk 条目 · 栏目「平台账号」…`
- 已知未做：`D:\a_js` 下仍无法新建文件（git 提交与 patch 落盘受阻），见回报

**任务 #27：字段值历史版本 + 条目变化时间线 + 单字段恢复 + 保留策略设置。**

### Added

- schema v5：新增 `field_history`（`entry_field_id` + 单调 `rev` + 值快照 + `op/source/at`）。
  **无外键**——`writeStore` 是全量重写，CASCADE 会把历史一起清空；改为重建后清理
  `entry_field_id NOT IN (SELECT id FROM entry_fields)` 的孤儿历史。
- 写入侧 diff（`repo.ts`）：只对「值真的变了」的字段追加历史；同值重写（布局保存、
  自动保存空转）不产生版本；清空记 `op='clear'`；首次建库/导入（rev 0）不记噪声。
- CLI：`entry field-history <条目> --key <字段>`（rev 倒序 + 当前值）、
  `entry history <条目>`（全字段变化时间线，按时间倒序）、
  `entry field-restore <条目> --key <字段> --rev <版本号>`（恢复；`--dry-run` 预览）。
- HTTP：`GET /api/entries/:ref/fields/:key/history`、`GET /api/entries/:ref/history`、
  `POST /api/entries/:ref/fields/:key/restore`。
- 面板：块头「⋯」新增「变化历史…」弹窗（版本列表 + 恢复此版）；条目底部新增
  「变化历史」按钮（本条目全字段时间线，旧值 → 新值）。恢复会自动重读条目与 bootstrap。
- 设置：`historyMode`（count/time）、`historyCount`（默认 50，1–1000）、`historyDays`
  （默认 90，1–3650）；保存后立即全库裁剪存量历史。设置页「默认行为」新增「字段历史保留」行。
- `docs/field-history.md` 更新为实现版：schema、diff、恢复语义、保留策略、里程碑状态与
  初稿差异（合并窗口未采用、无外键、无标题历史）。

### 验证

- lint 0 error（7 条 600 行提醒，其中 `core/db/repo.ts` 660 行含本次历史 diff 接线）
- typecheck 通过 · unit **472/472**（+6 历史专项；迁移测试对齐当前版本与 12 张表）·
  build 成功 · smoke **142/142**
- CLI 真机走查（隔离 home）：建条目 → 改值 → `entry field-history` 看到 v1/v2、
  `entry history` 时间线按时间倒序、`field-restore --rev 1` 写回旧值并追加 restore 版本；
  `--dry-run` 不改值；v4 库首次打开自动升 v5、原有数据与历史起点正常。

**任务 #26：设置里新增「编辑后自动保存」偏好；字段历史版本机制设计稿。**

### Added

- 设置项 `autoSaveFields`（默认**关**，`setting set --key autoSaveFields --value 是|否` 与设置页「默认行为」同源）：开启后，条目编辑停手 800ms 自动保存，不再依赖用户记得点「保存」。
  - 复用同一条保存链（`PATCH /api/entries/:id` → 重读 dump → 刷新 bootstrap），不新增接口；改动计数、`beforeunload` 提醒、手动保存/放弃改动按钮全部原样保留。
  - 关闭时（默认）完全走旧路径，行为与之前逐字一致。
  - `save` 每渲染都是新函数，自动保存用 ref 取最新一版并做 800ms 防抖；组件卸载/切条目时清计时器，不会跨条目串写。
- `docs/field-history.md`：字段级历史版本设计稿——schema v5 `field_history` 表（`rev` 单调版本号 + 值快照）、`writeStore` 写入侧 diff（全量重写不能无脑追加）、5 分钟合并窗口抵抗自动保存噪声、CLI/HTTP/面板三处入口、恢复语义（恢复也进历史、可再撤销）、保留策略与里程碑。

### 验证

- lint 0 error（7 条 600 行提醒，其中 `entries/view.tsx` 618 行含本任务新增的自动保存逻辑）/ typecheck / unit **466/466**（+3：默认关、布尔/CLI 字符串归一、PATCH 语义与 renderSettings 是/否）/ build / smoke **142/142**。
- 真机走查（隔离 home + 本机 Chrome）：设置页「默认行为」勾选 → 顶部「保存」→ 落盘 `autoSaveFields=true`；回条目页改字段停手约 1s，改动自动落盘（保存按钮回落为禁用，刷新后新值仍在）；关闭偏好后用同样操作等 2 秒，仍是「1 处改动未保存」且服务端值未变（旧手动流程零变化）。

**任务 #25（#24 的再验收反馈）：修「条目内自建字段不触发保存」的真根因 + 悬浮直接渲染被引用字段整块。**

### Fixed

- **条目内独自添加的字段（扩展字段）的改动不进脏值判定**——`dirty` 只遍历栏目字典 `data.fields`，扩展字段不在字典里，于是改了值顶栏不出现「保存」、值也存不下去。debug 引用因此看着「悬浮不更新」：引用从未被保存过。判据改为**本条目的结构行**（`entryFields`，含模板行与扩展行），字典仅在老数据缺结构行时兜底。这个 bug 同时影响所有扩展字段（不止 debug），属数据丢失级。

### Changed

- **悬浮预览改为底部寄存框**（#25 验收反馈原文：「悬浮 直接出现对应的块显示 提供基础的底部框 然后悬浮 就加载对应的块的整体 filed 进行显示」）：
  - 悬浮引用格子 → 视口底部弹出寄存框（宽 720px、最高 46vh、可滚），**field 引用直接渲染那一块的真实控件**（标签 + 类型 + 控件本体，`fieldset disabled` + pointer-events 只读）；条目/附件/栏目仍走文本摘要。md / table / file / source / debug 退回文本——它们要么拉附件/起编辑器，要么递归渲染 debug 自身。
  - 每次进入格子都重查一次（同一格子重复悬浮也算），格子内联值与寄存框内容一起刷新——「鼠标一停就是此刻的值」。
  - 关闭规则：Esc / 页面滚动（框内滚动除外）/ 指针离开格子与框 260ms；框内可停留阅读，不再跟着鼠标飘。

### 验证

- lint 0 error / typecheck / unit **464/464** / build / smoke **142/142** 零削弱。
- 真机走查 15/15（Playwright + 本机 Chrome，隔离 home 7881，**全程走用户路径**）：条目内「＋ 添加字段」建 debug 扩展字段 → 加引用后顶栏出现「1 处改动未保存」+ 保存按钮（根因复现/修复）→ 保存并重载后引用仍在（CLI `entry get` 核对落盘值）→ 悬浮出底部寄存框且渲染真实 input、值正确 → CLI 外部改值后重新悬浮，格子与寄存框同步新值 → Esc 关闭 → console 零错误。

**任务 #24（#23 的再验收反馈）：引用格子内联具体内容 + 块头 `⋯` 更多菜单（查看 / 编辑 / 删除）。**

### Added

- `entry field-update <ref> --key <k> [--label <新显示名>] [--hint <描述>] [--dry-run]`（CLI + `PATCH /api/entries/:ref/fields/:key` 同源）：改**条目内一个字段的属性**（显示名 / 描述）。只写这一条条目的结构行（`entry_fields.label/hint` 与 `spec` 同步，`spec` 是 FieldDef 的保真源——不同步会出现「块头新名、引用浮层旧名」），栏目字典、其他条目、字段值都不动；内置「原始资料」不给改，已脱离的字段要求先恢复；同值报 `skipped/unchanged` 不写盘。
- 面板块头新增 `⋯` 菜单（替换原来的单个 `×`）：**查看字段**（定义 + 当前值 + 可复制 locator）、**编辑字段属性…**（显示名 / 描述，写时复制）、**从本条目移除 / 删除扩展字段**（沿用 #20 语义与确认文案）。浮层用 portal + fixed 渲染——块的根节点是 `overflow: hidden`（高度由网格锁着），`<details>` 式下拉会被裁掉。

### Changed

- **debug 引用格子改为内容优先**（#24 验收反馈原文：「内连值的具体内容呀 你内联 filed 的 tag 标签干嘛」）：主文本直接是被引用位置的实时内容——字段=**值**（空值显示「（空）」）、条目=条目名、附件=文件名、栏目=标题；不再内联「字段」类种类标签与字段名，量词（条目完整度 / 附件字节 / 条目数）降为次文本。悬浮浮层仍是详情形态（种类 + 名称 + 值 + locator）。
- 字段提示文案同步：「格子内联实时值」→「格子内联显示内容」。

### 验证

- lint（0 error）/ typecheck / unit **464/464**（+5 field-update 专项：只落条目行、字典与其他条目零污染、spec 与镜像列不分叉、校验与 dry-run）/ build / smoke **142/142** 零削弱。
- 真机走查 22/22（Playwright + 本机 Chrome，隔离 home 7879）：格子内联具体值且无「字段」标签、悬浮详情不回归、块头 `⋯` 三动作齐全、浮层未被块体裁掉、查看弹窗含定义/定位符/当前值、编辑后块头改名且值保留（资源定位读到新名、其他条目与字典不变）、移除→管理条→恢复闭环、console 零错误。

**任务 #18：统一内部资源定位 + schema v4（字段类型不再被 DB CHECK 约束）+ debug 引用字段 + 侧栏全局检索与悬浮预览。**

### Added

- `shared/locator.ts`：内部资源定位符唯一实现——`nx-sk://section/<id>`、`entry/<id>`、`field/<条目或栏目>/<key>`、`file/<id>`；parse 对脏输入返回 null 不抛；旧复合串 `<栏目>:<key>` 兼容读（磁盘格式零改动）。只读出口 `resolve`（CLI/HTTP）：给 locator 返回存在性与摘要，字段值密文默认打码。
- `nx-sk resource search`（CLI + `GET /api/resources/search`）：跨栏目/条目/字段/附件全局检索，返回 locator+标题+定位信息。
- **`debug` 字段类型**（引用型）：值 `{v:1, refs:[locator…]}` 自描述文档，非法项丢弃计入 warnings 不炸；面板渲染成**小格子**——悬浮预览引用内容（密文打码）、点击复制 locator、× 删除、「＋ 引用资源」走检索面板选择；失效引用标灰「已失效」。
- **schema v4**：重建 fields/entry_fields 去掉 type 的 CHECK 枚举——**加新字段类型不再需要改库**（合法性由 validateFieldDef/behaviorOf 运行时保证，FIELD_TYPES 仍是唯一清单）。
- 侧栏搜索升级：结果按「当前条目字段 / 全局字段 / 条目」三类分组，点字段结果直达条目并滚动定位+短暂高亮对应块。
- 条目定位文本补一行 `定位: <locator>`（原两行 CLI 文案逐字不变，单测钉住）。

### 验证

- lint / typecheck / unit **431/431** / build / smoke **137/137**（零削弱）。
- v4 迁移保真：真 v3 库升级前后四表逐行 deepEqual、id 全等、幂等、坏脚本回滚；期间发现并修复 1 个真缺陷（v4 apply 重复建索引使 0→4 全链必炸）。
- 真机走查 25/25（Playwright + 本机 Chrome、隔离 home 7873）：三类检索、字段定位高亮、添加引用、格子标题、悬浮预览、失效标灰、locator 复制剪贴板校验、右键菜单/定位文本不回归、console 零错误。

### Changed

- **#19 验收反馈**：条目页「字段=值 快填」旁路撤除——条目内加字段只留「＋ 添加字段」正门（弹窗表单）；CLI/agent 的 `--set 未知键` 自动登记通路不受影响，退役的只是这块 UI 与其样式。
- **任务 #20：条目级字段移除与恢复**（补齐 #15 添加的逆向操作，v3 写时复制模型）：
  - `entry remove-field <ref> --key <k> [--restore] [--dry-run]`（CLI + `DELETE /api/entries/:ref/fields/:key` 同源）：**扩展字段=硬删**（entry_fields 行删除，field_data 随 CASCADE 走，值没了就是没了）；**模板字段=脱离（detach）**——行保留、meta 记 `{"detached":1}`，该条目不再渲染/序列化/计完整度这个字段，**栏目字典与其他条目零影响**；`--restore` 去掉标记，值原样回来（脱离从不动 field_data）。内置「原始资料」（source）不给删，与字典侧同纪律。
  - 读边界统一过滤脱离行：`readStore` 的 values、`serializeEntry`（新输出 `detachedFields: [{key,label}]`，entryFields 每项带 `template` 出身标记）、`completeness`、字段台账、资源 locator、section dump 的表格现值、transfer 导出。
  - **writeStore 防复活**（本轮最容易踩的坑）：存量条目按捕获行原样恢复时，脱离行跳过「values 缺行补模板/占位行」逻辑、值由捕获行原样带回 field_data——删了不会在下次保存时复活，值不会在全量重写中丢失；detach/restore/硬删都推进 rev，陈旧 Store 对象提交撞 BLOCKED 而不是静默覆数据。
  - 面板：块头 hover 出无边框 `×`（BlockBoard 新可选 prop `onRemoveField`，kvTable 等调用点零影响）——模板字段弹「从本条目移除…（不影响栏目模板与其他条目）」、扩展字段弹 danger「值会一并删除，不可恢复」；add-field-bar 下方新增「已脱离」弱字 chips 管理条，每个带「恢复」按钮。
  - 契约测试同步：dump 条目键白名单加入 `detachedFields`。
  - 验证：unit **438/438**（+7 remove-field 专项，含「detach 后连续两次 updateEntry 不复活」）/ smoke 137/137 零削弱；真机走查 17/17（Playwright + 本机 Chrome，隔离 home 7875）：hover 出 ×、移除→块消失+chip、恢复→块与值回来、扩展硬删→块与值都没、刷新持久化、dialog 取消不写、console 零错误。期间发现并修复 1 个真缺陷（writeStore 脱离判据误传 meta 对象，值在全量重写中丢失→restore 变 null）。
- **任务 #21（#18 验收反馈）：debug 引用只绑数据位置 + 格子内联数据板**（用户裁决原文：「debug字段引用具体的字段数据 不要引用结构」「结果至少是条目/条目-字段」「条目-field位置 而不是fielddata 从而可以实现内联数据板的功能 实时响应绑定的位置的结果」）：
  - **结构引用不收**：`nx-sk://section/…` 在 coerce 层丢弃进 warnings（语法无歧义）；模板字段引用 `nx-sk://field/<栏目id>/<key>` 要查库才认得出，新增写入封装 `seal/debug.ts` 丢弃（warnings 带原因）。坏链仍保留（#18「坏链留证」不变）。`isStoredEmpty` 同步：refs 空但有 warnings 的文档不再被当空清掉——「引用为什么没了」的台账必须留档。
  - **内联数据板**：格子直接显示绑定位置的实时值（字段值截断内联、条目完整度、附件字节），悬浮预览仍是详情形态；值改→保存→reload→批量重解，格子跟着变，无需刷新页面。
  - 新出口 `resource resolve-batch`（`POST /api/resources/resolve-batch`，action 显式标 `readOnly` 豁免 dry-run 检查）：一次请求取回全部引用摘要，坏链不抛（每项自带 ok/error），值一律打码口径（reveal 不开这个口子）。
  - picker 改走 `resource search --scope debug`：只出条目/条目-字段（含模板行与扩展行，副题带条目名）/附件，栏目与模板字段命中不出现——别让用户选了再被写入点丢。默认口径（侧栏三类检索）零改动。
  - demo 播种的 debug 引用同步改为条目级（指向示例条目自身与其名称字段）。
  - 文案随语义更新：「非法引用已忽略」→「引用已忽略」；picker 占位与提示语改口径。
  - 验证：unit **441/441**（coerce 拒结构、sealDebug 拒模板字段+坏链保留、warnings 留档、scope=debug 口径、resolve-batch 形状）/ smoke 137/137 零削弱；真机走查 22/22（Playwright + 本机 Chrome，隔离 home 7876）：格子内联实时值、悬浮预览、picker 无结构命中、改名称保存后格子实时刷新、CLI 混写结构引用被逐层丢弃且 warnings 可见、坏链标灰、resolve-batch 直测、复制 locator 不回归、console/HTTP 零错误。
- **任务 #22：CLI 面板代理——serve 存活时改走 HTTP 执行，根治 Windows 双进程开库冲突**（残留 mmap / disk I/O error）：
  - **portfile（`core/panel-port.ts`）**：serve 启动把**真实端口 + pid** 写进 `<home>/serve.json`（顺延端口也不丢），退出时只清自己写的；CLI 发现面板先读档案、校验 pid 存活，缺失/已死再探默认端口 7866。
  - **认领判据比端口复用更严**：app 名相同 **且 bootstrap 的 storePathRaw 与本 CLI 当前库路径相同** 才代理——`--store` / 环境变量换库、多面板并存（live + 临时 home）都不会被代理到别的库上；报不出库路径的老面板一律不认，宁可直跑。
  - **`POST /api/cli` 通用分发口**：body `{actionId, ctx, bodyB64?, fileName?}`，服务端按 id 查 ACTIONS 走**同一个 applySpec + run**，错误形状与 handleApi 逐条一致（INVALID_INPUT 同样补用法串）；Origin 纪律同写操作。统一走这个口是为了绕开 GET query 对 array/json/kv flag 的序列化问题。
  - **runCli 代理分支**：action 有 http 声明、未 `--direct`、未 `--store`、非 raw 下载口、且发现同库面板 → 代理执行；stdout 渲染（本地 action.render）、`--json` 形态、错误文案、exit code 与直跑**完全一致**（ctx 在本地 applySpec 后转发，服务端二次 coerce 幂等）。面板活着但代理失败/超时 → 报错（带端口与 action id），**不静默回退直连**；`--direct` 是显式逃生口。help/version/serve（无 http）与 raw 下载（直跑落盘）保持本地；binaryBody 上传以 base64 随 JSON 代理，本地文件读不到时原样转发让面板侧 service 报与直跑一致的错误。
  - 观测开关 `NX_SK_CLI_PROXY_DEBUG=1`：stderr 打一行「经面板代理 :端口 actionId」，供冒烟/走查验证路径归属，正常输出零影响。
  - 一致性测试新增反向断言：每条 http action（raw 除外）的路由必须解析回同一 id、binaryBody 必须带 file flag；`Action.readOnly` 显式豁免 dry-run 检查（#21 的 resolveBatch 同用）。
  - 验证：unit **459/459**（+proxy.test 10 项：portfile 语义/发现双判据/分发口错误形状/代理与直跑数据等价/kv·array·binaryBody 三形态等价）/ smoke **142/142**（+5 项：serve 在跑→代理执行带端口、--direct 跳过、代理与直跑输出等价、portfile 内容、serve 死后回落直跑）；lint/typecheck/build 全绿。
- **任务 #23（#21 的再验收反馈）：debug 数据板的实时性补到「悬浮/点击即查」**（用户裁决原文：「至少悬浮的时候 保证每次都是实时查值 如果有值就更新呀 动态绑定的 我不求完全那个元素变更 我这个debug字段就响应 至少我点击整个块 或者在块当中 或者鼠标悬浮 就实时查询值呀」）：
  - **悬浮 = 单查**：每次 mouseenter 都对该 locator 走一次 `resource resolve`，浮层与格子内联值随结果更新（外部 CLI/别的页面改的值，鼠标一停就是新的）；解不到如实标灰、坏链悬浮不弹陈旧浮层。
  - **点击所在块（含块头）= 整板批量重查**：控件向最近 `.blk` 挂 click 监听（卸载摘除），复用 resolve-batch 通路；与 #22 的 CLI 代理叠加后，外部改值→点块→面板显示新值，全程不重载页面。
  - 保存后 reload 的整体刷新（#21）保留——三层刷新：boot 变 / 块点击 / 格子悬浮。
  - 验证：五连全绿零削弱（unit 459/459、smoke 142/142）；真机走查 10/10（Playwright + 本机 Chrome，隔离 home 7878——7877 被 nx-kv 面板占用、serve 顺延并写 portfile，#22 机制在走查里现场自证）：CLI 改值不重载→悬浮出实时值→格子同步；再改值→点块/点块头→整板重查显示新值；点击前陈旧值可见（证明刷新不是 reload 带来的）；坏链悬浮如实标灰；console 零错误。

## 0.40.0 (2026-11-11)

**任务 #16：全局视觉改造——彻底无边框、Notion 配色令牌化。**

### Changed

- **配色令牌化**（`styles.css` `:root`，Notion 口径）：`--paper #ffffff`（主底）、`--soft #f9f8f7`（次级底：侧栏、静态容器）、`--hover #eeeceb`（悬浮/选中加深的唯一色块）、`--mid #7d7a75`（弱字色：图标、计数、旁注）、`--line/--line-strong` 对齐 rgba(55,53,47,.09/.16) 弱线量级、`--soft-2` 值并入 #eeeceb（保留变量免改引用）、`--ink` 不动。
- **弱线条表达块**：容器静止态不铺底色——`.blk` / `.panel` hover 才现出 1px 弱线轮廓（`box-shadow: inset 0 0 0 1px var(--line)`）；输入框静止态改「白底 + 1px 弱线」，hover 用线加深（不再是灰底）；原先拿 `--soft-2` 当分隔线的实线（`.tree-row`、`.source-item`、`.tp-col`、`.entry-head`、sticky-head 压边等）统一换成 `var(--line)`。
- **hover/选中底色统一**：所有带 `:hover` / `.active` / `.selected` / `.on` / `.sel` / 拖放落点语义的选择器（约 40 处，含侧栏 antd Tree 覆盖层、`.tab.active`、`.dgrp-head`/`.drow`、`.row.selected`、`.btn.ghost`、`.sn-item`、`.tree-sec/.tree-ent`、`.tf-*` 系列、`.peek-menu-row`、`.source-item.sel` 等）的 `background` 一律换成 `var(--hover)`；纯静态容器（`.sb`、`.tag`、`.group-title`、`pre.block`、`.md-preview`、`.entry-head`、`.tf-calc`、`.source-strip` 等）继续用 `--soft`。
- **antd 主题对齐**（`App.tsx` `ANTD_THEME`）：`colorTextSecondary #7d7a75`、`colorBorder rgba(55,53,47,.16)`、`colorBorderSecondary rgba(55,53,47,.09)` 与新令牌同源。
- 不变量保持：语义红 #b3261e 不动、状态用标签不用色块不动、主按钮深色填充不动；只改视觉（颜色/线/底色），DOM 结构、类名、文案、交互逻辑零改动。

## 0.39.0 (2026-11-11)

**任务 #15：条目内字段扩展正门——「＋ 添加字段」表单（指定类型/分组），替代旧的单行「直接加字段」。**

### Added

- `entry add-field`（CLI + `POST /api/entries/:ref/fields` 同源）：给**单条条目**添加扩展字段——`--key/--label/--type/--group/--value`，只落条目自身结构行（template_field_id=NULL），**栏目字典零污染**；重复键报冲突并指路 `--set` 写值；未知类型/未知分组/ KV 栏目都在写盘前拒绝；`--dry-run` 预览。
- 面板条目页新增「＋ 添加字段」弹窗：key / 标签 / 类型（中文名+内部 id）/ 分组（本栏目分组下拉）/ 初值；提交后块即时出现、刷新保持。
- `serializeEntry` 输出 `entryFields`（条目自身字段定义，行优先、字典兜底）——v3 块渲染契约补齐：面板 BlockBoard 从此跟随**条目自己的结构**渲染，条目内新加的扩展字段不再只有 CLI 可见。

### Changed

- 旧「＋ 直接加字段」保留为熟手旁路，改名「字段=值 快填」，提示语更新为「按值推断类型，只落本条目」。
- 契约测试同步：dump 条目键白名单加入 `entryFields`。

### 验证

- lint / typecheck / unit **410/410**（+6 add-field 专项）/ build / smoke 137/137 全绿。
- 真机走查 14/14（Playwright + 本机 Chrome，全新隔离 home）：弹窗表单→提交→「预算」块即时出现带 3000→刷新保持→重复键报错且弹窗可继续改→快填旁路正常；发现「块渲染仍字典驱动」一处真缺陷（toast 成功但 UI 无块）→ serializeEntry 补 entryFields 修复 → 复验全绿。

## 0.38.0 (2026-11-11)

**schema v3：动态结构——条目字段写时复制（copy-on-write）。栏目字段字典降级成模板，每个条目带自己的结构行与值行。**

### Changed

- **写时复制**：新增 `entry_fields`（条目自身字段行：key/label/type/spec/fill/position，`template_field_id` 非 NULL=出身模板、NULL=扩展字段）与 `field_data`（值逐键一行，JSON 文本，密文 blob 原样搬运）。`entries."values"` 列退役；`entry_attach` 的挂载点从 (entry_id, field_key) 收敛到 `entry_field_id`。行 id 全部确定性派生（`ef_<sha1[0:16]>` / `d_<sha1[0:16]>`，见 `db/identity.ts`），迁移搬运与运行时写入共用同一公式。
- **模板只初始化**：新建条目按字典实例化全部模板行；字典后续增删改（add-field / set-field / remove-field）**不回刷存量条目**——存量条目按自身行读写（序列化、完整度、附件反查、密文视图、导出包都看行）。
- **quickAdd 不污染字典**：`--set 新键=值` 推断出的字段只落条目自身的扩展行（bool / secretish→secret / file 等推断规则不变，落盘即密文）；`entry fields` 台账 = 字典 + 各条目扩展行（按 key 去重）。
- **`section sync` 重定义为两阶段（都只增不改）**：阶段 1 代码模板→栏目字典（原语义）；阶段 2 栏目字典→存量条目结构行（补缺行，position 追加）。非模板栏目不再报错——「add-field 之后跑 sync 把新行补进条目」正是 v3 的主要用法。`fields` 表新增 `default_value` 列：sync 补的新行与新建条目没给值的键都按它落数据行（只给新行，不回刷）。
- 序列化契约不变：空值仍输出 `null`、`values` 键集与条目行一致；栏目 ZIP 包格式不变（manifest.entries[].values 仍是逐键 map）。
- 迁移：`migrations/v3.sql`（DDL + entries/entry_attach 重建）+ `migrations/v3-apply.ts`（拆行/边重映射/unmapped 计数写 `meta.migrate_v3`）；`CURRENT_SCHEMA_VERSION=3`；v1/v2.sql 一字未动。升级前自动快照 `migrate/<ts>-pre-v2-to-v3.db` 机制不变。
- 测试同步：db-upgrade 的升级用例改为**裸 SQL 造真 v2 库**再升级（改版本号模拟旧库在 v3 下不再成立）；smoke 的存储布局探针（直读 values 列）改为 JOIN field_data——这是 schema 变化本身强制的适配；attachments 的「备用附件登记进字典」用例改为钉条目扩展行 + 字典不被污染。

## 0.37.0 (2026-11-11)

**schema v2：挂载位置收敛到「具体栏目的具体条目的具体字段」——source 只是普通字段，附件不挂结构。**

### Changed

- 用户裁决落地：栏目 / 条目 / 字段定义是结构定位信息，不是挂载对象——**删除 section_attach / field_attach 两张结构级边表**；`role='source'` 从 entry_attach 退役（原始资料袋里的值引用走 inline，显式挂载走 attach）。EDGE_ROLES 收敛为 `inline | attach`。
- 迁移走刚建好的版本机制：新增 `migrations/v2.sql`（重建 entry_attach：SQLite 改不了 CHECK → 建新表、整表搬运、历史 source 边落为 attach、改名补索引、DROP 两张结构表）+ `DIRECT_EDGES` 追加 1→2 + `CURRENT_SCHEMA_VERSION=2`；v1.sql 一字未动。
- `repo.ts` 全量重写只捕获/放回 entry 级显式边；测试同步：迁移器断言 9 张表、`role='source'` 必须被 CHECK 拒绝、attach 角色可插入。

### 验证

- lint / typecheck / unit 398/398 / build / smoke 137/137 全绿。
- **live 库真实升级实录**：v1→v2 由 CLI 首启触发，升级前自动快照 `migrate/20261111-162758-pre-v1-to-v2.db`（备份机制首次实战）；升级后 schema_version=2、9 表、51 条 inline 边 / 57 条目 / 55 附件记录逐项对账不变；serve(7866) API 与 CLI 双通道读取正常。
- 顺带清障：昨日遗留的旧 JSON 代码 serve（7867，store.json 已改名、再写会分叉）经授权停止。

## 0.36.0 (2026-11-11)

**底层存储从 store.json 重构为 SQLite（node:sqlite），采用「存储版本号 + 组合式迁移脚本」机制，运行时不做旧结构兼容。**

### Changed

- **存储换心**：主库 `~/nx-sk/nxsk.db`（`NX_SK_STORE_DB` 覆盖；WAL + busy_timeout）。`core/store.ts` facade 的导出 API 与 Store 对象形状**一字未动**，所有后端模块照常只通过它碰磁盘。`loadStore` = SELECT 组装（过 normalize 收口类型，不再做旧版本兼容）；`saveStore` / `mutateStore` = 单事务全量重写（代码结构留好按表增量写的缝）。
- **迁移框架**（详细参考 nx-kv 的存储版本号设计）：`meta.schema_version` 为版本判据，`db/migrations/v1.sql` 起按版本号**单向组合**执行，每支一个事务、失败回滚并中止启动；后续升级只提供新脚本（在 `migrations/index.js` 登记直接边 + 改 `CURRENT_SCHEMA_VERSION`），**绝不改已发布的 vN.sql**。缺边/降级都明确报错，不静默跳过。
- **乐观并发（rev）**：`meta.rev` 全局写计数。载入记 rev，提交时 rev 不匹配抛 BLOCKED（提示重试）——修掉 serve + CLI 双进程的 lost-update（旧版整份覆盖，后写的静默抹掉先写的）。
- **首启导入**：db 不存在且 store.json 存在 → 读 json（**有 version 没 version 都接受**，过 normalize 升到当前形状）→ 建库跑迁移 → 全量写入 → store.json 改名留证 `store.json.imported-<ts>`（不删除，沿用 corrupt 留证纪律）；损坏文件挪 `.corrupt-` 后播种；导入失败整体回滚、JSON 一字节不动并写失败日志。孤儿条目（指向不存在的栏目）在预检就报明细，不给外键撞半套现场。
- **表结构**：sections / groups（含 `declared`：0=syncSectionGroups 自愈出的未声明分组）/ fields（type CHECK 与 FIELD_TYPES 同一份清单，单测钉住）/ entries / settings（k/v，JSON value）/ ui_state（预留，面板选择现状仍在浏览器 localStorage，不硬塞）/ meta。JSON 列（fields.spec、attachments.meta）是**保真源**，标量列是查询与约束的镜像——往返深比较不漂键存在性。
- **attachments 对齐 nx-kv v2**：kind ∈ (file/url/section/entry/field)；file 行 id = FileRecord.id **原样**（values 里嵌的引用一字不改）；url/section/entry/field 用确定性派生 id（`att_*_<sha1[0:16]>`），身份规则收敛到 `db/identity.ts` 唯一实现；dedupe_key 唯一部分索引（软删后可重新登记）；边表 entry_attach / section_attach / field_attach，**role 是边的语义不是资源属性**（inline=从 values 用现有 fileReferences 重算、attach/source=显式边跨重写保留）；删除钩子对指向已删条目/栏目/字段的内部指针行软删（UPDATE deleted_at，行不物理删），`findDriftedPointers` 可检漂移。
- `engines.node` 升到 `>=22.13.0`（node:sqlite 免 `--experimental-sqlite` 的下限，与 nx-kv 同口径；`db/version.ts` 运行时先检查再 import，报错指得出真因）。`--store` 全局 flag 改指 DB 路径；`setting set` 返回值与面板存储页展示的 `path` 从 store.json 换成 nxsk.db。
- build 链路新增 `scripts/copy-migrations.mjs`（tsc 不拷 .sql，迁移脚本随 dist 发布）。
- **升级之前先备份**：凡「往既有库里写结构」的路径都先做库快照——版本升级（情况 C）复制 `migrate/<ts>-pre-vX-to-vY.db`，崩溃恢复补导入（情况 D）复制 `migrate/<ts>-pre-import-json.db`；复制前 `wal_checkpoint(TRUNCATE)` 保证快照含最近写入。首启导入的 JSON 原件由 `.imported-<ts>` 改名留证兜底（同一纪律）。

### Added

- 新单测 27 项（`tests/unit/db-*.test.mjs`）：迁移 runner（空库→v1、幂等、坏脚本回滚、缺边/降级、async 事务体堵死）、导入器（带/不带 version、无 json、corrupt、失败回滚 + 留证改名）、rev 冲突（并发提交第二个报 BLOCKED 且不动库）、往返保真（json→db→loadStore 与 normalize(json) 深比较；inline 边 = fileReferences 重算结果）、attachments 身份/删除钩子/漂移/dedupe 索引。
- **json 迁 db 防丢测试**（`db-import-fidelity.test.mjs`）：真实形状 fixture（分组/字段/版式/KV 栏目/密文 blob/file+md 双载体引用/settings）逐项断言——每个栏目/条目/分组/字段 id 在库一个不少、layout 与密文逐字节保真、附件 55→55 式对账、inline 边精确到 (entry, field_key, attachment)。**升级导致丢数据会被这组测试直接钉死**。
- **升级备份测试**（`db-upgrade.test.mjs`）：v0→v1 升级与崩溃恢复补导入两条路径都必须先留 `migrate/pre-*.db` 快照，且快照本身是可打开、含升级前数据的完整库。
- `core/store-shape.ts`：Store 形状与 normalize 从 store.ts 拆出（形状层零依赖 facade，避免 store.ts ⇄ db/* 运行时循环 import）。

### 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:unit`（398/398）/ `pnpm test:smoke`（137/137）全绿（Node 24.18.0，Windows）。
- 冒烟里「CLI 与 HTTP 写进的是同一份数据」原样保留——serve 与 CLI 两个进程现在写的是同一个 nxsk.db，rev 校验在跨进程路径上被真实覆盖。
- **真实数据迁移实录**（2026-11-11）：live `~/nx-sk/store.json`（13 栏目 / 57 条目 / 55 附件记录 / 42 个 AES-GCM 密文 / 1 KV 栏目）导入 `nxsk.db` 后逐项对账全等；55 条 FileRecord → attachments(kind='file')，51 条 inline 引用边与 CLI `file list`「被条目引用 51/55」精确吻合；抽样密文 blob 逐字节一致、kid 保留、`--mask` 解密链路完好。迁移前全量备份 138 文件 / 40,039,375 字节校验一致。

## 0.35.0 (2026-11-11)

**栏目属性管理从弹窗升级为整页编辑器：块式分组面板 + 字段拖拽，复用条目正文那套拖拽/块基础设施。**

### Added

- `modules/sections/dictEditor.tsx`：栏目属性整页编辑器（点栏目行「编辑」进入，替代旧弹窗）。基本属性改成 Notion 行式（名称+说明在左、控件在右）；分组 = 一块面板、字段 = 面板里的一个块。
- **拖拽逻辑**（与 blockBoard 同款 HTML5 DnD + 插入线）：拖分组标题行调整分组顺序；字段行只有 ⠿ 把手可拖，拖到某行上半/下半 = 插到它前/后，**拖进别的分组 = 挪过去**（落点分组由所在面板表达，字段行的「分组」下拉框退役）。排序走 `groups` / `fields` 的整份替换 PATCH——后端早已支持，没有新增 API。
- 面板空白区可直接投放（追加到该组末尾）；空分组面板给出「把字段拖进来」提示；未声明分组的字段仍单独成块兜底（拖回正经分组即可归位）。

### Changed

- 栏目视图里 `saveEdit / addField / moveField / GroupRow / FieldRow / ColumnRow` 等旧弹窗代码整体迁入编辑器；保存模型不变：一次改动一次 PATCH + 立刻回读，↑↓ 按钮退役。
- 一致性测试「视图里调用的每个 /api/... 都有对应路由」改为**递归扫描整个前端目录**：API 调用拆进同级组件（如 dictEditor.tsx）也要被扫到，堵住「挪个文件名就绕过断言」的洞。

### 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:unit`（371/371）/ `pnpm test:smoke`（137/137）全绿。
- 真机走查（Playwright + 本机 Chrome，隔离 store，21 项断言全过、无控制台报错）：整页编辑器在场、旧弹窗退役、4 块分组面板 15 个字段块、字段跨组拖拽（拖出 7→6 / 拖入 3→4）且刷新后保持、面板拖拽换序、标签失焦即 PATCH、新增/删除空分组、新增字段与确认弹窗删除、「返回栏目」回树。

## 0.34.0 (2026-11-11)

**侧栏补上两块 Notion 基础设施：右缘拖拽线改宽 + 树节点右键菜单；侧栏已有条目时，正文不再重复显示条目列表。**

### Added

- 侧栏右缘拖拽线：按住拖动实时改宽（200–420px 夹取），松手落 localStorage（`nx-sk-sidebar-w`，与收起态一样属纯视觉偏好、不进 store）；双击恢复默认 264px；刷新/重开保持。拖动期间沿用 `body.col-resizing` 屏蔽文字选中。
- 树节点右键菜单（antd `Dropdown` trigger=contextMenu）：栏目——打开 / 新标签页 / 复制栏目链接 / 展开·折叠条目；条目——打开 / 新标签页 / 复制条目定位（CLI 文本，与条目视图 ⧉ 按钮同源）；工具页——打开 / 新标签页 / 复制页面链接；分组——展开·折叠。搜索态不提供展开切换（此时展开由搜索结果接管）。
- 打开栏目时侧栏自动拉取并展开它的条目（Notion 的「子页面就在树里」），并把栏目记入 loadedKeys 跟随 reload 刷新。
- `entryRef.ts`：条目定位文本与剪贴板复制（API 优先、被拒退回 textarea+execCommand）从条目视图抽出为共享模块，侧栏菜单与 ⧉ 按钮两处消费，文本与两条 toast 文案逐字不变。

### Changed

- 侧栏树里已有当前栏目的条目时，正文隐藏「条目列表」列与它的拖拽线，编辑器独占正文宽度；收起侧栏（或条目尚未加载）时列表照旧出现——它是收起态下唯一的条目导航，也保住「勾选导出」的入口。

### 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:unit`（371/371）/ `pnpm test:smoke`（137/137）全绿。
- 真机走查（Playwright + 本机 Chrome，隔离 store，23 项断言全过、无控制台报错）：拖拽加宽 264→381 并持久化、刷新保持、双击复位；栏目/条目/工具/分组四类右键菜单项齐、折叠↔展开往返、复制条目定位出 toast；正文列表隐藏与收起态回归；右键「打开」到达设置页。

## 0.33.0 (2026-11-11)

**面板布局 Notion 化：删掉顶部头部与横排 tab，改为「左侧可收起导航树 + 面包屑 + 内容」，设置页改成左侧区块导航 + 右侧行式表单。**

### Added

- 左侧导航树（antd `Tree`）：分组 › 栏目 › 条目三层——分组与栏目来自原导航配置，条目在栏目展开时懒加载（`GET /api/entries?section=`），大栏目由树虚拟滚动兜底；侧栏顶部搜索框按标题过滤栏目与已加载条目，命中分支自动展开；底部常驻存储路径（可点击复制）。
- 侧栏整体可收起：开关在面包屑左侧（Notion 的面板开关位），状态落 localStorage，收起后内容区独占整行。
- 面包屑栏（antd `Breadcrumb`）：「分组 › 栏目 › 条目」三级定位，点栏目名跳回栏目；「刷新数据」移到这行右侧。
- 设置页重构为 Notion Preferences 结构：左侧区块导航（栏目管理 / 默认行为 / 存储与运行 / 密钥 / 面板与 CLI / 数据迁移 / 上次读取异常），右侧无边框行式表单（名称 + 说明在左、控件在右、1px 细线分隔）；保存 / 放弃 / 重新读取与脏值提示保留在内容区顶部。
- 新增开源依赖：`antd` ^5（Tree / Breadcrumb / Input）、`@ant-design/icons` ^5（单色线性图标，替代被删的 CSS 三角与纯文字 tab）。

### Changed

- 删除 `header.top` 与 `nav.tabs`：品牌 + 版本迁到侧栏顶部，存储路径迁到侧栏底部与设置页，分组悬浮菜单（`tab-group` / `tab-menu`）整块退役——分组现在是树里的文件夹节点。
- 条目视图跟随外部选择：侧栏点同栏目的另一条时，主区域直接切换选中（不重拉数据）。
- 附件页内部分类 tab 仍用原 `.tab` 样式，不受影响。

### 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:smoke` / `pnpm test:unit` 全绿（见提交）。
- 真机走查（Playwright + 本机 Chrome，隔离 store）：侧栏树三层展开与懒加载、搜索过滤、收起/展开、面包屑三级显示与跳转、设置页七个区块切换与保存、附件/导出/栏目管理各页可达、无控制台报错。

## 0.32.0 (2026-11-10)

**三态面板换成 flexlayout-react 外壳：侧边预览有真正的可拖拽分栏线，分栏宽度按面板类型记住。**

### Added

- `flexPeek`：三态（side / center / fullpage）统一交给 flexlayout-react 布局。side 形态铺满视口但外壳 `pointer-events:none`，只有右侧面板与 splitter 接收指针事件，左边条目照常可点可滚；拖拽分栏线会实时改变面板宽度，并按 `persistKey`（source / shortcut）写进 localStorage，下次沿用。
- 窄屏（<900px）下列宽默认 86vw，不再缩成一条缝；center 形态改为响应式固定框（`min(1100px, 92vw) × min(820px, 86vh)`）。
- `types/flexlayout-react.d.ts`：flexlayout-react 0.8.x 的类型入口内部是无扩展名相对导入，nodenext 下解析不到，补一份只覆盖本项目用法的本地声明（沿用 react-grid-layout 的做法）。

### Changed

- 快捷键字段的详细面板仍默认整页；可在「打开方式」菜单里切到侧边预览（现在带拽线）或居中预览。

### 验证

- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:smoke`（137 项）/ `pnpm test:unit`（371 项）全绿。
- 真机走查（Playwright + 本机 Chrome，隔离 store）：来源面板默认 side 且有 1 条 splitter；拖拽 160px 后面板 544→704，刷新重开仍是 704；居中框实测 1100×808 居中；窄屏 760px 下侧栏 647px；`elementFromPoint` 验证左侧命中页面内容（不是透明遮挡层）；Esc 关闭正常。

## 0.31.3 (2026-11-10)

**快捷键面板：说明允许留空、分组与条目的 `createdAt` / `updatedAt` 与参考实现一致，修掉「加不进去 / 存不下来」。**

### Fixed

- 「+ 新增快捷键」在说明留空时被静默丢弃：`addShortcut` 里多了 `if (!desc) return`。参考实现只 trim 不校验，列表把空说明显示成「未填写」，现已对齐。
- 存储层 `normalizeShortcutGroups` 对空说明直接抛「缺少 description」，导致新增空说明后保存整条条目失败；现在空说明按 `''` 落盘。
- 分组不再丢时间戳：新建分组写 `createdAt` / `updatedAt`，增删改同组快捷键时刷新 `updatedAt`；导入的条目补 `createdAt`，追加到的分组刷新 `updatedAt`。存储结构因此与参考 `useShortcuts` 落盘一致。

## 0.31.2 (2026-11-10)

**README：快速开始补上「没有 nx-sk 命令时用 `node bin/nx-sk.mjs serve`」。**

### Changed

- 开头代码块从只有 `nx-sk serve` 改为同时给出仓库内直跑命令，并把「全局 bin 目录可能不在 PATH 上」的指向补在下面。
  之前这段说明只放在「开发」一节末尾，首次安装的人看不到，容易卡在 command not found。

## 0.31.1 (2026-11-10)

**开发脚本 `scripts/link-local.mjs`：`--auto` 跳过时补上可照做的下一步，并报告残留安装清单。npm 包内容与 0.31.0 相同（`scripts/` 不在发布清单里）。**

### Fixed

- `pnpm build` 的 `--auto` 在 PATH 上没有现成 `nx-sk` 时只打印「跳过」，用户无从得知下一步（误以为 build 坏了）。
  现在补充三条可执行指引：`pnpm run link:local`、`npm i -g nx-sk`、`node bin/nx-sk.mjs serve`（不改 PATH 的临时用法）。
- 上次 `unlink` 半途失败留下的 `~/nx-sk/dev/install.json`（记录的文件已不在）此前静默存在；`--auto` 现在会检测并提示用 `pnpm run unlink:local` 清理。

### 说明

- `--auto` 的语义不变：只覆盖 PATH 上现成的落点，**不新建目录、不改 PATH**——CI 与全新机器上跑 build 必须无副作用。
  要拿到 `nx-sk` 命令仍走 `pnpm run link:local` 或全局安装，`--auto` 只负责「已有落点时让它指向本仓库」。

## 0.31.0 (2026-11-10)

**`shortcut` 字段详情面板按参考实现 `shortcut-library` 一比一复刻（分组目录 / 表格 / ANSI 104 键 / 热力全屏 / 组合键录入同构），补齐 TOML 导入；并修复 store 首次读取不落盘导致的保存 404。**

### Added

- **详情面板**：侧栏分组增删改与条数、组合键/条件/说明表格与冲突标记、行悬浮联动键盘高亮与 tooltip、
  键位悬浮/长按/双击弹层、可拖拽侧栏宽度与键盘预览高度、全屏热力键盘（缩放/平移/图例）。
  `side/center/fullpage` 三态沿用 `peek` 外壳，默认 fullpage。
- **组合键录入弹层**：修饰键累积、Backspace 撤销、Esc 取消、Enter 确认，支持可选激活条件。
- **TOML 导入**：顶栏「导入」提供粘贴/文件两页，解析预览、格式说明与错误汇总；同名分组追加、新分组创建。
- **回归测试**：store 文件不存在时首次读取即落盘、重复读取 id 稳定。

### Changed

- `shortcut` 字段折叠条只报组数/条数（`N 组 · M 条`），详细内容进面板。
- 键盘预览默认高度 200px、键单位 44px，与参考实现一致；空间不足时按参考设计滚动。
- 删除旧本地键盘图 `shortcutKeys.ts` 与 `styles.css` 中对应的面板样式。

### Fixed

- store 文件不存在时只在内存播种，每次请求重新生成随机 id，前端保存 PATCH 旧 id 返回 404。

### 说明

- 参考实现中由宿主注入的登录与保存模式设置未移植：nx-sk 没有账号体系与服务端保存模式，面板其余部分
  与参考逐行对齐。三态窄宽下的取舍与验证边界已写入 `docs/behavior-parity.md`。

## 0.30.0 (2026-11-10)

**`peek` 头部换成 Notion「打开方式」菜单（像素对照、键盘可达），补 `#/<栏目>?entry=<id>` 深链与默认视图；补齐 `#5` 遗留的列表计数与全屏空白。**

### Added

- **「打开方式」菜单**：侧边预览 / 居中预览 / 整页 / 新标签页 / 编辑默认视图（二级菜单）。
  行高 32px、菜单宽 216px、图标 16px、勾选在右缘、分隔线、悬停/选中态均按 Notion 截图量取；
  支持 ↑↓/Home/End、→ 进二级、← 退二级、Esc 只关菜单、点外部关闭，关闭后焦点回触发按钮。
- **默认视图持久化**：「编辑默认视图」写入 `localStorage['nx-sk-peek-default:<source|shortcut>']`，
  重载后按该形态打开；隐私模式写盘失败不影响当前切换。
- **条目深链**：`#/<栏目>?entry=<id>` 直接选中该条；选中条目时地址栏同步 `?entry=`（仅当地址已在
  该栏目，兜底栏目仍不补 hash）。菜单的「新标签页」用这个地址打开。
- **条目列表 shortcut 计数**：列表行显示 `N 组 · M 条`（title 带字段名），补上 0.29.0 只做在折叠条/面板里的遗漏。

### Changed

- 三态从并排按钮改为单个「打开方式」触发按钮 + 菜单；side/center/fullpage 的面板尺寸、遮罩、
  焦点陷阱与 reduced-motion 行为不变。
- fullpage/center 的键盘图区接管剩余高度并垂直居中，不再在底部单侧留大片空白。
- side 表格最小宽度 420 → 400px，留 20px 容差，字体/缩放变化不再立刻出横向滚动条。

### Fixed

- `shortcut` 面板的「新标签页」拿不到 `sectionId/entryId` 而缺失。
- 悬停展开二级菜单后再点父项会把它关掉（hover 开 + click 切换冲突）。
- 静态菜单多了 Notion 截图里没有的二级箭头（改为悬停/聚焦时显示）。

### 说明

- side 下隐藏键盘导航列是有意取舍：46vw 减去分组目录后只剩 ~421px，保留 150px 导航列会让长键名逐字换行。
  原因与验证边界（仅 Chromium）已写入 `docs/behavior-parity.md` §0.30.0。

## 0.29.0 (2026-11-10)

**新增 `shortcut` 字段与 `peek` 三态外壳；`source` 迁到同一外壳。三种形态、焦点与 reduced-motion 均经真实浏览器走查（57 项断言全过，控制台/网络 0 错误）。**

### Added

- **快捷键字段（`shortcut`）**：值按「组 → 条目 → 按键」三层存；折叠条只报组数/条数，
  点「详细」打开键位面板（默认全屏，可切侧边/居中）——左侧分组目录、右侧说明表、底部键盘图，
  录入时直接按组合键、悬停条目点亮对应键。`combo` 存 `KeyboardEvent.code`，写入接受
  `"Ctrl+R"` / `["Ctrl","R"]` / `[{code,label}]` 三种写法。
- **`peek` 三态外壳**：同一份内容可在 side / center / fullpage 之间切换。center/fullpage 补遮罩、
  `aria-modal`、焦点陷阱、Esc 关闭与 reduced-motion；side 保持原右侧栏的宽度、断点与动画不变。

### Changed

- 原始资料（`source`）迁移到 `peek` 外壳：默认仍是原来的右侧栏，视觉与交互不变，新增三态切换按钮。

### 说明

- 走查修掉三处问题：三态选择器与 JSX 类名不一致导致面板尺寸/定位全部失效；点遮罩关闭后焦点掉到
  `body`（现先 `preventDefault` 再关）；窄栏下快捷键表格逐字换行、全屏下表格与键盘图之间留大片空洞。

## 0.28.0 (2026-11-10)

**全量 TypeScript 化：后端与前端源码统一为 `.ts/.tsx`；字段与模块改为注册表驱动。对外行为不变。**

### Changed

- **源码全量 TypeScript**：`src/**` 不再有 `.js/.jsx`；`pnpm build` 先用 `tsc -p tsconfig.build.json`
  产出 `dist/**/*.js`（`.ts` 导入后缀在 emit 时改写），再把面板构建到 `dist/web/public`。
- **字段收敛为穷举注册表**：服务端 `FIELD_BEHAVIOR` / `FIELD_SEAL`、前端 `FIELD_CONTROLS`
  都是 `Record<FieldType, …>`；`FIELD_TYPES` 加一项而漏实现/漏控件，会直接编译失败。
- **模块「目录即声明」**：`src/modules/<id>/index.ts` 自动装载，新增模块不再需要改注册表与 eslint 清单。
- **前端只消费 `shared`**：类型与零依赖纯函数从 `src/shared/**` 引入，eslint 边界规则覆盖 `.ts/.tsx`，
  继续拦住 `import '../../core/**'` 与 `import '../../modules/**'`。

### Fixed

- **导出 ZIP 时表格的敏感列按列定义解密**：此前 `plainValues` 只处理 `entrylist`，含敏感列的表格会带密文出包，
  换机器后永久不可解（独立提交 `fc4b9e2`）。

### 说明

- 命令、HTTP 响应形状、面板文案与交互、`store.json` 格式均未变化；`engines.node` 仍是 `>=18.17`。
- 贡献者：单测直接执行 `.ts` 需要 Node `>=22.18`；改了后端源码要重新 `pnpm build`。

## 0.27.0 (2026-11-08)

**表格字段重做：列头 ⋮ 属性菜单、行列都有抓手、去掉了那一整块「列设置」表单。**

原来的表格能用，但长得像后台配置页：表格下面铺着一整块「列设置」，一列一行、七八个输入框
（key / 名称 / 类型 / 汇总 / 单位 / 默认值 / 密文 / ←→×），而行与列的操作散在两端。
这一版按 Notion 数据库的手感重排：**表头就是属性入口，操作都收在 hover 里，静止时这页只有数据**。

### Changed

- **列头 ⋮ 打开属性菜单**：列名 / 类型（含「计算列（JS）」）/ key / 单位 / 默认值 / 表尾统计 / 密文 /
  下拉选项 / 公式，以及左移右移、左右插入、复制属性、删除属性。弹层按锚点定位，空间不够自动翻到上方。
- **表头末尾 `＋`**：加列的入口长在列该长的位置；原来底栏那个「＋ 添加列」只在空表时出现。
- **行抓手挪到左侧沟槽**：静止显示行号，hover 变成 `⋮`（在上/下方插入、复制、删除）+ `⠿`（拖动排序）。
  原来行操作挤在行尾 78px 的操作列里,现在表格右侧干净了。
- **表尾「新建一行」**：加行不用回工具栏；回车在最后一格仍然能续行。
- **质感**：格子不再是「描边输入框」——无边框、无底色，只有 1px 网格线；hover 整行浮起，
  focus 才在格子里显一圈极淡边界。表头小字灰色、计算列浅底、统计行加粗、数字等宽右对齐。
- 删掉了整块「列设置」面板（`.tf-cols` / `.tf-colrow`），列定义现在只在列头弹层里改。

### Fixed

- **勾选列被撑成一整格黑块**：复选框套了给文本框用的 `.tf-input`（width/height 100%），
  现在单独用 `.tf-check`（15px）。
- **弹层跑到屏幕左上角**：行/列的 `⋮` 原本用 `display:none` 藏在 hover 里，键盘或脚本点开时
  `getBoundingClientRect()` 全是 0。改成「常驻布局 + opacity 切换」，行号绝对定位叠在同一格上。

## 0.26.0 (2026-11-08)

**原始资料（`source`）改成真正的侧边栏；块头 / 面板标题整行都能拖。**

它本来就有 master-detail 的骨架（左清单 / 右正文），但外面套的是「全屏遮罩 + 模态 dialog」：
打开时整页被压暗、还被块的 `overflow: hidden` 裁掉一角——整理素材时看不见原文，
而「整理」恰恰要求两边对着看。

### Changed

- `SourceDrawer` 用 `createPortal` 挂到 `document.body`，定位改为**窗口右侧通栏**
  （`position: fixed`，宽 `min(720px, 46vw)`，窄屏 94vw），带一条柔和投影与轻微的滑入动画。
- **去掉遮罩与 `aria-modal`**：改成 `role="complementary"`，左边条目仍然可读、可滚；
  关闭走「关闭」按钮 / `Esc`（焦点仍然归还折叠条）。
- 层级排好：侧边栏 45 < 弹窗 50，toast 提到 70（不会被侧边栏盖住）。
- **块头、面板标题行整条都是抓手**（不再只靠那个 10px 的 `⠿`）：hover 给浅底、`⠿` 平时淡显
  hover 变实、光标 `cursor: grab`——三件事一起说「这行能拖」。块体（输入区）仍然不能拖，
  否则选词会变成搬块；面板行内按钮也不会触发拖动。

### Fixed

- **拖块不再「卡手」：改成插入式排序**（用户反馈「只能显示在可以显示的位置」）。
  网格里全宽块只有 `x=0` 一个落点、半宽块只有两个，用引擎的自由拖拽时块只能在「合法格」
  之间跳，还会被纵向压实实时吸回去——拖到哪儿都不对。现在：
  - 拖动只表达**顺序**：拖到某块的上/下半，出现一条 2px 插入线（与表格搬行同一套语义），
    松手按新顺序重新铺格（`repackBlocks`，**保留每块原来的宽度**）。
  - 宽度仍是独立自由度：拖块的左右边缘改宽，所以「单列变多列」照旧成立。
  - 拖动过程中不再有实时重排（引擎的 drag 已关掉），落点所见即所得。
- **「拖拽有点难触发」的真因**：上一版把 `Block` 组件直接当成网格的子元素，而
  `react-grid-layout` 靠 `cloneElement` + `ref` 给子元素注入定位与拖拽手柄——函数组件接不住
  ref，按下时抛 `<DraggableCore> not mounted on DragStart`，拖动因此在 mousedown 就断了。
  现在子元素回到原生 `div`（`.blk-cell`），块放在里面。

## 0.25.0 (2026-11-08)

**正文改成「按内容长」的文档：md 有多长就多高，界面去掉边框，读的内容回到第一眼。**

上一版把正文块化了，但块高是固定的：md 正文被塞进一个 220px 的框里滚动——那还是「面板」的思路，
不是「读文档」的思路。这一版把高度的决定权还给内容，并顺手把视觉收干净。

### Changed

- **块高由内容决定**：行高压到 8px 一档，用 `ResizeObserver` 量块里的内容（md 正文、附件列表、
  清单/表格、自动增高的 textarea），显示高度 = max(存储的最小高, 内容高度)。内容删掉就缩回最小高。
  - 存的 `h` 因此变成**最小高**：版式 JSON 描述「这个栏目怎么排」，不是「这一条内容有多高」——
    后者每条记录都不一样，不该落盘（视图期算出来的高度会在回写时剥掉）。
  - **只保留左右缩放手柄**：高度既然跟内容走，再叠一个手动高度只会互相打架（拖宽 → 内容重排 → 高度自己跟）。
- **md 正文不再限高滚动**：`.md-preview` 去掉 `max-height: 340px / 560px`，阅读态连灰底也去掉，
  正文直接落在页面上；工具行（字数 / 图片数 / 编辑）退到 hover 才出现。
- **无边框**：新增 `--line`（rgba 8.5%）代替原来的实色分隔线；块与面板去掉边框与底色，
  靠留白与字号分层；把手、字段 key、面板操作平时不出现，hover / 聚焦才浮出。
- **现代控件**：输入框改成「无边框 + 浅底，focus 才显边界」；按钮/标签去掉浮雕投影，改为平色块 + hover 加深；
  顶部 tab 扁平化（选中只加深底色）；浮层统一一层柔和投影。
- **阅读优先的排版**：条目名抬到标题级（16px / 600，仍是就地可改的输入）；
  「＋ 直接加字段」收成折叠项，不再常驻一行；块内正文字号 13px（工具条仍是 12px）。

### Notes

- 版式 JSON 的 `h` 语义变了（最小高 / 8px 一档），但**结构与读写口径不变**：
  `section get --json` / `section update --layout` 照旧；老版式读进来会被夹到最小高，
  视觉上相当于「内容多长就多长」，不需要迁移脚本。
- 全局样式改动波及所有页面（条目 / 栏目 / 附件 / 导出 / 设置），逐页截图确认过没有退化。

## 0.24.0 (2026-11-08)

**条目正文块逻辑化：一个分组 = 一块面板，一个字段 = 面板里的一个块——能拖、能并排、窄屏自动折列。**

过去正文是「分组小标题 + 自动填充的字段矩阵」：顺序由字段字典决定，想把「岗位」挪到「公司名称」
右边、想让两块并排、想让长文独占一整行，都只能去改字段字典。现在**版式是独立的一份 JSON**
（`section.layout`），拖动即改、自动落盘，与「字段值」是两条保存链——拖一下版式不会把没填完的值一起提交。

### Added

- **块面板**：每组一块面板，面板里每个字段一个块（块头 = 标签 + 密文/填写策略标签 + 字段 key）。
  底层用 `react-grid-layout`（MIT）做网格引擎：拖块头 `⠿` 搬块、拖右下角改宽高、单列变多列、
  窄屏按断点自动折成一列。碰撞 / 回弹 / 折行都交给引擎，**不自己实现面板引擎**——
  这一层最容易出错，也最没有复用价值。
- **版式单独存**（`section.layout`）：
  `{v, mode, panels[], groups{分组:{collapsed, layouts{断点:[{i,x,y,w,h}]}}}}`。面板顺序、折叠态、
  每个块的位置/宽度/高度都在里面，`i` 就是字段 key；坐标是列单位（lg 12 / md 10 / sm 6 / xs 4 / xxs 2）。
- **结构变了版式自愈**（幂等，读写两条路都过一遍）：删字段 → 对应块消失且不留空位；加字段 →
  接到该组最底部（不插队打散已排好的版式）；删分组整块移除、新分组接末尾。
  没存过版式 = 按默认编排铺一遍（窄字段半列、宽字段整行、窄屏单列）。
- **CLI 对等**：`section get --json` 带出**已按当前字段对齐**的 `layout`；
  `section update --layout @layout.json` 整体写版式、`--clear-layout` 回到默认编排。
  端到端冒烟把「面板走的那条 HTTP PATCH」与 CLI 两头都钉住了。
- **落位吸附**：半宽的块从「缝上」（x=3 这种）吸附到 0 / 6 这类档位，两块并排才齐；
  用户特意拉的自由宽度（除不尽列数，如 5 列）保持原样，不被「自动摆正」。
- **表单视图**：一键切回单列流式（长文 `md` / 表格字段多时更好读），版式保留、切回来即恢复。

### Notes

- 新增依赖 `react-grid-layout@^2.3.0`（含 `react-draggable` / `react-resizable`）；构建产物 +约 105KB gzip
  在条目视图的懒加载分片里，首屏不受影响。
- 版式**不影响**条目值、完整度与 CLI 读写口径；老 store 没有 `layout` 也能直接用（读一次就按默认编排渲染）。

## 0.23.1 (2026-11-05)

### Added

- **`skill install --all`：一次装齐 `assets/` 下全部 skill，且直接覆盖**。范围取目录
  扫描（事实源 `assets/<x>/SKILL.md`），不依赖分组表；覆盖隐式生效，不用再补 `--force`。
  与 `[name]` 互斥；`--mode symlink` / `--dry-run` 对整批同样适用。

## 0.23.0 (2026-10-31)

**栏目结构在面板里可自己搭了：分组能增删改序，字段能改名 / 换组 / 换类型 / 换位置。**

过去面板只能「加字段」，连建一个分组都要回 CLI 或换模板——于是「这个栏目长什么样」
这件事实际上只有命令行能控制，面板就不是控制面板。这次把结构的四个分组操作与两个字段操作
做成 action（面板与 CLI 同一份），面板「编辑栏目」里直接可改。

### Added

- **分组骨架**：`section update --add-group / --rename-group / --move-group / --remove-group`。
  改名可以**连 id 一起换**（组里字段的 `group` 引用跟着改，不会整组从表单里消失）。
  三条规矩全是**拦下来**而不是悄悄做：id 重复报 `CONFLICT`（不覆盖同名分组）、
  **非空分组不给删**（报 `BLOCKED` 并列出是哪几个字段）、内置「原始资料」分组不给删。
- **字段级改动**：`section update --set-field`（标签 / 类型 / 分组 / 提示 / 必填策略）
  与 `--move-field`（在自己分组内上下挪）。**key 不可改**——值按 key 存在条目里，
  改 key 等于让已有值读不出来；要换就新增字段再搬值。
- **面板**：「编辑栏目」弹窗里两块——「分组」（id / 名字就地改、↑↓ 换序、空组才能删）
  与「字段字典」（每行可改标签 / 类型 / 分组 / 提示 / 必填策略，组内 ↑↓，删除）。
  一次改动一次落盘（每次改动都要过后端校验，出错时知道是哪一步），改完立刻回读。
  清单类字段（`entrylist` / `table`）的**类型置灰**：列是字段自己的结构，
  就地换类型等于换一个字段——要建就在「新增字段」里连列一起建。
- 每次改动都把**新旧值**打进输出（`字段 phone：分组 contact → reach`），
  不再只说「已更新栏目 job：fields」——那种输出改错了没法回溯。

- **表格 / 清单：行与列都能拖**（Notion 那种手感）：拖**表头**搬列、拖行尾的 ⠿ 搬行，
  松手前一条**插入线**告诉你落在哪（只高亮整行说不清「会插到哪」）。排序算法单独一个
  `reorderAt`（插入位语义，有单测）——差一的表现是「拖到第二行结果跑到第三行」。
  整行不做 `draggable`：那会跟单元格里选文本打架，把手是唯一的拖拽入口。
  ↑↓ / ←→ 保留但**悬停才浮出**，行内操作键统一收成 16px 小图标键（密集表里的按钮
  不该抢内容的注意力）；entrylist 那颗「正常大小的删除按钮」也换成了小图标键。

## 0.22.0 (2026-10-31)

**原始资料的 text 底层改为 markdown：图片内嵌在正文里，图文不再分家。**

聊天记录是图文混排的——把文字存成一条、图存成另一个附件条目，等于把一段话拆得没头没尾。
所以 `text` 直接以 markdown 为底层：`![说明](f_xxx)` 内嵌附件库的图、`![说明](https://…)` 直接外链，
正文照旧原样存（面板上的修改是人显式点了「编辑」）。

### Added

- **抽屉收集即排版**：粘贴框变成 markdown 收集器——图片直接 **Ctrl+V** 或**拖进编辑器**（自动上传
  附件库并在光标处插入引用）、「插入图片」按钮选文件；图片内嵌显示，其它文件以可点链接内嵌。
  拖拽两条路语义不同：拖**编辑器** = 插进正文，拖**左栏清单** = 入袋成附件条目。
- **text 条目可显式编辑**：正文面板加「编辑 / 保存修改」（就地更新——是人点的保存，
  「原文不改写」的纪律不破）；正文渲染走与 md 字段同一台机器（图片解析 / 外链 / 点击放大 / 任务勾选）。
- 导出/导入：资料袋正文里内嵌的图片引用计入**引用扫描**（随包带走）并在导入时**重映射**到新库 id
  （`sourceImageIds` 一处实现，打包与完整性检查共用）。
- CLI：`source get` 的 text 用 `rewriteMdImages` 还原成 `[图片: 说明] 本地路径`（外链标注「外链」）；
  标题推断与摘要压掉图片语法（`![截图](f_x)` 不再当标题、摘要里是 `[图: 说明]`）。

### Compatibility

- **老数据不用迁移**：普通文字本来就是合法 markdown（段落 + 换行），渲染层无缝接管；
  `--set source='随手记'`、`source add --text` 的用法全部不变。

## 0.21.0 (2026-10-30)

**条目有了块正文（`entry.body`）；栏目有了数据库视图（`section.views`）。**

块是「递归的内容单元」，视图是「同一批数据的多种投影」。两者都**只加可选键**，
老 store 一个字节不用改；反方向的降级被显式拦住（见 Changed）。

### Added

- **块正文**：`entry.body: Block[]`，七种叶块（段落 / 标题 / 图文 / 表格 / 清单 / 附件 / 密钥）
  与两种容器块（内嵌栏目 `section` / 分栏 `column`，容器块的编辑随下一版）。
  - CLI：`entry block add | update | move | remove | remove-many`、`entry body <ref> [--mask]`；
    HTTP 同名路由，**一条 action 双端**（面板与 CLI 走同一份 service）。
  - 详细页下半部分是块面板：双击编辑文本块、表格块复用表格字段的同一台机器（公式/统计照旧）、
    密钥块与 secret 字段同一条 AES-256-GCM 路径，打码态**只读**（把星号写回去等于把星号存成密钥）。
  - 块随导出包往返；file 块里的附件 id 计入引用扫描（`file cleanup` 不会误删）；
    md 块里的贴图随包重映射。
- **数据库视图**：`section.views` / `section.defaultView`。
  - CLI：`section view list | add | update | remove | set-default`（HTTP 同名路由）。
  - **缺省视图是推断的、不落盘**：非 KV 栏目给「表格 / 精简 / 看板」，KV 栏目给「KV」；
    第一次改视图才固化（并把当时生效的那套一起写进去，chips 不会凭空消失）。
  - 投影只存 `key/width/hidden`，标签与类型回查字段字典；引用的字段被删 → 列还在，
    表头写「已删字段」、单元格「—」（不炸、也不静默消失）。
  - 面板：栏目页顶部视图 chips + 表格视图（横向投影，密文列在表格里一律打码）。
    看板**渲染**随下一版（配置与 action 已可用）。

### Changed

- **`STORE_VERSION` 3 → 4**。只加可选键、无迁移函数；但**老版本读 v4 store 后写入会被拒**
  （`BLOCKED`：「store 由更新版本的 nx-sk 写入」）。不拦的话，老版本的白名单归一会把
  `body` / `views` 静默抹掉，且版本号相同、无从警告。
- **导出包 `formatVersion` 1 → 2**（包里多了 `entries[].body` 与 `section.views`）。
  老版本读到新包会明确报「版本过新，请先升级」，而不是把两个键静默丢掉。
  导入时视图只在「新建栏目」或「目标没配过视图」时应用——目标已有视图说明用户自己配过，不覆盖。

### Fixed

- **表格字段的敏感列导出为明文**（0.19 起的老缺陷）：`plainValues` 没有 table 分支，
  导出包里是密文 blob，跨机器导入永远解不开。现在与其它敏感字段同一口径（包里明文，保护靠口令）。
- 块面板在 `bootstrap` 后渲染崩溃（注释与函数声明粘连导致 TDZ）。

## 0.20.0 (2026-10-30)

**栏目管理重构成树；初始化不再播种一堆场景栏目，改播一个「字段样例」说明书。**

### Added

- **栏目管理 = 栏目 → 条目的树**（`section tree`，HTTP `GET /api/sections/tree`）：
  可展开/收起（展开态记在面板设置里）、**多选 / 全选**（勾栏目 = 连条目一起，条目可单独勾）、
  **批量删除**（`section remove-many` / `entry remove-many`，HTTP 同名 POST 路由）——
  精确到条目，删栏目等同删文件夹（连带条目，需显式确认）；找不到的跳过并报告（status: partial），
  一个都找不到才报错。栏目多时的搜索：栏目命中整棵留下，只有条目命中时只留命中的并临时展开。
- **初始化只播种一个「字段样例」栏目**（`demo` 模板，连一条示例条目一起）：
  标量字段（文本/数字/是否/下拉/日期/标签）、组合字段（结构清单 + 表格：计算列与表尾统计）、
  富内容（图文 / 附件 / 密钥）各来一份，外加自带的「原始资料」袋——
  第一屏是说明书，不是别人的表格。求职 / 密钥 / 项目那 6 个场景模板仍是模板（`section add --template`）。
- **没有 KV 栏目时第一次 `key set` 自动补建**（与 `section add secret --template secret` 同形状；
  读命令不建）。播种不再自带密钥栏目后，`key set` 的「我要存」不该被「先建栏目」挡住。

### Changed

- `settings.defaultSection` 缺省从 `job` 改为 `demo`（指向播种的那个栏目）。
- 面板「栏目」页整页重构：平铺列表 → 树 + 批量条 + 搜索；存量用户的 store 不受影响
  （播种只发生在「store 文件不存在」时，文件在、栏目为空依旧不复活）。

## 0.19.0 (2026-10-30)

**新字段类型 `table`：结构写在数据里的表单表格。**

`entrylist` 是「变长的几列文本」；`table` 是它的进阶形态——每格有类型（勾选 / 下拉 / 数字 /
日期），带**计算列**与**表尾统计**。关键差别不在功能多少，在**结构归谁**：
`table` 的列定义、行、公式、统计配置全部存在**条目值里**，不在栏目字典里。
因此「这一条想多一列」不必改 schema，也不会波及同栏目的其它条目；
面板上直接加列 / 改类型 / 写公式，改完就是这份数据的一部分。

### Added

- **`type: 'table'` 表格字段**（`src/shared/table.js` 为计算内核，前后端同一份实现）：
  - 值是一份**自描述文档**：`{v, columns, rows, totals?, summary?}`。三种输入都认——
    行数组（列取字段的「初始列」或从行推断）、文档本身、以及它们的 JSON 串。
  - 列有类型：`text / textarea / number / bool / select / date / month / tags`；
    给 `formula` 就是**计算列**（不落盘，读时现算）；`sensitive: true` 的列密文落盘。
  - 公式是 **JS 表达式**（不发明语法），只包成 `return ( … )`：列 key 与**中文列名**
    都能当变量，`row` 取原值、`rows` 取整表、`col("列名")` 取一列；
    `sum / avg / min / max / count / countTrue / distinct / median / pct / round / isBlank …`
    与 `Math`、`JSON` 等内建可用。求值作用域用 `with` + Proxy 封死，`window / process / fetch` 取不到。
  - **统计两层**：列上的 `total` 决定表尾那一格（数字默认求和、勾选默认计是，
    多种统计方式自动分组成「合计 / 平均…」多行）；整表表达式写在数据的 `totals` 里
    （如完成率 `pct(countTrue(col("done")), n)`）。统计不落盘，读时现算。
  - 错误停在能看懂的那一层：「不存在的名字『qty』，可用的名字：a、b…」、
    「计算列只能引用它前面的列」、「结果不是有限数字（除以 0）」——不吐 NaN。
  - 新命令 `nx-sk entry table <条目> --field <表格字段>`（HTTP `GET /api/tables/:ref`）：
    只读地印出表头 / 数据 / 计算列 / 合计 / 公式报错。
  - 面板：`tableField.jsx` 的表格控件——勾选框 / 下拉框 / 数字 / 日期就地编辑，
    回车换下一行、Alt+↑↓ 跳上下格、行可上下移与删除；「列设置」里加列 / 改类型 /
    写公式 / 指定统计方式 / 默认值 / 左右移 / 删列（连值一起删，改 key 会搬值）。
    栏目编辑页新增字段时可直接配初始列。
  - **写入即体检**：每条公式在保存前用一行空值当探针跑一遍，只拦**与数据无关**的错
    （语法错 / 名字解析不到 / 结果不是单值），除零这类「这条数据不巧」留到渲染时逐格报。
    列、行、默认值、下拉候选、`total`、`totals` 全走同一条校验，面板与 CLI 共用。
  - 列可以带 `default`（新增行时的初值，按类型强转；`0` / `false` 都合法）。
  - 新 reference `assets/nx-sk/references/15-special-fields.md`：值不是标量的字段
    （`table` / `entrylist` / `md` / `file` / `source` / `secret`）的形状、规矩、
    公式与统计口径、错误对照表；`10-sections-entries` 里那份表格说明改为指向它（不留两份）。

### Changed

- **空表现在是合法的**：`--set 表=` / `[]` / `{}` / `{"columns":[],"rows":[]}` 都能把表清空
  （值存 `null`）；有初始列时 `[]` 留下「列在、行空」的骨架；只有「有行却没列」才报错。
  原先「必须给列」的硬校验会把「只想清空」和「新建一张空表」一起挡掉。
- `isBlank` 与 `isStoredEmpty` 分开了：前者判完整度（有列没行的表算没填），
  后者判「值要不要输出」（骨架必须带出去，否则面板拿不到列，搭好的结构一保存就"消失"）。
- `serializeEntry` 对表格字段永远输出**自描述文档**（列跟着数据走），
  所以 `entry get` / `section dump` / 导出拿到的东西不需要再回查栏目字典。
- `sensitiveViewer` 现在也认表格的密文列（原先只探 entrylist 的 `fields`），
  并且列存在数据里时按「任一格是密文」判定，不会再退化成「需要密钥才能解密」。
- **短值的打码占位现在也认得出**：`maskValue` 对 ≤10 字符的值返回全星（`***`），
  而老判断只认「连续 6 个星」，于是 3 位密码的打码值会被当成新密码加密存进去（无声数据损坏）。
- 空表算「未填」：`isBlank` 认 `{rows: []}`，完整度不会被一张没有行的表撑满。

### Fixed

- 表格的密文列在**打码显示**时保存：打码占位优先按打码值反查原密文（行被拖动过也能认对），
  认不出来才退回行号兜底；已知限制（两格打码值一模一样又拖了行）写进文档。
- `sections` 的「新增字段」表单里 `toast` 未定义（校验失败时会抛 ReferenceError），现按 props 传入。

## 0.18.0 (2026-10-28)

**拖拽不再闪，悬浮不再乱弹；「原始资料」袋对每个栏目都成立。**

这一版没有新栏目，都是「原来能用、但用起来别扭」的地方：设置页拖分组时列表自己
在动，于是闪；头部悬浮分组入口时一秒钟弹开又收起好几个；自定义栏目丢了资料袋。

### Changed

- **头部「分组入口」的悬浮展开加了意图延迟，并且同一时刻只开一个**：原先 `mouseenter`
  立刻弹、`mouseleave` 140ms 就收，鼠标横穿导航栏去点右边的 tab 时，路过的分组会被
  顺带弹开又收起（一眼看过去就是乱闪）；各分组的展开态又各自持有，快速划过能同时
  叠出两个菜单。现在：停住 130ms 才展开（路过不算）、离开 180ms 后收起（划进菜单就撤销）、
  展开态交给 App 托管成「只开一个」、点击改为切换（触屏没有 hover，只能走这条路——
  按 `(hover: hover)` 分流，避免 tap 时合成的 mouseenter 先把菜单开掉、click 又把它关掉）。
  另加：展开时三角翻上去（只动 transform，不改布局）。
- **「原始资料」袋（`source` 字段）成为每个非 KV 栏目自带的结构**：此前只有模板实例
  自带，自定义栏目一旦传了 `--fields`/`--groups`（sk-needdo 的常规路径），袋就被
  整体覆盖掉了。现在内置规则收口为唯一函数 `ensureSourceBuiltin`，在 `instantiateTemplate`、
  `section add`、`normalizeSection` 三处生效——存量栏目缺袋时读一次即自愈，
  KV 表仍不加（形状固定）。sk-needdo 文档同步改为「杂乱输入先入袋、再整理」，
  并去掉字段设计里重复的「来源」text 字段（与 `source` 键冲突）。

### Fixed

- **设置页「栏目管理」拖拽闪屏、边缘落点乱跳**：两处根因都在「拖的时候列表自己在动」。
  - 闪屏：原先用**实时预览**（拖动中就把被拖的行挪到落点上）。行一挪，指针底下的元素
    就换了、下方容器整体位移一行（28px），`dragover` 于是算出另一个落点，再挪再算——
    自己推自己。现在拖动期间**列表静止**（被拖的那行半透明留在原地），落点用一条
    **不占布局的指示线**（2px inset 压在行边上）表达：几何恒定 → 落点只随指针单调变化，
    松手一次性提交，结果就是指示线指的位置。拖影也从 10px 的把手换成整行。
  - 边缘乱跳：容器空白处（缝隙、内边距、说明文字）原先一律判成「追加到末尾」，
    指针一进缝隙整列表就跳到队尾；现在整块容器都按**行中线**算插入位
    （`navModel.slotAt`），边缘与缝隙都归到最近的一侧。
  - 平铺区索引错位：`containerOf` 的平铺分支拿 `poolOrder`（含已归组 / 隐藏栏目的全量顺序）
    当行号，与屏幕上第几行差好几格，落点因此偏——改为按**可见行**（`viewRows`）取索引。
  - 分组换位从「交换」改成「挪」：0 拖到 2 时中间那组上移一格，不再把 B 留在原地。
  - 顺带：拖回原位不再提示「有未保存的改动」（导航按 `sameStructure` 判脏，
    `order` 里留下的序列脚印不参与比较）。

### 测试

- `nav-model.test.mjs` 新增 5 组用例：可见行口径（`viewRows` / 平铺区落点不偏格）、
  行中线取位（`slotAt`，缝隙不跳）、结构等价（`sameStructure`，拖回原位不算脏）、
  分组「挪」而非「交换」（`moveGroupTo`）。

## 0.17.0 (2026-10-25)

**附件不再靠下拉框挑，孤儿附件能一键清，改动不用翻到页底才保存。**

三处都是「长栏目 / 附件多了以后，原来的做法开始难受」逼出来的：

### Added

- **附件库选择面板**（字段里的 `file` 字段）：点「从附件库选…」打开的是
  **可搜索的面板**，不是原生下拉框——库里几十个附件时，下拉框根本没法挑。
  - **关键字搜索**：按名称 / 备注 / 标签过滤（Esc 关闭）；
  - **未引用优先**：没有任何条目引用的原件排在前面（刚导入还没挂上去的就在最上面），
    已被引用的排在后面并标注「已被 N 处引用」——仍然可选（同一原件可被多条条目共享）；
  - 点一行即**追加**到本字段，可连点多个；已挂上的会从列表里消失。
- **`nx-sk file cleanup`**：一键清理**未被任何条目引用**的附件（孤儿附件），
  物理原件一并删除、不可撤销。判据与附件中心的「未引用」筛选片**完全同一套**
  （`fileReferences` 为空）——两套判据会出现「筛选片里看不到、清理却删了」这种吓人的不一致。
  有 `--dry-run`（先列清单）；没有可清的返回 `skipped`（不是失败）。
  面板上：附件中心工具条「清理未引用（N）」，点了弹确认并报清数量。
- **条目表单的保存按钮固定在右上角**：有改动时表单顶栏出现「N 处改动未保存 · 保存」，
  且顶栏**吸顶**（`position: sticky`）——长栏目滚到一半也看得见保存，不必翻到表单最底。
  底部的保存按钮保留；关标签页前会拦一下（`beforeunload`），改到一半不留神关掉不丢改动。

### Changed

- 字段里的 `file` 附件选择从原生 `<select>` 换成选择面板（原来只能在一堆选项里肉眼找）。

### 测试

- 新增用例：`file cleanup` 只删未被引用的附件，被引用的原样留下（物理文件也在），
  试运行不动台账，反复清理不伤被引用的附件。

## 0.16.0 (2026-10-23)

**凭据自动化：账号密码跟着场景走，直接渲染成配置文件。**

nx-sk 的定位从来不是「另一个密码管理器」，而是**把凭据变成能用的东西**。
这一版把这条主用途补齐：凭据不再必须绕去「密钥」栏目，agent 可以大胆写、直接出成品配置。

### Added

- **自动登记的凭据键直接建成密文字段**：键名里出现 密码 / 口令 / 密钥 / 账号 / 帐号 /
  凭据 / token / apiKey / accessKey / secretKey / password / passphrase 等词时，
  新登记的字段就是密文字段 —— 落盘 AES-256-GCM 密文，读出来默认原文。
  于是 `--set 密码=…` 这种「一把写进去」的用法**不需要先声明 schema，也不会明文裸奔**。
  判据刻意宽松：把不是凭据的字段多加密一次只是多几行密文，反过来漏加密的代价是凭据裸奔。
- **deploy 模板自带「凭据清单」字段**（分组「凭据」）：结构清单，一行一组账号，
  密码与令牌列 `sensitive` 密文落盘。**一个场景的凭据写在那个场景的条目里**，
  不再需要为它单开一个密钥栏目。老栏目用 `section sync deploy` 补上。
- **结构清单的行可以用**列标签**写**（`密码` 与 `pass` 等价），与顶层 `--set` 同一口径 ——
  之前只认列 key，文档里的示例是错的，agent 按文档写就会报错。
- **渲染脚本 `assets/nx-sk/scripts/render-config.js`**：把条目里的凭据替换进模板正文的
  `${VAR}`，产出成品配置文件（compose / k8s / .env / Dockerfile）。
  跑完报「替换了哪些、哪些没解析」。固化成文件是因为**多行 `node -e` 在 Windows 终端里
  会被吃掉引号**（实测是静默不执行、退出码 0）。
- **新 ref `30-credentials`**：凭据归属哪个栏目、多组账号怎么建清单、跨栏目台账、
  渲染流程、安全边界与常见场景落位。SKILL.md 与 `10` / `20` / `50` 三个 ref 同步改写，
  整体口径从「怕明文」改成「**模板层与场景层分工**」。
- **随包 skill 改成「完全客户端」**：只回答「怎么用」与「东西该往哪儿放」，
  不再夹带开发侧知识。`references/00-design.md` **整篇重写**——
  从「代码分层 / action 声明 / 错误契约 / 踩坑记录」改成**用户侧的心智模型**：
  栏目确定结构、条目确定数据、内置字段是建议清单、动态栏目 + 动态条目、
  四个聚合点、密文边界、给 agent 的三条不变量。
  开发侧内容（分层与依赖方向、action 机制、错误契约表、实测踩坑表）**归位到仓库 README**
  的「设计取舍与踩坑记录」——装了包也用不上它，但仓库开发者需要它。
  其余 ref 里的 HTTP 路由列、源码路径也一并清掉。

### Changed

- **密钥（KV）栏目的定位收窄为「跨场景通用的 key」**：只服务于一个场景的凭据
  （某台服务器的密码、某个平台的账号）改写进场景自己的栏目条目。理由是凭据的寿命跟着场景 ——
  堆在一个 KV 表里，到头来只能靠键名前缀编码场景，等于把结构塞进键名。
- **`entry keys` 台账的地位明确**：它是「凭据散在各个栏目里」的对账表 ——
  改密码、找入口、迁移机器前先跑一遍。
- skill 文档补齐了两个漏写的内置模板（`platform` / `thesis`，共 8 个），
  以及 `entrylist` 行的列标签写法。

### Fixed

- 模板里 `deploy` 的 `content` 字段提示与 `50-deploy` 的口径此前互相矛盾
  （一个说「真值放密钥栏目」、一个说「明文密钥不写在这里」），现在统一为
  「模板正文写占位符、场景真值写凭据清单」。
- **`entry keys` 台账漏掉结构清单里的凭据**：场景凭据现在住在 entrylist 的行里
  （`creds` 清单），而台账只扫顶层字段 —— 于是「一条命令看全部凭据」恰好看不见
  放在清单里的那些。台账改为展开清单行逐格上报。

### 测试

- 新增 `tests/unit/credentials.test.mjs`：自动登记的凭据键密文落盘、读回原文、
  `--mask` 打码；不像凭据的键不误加密；清单行可用列标签写；
  deploy 模板自带凭据清单且敏感列密文。
- 新增断言「随包手册不许出现开发侧知识」（HTTP 路由 / 源码路径 / 构建工具链）——
  已做反向验证：塞进一个路由即红。开发侧内容要进随包手册前，先过这一关。

## 0.15.3 (2026-10-20)

### Changed

- **端口被占用时不再报错退出：自动复用或顺延，并把浏览器指过去**。`serve` 绑定端口
  遇到 `EADDRINUSE` 时，先探测该端口上的 `/api/bootstrap`：占用者**就是本项目的面板**
  （`app.name` 相同）就直接复用它——不再起第二个进程——并打开浏览器指向它；占用者是
  别的服务（或探测不出来）则顺延到**下一个空闲端口**起自己的面板，并打开浏览器指向新
  面板，不会把浏览器指向别人的服务。
- **跨项目统一的关闭开关 `NX_SERVE_NO_OPEN`**：设成 `1` / `true` / `yes` / `on` 时
  `serve` 完全不开浏览器（所有 nx-xx 项目共用这一个变量名）；`--no-open` 仍然只关
  当前这一次。

## 0.15.2 (2026-10-20)

### Changed

- **skill 改名：`kv-source` → `sk-source`**——与 sk-pdf / sk-needdo / sk-thesis 用同一个
  `sk-` 前缀（它们都是「教 agent 做一类事」的配套 skill，`nx-*` 前缀留给 CLI 本体）。
  已装过旧名的：`nx-sk skill install sk-source --force` 装新的，旧的目录可手动删。

## 0.15.1 (2026-10-20)

### Fixed

- **附件字段里的附件列表改成 5 行高的滚动窗口**：原先是**全部铺开**——20 个附件就把
  条目表单撑高近 1000px，填别的字段时得拖着整页上下滚。现在默认只露 5 行，
  窗口内上下滚动查看，下方标「共 N 个附件（窗口内上下滚动查看）」，需要看全时点
  「展开全部」/「收起到 5 行」。

## 0.15.0 (2026-10-20)

**原始资料袋：每个栏目都自带一个「乱入区」**

### Added

- **毕业论文栏目模板（`section add --template thesis`）+ 随包 skill `sk-thesis`**：把信息工程学院
  2022 版撰写规范（设计开发类）做成 9 组 / 59 个字段——页面与字体硬指标、章节结构、图表与三线表、
  代码要求、参考文献（GB/T 7714-2015）、打印装订与日期红线，外加一份可直接勾选的「交稿自检」清单。
  配套 `assets/sk-thesis/templates/毕业论文模板-设计开发类.docx`：A4、页边距 2.5/2/2.5/2 cm、
  1.5 倍行距、宋体小四、标题黑体四号 / 黑体小四 / 宋体小四、三线表 1.5 磅 / 1 磅、目录域、
  分节页码（封面与目录不编、标题页起为 1），关键位置带 23 条格式批注。
  `scripts/make_thesis_template.py` 可重新生成；`references/10-format` 是数值速查，
  `20-structure` 是章节骨架与装订顺序，`30-pitfalls` 记录真实错法（一级标题加粗、
  图题「图 1」多空格、（1）用自动编号带悬挂缩进、批注未删导致 PDF 整页缩到 74%）。

- **原始资料袋（`source` 字段）：每个栏目都自带一个的「乱入区」**——杂乱资料（邮件、截图、
  PDF 摘录、手抄的表）先**原样**收进袋子，之后由 agent 或人按栏目字段字典整理成结构化字段。
  「先乱入、后整理」因此成立：没有这个袋子，用户只有把乱数据硬塞进结构化字段（把结构搞脏）
  或干脆不存（信息丢了）两个坏选择。
  - **面板**：条目表单底部一条折叠条「原始资料 · N 条」，点开是右侧抽屉——左清单、中正文，
    文件拖进去即入袋（同时给了「选择文件」按钮与粘贴框：WCAG 2.2 AA 要求拖拽不能是唯一入口）。
    抽屉内焦点有可见指示器（2px 描边），关闭后焦点归还折叠条。
  - **CLI**：`source list / get / add / update / remove / ensure`；`--file` 先进附件库、
    **原件保留不搬走**（「加一条资料」不该搬用户本机的文件，那是 `file add` 的语义）。
  - **双向同步**：整理完用 `source update --mapped 字段key` 给用上的资料打锚点，
    字段值也可回写进袋子留出处——「哪个字段的值来自哪条原始资料」永远反查得回来。
  - 三条纪律写进代码与文档：**原文不改写**、**不确定就留空**、**敏感内容不进袋**（袋是明文的，
    密码走「密钥」栏目或 `sensitive` 字段）；袋**不计完整度**（暂存区不是「该填的格子」）。
  - 新栏目（模板或自定义）都自带这个字段；老栏目用 `nx-sk source ensure` 一次补齐。
- **`sk-source` skill**（随包分发，`nx-sk skill install sk-source`）：讲透「原始资料 ↔ 字段」
  的双向同步、映射表纪律（把握不足就不写）、以及各种文件（PDF/截图/邮件/表格）怎么进袋。

### Fixed

- **数组型 flag 的逗号没被切开**：`--unset a,b`、`--tags a,b` 会把整串当成**一个**值
  （CLI 解析层把 array flag 收成数组，而强转那一步见数组就跳过了切分）——
  `--unset a,b` 直接报「没有字段: a,b」。现在每个元素都再按逗号切一次。

## 0.14.0 (2026-10-19)

**统一列表机制：跨栏目关键 key 台账 + 容器平台字段模板 + 结构清单**

### Added

- **关键 key 台账（`nx-sk entry keys [--reveal]`）**：跨栏目聚合 链接 / 账号 / 密码 / 镜像 / token 等
  关键字段统一列表——不管是 job/school 还是自己手搓的「容器平台」栏目里的 accessUrl / account /
  password 字段，全部进同一张台账。值默认打码（链接类保留原文便于点击；账号/密码/token 一律掩码）；
  `--reveal` 出明文（密文字段走解密）。给 agent 一句「把川农控制台链接和账号密码贴出来」就能直接拿到。
- **容器平台模板（`nx-sk section add --template platform`）**：一个平台（KubeSphere / Rancher / 自建 k8s…）
  一个条目，字段：基本信息（平台名/提供方/环境）/ 访问凭据（控制台链接/账号/密码[密文]）/ 镜像与部署
  （项目命名空间/仓库/镜像名/部署清单附件）/ 网络入口（应用入口链接）/ 备注。
  配合 `entry keys` 把分散在每个平台条目里的链接/账号/密码自动汇总成台账。
- **条目页左右栏可拖宽**：条目列表 ↔ 内容之间加了分隔把手（骑在原 14px 间隙上，间距节奏不变），
  拖动即调整左栏宽度（240–560px 夹紧），双击恢复默认 300px；宽度记在 `ui.listW`
  （localStorage），跨会话保留。拖动过程只改本地 state，松手才落盘，不因 mousemove 重渲染表单。

- **条目定位面包屑：点击即复制，方便把「改哪个条目」一键贴给 agent**。条目列表每行悬浮出 ⧉
  （hover 才显示，不打扰），右侧详情头的「栏目 › 条目 ⧉」整条可点；复制出的定位同时带
  人读路径（栏目「标题」(id) › 条目「标题」(id)）与可直接执行的 CLI
  （`entry get` / `entry update --section <栏目id> <条目id>`）——标题可能重名或被改，
  定位与命令一律用 id，agent 拿到就能精确动手，不用再猜「是哪一条」。

- **`entrylist` 字段类型：结构清单（变长行）**——一个字段的值是**行对象的数组**，行数不限；
  列（子字段）在字段定义的 `fields` 里声明。为「一个条目挂多组 链接/账号/密码」这类密集结构而生：
  tags 存不了结构，拆成多个字段又不知道会有几组。
  - 面板渲染成**密集迷你表**（列头 + 行输入框，直接增删行）；「新增字段」选「结构清单（变长行）」
    预填 名称 / 链接 / 账号 / 密码(密文) 四列，列可增删、可勾「密文」。
  - 敏感列（`sensitive: true`）与顶层敏感字段同一条边界：AES-256-GCM 密文落盘、默认读原文、
    `--mask` 打码、打码占位原样回传保留原密文（想改密码却只拷了打码值会当场报错）；
    ZIP 导出前同样把清单里的密文解开。
  - CLI 写入用 JSON：`--data '{"账号清单":[{"名称":"…","链接":"https://…"}]}'`（`--set` 认 JSON 串，
    空串 = 清空）；没登记过的键直接写行数组会自动登记成 entrylist 并从行推断列；
    `entry get` 里清单一行一条、带列标签；模板漂移把列定义也算进去（列变了 sync 会报）。

- **`sk-pdf` skill：把 PDF 转成图文 SOP 栏目**（随包分发，`nx-sk skill install sk-pdf`）。
  解决「照着一份 PDF 手册把流程沉淀进 nx-sk」这件事每次都要重新摸索的问题 ——
  流程、脚本、坑都固化下来了。
  - 两个脚本（唯一第三方依赖 PyMuPDF，其余全是标准库）：
    `pdf_probe.py` 先探查（页数 / 每页图数 / 图片尺寸分布 / 是不是扫描件，
    图 ≤5 张就别走图文流程）；`pdf_extract.py` 出**带图片占位符的 markdown** + 导出图片。
  - **按版面坐标（y）排序拼图文**，不按页码也不按 xref 顺序 —— 这是最关键的一点：
    顺序错了文字全对而截图全错位，用户照着图文对不上完全做不下去。
  - 图片编号 `页码_页内序号`（如 `006_1`），挑图时用编号对话不易错，事后可回溯来源。
  - **技术栈（实测后写定，不是猜的）**：只用 **PyMuPDF** 一个第三方库，其余全是标准库；
    Pillow / pypdf / pdfplumber 实测都不需要，不装（少一个依赖就少一处「换机器跑不起来」）。
    选 PyMuPDF 的唯一理由是它能给 `get_image_rects()`（图片在页面上的**摆放矩形**）——
    图文拼接靠的就是 y 坐标，别的库给不出位置就不适用。
    缺依赖时脚本会打印**可操作提示**（装什么、装到哪、Windows 上装完还报错多半是解释器指错了），
    而不是只丢一句 `No module named`。
  - 栏目结构模板：简介 / **准备材料** / 入口与地址 / 操作手册 / 常见问题 / 自检清单，
    以及账号密码各自一个 `sensitive` 字段、正文只写「见〈某字段〉」。
  - `30-pitfalls` 记的是真做一份 52 页手册时踩到的：51 张图只该留 18 张、
    占位符忘换附件 id、本地路径渲染不出、`file add` 默认移动原件、
    扫描件抽出来是空、md 图片曾被附件中心误判「未引用」。
  - 已端到端验证：探查 → 抽图 48 张 → 上传 → 建栏目/字段/条目 → 写 md →
    `file get` 的 `usedBy` 正确指向本条目、未引用数 = 0。
  - 主 skill 补了 `md` 字段与图片引用的说明（此前完全没提，是缺口）。


### Fixed

- **短明文打码**：原规则长度 ≤ 12 的值直接显示全明文——账号 14611 整条明文。现在
  账号/密码/token/secret/身份证/电话/银行等敏感类字段一律 `maskValue`（maskValue('14611')='**'）；
  链接/镜像等 URL 类仍明文。
- **关键 key 字段识别**：从文件名启发式改为 key/label 文本匹配（`account|password|token|...`），不再
  依赖文件名含数字（`sqlh` 等字母名字段也能正确入台账）。
- **md 正文里的图片在附件中心被显示成「未引用」**：`fileReferences` 只扫 `type: 'file'` 的字段，
  完全不看 `md` 字段正文里的 `![说明](f_xxx)` —— 而图片是内嵌在 markdown 里的正式引用。
  实际影响：一份 18 张截图的 SOP 容器平台栏目，全部 18 张图都被判成孤儿，
  「未引用」筛选会把它们捞出来，看着像附件丢了。
  - 现在 `file` 与 `md` 两种引用都反查，并给出栏目 / 条目 / 字段的完整定位。
  - `collectFileSections` 同步放开：只有 `md` 字段的栏目也出现在附件中心的栏目筛选里
    （原先只有 `file` 字段的栏目才出现，按栏目筛选时根本找不到 md 图片所在栏目）。
  - **顺带修掉一个更隐蔽的坑**：命中判定原先是 `findFileRecord(store, id) === rec`
    （对象引用相等）。调用方拿到的通常是 `listFiles` 加工过的**副本**，引用不同 →
    静默判成「未引用」。改成按 id / 唯一文件名判定，副本传参也能命中。

## [0.13.0] - 2026-10-18

> **BREAKING**：`nx-sk export run` / `export list`（可读导出 JSON / Markdown）已移除。
> 导出现在**只有 `nx-sk transfer` 一条路径**（`export` / `import` / `bundle-export` /
> `bundle-import` / `import-new`）。详见 [Removed](#removed)。

### Removed

- **可读导出（JSON / Markdown）整体删除**：`nx-sk export run` / `export list`、
  `POST /api/export`、`GET /api/exports`、`components/readableExport.jsx`、
  `store.exports`（历次导出历史）与 `MAX_EXPORT_HISTORY` 全部移除。
  它和备份是同一类东西 —— 「往本机目录再写一份副本」，而 ZIP 导出已经把这件事做完了，
  两套口径并存只会漂移（谁也不知道该看哪一份）。
  - 设置页移除：可读导出面板（格式 / 输出目录 / 凭据开关 / 历次导出 / 目录内文件），
    以及「默认导出格式」「默认导出目录」「导出默认带明文密钥」三项设置；
    `SETTING_KEYS` 里的 `exportDir` / `exportFormat` / `includeSecretsInExport` 一并去掉。
  - 栏目页「更多」里的「导出 JSON / Markdown」菜单项移除（ZIP 导出 / 导入不动）。
  - **「导出导入」页与 transfer 五条命令完全不动** —— 那是本项目唯一的导出路径。

## [0.12.0] - 2026-10-18

> **BREAKING**：`nx-sk backup *` 命令与 `.nxskbak` 格式已移除。改用 `nx-sk transfer export` /
> `transfer import-new`。旧的 `.nxskbak` 文件不再可导入，请在本版发布前用 0.11.x 导出一份。
> 详见 [Removed](#removed)。

### Added

- **导出包可设口令加密**（按栏目 ZIP 与全局 bundle 都支持）：导出选项里填口令（输两次），
  下载的包整体 AES-256-GCM 加密。密钥由口令经 scrypt 派生，与密钥库同一套参数；
  每次导出盐与 IV 都重新随机 —— 同一个包加密两次密文不同。
  - 导入是同一个入口：自动识别加密包，**先问口令**再预览 —— 不会把「缺口令」
    误报成「包坏了」。口令错 / 内容被改都在 GCM 认证阶段报错，不会解出垃圾。
  - CLI：`--passphrase`，也认环境变量 `NX_SK_TRANSFER_PASSPHRASE`（命令行口令会进进程列表）。
- **导入预览列出冲突明细**：哪条撞上哪条（同 id / 同标题）、另存会变成什么标题
  （选「另存」后实时显示 `→ 甲（导入）」）。单栏目与整库预览口径一致。
- **零依赖 ZIP 实现**（`src/core/zip.js`：store/deflate、CRC32、路径安全校验），
  不引第三方压缩库就能产出合法的跨平台 ZIP。
- **图文（`md`）正文改用 markdown 组件渲染**（新增依赖 `react-markdown` + `remark-gfm` + `remark-breaks`，
  新组件 `web/frontend/components/mdView.jsx`）：标题、有序/无序列表、表格、代码块、引用、删除线、
  裸网址自动链接都按标准 markdown 渲染。此前手写解析只认图片与链接，SOP 里的结构在预览里全是字面量。
  - **待办可点**：`- [ ] 步骤` 在预览里就是勾选框，点一下写回正文的 `[x]`（`mdSource.toggleTaskAtLine`）。
    按解析器给的**行号**定位，不是「第几个勾选框」——嵌套列表与有序列表都不会串行；
    勾选状态只有正文一份，不另存，所以导出、CLI 读到的就是勾完的样子。
  - **图片与链接的行为保持不变**：`![说明](f_xxx)` 仍走附件库 + 放大镜（`[说明](f_xxx)` 直接打开附件）；
    只放行 http(s) 与能查到的附件 id，其余按普通文字渲染，`javascript:` 不会被执行。
  - **裸地址自动识别**（`web/frontend/mdSmart.js`，remark 插件，排在 gfm 之后）：
    `125.67.197.2:7443`、`10.0.0.1`、`localhost:7866` 渲染成虚下划线的「点击即复制」；
    `qcloud.sicau.edu.cn/login`、`example.com:8080/a?b=1` 自动补 `http://` 后点击打开。
    宁可严：TLD 黑名单（`config.json`、`README.md` 这类文件名不会被当成域名）、端口 1–65535 校验、
    前面是字母/数字/`@`/`/`/`:` 时不算起点（不在已有 URL、邮箱、路径里再识别一次）；
    代码块与行内代码原样保留。工具栏统计同步区分「链接」与「IP」。
  - **补掉解析器带进来的两个坑**：GFM 自动链接一直吃到空白，中文句子又不用空格，
    `见 https://a.com。另见` 会被整段算进 href（点开 404）—— `cleanHttpUrl` / `linkTextParts`
    按「解码后遇到中文标点即断」截断，断下来的标点回到正文；`remark-breaks` 把单个换行渲染成 `<br>`，
    保住手写那版 `pre-wrap` 的「一行一步」手感，已有 SOP 不会挤成一整段。
  - 统计与下方图库仍走 `mdInline.js`（只读解析，不参与渲染）；新增 `tests/unit/md-source.test.mjs`，
    `md-inline.test.mjs` 补了 URL 截断的用例。

### Changed

- **加密包改为「内部数据先加密，再套合法 ZIP」**：之前整个文件是密文，Windows 会报
  「压缩(zipped)文件夹错误」。现在外层始终是标准 ZIP（内含 `payload.enc` + `README.txt`），
  系统压缩工具能正常打开，只看到一个看不懂的文件；判定是否加密也只需看条目名，
  不用嗅探 magic。旧 `NXSKENC1` 整文件密文**仍可导入**，只是不再产出。
- **去掉「打码 / 明文」二选，口令即保护**（BREAKING，flag 层）：`--no-secrets` 移除。
  要分享就设口令，不设口令的包自己收好。读取侧仍兼容 0.11.0 及更早的打码包
  （遇到 `******` 跳过该字段并计数，不会把打码串当新密码存进去）。
- **「按栏目 / 整库备份」两个 tab 合并成一个面板**：栏目的全选就是整库导出，
  「整库」按钮只是全选的快捷方式，产物与逐栏勾选是同一个包、同一套导入逻辑。
- **导出包支持 `--no-files`**：只带元数据不带附件原件，跨机传配置时省体积。
- **`transfer import-new` 自动识别包结构**：不用手动挑单栏目导入还是整库导入。
- **面板重排（UI）**：左右两栏（左 = 选内容 + 设口令，右 = 解密导入）；
  栏目横向 chips，**指针移上去自动展开该栏目条目**（点击/键盘同样可用，不只靠悬浮），
  「整库 / 清空」预设；口令与「导出 ZIP」提到卡片头部常驻，条目再多也不用滚动找按钮。
  chips 用原生 `<button>` + `aria-pressed`/`aria-expanded`，长标题省略号 + title 兜底。
- **附件中心分页**：面板每页 24 个，避免一次加载全部图片把浏览器撑爆；
  CLI 默认仍全量返回。

### Fixed

- **头部导航的分组角标显示成了条目数之和**：「求职资料」分组只有 6 个栏目，角标却是 16 ——
  那是组内所有栏目的条目数加总。角标紧挨组名，本该回答「这一坨里有多少个栏目」；
  加总出来的数字看着像「这个分组本身是个栏目、底下挂着 16 条记录」，而展开后每行
  又各有自己的条目数，既冗余又误导。现在显示**栏目数**，并给 button 补了
  `title="求职资料：6 个栏目"`。平铺 tab 不变（它的角标本就是该栏目的条目数）。
- **`entryIds` 在路由层没透传**：服务层单测是绿的，但 ZIP 仍打全量。
  修复后浏览器解包确认只含所选条目。
- **group 回落不一致**：多处各自兜底成不同栏目名，统一到一处。
- **阅读态下没有图片的 `md` 字段不再显示空的图片区**：纯文字字段（上线检查清单、常用链接）
  底下会多出「图片（0）」和一句「正文里还没有图片」，纯噪音。现在只有正文真有图、
  或正在编辑时才渲染那块；编辑态保留，因为它是「贴进来的图会出现在这里」的落点提示。
- **「另存」的标题在极端情况下会重复加「（导入）」**：`uniqueTitle` 的基准原本传的是
  `标题（导入）`，二次重名会变成 `A（导入）（导入）`，与预览里算给用户看的 `copyTitle` 也对不上。
  现在基准统一用原标题，预览与实际落盘一致。
- **空栏目被整库选中时，chip 的 `aria-pressed` 是 false**：选中态原先按条目数推导
  （`!!n`），0 条目的栏目于是即使用户勾了也读成「未选」—— 读屏用户得到错误状态。
  选中态现在与条目数无关。

### Removed

- **备份模块整体删除**（BREAKING）：`nx-sk backup *` 命令、`.nxskbak` 格式、
  `src/modules/backup/` 与 `references/30-export-backup.md` 全部移除。
  有文件导出就够了，本地快照备份是重复的第二套回退机制，而且两边口径必然漂移。
  - 删条目 / 栏目 / 附件**不再留快照** —— 改为「先导出再删」，`transfer export`
    出来的包就是唯一回退手段。
  - 跨机敏感字段的重新加密逻辑迁到 `transfer`：导入后用**本机 vaultKey** 重加密落盘，
    与手填字段没有区别。
  - 导航名由「导出与备份」改为「导出导入」；旧书签 `#/backup` 自动落到「设置」。
  - 旧命令 `nx-sk backup export|import` 报「未知命令」，请改用 `transfer export` /
    `transfer import-new`（旧 `.nxskbak` 文件不再可导入）。

## [0.11.0] - 2026-10-18

### Added

- **栏目导出 / 导入 ZIP（局部迁移）**：栏目页右上角「更多」里有四项 ——
  导出 ZIP（含凭据）、导出 ZIP（打码）、导入 ZIP…、导出 JSON/Markdown。
  导入支持**整页拖入**，先出预览（来源/目标栏目、条目新增与冲突、将补字段、附件新增/复用、
  凭据是否打码），再选冲突策略（跳过 / 另存 / 覆盖）确认后才写盘。
  - 包结构：`manifest.json`（栏目定义 + 条目 + 附件清单 sha256）+ `attachments/<id><ext>` + `README.txt`；
    纯 Node 实现 ZIP 读写（store/deflate），零依赖，拒绝绝对路径与 `..`。
  - 附件按 sha256 **去重复用**；正文 / 附件字段里的旧 file id 自动重映射到新 id。
  - 导出的凭据默认明文（与 export 模块一致）；`--no-secrets` 打码，导入侧识别 `******` 并跳过该字段，
    不会把打码串当新密码存进去。
  - CLI：`nx-sk transfer export <栏目> --out x.zip [--no-secrets]`、
    `nx-sk transfer import <栏目> --file x.zip [--dry-run] [--on-conflict skip|copy|overwrite]`。
  - HTTP：`GET /api/sections/:ref/export.zip`、`POST /api/sections/:ref/import.zip`（原始二进制 body，
    不走 base64/JSON，避免大包膨胀 1/3 与 32MB 上限）。
  - **精确导出**：条目列表可勾选（表头全选 / 清空），选中后只打包这些条目与**它们引用到的附件**；
    `--entries` 接受 id 或标题（逗号分隔）。
  - **零配置导入**：`POST /api/import.zip`（栏目页「导入 ZIP」/ 拖入）按包内结构**新建栏目** ——
    字段字典、分组、KV 标记、附件一起建好；id 冲突自动加序号、标题加「（导入）」，
    同一份包可反复导入成多份，不会静默并进现有栏目。

- **统一的全局导出 / 导入面板**：「导出与备份」页顶部是栏目树（栏目/条目多选、全选/清空），
  导出为一个多栏目 bundle（`bundle.json` + 每栏目同构 `sections/<id>.zip`）；
  下方拖入/点击选择 ZIP，先预览将产生的变更（栏目、条目新增/冲突、补字段、附件新增/复用、凭据），
  再选冲突策略应用。全局导入逐栏目复用单栏目逻辑，行为与栏目页一致。
  CLI：`transfer bundle-export --sections ...`、`transfer bundle-import --file ...`。
- **附件中心分页**：`GET /api/files` 支持 `limit` / `offset` 并返回 `page` 信息；面板每页 24 个，
  避免一次性把整库图片加载进浏览器导致 OOM；CLI 不传 limit 时仍是全量（行为不变）。

- **新字段类型 `md`（图文）**：值是一段 markdown 正文，可用 `![说明](f_xxx)` 引用附件库里的图片 ——
  为「说明 + 截屏」混排的内容（部署 SOP、报错复现步骤）准备的。
  - 编辑器（`fieldEditor.jsx`）：**Ctrl+V 直接粘截图** / 拖图片进来 / 选文件 / 从附件库插入，
    都会先上传到附件库，再把 `![名字](id)` 插到**光标处**；批量先收齐再一次性插入，
    避免连续插入跟光标位置打架。纯文字粘贴不拦截，仍走浏览器默认行为。
  - **图片统一下方成组**：正文里引用到的图片去重列成缩略图，点击开大图 —— 滚轮缩放、
    拖动平移、双击或「适应」复位、Esc 关闭（新增 `components/lightbox.jsx`）。
    截屏里的一行小字因此看得清，又不必跳到新标签页丢掉上下文。
  - 正文下方就地预览（图片内联渲染），贴完立刻能确认是不是要的那张。
  - **正文里的 http(s) 链接在预览里可直接点开**（新标签页）：裸网址与 `[文字](https://…)` 都识别。
    网址尾巴上的中文标点（`。`、`）`）会留在正文里不被吞进 href，括号按成对判断 ——
    维基式 `…/Foo_(bar)` 不会被截断。只认 http/https：`www.`、`ftp://`、文件路径一律按原文，
    否则文件名和包名会满屏变成可点链接。解析抽到 `web/frontend/mdInline.js`（纯函数，有单测），
    图片与链接共用一次扫描，`![x](https://…)` 不会再被拆成「图片缺失 + 一条网址」。
  - **外链图片 `![说明](https://…)` 直接显示**（不进附件库、需要联网），CLI 侧输出
    「[外链图片: 说明] 地址」而不是误报「图片缺失」——误报会让人以为附件被删了又重传一遍。
  - 图片走附件库（`~/nx-sk/files/`），同内容去重；正文里只留 id，所以这段文字导出成 md、
    贴进仓库 README 都能直接渲染（标准 markdown，不是自家方言）。
  - 读侧：`entry get` 把 `![说明](f_x)` 还原成「[图片: 说明] 本地路径」，并把内嵌图片一并放进
    返回的 `files` 表 —— 否则 CLI / agent 只能拿到一串 `f_xxx`。为此 `getEntry` 多回一个
    `fieldTypes`（键 → 类型），渲染据此决定要不要做这层还原。
  - 面板的类型下拉框改为「中文名（id）」，如「图文（可贴图）（md）」——此前只显示内部 id。
  - **`deploy` 模板同时新增 `sop` 字段**（`md` 类型，`fill: optional`）：部署资源的「操作步骤（图文）」。
    已建的 `deploy` 栏目不会自动回溯，用 `nx-sk section sync deploy` 补上（只增不改）；
    `references/50-deploy.md` 同步补了「写操作步骤」一节（含「截屏里有 token 先打码」）。

- **新栏目模板 `deploy`（部署配置）**：把 Dockerfile / docker-compose / k8s 清单存成**可复用资源**。
  一份文件一个条目 —— `content`（文件原文）+ `path`（建议落盘路径）+ `vars`（复用前要替换的变量）
  + `usage`（何时用、坑在哪）+ `kind` / `stack` / `tags` / `files`。
  只有正文、没有后三项的配置是「没有上下文的 YAML」，下次没法照着用，所以它们不是可选装饰。
  首次运行随其余 5 个模板一起播种（内置模板共 6 个）；**已有 store 不会自动回溯**，用
  `nx-sk section add deploy --template deploy` 补上。
  - 约定：`content` 里**只写 `${VAR}` 占位**，真值放「密钥」栏目（密文落盘）。
    配置文件是最容易被整份复制粘贴分享的东西（发同事 / 贴 issue / 进聊天记录），
    两者混在一起等于给凭据开了一条最宽的出口。这条写进字段 hint 和 `references/50-deploy.md`。
  - 新增 ref 文档 `50-deploy`：为什么单开一个栏目（vs 附件库 / git）、`kind` 取值约定、
    复用四步（找 → 取正文 → 替换变量 → 落盘）、什么时候不该放这里。SKILL.md 的 ref 路由表已登记。

### Fixed

- **正文预览整篇「图片缺失」，下方图库却正常**：图片 token 只带 `src`，而渲染层按 `id`
  去附件表里查记录 —— 查表键成了 `undefined`，于是每张图都判定为「不存在」。
  图库走的是 `imageRefs`（输出 `id`），所以缩略图反而全都正常，形成「下面 18 张都在、
  正文说一张都没有」的怪象。现在 token 同时带 `id` / `src`，`recordOf` 两个都认，
  并用真实浏览器验证：`imgs=18 / missing=0 / thumbs=18`，另加 token 形状的回归测试。
- **CLI / 另一个标签页导入的附件，面板里整篇显示「图片缺失」**：附件列表缓存没有失效时机，
  页面一直按进入时那份渲染。整份 SOP 的 18 张图是 CLI 导入的，因此正文全部报缺失
  （附件中心却能看到）。现在缓存加了 1.5s TTL，且图文字段 / 附件字段在挂载时**强制刷新一次**；
  图片还没拉回来时显示「正在加载图片…」，不再把「未加载」误报成「不存在」。
- **「不填」提示把已填值的可选字段也算进去**：`excluded` 是**策略标记**（`fill: optional/avoid`），
  不代表字段空着。于是「容器平台」这种把可选字段也填满的条目，会被报成「另有 7 项已标不填」，
  与事实相反。现在 CLI（`entry list` / `entry get`）与面板都只列**真的空着**的可选字段。
- **图文字段刚粘贴的图不显示预览，一直显示「图片缺失」**：附件列表带缓存，上传成功后
  `listAttachments()` 返回的仍是进入页面时那份，新 id 不在表里；而预览是按 id 查表渲染的，
  于是图明明已经进了附件中心，字段里却查不到。现在上传后先把返回的记录**就地并进列表**
  （`mergeFiles`，按 id 去重）再强制刷新服务端台账 —— 预览不再依赖列表是否刷新过。
  另外「图片缺失」的悬停提示写清了原因：指向的附件可能已在附件中心被删除，重新粘贴会得到新 id。

- **`entry get` 按行渲染多行正文**：此前 `[String(v)]` 把整段塞进第一行，只有首行带键名列宽，
  后面每一行都从第 0 列开始 —— 一段 40 行的清单打印出来像「掉出了表格」，人眼没法对。
  现在续行统一缩进到内容列（对长 YAML / Dockerfile 尤其明显）。
- **`settings.defaultSection` 不再是死配置**。此前它只是被落盘，**没有任何读取方**：
  面板初始 tab 来自 `DEFAULT_UI.view = 'job'`（写死），CLI 也不读它 ——
  于是「默认栏目」改完毫无反应，删掉 `job` 栏目还会让首屏停在一个不存在的 id 上。
  - 面板当前 tab 的解析规则抽成纯函数 `src/web/frontend/activeView.js`：
    **地址栏深链 → 本次选择 → `settings.defaultSection` → 第一个 tab**，
    并由 `tests/unit/active-view.test.mjs` 覆盖两条最容易回归的分支
    （boot 之前不许兜底，否则深链被第一个工具页顶掉；默认栏目指向已删栏目要优雅降级）。
  - 当前 tab 不再写 localStorage：它归地址栏管。两个记忆源并存时，
    落盘的那个会永远压住默认栏目，这正是「改了设置看不到效果」的来源。
  - 写入 `defaultSection` 时校验栏目真实存在（写标题也认，归一成 id），
    失败会列出可选项而不是静默存一个永远不生效的值；设置页改成下拉选择，不再手打 id。
    `setting get` 仍然列出这一项（带校验器的标量项，不是「结构化项」）。
- **`section sync` 会报告「模板漂移」**：同名字段在「栏目 vs 模板」之间哪些属性不同
  （label / type / group / hint / options / maxItems / sensitive / fill），`--dry-run` 也报。
  仍然**只增不改** —— 定义归栏目，你可能就是刻意改过的；提示里给出真正能跟进的命令
  （`--fields` 整份替换，或先 `--remove-field` 再 `--add-field`）。
  `upToDate` 仍只看「有没有可补的」，否则改过一个标签就会永远报「不是最新」。

### Changed

- **字段类型清单单一来源**：`bootstrap` 下发 `fieldTypes`，面板「新增字段」的类型下拉框据此渲染。
  此前 `modules/sections/view.jsx` 自己抄了一份 10 项清单 —— 后端加一种类型时下拉框永远看不到它。
- **文案修正**：内置模板是 **6 个**（`job` / `secret` / `projects` / `internships` / `campus` / `deploy`），
  而 `section templates` / `section add` 的摘要与 `--template` 的提示一直只写「求职 / 密钥」，
  会把人引向「只有两个模板」的误解。README 与 `assets/nx-sk/SKILL.md` 的栏目表同步补齐，
  并说明「这 6 个是首次运行播种的默认值，不是固定清单」。

## [0.10.0] - 2026-10-15

### Added

- **「栏目管理」重做成容器 + 拖拽**（设置页）。整页只有一个心智模型：一个栏目要么在「平铺」里、要么在某个分组里、要么在「隐藏」里；拖，就是把它从一个容器挪到另一个。
  - **「隐藏」不再是一个开关，就是一个容器**：与分组同构，拖进去即不进头部（`#/栏目` 直达仍可用）——「显隐」与「归组」因此是同一套操作，不用记两种交互。
  - **拖拽实时预览**：拖动过程中列表就按落点重排（被拖的行半透明停在新位置），松手直接提交这个顺序——所见即所得，不再「先松手再猜落在哪」。
  - **平铺区也能拖排序**：新增 `settings.navOrder`（栏目 id 数组）——显式排过的按它排，没排过的新栏目按栏目自身 `order` 跟在后面，所以「从没拖过」= 老行为不变。
  - 行内只留一个「移出」逃逸按钮（上一版的 上移/下移/显示中/隐藏中 全部去掉）；分组把手可拖，换分组之间顺序。
  - 设置页改为**一次保存**：标量设置与导航配置一起存，顶部只出现一次「有未保存的改动 / 保存 / 放弃改动」。

- **`settings.navHidden` / `settings.navOrder` 的后端校验**：与分组同构的「栏目 id 清单」校验（栏目必须真实存在、去重保序）；CLI 三种写法都认：`--set navOrder=["a","b"]` / `navOrder=a,b` / `navHidden=a`。`setting get` 人类模式现在能一次看全「栏目 + 隐藏状态 + 平铺顺序 + 分组」。

### Fixed

- **拖拽预览抖动**：两个自己推自己造成的——① 行内 `dragover` 冒泡到容器后会被当成「拖到空白处」翻成「追加到末尾」，指针压在被拖的行上时两种判断来回切；② 落点取自「预览后」的行号，预览一重排索引就变。现在行内就地拦下（`preventDefault` + `stopPropagation`，悬停在自己身上时保持落点不重算）、插入位取自原始配置（+ 指针在上半/下半决定前后）、值没变就不 setState。实测：停在落点边界采样 8 次顺序不变，慢速扫过整列只单调变化 4 次。
- **分组下拉鼠标下滑就消失**：pill 与菜单之间那 4px 空隙被判成「离开」——补透明桥 + 离开延迟 140ms。

## [0.9.2] - 2026-10-15

### Added

- **分组内的栏目顺序可调**：设置页的每个分组改成**有序列表**——每个成员一行（序号 + 名称 + 条目数），用「上移 / 下移」调整，**头部展开列表就按这个顺序显示**；「移除」出组，下方列出尚未归组的栏目（点一下追加到组尾）。组内出现「栏目已删除」的行会标红提示（保存前移除即可，否则保存会被后端的严格校验拦住）。

## [0.9.1] - 2026-10-15

### Fixed

- **设置页保存无效：面板发的 body 键被静默丢掉**。HTTP body 经 `applySpec` 只保留**声明过的** args/flags（有意严格，防止多余字段流进 service），而设置页发的是平铺的 `{exportDir: …}` / `{navGroups: …}` → 全被丢掉 → service 收到空 patch，只报一句“至少要给一项：setting set --key …”（根因离现场很远）。改为走声明过的 `set`（HTTP 形态 `{set: {k: v}}`，`spec.js` 本来就写着）。**面板「默认行为」卡的保存此前同样是坏的**，一并修好。
- **分组下拉鼠标下滑就消失**：pill 与菜单之间那 4px 空隙被鼠标穿过时判成“离开”，菜单刚展开就消失——补一块透明桥盖住空隙，并在离开后延迟 140ms 再关（斜着从 pill 划到菜单行也不闪）。
- 面板文案里两处 markdown 的 `**` 直接显示了出来（JSX 不渲染 markdown）——改为 `<b>` / 纯文本。

### Added

- **一致性断言：视图写请求的 body 键必须在 action 里声明过**（含反证：喂一段未声明键的合成代码，断言规则确实判红）。扫全部模块 view，把“发了未声明的键 → 静默丢掉 → 下游报一个离根因很远的错”这类问题钉死在测试里。

## [0.9.0] - 2026-10-15

### Added

- **头部导航分组：设置里自己配，栏目收拢 + 悬浮展开**。栏目越建越多时，头部一排 pill 一眼分不出主次——现在可以在**设置页**（或 CLI）把同域栏目归成一组（如 项目经历 / 实习工作经历 / 校内职务实践 / 学校信息 / 申请相关 →「求职」），头部只显示**一个分组入口**（带成员条目数汇总），**悬浮展开上下列表**选具体栏目（点击行切换、当前栏目加粗；外点 / Esc 关闭；触屏点 pill 也能开）。
  - 配置存在 `settings.navGroups`（`{title, sections[]}` 数组，**数组顺序 = 头部显示顺序**）；缺省空数组 = 全部栏目平铺（老 store 读一次自动补默认，无需迁移）。
  - 校验严格且明确：形状不对 / 栏目不存在 / 一个栏目进两个组 / 缺组名 / 空组 —— 都报 `INVALID_INPUT` 并说清是哪一组哪一项（栏目写**标题**也认，统一归一到 id）。
  - 分组只是**显示配置**：不动栏目与条目数据；组内栏目被删掉时头部优雅略过（配置保留）。CLI：`nx-sk setting set --set 'navGroups=[…]'`，清空即恢复平铺。
  - 未分组的栏目与系统工具（附件 / 导出与备份 / 设置）照旧平铺，顺序不变。

## [0.8.2] - 2026-10-15

### Fixed

- **`file update --name` 改名不带扩展名时，物理文件丢扩展名**：磁盘上只剩 `身份证人像面-赵刘学`（无 `.jpg`），而台账 `ext` 字段还记着 `.jpg`——内联预览、系统默认程序打开、`backup --with-files` 还原出来的文件全部哑掉。现在 `relocateFile` 会在新名字没有扩展名时**自动接回原扩展名**；名字自带扩展名则原样保留（不重复追加）。
- **历史连写的附件值解析不出来**：0.8.0 之前 `--set 头像图片=f_a,f_b` 会把两个 id **连成一个字符串**存进 values，`fileIdsOf` 此前不拆串内分隔符 → 面板显示「未解析」。现在 `fileIdsOf` / 前端 `toIds` 对字符串统一按 `,，、;；` 拆开——单值、数组、连写串三种历史形态都能归一（附件名里带逗号的极端情况请改用 id 关联）。

## [0.8.1] - 2026-10-15

### Added

- **条目里的附件字段框支持拖拽上传**：把文件（可多个）直接拖进 `file` 字段框即上传并追加到列表，悬停时虚线描边提示（与「附件」中心同一套视觉语言）；超过 `maxItems` 上限时拖入会明确提示。之前只有「附件」中心页支持拖拽。

## [0.8.0] - 2026-10-13

### Added

- **`file` 字段支持多附件：值 = 附件 id 的列表**。一个字段可以挂**多个**附件（简历多版本、头像多张、证书多份）——CLI 逗号分隔（`--set 简历附件=f_aaa,f_bbb`）或 `--data` 传 JSON 数组；面板字段控件改成**列表**：一次**多选**上传、从附件库逐个追加、逐行移除（下载 / 复制路径照旧）。
  - **新写入统一存数组**（哪怕只有一个）——`entry get --json` 与导出里 `file` 字段的值形状一致；**历史单值字符串原样兼容**（读、反查、搜索、面板编辑都按「单元素列表」处理），不做数据迁移，下次在面板编辑保存后统一成数组。
  - 反查 / 搜索 / 渲染全部按列表走：列表里的**任一**附件都能被 `file get` 反查到「被引用」；按**任一**附件名都能搜到条目；`entry get` 里多个附件各占一行（附件名 + 物理路径）。
  - 数量上限复用 `maxItems`（与 `tags` 同一套属性与报错口径，默认不限）；未登记的键写入 `f_` 形态的值会自动登记成**附件字段**（而不是文本 / tags）。

## [0.7.1] - 2026-10-13

### Changed

- **`textarea` 字段自适应高度，所见即所得**。`type: 'textarea'` 字段（自我介绍、个人优势、备注等）从固定 `rows={3}` 改为按内容撑开——填多少显示多少，不再需要滚轮。初始留 2 行下限避免空字段塌成 0；关掉浏览器默认拖拽手柄与滚动条以免和自适应打架；用 `useLayoutEffect` 避免「旧高度 + 新内容」闪一帧，删字时也能正确回缩。

## [0.7.0] - 2026-10-13

### Added

- **导入缺省「合并」：只增不减，不再整份替换**。`backup import` 旧行为是整份替换——跨源导入一个老结构的备份，本机栏目结构、条目、附件台账全被覆盖成备份的样子（原始事故：求职栏目的「附件资料」组消失）。现在缺省按「只增不减」合并：补缺失的栏目/条目/附件台账、补空字段、把备份多出的分组与字段只增补进已有栏目（复用 `mergeTemplate`）；**两边都有值且不同 → 保留本地**、列入冲突清单交用户处理；本地已有数据与结构**永不删改**。KV 栏目按名称匹配（跨机器 id 不可靠），普通栏目按 id。导入完成输出完整报告（CLI 文本 / 面板弹窗）：新增、补空、冲突、结构差异、附件统计、快照路径；`--dry-run` 可先看计划不落盘。`--replace` 保留旧的整份替换语义。敏感字段的补空值自动用本机 vaultKey 重新加密；报告里的值一律打码，密钥明文不进报告。
- **`backup export --with-files`：附件原件入包（压缩包式）**。附件台账随包携带升级为**恒定行为**（v3 格式——0.5.x–0.6.2 的包根本不含 `files`，任何一次导入都会把台账清零，本次一并根修并加了回归钉）；`--with-files` 再把台账指向的原件读成 `{rel → {b64, sha256}}` 单块加密嵌入 `filesData`（与主数据同一把口令派生 key）。导入时自动落盘还原（sha256 校验；磁盘已有且内容不同以磁盘为准）；v2 旧包继续可导，缺原件在报告里如实列出。

### Changed

- 面板「加密备份」：导出加「连附件原件一起打包」勾选；导入拆成「解密并导入（合并）」与「整份替换…」（danger 确认）两个动作；结果以报告弹窗呈现；超过 28MB 的包提示走 CLI（接口请求体上限 32MB）。

## [0.6.2] - 2026-10-12

### Fixed

- **加密备份：跨机器恢复后 store.json 里 secret 字段仍是密文**。0.6.1 把 secret 字段解开成明文后直接落回 store.json——丢了本机「落盘密文」防护。回归到 0.5.1 的设计：导出时用本机 vaultKey **解开** secret 字段、整包口令加密入 `.nxskbak`；导入时解开整包后**用本机 vaultKey 重新加密** secret 字段再写回 store.json。两条安全边界各自独立：本地靠 vaultKey、传递靠口令。

## [0.6.1] - 2026-10-12

### Changed

- **加密备份跨机器恢复：密钥栏目与其他栏目走同一路径**。`backup export --password` 导出时，先把 secret 栏目的密文字段用本机 vaultKey **解开为明文**，再随整份 payload 一起用口令派生密钥（AES-256-GCM）加密入 `.nxskbak`；导入时直接拿明文落回 store.json，B 机不需要 A 机的 `~/.vaultkey` 即可 `key get` 出原文。理由：密钥条目就是一段文本，"跨机器恢复要看"才是它的实际场景，再绕一层「reWrapped 兑回本机 vaultKey」是多余的间接层。落回 store.json 后，下次写入会由 B 机 vaultKey 重新加密（落盘仍是密文），所以单机"store.json 泄露不等于密钥泄露"这条不变量没退化。

## [0.6.0] - 2026-10-12

### Added

- **agent 手册补齐附件域**：随包分发的 `assets/nx-sk/` 新增 `references/40-files.md`（附件库：导入默认移动、`file` 字段值 = 附件 id 的链接、可逆还原、附件中心为什么由栏目驱动、看不到上传字段怎么办），并在 `SKILL.md` 与 `README.md` 的 ref 路由表登记；同步修订 `10-sections-entries`（求职模板 79 字段 / 10 分组、字段类型表补 `file`、栏目命令补 `sync`）与 `00-design`（core 清单补 `attachments`、错误案例补附件组织方式的取舍）。

### Changed

- **顶栏层级重排**：品牌升为标题（15px / 700），副标题与版本号降为从属元信息并整体右移，超长存储路径自动省略（完整值在 `title`）；身份栏与导航栏拉开 padding 差异，并在「内容栏目」与「系统工具」之间加一条分组细线；计数降为等宽小字。

### Fixed

- **默认视图被顶成「栏目」**：`/api/bootstrap` 返回前用静态视图兜底并写回 ui 状态，导致默认视图与头部高亮错位（首屏还会覆盖 `#/job` 这类深链）；改用 `booted` 门控——未拿到 bootstrap 就显示「正在装载…」，不兜底、不写入。顺带清理已无定义的 `header.top .meta` 样式，残留处改用已有的 `.muted`。
- **CI 跨平台单测**：附件单测里 `join('\\')` 拼路径只在 Windows 成立，ubuntu 上 ENOENT——0.5.0 / 0.5.1 因此都没发出去；改为跨平台 `join(...rel.split('/'))`。

## [0.5.1] - 2026-10-12

### Fixed

- **加密备份跨机器恢复后密钥栏目无法解开**（原始事故：用户将 A 机 `backup export --password` 出的 `.nxskbak` 文件拷贝到 B 机再 `backup import` 后，B 机 `key get` 报「密钥或密文与写入时不一致」）。原因：原备份包只对整包加密，**包内密文字段仍用 A 机的 `~/.vaultkey` / `NX_SK_PASSPHRASE` 派生 kid**——B 机的本地密钥与其不一致，GCM 校验失败。修法：导出时给每条密文追加一个口令派生的 `reWrapped` 副本；导入时解开 `reWrapped` 拿明文、用 B 机本机 vaultKey 重新加密后写回主字段、`reWrapped` 丢弃——B 机后续 `key get` 走的就是 B 机的本机密钥。备份包不再依赖导出机的本地密钥状态；同时给 smoke 加了「换 vaultkey 后口令导入仍能解出明文」的端到端断言。

## [0.5.0] - 2026-10-12

### Added

- **统一附件管理（本地文件存储 + 可逆移动）**：新增「附件」模块（CLI `file list|get|add|update|remove|content|restore|open`，Web「附件」工作台，HTTP `/api/files` 一组路由）。
  - 所有附件原件统一落在 `~/nx-sk/files/`，元数据随 `store.json` 落台账；按 sha256 自动去重——同一份原件只存一次，可被多条条目共享。
  - 本机路径导入**默认移动**（提交附件 = 把原件搬进 nx-sk 目录），`--copy` 才保留原件；Web 拖拽 / 选择上传为复制语义（浏览器无法删除任意路径文件）。
  - **可逆**：`file restore` 把附件移回原始位置（或 `--to` 指定目录）并撤销台账；`--copy` 只导出副本、库中保留。
  - 每个附件给出物理路径与浏览器链接（`/api/files/:id/content`，支持内联预览与 `?download=1` 下载，正确的 Content-Type 与 UTF-8 文件名）。
  - 新增 `file` 字段类型，**值 = 附件 id**：id 全局唯一 → 各条目的附件空间天然隔离；去重后同一原件又可被多条条目引用。求职模板新增「附件资料」组：**简历附件 / 头像图片 / 成绩单 / 证书扫描件（不必填）**。
  - **上传 / 选择发生在栏目条目里**：条目表单的 file 字段可直接「上传文件」或从附件库选一个，保存即建立链接；字段里显示附件名 / 缩略图 / 物理路径 / 下载 / 清除。
  - **「附件」中心由栏目驱动、不预定义**：不做指派，也没有预设分类或槽位；筛选片按「哪些栏目在引用附件」动态生成（外加「未引用」），每张卡片显示被哪个栏目 / 条目 / 字段引用（`fileReferences` 反查）。CLI 侧为 `file list --section <栏目|none>`。
  - 修复 `file update` 的结果被误报成「已还原」的渲染 bug（还原与更新的 payload 都带 `path`，现改用独立的 `restored` 标记区分）。
  - HTTP 请求体上限由 4MB 提升至 32MB（base64 上传扫描件 / 照片）。

- **`section sync`：按模板补齐栏目字段（只增不改不删）**：栏目字段字典是**持久化数据**（实例化时深拷贝，此后独立演化），模板新增的字段**不会回溯**到已建栏目——于是「模板给求职加了 `file` 的附件字段，老栏目里却看不到上传入口」。新增 `section sync <ref>`（CLI）/ `POST /api/sections/:ref/sync`（HTTP）/ 栏目编辑弹窗的「同步模板字段」按钮，把模板里新增、本栏目还缺的分组与字段补进来，并保持模板顺序；已有字段（含用户改过的 label / hint / fill）与自定义分组原样保留。带快照与 `--dry-run`。顺带修复 `section update --add-field` 引用未声明分组时不补声明、导致面板整组字段消失的隐患。

## [0.4.0] - 2026-10-08

### Added

- **口令对称加密的整库备份 / 恢复（导入导出）**：新增「加密备份」模块（CLI `backup export|import`，Web 同名面板，HTTP `POST /api/backup` 与 `POST /api/backup/restore`）。
  - 导出：设置口令 → 整份数据（栏目 / 条目 / 设置）经 **scrypt 口令派生密钥 + AES-256-GCM** 加密为单个 `.nxskbak` 文件并在浏览器下载；文件内含随机盐，**口令不落盘**。
  - 导入：选择备份文件并输入口令 → 解密校验后整份恢复；**恢复前自动给当前数据留安全快照**（可回滚）。
  - 口令错误或文件被篡改：GCM 认证失败、明确报 BLOCKED，且不改动当前数据；两个动作均支持 `--dry-run`（只演练 / 只解密校验）。
  - 口令也可用环境变量 `NX_SK_BACKUP_PASSWORD` 提供；复用 `core/crypto.js` 原语，与字段级密钥库（`core/vault.js`）相互独立。

## [0.3.4] - 2026-09-26

### Added

- **多行值的可靠通道**：`key set <名> -`（stdin）与 `key set <名> --data @文件.json`
  （也接受 `-` 与 JSON 字面量）。对象含 `value` 键时取它，只含一个键时取那个键，
  多键且无 `value` 直接报错而不是猜。

### Fixed

- **Git Bash 下多行参数不再被静默截断**（原始事故）：转发器里 `exec node` 走的是
  PATH 上的 node，而它可能是 Volta 之类的中转 shim，那一跳会把 `$'l1\nl2\nl3'`
  截成 `l1` 且**不报错**——一次性凭据就这么丢掉大半。改为直连本进程的
  `process.execPath`，并带路径失效回退（node 升级换目录时退回 PATH，重跑
  `link:local` 即恢复）。
- **恢复被删的 `references/40-extend.md`**：它与 SKILL.md 路由表里的条目被**同时**
  删掉，于是「路由表 ↔ 目录双向对账」两边一起变空、照样通过——这个 ref 就这样被
  删了两次。新增断言钉住「ref 体系整体不被削掉」（必存 ref 下限 + 编号升序唯一），
  已做反向验证（删文件时确实变红）。

### Notes

- **`.cmd` 那条路修不了**：实测直连真实 `node.exe` 与走 shim 结果**完全相同**
  （多行都截断、尖括号都失败），瓶颈是 cmd.exe 解析 `.cmd` 内容时的 `%*` 展开。
  cmd / PowerShell 下多行值必须走 `-` 或 `@文件`。
- 原计划要在 CLI 里做「检测到含换行就拒绝」，实测后**放弃**：损坏后 CR 是被删掉而非
  保留（`$'a\rb'` 实际落盘 `"ab"`），零真阳性；而 `@文件` 读入的合法 CRLF 多行值含
  CR，会被自己的检测拦住（高假阳性）。LF 截断后与合法单行值不可区分——可靠信号不存在。

## [0.3.3] - 2026-09-26

### Fixed

- **自定义栏目在 Web 面板整页空白**：栏目的分组元数据有两条读取路径——CLI 从字段
  **推导**（`groupFields(fields)`），面板按**声明数组**（`section.groups`）渲染。
  用 `section add --fields '{…"group":"basic"…}'` 建栏目而没同时给 `--groups` 时，
  `groups` 是空数组：CLI 显示正常、面板的字段表单整组消失，而页面本身不报错，
  看起来就像「这个栏目不存在」。
- 修复：新增 `syncSectionGroups()` 把「分组声明 ⊇ 字段引用」钉成**栏目不变量**，
  规则只写一份，在 `normalizeSection`（store 读写的唯一收口）与 `section add` 的
  草稿两处调用——**存量数据读一次即自愈**，此后 `--add-field` / 面板加字段引用到
  未声明的分组也会自动补齐声明。

### Changed

- CHANGELOG 中 0.3.1 那条安全说明不再复述被清除的原文（说明「清理了 PII」的句子
  本身不该再带上那份 PII）。

## [0.3.2] - 2026-09-25

### Fixed

- **密钥页 CRUD 全挂**：`guard` 返回的包装函数不透传参数，所有 `guard(async (row) => …)`
  形式的行级操作拿到 `undefined`，读 `row.name` 抛
  "Cannot read properties of undefined (reading 'name')"。改值/改名/删除、
  栏目页 8 个操作、导出 dry-run 全部中招；blur 触发的改名让「点一下别处就报错」。
- `kvTable.rename`：改名成功后 `draft` 的键同步迁移到新名（原先留在旧键下，
  值输入框显示为空、blur 会把值写回旧键名）。

## [0.3.1] - 2026-09-25

### Security

- **清除文档与帮助文本中的真实个人信息**：真实姓名与邮箱拼音样例统一替换为占位符
  （姓名→`张三`、邮箱前缀→`zhangsan`），涉及 skill 文档示例（`assets/nx-sk/references/`）、
  CLI 帮助文本（`help entry`）、面板 toast 提示与单测夹具；提交作者身份统一为
  `nx-sk <nx-sk@local>`。已用 `git filter-repo` 重写全部历史并 force-push。
- 0.3.0 因包含上述信息已在 npm 标记 deprecated（unpublish 被 granular token
  2FA 政策拦截，需官网手动删除）。

## [0.3.0] - 2026-09-25

### Added

- **字段填写策略 `fill`：`normal` / `optional` / `avoid`** —— 有些格子填了反而减分
  （应届生的「上一家公司」、政治面貌为「群众」时的「入党时间」），这次把这种判断做成**数据**。
  - `optional`（不必填）与 `avoid`（不填）**既不计入完整度的分子、也不计入分母**。
    完整度这个数字是用来导航「还该补什么」的，被一批主动跳过的字段长期压着就失效了。
  - 它们不会被藏起来：`serializeEntry` 新增顶层 `excluded[]`，与 `missing[]` **并列**
    （「主动跳过」和「还没填」是两件事）；`completeness` 新增 `excluded`（个数）与
    `excludedFilled`（标了不填却仍然填了的个数，非 0 就说明策略该更新了）。
    CLI 的 `entry get` / `entry list` 把两者分开报，面板在字段标签上打中性标签。
  - 新增 `section update --fill <字段>=normal|optional|avoid`（可重复，label 或 key 都认；
    改回照常填传 `normal`）。`entry fields` / `section dump` 的字段字典输出带上
    `fill` 与 `fillLabel`。
  - `validateFieldDef` 放行 `fill` —— 该函数是**白名单**，漏了会静默丢弃新属性，
    后果是「用户设了不填、完整度照旧算它」，很难查。非法策略报错而非忽略；`normal` 是缺省、不落盘。
  - **非破坏性**：没有任何字段带 `fill` 时，行为与之前完全一致，旧 store 无需迁移。

### Fixed

- **「面板无 emoji / 不使用原生弹窗」这条守卫覆盖不全**：它只 `readdir` 了
  `src/web/frontend/` 的**直接子文件**，于是 `frontend/components/`（`fieldEditor.jsx`、`ui.jsx`）、
  `App.jsx`、`main.jsx`、`api/` 全都没被扫到 —— 等于**面板规则不覆盖面板**；
  `src/core/`、`bin/`、`scripts/` 同样漏了。改为递归收集并补齐这几处，
  顺手清掉 `core/render.js`、`core/store.js` 里两处漏网的 emoji。
  已按项目「改完规则必须反向测试」的要求验证：往原先扫不到的 `components/fieldEditor.jsx`
  注入 emoji，测试如期变红，还原后恢复全绿。

## [0.2.0] - 2026-09-24

### Changed

- **【破坏性】密文字段默认原文显示**，打码改成显式选项：
  `--reveal` 全部换成 `--mask`（`key get/list`、`entry get`、`section dump`、`GET /api/keys?mask=1`）；
  导出默认也含明文（`settings.includeSecretsInExport` 默认 `true`，要打码加 `--no-secrets`）。
  理由：本机单人工具，数据是给自己看的，默认打码等于每次先拦自己一道。
  **落盘仍然是 AES-256-GCM 密文**——「store.json 泄露」不等于「凭据泄露」这一点没变。
  面板里的勾选框从「显示密文字段明文」翻成「打码显示（投屏/截图时用）」，默认不勾。
- **【破坏性】skill 不再出现在 Web 面板**：删掉 Skill tab 与它的视图；`skill install` / `skill get`
  仍完整保留在 CLI（用户明确要求，偏离了骨架 ref「三条最高优先级命令要有 Web 入口」的建议）。
- **【破坏性】密钥栏目从 8 字段缩成极简 KV**：只保留「名称（条目名）→ 值」。
  删掉了服务商 / 接口地址 / 模型 / 用途 / 有效期 / 额度 / 备注 ——
  存一个 key 不该先填一张表；「这个 key 干什么用」写进键名里就够了。
  - **自动迁移**：`store.json` 版本升到 `2`。首次读盘时把旧 `keyValue` 的值搬到 `value`，
    并**先留一份迁移前的原始文件快照**到 `~/nx-sk/backup/…-migrate-v1-to-v2.json`；
    其余旧值**不删除**（不再显示 ≠ 删掉），`bootstrap --json` 的 `migration` 字段会报告迁移结果。
  - 迁移幂等：`version` 落盘后不再触发。

### Added

- **README 补「安装」节**：`npm link` 做成全局垫片（全局 node_modules 是指向项目的软链，
  改代码即刻生效）、skill 的**软链垫片**做法、以及 `npm unlink -g nx-sk` 的回退方式。
- **skill 在本机改成软链**：`~/.claude/skills/nx-sk` 与 `~/.workbuddy/skills/nx-sk`
  现在都软链到项目 `assets/nx-sk`（与 `server-cli-web-scaffold` 同一种做法）。
  `skill install` 装的是**副本**，只在分发/跨机器时用；日常用软链才不会让 agent 拿到旧版手册。
- **【破坏性】KV 栏目在面板里就是一张表**：`secret` 标了 `kv: true`，面板渲染成
  「名称 / 值」两列表格（改值即改、加行即加键、行内重命名、一键复制），
  **不再有**条目列表、字段表单、完整度百分比 —— 那些只对「一族同构条目」的栏目（求职）有意义。
  CLI 侧 `key *` 缺省作用在标了 `kv` 的栏目上，并新增 `--section`；
  `settings.kvSection` 这个间接层**删掉**（哪个栏目是 KV，由栏目自己说了算）。
- **KV 栏目拒绝加字段**：往里塞字段会让「值在哪一列」变得不确定，所以直接报错并指出
  该用 `key set`。这条是真实事故换来的：早先面板那行「KV 直填」把 `3123312=xxx`
  登记成了字段，用户看到的是一堆无意义的「模板建议」。
  配套 v2 → v3 迁移：把误当字段用的值搬进值列，字段收成一个，旧键一律不删，迁移前留原始快照。
- **`entry update` 改名时挡住重名**（同栏目已有同名条目报 `CONFLICT`）——
  重名会让「按名字取」变成二义。
- **字段台账不再拦写入**：`--set 任意键=值` 一律能存，没见过的键自动登记
  （键名就是字段名，**中文也可以**；类型按值推断：`是/否` → bool、数组 → tags、其余 → text）。
  `--allow-new-field` 随之取消（它现在是默认行为）。
  **刻意不推 number**：18 位身份证号这类长数字超过 2^53，推成数字会静默丢精度。
- **面板加「KV 直填」行**：敲 `字段=值` 回车即写入，不再必须先在分组表单里找到那一格；
  「未填 N 项」也从告警口吻改成中性的「模板建议里还有 N 项没填（不影响使用）」。
- `assertFieldKey` 放宽到允许中文（仍挡空白 / 路径分隔符 / `..`），
  这样 `--set 微信号=xxx` 存下去就是 `微信号`，不必再记一个英文别名。
- **`key` 系列命令（KV 直通）**：`key set <名称> <值>` / `key get <名称> [--reveal]` /
  `key list [--reveal]` / `key remove <名称>`，对应接口
  `PUT /api/keys/:name` / `GET /api/keys/:name` / `GET /api/keys` / `DELETE /api/keys/:name`。
  - `key *` 是 `entry *` 的**语法糖**，与 `entry` 同模块、共用同一批 service 函数
    （加解密 / 打码 / 快照 / `--dry-run` 只有一份实现），有一致性测试钉住「不许另起一套」。
  - `key set` 是 **SET 语义**（同名覆盖，返回值带 `created`）。这是它与 `entry add`
    （同名报 `CONFLICT`）唯一刻意的差别。
  - 重复写同一个值 → `{ status: 'skipped', unchanged: true }`，不重写密文、不留快照。
  - 作用栏目由新设置项 `settings.kvSection` 决定（默认 `secret`）。
- CLI 位置参数与 flag 的优先级明确为**显式 flag 覆盖位置参数**，
  于是 `key set K <值>` 与 `key set K --value=<值>` 等价 ——
  后者是值以 `-` 开头时唯一可用的写法。

### Fixed

- `cli.js` 的 `parseArgs` 原本让位置参数覆盖同名的显式 flag，导致 `--value=` 被静默忽略。
- `key set` 的「值没变」判定原本只比明文，面板原样回传打码值时会被误判成覆盖
  （多写一次密文 + 多留一份快照）。现在明文相同与掩码相同都算「未改动」。

## [0.1.0] - 2026-09-24

首个版本：本机个人资源管理器（server-cli-web 骨架的完整实现）。

### Added

- **栏目化数据模型**：栏目 = 一组同构条目 + 一份字段字典（字典是数据，不是代码分支）。
  内置两个模板：`job`（求职 / 个人信息，9 分组 75 字段）、`secret`（密钥，8 字段）。
- **CLI**（26 条命令）：`serve` / `help` / `version` 三个平台命令，
  以及 `bootstrap` / `health` / `routes` / `section.*` / `entry.*` / `export.*` / `setting.*` / `skill.*`。
- **HTTP API**：由 action 声明同源编译，路由按「字面量段优先」排序（`/api/sections/templates`
  不会被 `/api/sections/:ref` 遮蔽）。写操作校验 `Origin`。
- **Web 面板**：栏目动态 tab、按分组渲染的字段表单、PATCH 语义保存（只发改动过的字段）、
  密文字段一键揭示、完整度与未填清单、派生式 CLI 提示、页内 toast / dialog / 错误边界。
- **密文存储**：敏感字段 AES-256-GCM 落盘，密钥来源支持 `NX_SK_PASSPHRASE`（scrypt + 盐）
  或本机 `~/.vaultkey`；密文带密钥指纹 `kid`，换来源时给明确的 `BLOCKED` 而不是乱码。
  打码值原样回传会被识别为「不修改」，直接写入打码占位会被拒绝。
- **整体导出**：JSON + Markdown，支持按栏目、指定目录、`--dry-run`；凭据默认打码，
  `--with-secrets` 才出明文并在导出文件里标记 `withSecrets`。
- **快照与回滚**：每次破坏性写入前整库快照到 `~/nx-sk/backup/`（最多 20 份）。
- **损坏保护**：`store.json` 解析失败先改名为 `.corrupt-<时间戳>.json`，不静默覆盖。
- **内置 skill**：`skill install` 装到 `~/.claude/skills`（三态，不静默覆盖），
  `skill get` 输出「prefix → 文档 → install 状态」三段，`--json` 为四元契约。
- **测试**：40 项单测（含一致性断言：模块目录 ↔ 注册表 ↔ 前端视图表 ↔ 视图里的 `/api` 字面量、
  CRUD 五操作与路由形状、CLI 路径可解析回自身、eslint 互依禁列覆盖、文档漂移防护、
  装载期自检的负向反证）+ 56 项端到端冒烟断言。

### Notes

- 数据默认落在 `~/nx-sk/`（骨架 ref 的默认是 `~/.<主题名>/`，本实现按项目要求改成可见目录）。
- 存储路径支持 `NX_SK_HOME` / `NX_SK_STORE` 覆盖 —— **不是可选项**：没有它测试会写脏真实数据。
- eslint 的模块互依禁列是**逐模块枚举**的：新增模块必须补一行，漏补是静默的
  （已由 `tests/unit/consistency.test.mjs` 兜住）。
