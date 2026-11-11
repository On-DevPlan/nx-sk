-- schema v4：字段类型不再被 DB CHECK 约束（用户裁决，任务 #18）。
--
-- 理由：**加一种字段类型不再需要 schema 迁移**。
--   v1 把 FIELD_TYPES 抄进了 fields.type / entry_fields.type 的 CHECK IN 枚举，
--   于是每加一种类型（本次的 debug 就是第一个受害者）都要「改 shared 清单 +
--   写一次 schema 迁移」两件事，而后一件对数据本身毫无保护价值——
--   类型清单的唯一权威本来就是 shared/fields/types.ts 的 FIELD_TYPES，
--   写入点的合法性由 validateFieldDef（定义）与 behaviorOf（行为分派）在**运行时**保证，
--   未知类型在写入当场报错，比 CHECK 的报错离根因更近、信息更全。
--   CHECK 留在库里只剩一个坏处：它把「清单」抄成了第二份，两份必然漂移。
--
-- 做法（v2/v3 的标准姿势）：建新表（fields_new / entry_fields_new，**其余约束/索引/PK
-- 原样保留**，只去掉 type 的 CHECK IN 枚举）→ 整表搬运 → 删旧表 → 改名 → 补索引。
-- entry_fields 被 field_data / entry_attach 外键引用，DROP 会经 CASCADE 带走两张子表——
-- 所以搬运/恢复顺序在 v4-apply.ts：先捕获四张表全行，重建后原样放回（id 一字不改）。
-- 已发布的 v1.sql / v2.sql / v3.sql 永不修改。

-- ── fields_new：与 v1.fields + v3.default_value 同形，仅 type 去 CHECK ──
CREATE TABLE fields_new (
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL,
  group_id   TEXT,
  fill       TEXT NOT NULL DEFAULT 'normal' CHECK (fill IN ('normal', 'optional', 'avoid')),
  hint       TEXT NOT NULL DEFAULT '',
  sensitive  INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  sort       INTEGER NOT NULL DEFAULT 0,
  spec       TEXT NOT NULL CHECK (json_valid(spec)),
  default_value TEXT
);

-- ── entry_fields_new：与 v3.entry_fields 同形，仅 type 去 CHECK ──────────
CREATE TABLE entry_fields_new (
  id                TEXT PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  template_field_id TEXT,
  key               TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL,
  hint              TEXT NOT NULL DEFAULT '',
  spec              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec)),
  fill              TEXT CHECK (fill IS NULL OR fill IN ('normal', 'optional', 'avoid')),
  position          INTEGER NOT NULL DEFAULT 0,
  meta              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
);
