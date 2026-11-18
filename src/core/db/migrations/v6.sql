-- schema v6（0.42）：分组从「栏目上的结构」变成「一种字段」。
--
-- 用户裁决：#36「组本身就应该 field 而不是栏目上的结构，这个特殊的 field 可以包装 ui、
-- 链接其他 field 的结构，但底层数据结构只有 field」。
--
-- 形状变化：
--   · 删表 `groups`（栏目级分组声明）；
--   · fields 去列 `group_id`（字段级分组引用）；
--   · 分组变成 `fields` 里 type='group' 的一行：spec 带 `keys`（引用同栏目其他字段 key），
--     成员的 spec 不再带 `group` 键。
--
-- 与 v4 同一条姿势：建新表（其余约束/索引/PK 原样保留，只是少一列）→ 搬运 → 删旧表 → 改名。
-- 数据搬运（groups 行 → group 字段行、成员 spec 去 group、entry_fields 补组行）在
-- v6-apply.ts 里**同一事务**完成：必须先读 groups 再 DROP，纯 SQL 表达不了。
-- 已发布的 v1..v5 永不修改。

-- ── fields_v6：v4 的 fields 去掉 group_id ─────────────────────────────
CREATE TABLE fields_v6 (
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL,
  fill          TEXT NOT NULL DEFAULT 'normal' CHECK (fill IN ('normal', 'optional', 'avoid')),
  hint          TEXT NOT NULL DEFAULT '',
  sensitive     INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  sort          INTEGER NOT NULL DEFAULT 0,
  spec          TEXT NOT NULL CHECK (json_valid(spec)),
  default_value TEXT
);

-- ── entry_fields_v6：与 v4.entry_fields 同形（v3 起就没有 group 列）─────
-- 重建只为让它与新 fields 的「组行」语义对齐（组行同样是一条结构行），
-- 表结构本身没变——但**必须重建**：CASCADE 顺序见 v6-apply.ts。
CREATE TABLE entry_fields_v6 (
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
