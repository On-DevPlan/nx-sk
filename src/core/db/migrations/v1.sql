-- schema v1：nx-sk 存储从 store.json 换成 SQLite 的初始 schema。
--
-- 设计口径（2026-11-11，参考 nx-kv core/db v1/v2）：
--   · meta 表存 schema_version（runner 的版本判据）与 rev（乐观并发计数）；
--   · 时间戳列用 **TEXT ISO**（`new Date().toISOString()` 形状）：与 store.json 时代的
--     nowIso 完全一致，往返保真不用换算；可空列（created_at/updated_at/deleted_at）
--     保持「没有就是 NULL」，与 JSON 里的 null 一一对应；
--   · JSON 列一律 CHECK (json_valid(...))：脏 JSON 在建库/写入时就被挡下，
--     而不是读出来才炸面板；
--   · 行→对象映射的**保真源**是 JSON 列（fields.spec / attachments.meta）：
--     标量列是查询与约束的镜像。这样「原始 JSON 里有没有某个键」这种键存在性
--     差异不会在 db→json 往返中丢失（深比较断言依赖这一点）。
--   · 运行时不做旧结构兼容：store.json 只在首启被导入一次（过 normalize 升到当前形状），
--     之后它被改名留证，这个库就是唯一真相。

-- ── meta：库级状态（版本、并发计数、来源标记）──────────────────────────
-- store_kind 是「这是我们建的库」的判据：有表但没这个键 = 别人的 SQLite 文件
-- 被改名成 nxsk.db，bootstrap 直接拒绝，绝不自动建表。
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ── settings：store.settings 的按键拆分（value 一律 JSON 文本）──────────
-- 硬规则（照抄 nx-kv G2）：凡需要出现在 WHERE 里的东西不许进这里——
-- 它只做「按键取值」；settings 里出现过的键 = store.settings 的顶层键，
-- 未知键原样保留（normalize 只收口已知键，不发明新键）。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

-- ui_state：预留的「面板选择」k/v（形状与 settings 相同）。
-- 现状：面板的 view/entry/q/mask 存在浏览器 localStorage，**不在** store.json 里
-- （见 shared/model.ts 的 UiState 注释），所以这里只建表、不接线——
-- 哪天要把选择收进后端存储，直接写这张表，不用再动 schema。
CREATE TABLE IF NOT EXISTS ui_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

-- ── sections：栏目（字段字典 + 版式的头部）────────────────────────────
-- "order" 要加引号：ORDER 是 SQL 关键字。
-- layout 是块布局 JSON（显示关系），读路径一律过 sanitizeLayout，落库前已收口。
CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "order"     INTEGER NOT NULL DEFAULT 50,
  template    TEXT,                -- NULL = 不是模板建的（或模板已被删）
  kv          INTEGER NOT NULL DEFAULT 0 CHECK (kv IN (0, 1)),
  title_field TEXT,                -- NULL = 没有标题字段
  title_label TEXT NOT NULL DEFAULT '名称',
  layout      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(layout)),
  created_at  TEXT,
  updated_at  TEXT
);

-- ── groups：栏目分组声明（头部导航的一个分组）──────────────────────────
-- declared：1 = 用户/模板声明的分组；0 = syncSectionGroups 自愈出的「字段引用了
-- 但没声明」的分组（servers 白屏事故的收口产物）。导入时按原始 JSON 的 groups
-- 数组判，之后原地保留（见 db/repo.ts 的 writeStore）。
CREATE TABLE IF NOT EXISTS groups (
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  declared   INTEGER NOT NULL DEFAULT 1 CHECK (declared IN (0, 1)),
  PRIMARY KEY (section_id, id)
);

-- ── fields：字段字典（栏目内全局顺序 = 原数组顺序显式化成 sort）────────
-- type 是**封闭枚举**，与 shared/fields/types.ts 的 FIELD_TYPES 同一份清单
-- （由 db 单测钉住，两边漂移当场红）。
-- spec 是保真源：整个 FieldDef 的 JSON（含类型特有键 options/columns/fields/
-- formula/unit/maxRows…）；label/type/group/fill/hint/sensitive 同时是列——
-- 列供查询与 CHECK，spec 供无损往返。写入点只有 repo.ts 一处，不会分叉。
CREATE TABLE IF NOT EXISTS fields (
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL CHECK (type IN
               ('text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags',
                'entrylist', 'table', 'source', 'secret', 'file', 'md', 'shortcut')),
  -- 分组引用（NULL = 未分组）。**不建外键**，理由是实测出来的：
  -- SQLite 不支持 `ON DELETE SET NULL (列清单)` 只置空复合外键的某列（3.53 报语法错），
  -- CASCADE 会「删分组连字段一起删」（语义错），RESTRICT 会挡住 sections 整表级联重写。
  -- 「分组声明 ⊇ 字段引用」本来就是栏目不变量，由读边界 syncSectionGroups 唯一收口
  -- （store.json 时代同一条纪律），孤儿引用读一次即自愈成 declared=0 分组。
  group_id   TEXT,
  fill       TEXT NOT NULL DEFAULT 'normal' CHECK (fill IN ('normal', 'optional', 'avoid')),
  hint       TEXT NOT NULL DEFAULT '',
  sensitive  INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  spec       TEXT NOT NULL CHECK (json_valid(spec)),
  PRIMARY KEY (section_id, key)
);
CREATE INDEX IF NOT EXISTS ix_fields_section ON fields (section_id, sort);
CREATE INDEX IF NOT EXISTS ix_fields_group ON fields (section_id, group_id);

-- ── entries：条目（值文档存 "values" JSON，与 store.json 时代逐键一致）──
-- "values" 必须加引号：VALUES 是 SQL 关键字，裸用作列名 SQLite 直接拒（实测）。
CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  "values"   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("values") AND json_type("values") = 'object'),
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_entries_section ON entries (section_id);

-- ── attachments：统一资源表（对齐 nx-kv v2 的设计）─────────────────────
-- 身份规则收敛在 core/db/identity.ts（唯一实现）：
--   file  → id = FileRecord.id 原样（`f_...`）：values 里嵌的附件 id 一字不改；
--   url   → id = att_url_<sha1(小写 url)[0:16]>
--   section → id = att_section_<sha1(id)[0:16]>
--   entry → id = att_entry_<sha1(id)[0:16]>
--   field → id = att_field_<sha1(section + ':' + key)[0:16]>（target_key 用复合串，无 target_seq）
-- kind=file/url 用 local_path/url/mime/size/hash/storage 列；
-- kind=section/entry/field 是「指向内部资源」的指针行，用 target_kind/target_key 定位。
-- **保真源是 meta**（整条 FileRecord 的 JSON）；标量列是查询镜像：
-- local_path = rel（相对 filesDir 的 posix 路径）、size = bytes、hash = sha256、
-- mime = 按 ext 推导的 MIME（派生值，别当真相）、storage 恒 'local'（本机附件仓）。
-- dedupe_key：file 用 sha256（同内容不重复登记的库级护栏）、url 用小写 url；
-- 内部指针留空（id 已是确定性派生，天然唯一）。
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('file', 'url', 'section', 'entry', 'field')),
  name        TEXT NOT NULL DEFAULT '',
  local_path  TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  hash        TEXT NOT NULL DEFAULT '',
  storage     TEXT NOT NULL DEFAULT '' CHECK (storage IN ('', 'local')),
  -- 内部资源的定位信息（kind=section/entry/field 时有值；file/url 为空）。
  -- field 的 target_key 是 "<section>:<key>" 复合串。
  target_kind TEXT NOT NULL DEFAULT '' CHECK (target_kind IN ('', 'section', 'entry', 'field')),
  target_key  TEXT NOT NULL DEFAULT '',
  dedupe_key  TEXT NOT NULL DEFAULT '',
  meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  -- 软删：删条目/栏目时指向它的内部指针**不物理删**（UPDATE deleted_at），
  -- 与 corrupt/import 留证同一条纪律——有据可查比干净的外表重要。
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- 同一逻辑资源只保留一行（软删后允许重新登记，所以 WHERE 里排除 deleted）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_attachments_dedupe
  ON attachments (dedupe_key)
  WHERE dedupe_key <> '' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_attachments_kind ON attachments (kind, deleted_at);
CREATE INDEX IF NOT EXISTS ix_attachments_target ON attachments (target_kind, target_key);

-- ── 边表：role 是**边的语义**，不是资源的属性（照抄 nx-kv 的注释纪律）──
--   inline = 从条目 values 里重算出来的引用（saveStore 每次全量重算，见 repo.ts）
--   attach = 显式挂载（未来的 CLI/面板命令）
--   source = 原始资料袋语义的挂载
-- 同一个附件被同一条目的两个字段各引用一次是两行（PK 含 field_key）。
CREATE TABLE IF NOT EXISTS entry_attach (
  entry_id       TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  field_key      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'inline' CHECK (role IN ('inline', 'attach', 'source')),
  position       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (entry_id, attachment_id, field_key)
);
CREATE INDEX IF NOT EXISTS ix_entry_attach_att ON entry_attach (attachment_id);

CREATE TABLE IF NOT EXISTS section_attach (
  section_id     TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'attach' CHECK (role IN ('inline', 'attach', 'source')),
  position       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (section_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS ix_section_attach_att ON section_attach (attachment_id);

CREATE TABLE IF NOT EXISTS field_attach (
  section_id     TEXT NOT NULL,
  field_key      TEXT NOT NULL,
  attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'attach' CHECK (role IN ('inline', 'attach', 'source')),
  position       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (section_id, field_key, attachment_id),
  FOREIGN KEY (section_id, field_key) REFERENCES fields(section_id, key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_field_attach_att ON field_attach (attachment_id);
