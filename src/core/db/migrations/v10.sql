-- v10（2026-11-22，任务 #63）：条目一句话说明（desc）。
--
-- 为什么是 entries 的一列，而不是再塞一个字段：
--   · desc 是「给 agent / 人认条目」的短标签，不是可填的内容——它不参与完整度、
--     不属于任何分组、也不该在字段结构里占一格；
--   · 塞进 values 就要为每条条目物化一行 entry_fields，删了还会被字典补回来；
--   · 列名用 description（DESC 是 SQL 关键字，做列名要到处加引号，容易漏）。
ALTER TABLE entries ADD COLUMN description TEXT NOT NULL DEFAULT '';
