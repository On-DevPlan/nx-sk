-- schema v8（0.44）：KV 模板标记彻底退役。
--
-- v7 的 templates 仍带 `kv` 列，只是代码不再读；v8 把它从库里删掉，
-- 让 schema 也只剩「模板 + 字段 + 条目」这一套结构。
-- 该列的值从未参与运行时行为，删除不影响任何条目/字段/条目数据；
-- 旧 kv:true 的模板与旧「一条一键」条目仍按普通模板/普通字段保留。

ALTER TABLE templates DROP COLUMN kv;
