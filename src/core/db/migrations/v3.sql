-- schema v3：动态结构——条目字段写时复制（copy-on-write）。
--
-- 用户裁决（2026-11-11）：
--   · 栏目字段字典降级成**模板**：只参与条目初始化与 sync，不再直接驱动存量条目——
--     每个条目自带 entry_fields 行（自己的结构）+ field_data 行（自己的值）；
--   · 模板只初始化：add-field / 模板演进都不回刷存量条目的行；
--     `section sync` 第二阶段把字典里**条目缺的**行补进存量条目（只增不改）；
--   · quickAdd（写一个字典里没有的键）不再污染字典：只在条目自身建扩展行，
--     template_field_id = NULL 即「扩展字段」，非 NULL 即「出身模板」；
--   · template_field_id 用复合串 "<section_id>:<key>"（identity.fieldTargetKey 同一口径）——
--     v1 的 fields 表没有 id 列，复合串就是它唯一的稳定身份；
--   · entries 的 "values" JSON 列退役：值逐键落 field_data（value 是 JSON 文本，
--     密文 blob 原样搬运，导入层不碰内容）；
--   · entry_attach 的挂载点从 (entry_id, field_key) 收敛到 entry_field_id——
--     「具体条目的具体字段」在 v2 是复合定位，v3 有了真正的行 id。
--
-- entries / entry_attach 两张表按 v2 的标准姿势重建（建新表 → apply 搬数据 →
-- 删旧表 → 改名 → 补索引）。数据搬运全在 v3-apply.ts：搬 entries 行之前必须先读
-- 旧表的 values 列拆行，搬边之前必须先捕获旧边表——纯 SQL 表达不了这个顺序。
-- 已发布的 v1.sql / v2.sql 永不修改。

-- 字典的「模板默认值」：sync 补行时，若条目该键还没有数据行，就用它落一条。
-- NULL = 没有默认值。JSON 文本（与 field_data.value 同一口径，标量也是 JSON）。
ALTER TABLE fields ADD COLUMN default_value TEXT;

-- ── entry_fields：条目自己的字段结构（写时复制的载体）──────────────────
-- 列是 spec 的镜像（查询/约束用），spec 仍是保真源（整条 FieldDef 的 JSON）。
-- fill 可空：NULL = normal（缺省不写噪音，与 fields.fill 的镜像语义一致但更宽松——
-- 行上的 fill 只影响展示，完整度判据读 spec）。
-- UNIQUE(entry_id, key)：一个条目一个键只有一行结构。
CREATE TABLE entry_fields (
  id                TEXT PRIMARY KEY,                    -- ef_<sha1(entry_id + ':' + key)[0:16]>（确定性，见 identity.ts）
  entry_id          TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  template_field_id TEXT,                                -- "<section_id>:<key>"；NULL = 扩展字段
  key               TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL CHECK (type IN
                      ('text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags',
                       'entrylist', 'table', 'source', 'secret', 'file', 'md', 'shortcut')),
  hint              TEXT NOT NULL DEFAULT '',
  spec              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec)),
  fill              TEXT CHECK (fill IS NULL OR fill IN ('normal', 'optional', 'avoid')),
  position          INTEGER NOT NULL DEFAULT 0,
  meta              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
);
CREATE INDEX ix_entry_fields_entry ON entry_fields (entry_id, position);

-- ── field_data：条目字段自己的值（一键一行，JSON 文本）─────────────────
-- value NOT NULL：「没填」= 没有数据行（而不是有一行 NULL）——
-- 读出来键缺席，序列化补 null，与旧版 values 列的键存在性语义逐键一致。
-- entry_field_id UNIQUE：一行结构最多一份值。
CREATE TABLE field_data (
  id              TEXT PRIMARY KEY,                      -- d_<sha1(entry_field_id)[0:16]>（确定性）
  entry_field_id  TEXT NOT NULL UNIQUE REFERENCES entry_fields(id) ON DELETE CASCADE,
  value           TEXT NOT NULL CHECK (json_valid(value)),
  created_at      TEXT,
  updated_at      TEXT
);

-- ── entries_new：去 "values" 列，其余与 v1 一致 ────────────────────────
-- 数据搬运 / DROP / RENAME / 补索引在 v3-apply.ts（必须先读旧表 values 拆行）。
CREATE TABLE entries_new (
  id         TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  created_at TEXT,
  updated_at TEXT
);

-- ── entry_attach_new：挂载点收敛到 entry_field_id ──────────────────────
-- role 语义不变（inline = 从值重算，attach = 显式挂载）；
-- field_key 列没了——键跟着 entry_fields 行走，不再在边上重复。
CREATE TABLE entry_attach_new (
  entry_field_id  TEXT NOT NULL REFERENCES entry_fields(id) ON DELETE CASCADE,
  attachment_id   TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'inline' CHECK (role IN ('inline', 'attach')),
  position        INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  PRIMARY KEY (entry_field_id, attachment_id)
);
