-- schema v2：挂载位置收敛到「具体栏目的具体条目的具体字段」。
--
-- 用户裁决（2026-11-11）：
--   · 栏目 / 条目 / 字段定义是**结构定位信息**，不是挂载对象——附件是数据，
--     挂在结构上没有价值：删除 section_attach / field_attach 两张结构级边表；
--   · source 只是一个普通字段（原始资料袋），不是一种挂载语义：
--     删除 role='source'——资料袋里的值引用仍走 inline，未来显式挂载走 attach。
--
-- entry_attach 的 CHECK 改不了（SQLite 不支持 ALTER CONSTRAINT）→ 按标准姿势重建：
-- 建新表 → 整表搬运（历史 'source' 边落为 'attach'：保留挂载事实、去掉语义；
-- 实际写入方从未上线，预期 0 行）→ 删旧表 → 改名 → 补索引。
-- 已发布的 v1.sql 永不修改。

CREATE TABLE entry_attach_new (
  entry_id       TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  field_key      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'inline' CHECK (role IN ('inline', 'attach')),
  position       INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (entry_id, attachment_id, field_key)
);

INSERT INTO entry_attach_new (entry_id, attachment_id, field_key, role, position, note, created_at)
  SELECT entry_id, attachment_id, field_key,
         CASE WHEN role = 'source' THEN 'attach' ELSE role END,
         position, note, created_at
  FROM entry_attach;

DROP TABLE entry_attach;
ALTER TABLE entry_attach_new RENAME TO entry_attach;
CREATE INDEX ix_entry_attach_att ON entry_attach (attachment_id);

DROP TABLE IF EXISTS section_attach;
DROP TABLE IF EXISTS field_attach;
