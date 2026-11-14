-- schema v5：字段值历史（任务 #27）。
--
-- 每行 = 一个 entry_field 的一次**真实值变化**：
--   rev       该字段内单调递增的版本号（1,2,3…），恢复也追加新行，不改写历史
--   value     变化后的完整值（JSON 文本，快照；不是 diff）
--   prev_value变化前的值（便于「这一跳改了什么」）
--   op        set / clear / restore
--   source    写入来源（ui / restore；其它来源留待后续）
--   at        ISO 时间
--
-- **刻意不建外键**：writeStore 是单事务全量重写（DELETE FROM sections → CASCADE
-- 清空 entry_fields），若这里 REFERENCES entry_fields ON DELETE CASCADE，
-- 每次保存都会把历史一起清空再靠应用层搬回去——代价随历史行数线性增长。
-- 改为应用层同事务清理：writeStore 在重建后用
--   DELETE FROM field_history WHERE entry_field_id NOT IN (SELECT id FROM entry_fields)
-- 删掉真正消失的字段的历史；字段还在的，历史原样不动。
-- 这样「保存一次只写变化的那几行」，自动保存也不会把历史表整份重写。
CREATE TABLE field_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_field_id TEXT NOT NULL,
  rev            INTEGER NOT NULL,
  value          TEXT NOT NULL CHECK (json_valid(value)),
  prev_value     TEXT CHECK (prev_value IS NULL OR json_valid(prev_value)),
  op             TEXT NOT NULL CHECK (op IN ('set', 'clear', 'restore')),
  source         TEXT NOT NULL DEFAULT 'ui',
  at             TEXT NOT NULL,
  UNIQUE (entry_field_id, rev)
);

-- 字段详情：按字段取最近 N 版；条目的时间线：按时间倒序扫该条目的全部历史。
CREATE INDEX ix_field_history_field ON field_history (entry_field_id, rev DESC);
CREATE INDEX ix_field_history_at ON field_history (at);
