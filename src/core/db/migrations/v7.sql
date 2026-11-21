-- schema v7（0.43）：条目模板从「容器」降级为「模板」，条目升级为唯一内容节点。
--
-- 用户裁决（任务 #45）：
--   · 条目模板在 DB 上也改名成 template：templates + template_fields；
--   · 条目不再属于某个条目模板容器；`entries.section_id` 改成 `template_id`，
--     它只记录「创建时用过的模板」，不参与导航、不参与级联删除；
--   · 文件夹不是新实体：任何条目都能有子条目，父子关系放 `folders` 表；
--   · 旧条目模板迁移时各自生成一个**空条目**（folder 节点），旧条目挂到它下面；
--   · `__blank__` 是内置空白模板：folder 节点和「无模板」条目都用它，
--     blank=1 时 normalize 不补「原始资料」字段，保证 folder 真的可以从空开始。
--
-- 表没有外键：writeStore 是单事务全量重写，服务层负责校验 parent/模板存在；
-- 不用 FK 换来的是「删模板不连带删条目」这条语义不会被 SQLite CASCADE 偷走。
-- 旧 v1..v6 永不修改；数据搬运在 v7-apply.ts（DROP entries 会 CASCADE 子表，
-- 必须先捕获再重建，纯 SQL 表达不了这个顺序）。

-- ── templates：原 sections 表，换名字 + blank 标记 ─────────────────────
CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "order"     INTEGER NOT NULL DEFAULT 50,
  source      TEXT,                -- 原 template 列：它从哪个代码模板实例化而来
  kv          INTEGER NOT NULL DEFAULT 0 CHECK (kv IN (0, 1)),
  blank       INTEGER NOT NULL DEFAULT 0 CHECK (blank IN (0, 1)),
  title_field TEXT,
  title_label TEXT NOT NULL DEFAULT '名称',
  layout      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(layout)),
  created_at  TEXT,
  updated_at  TEXT
);

-- ── template_fields：原 fields 表，section_id 改成 template_id ──────────
CREATE TABLE template_fields (
  template_id  TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL,
  fill         TEXT NOT NULL DEFAULT 'normal' CHECK (fill IN ('normal', 'optional', 'avoid')),
  hint         TEXT NOT NULL DEFAULT '',
  sensitive    INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  sort         INTEGER NOT NULL DEFAULT 0,
  spec         TEXT NOT NULL CHECK (json_valid(spec)),
  default_value TEXT,
  PRIMARY KEY (template_id, key)
);
CREATE INDEX ix_template_fields_template ON template_fields (template_id, sort);

-- ── entries_new：去 section_id，换 template_id；不加 parent 列 ─────────
-- parent 是 folders 表的职责：一个条目一行，根节点 parent_id = NULL。
CREATE TABLE entries_new (
  id         TEXT PRIMARY KEY,
  template_id TEXT NOT NULL DEFAULT '__blank__',
  title      TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  created_at TEXT,
  updated_at TEXT
);

-- ── folders：条目的父子关系（Lion 式「条目即文件夹」）──────────────────
-- 每个条目恰好一行（含根节点）；entry_id 是主键，parent_id=NULL 就是根。
-- 不建外键，理由见文件头：删除子树由服务层显式处理，DB 不做隐式级联。
CREATE TABLE folders (
  entry_id  TEXT PRIMARY KEY,
  parent_id TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE INDEX ix_folders_parent ON folders (parent_id, sort);
