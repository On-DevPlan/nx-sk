-- v9（2026-11-21，0.44 · 任务 #51）：条目模板默认标签。
-- 模板只负责初始化，但「这类条目叫什么」是模板的稳定语义：从模板新建条目时
-- 把模板 tags 一起带进 entries.tags，agent 就能用 tag 直接检索，不必记模板 id。
ALTER TABLE templates ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags));
