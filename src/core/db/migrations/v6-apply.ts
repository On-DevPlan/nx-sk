// v5 → v6 的数据搬运（DDL 见 v6.sql；runner 在同一事务里先执行 DDL 再调这里）。
//
// 目标形状（0.42）：**底层只有 field**。分组不再是栏目上的 `groups[]`，
// 而是 fields 里 type='group' 的一行，spec 的 `keys` 引用同栏目其他字段的 key。
//
// 顺序是硬约束（DROP 的 CASCADE 会带走子表）：
//   1. 先捕获 groups / fields / entry_fields / field_data / entry_attach 全行；
//   2. 把每个栏目的 groups 行折成 group 字段行（keys = 原本 group_id 指向它的成员），
//      成员 spec 去掉 `group`；`group_id` 为空（历史孤儿）的字段归到 `other` 组（没有就合成）；
//   3. fields 重建：**组行在前、叶子行按原 sort** → 面板顺序与成员顺序都不变；
//   4. entry_fields 重建：存量行原样（spec 去掉 group），每个条目再补上本栏目的组行
//      （组也是结构的一部分：条目按自身结构行渲染，缺了组行面板就分不出块）；
//   5. 子表原样放回（field_data / entry_attach 的 id / 值 / 时间戳一字不改）；
//   6. DROP groups（分组声明的旧家）→ 删 group 相关索引 → meta.migrate_v6 计数。
//
// 列名全部显式写出：SELECT * 的位置耦合会在将来加列时静默错位。
import { nowIso } from '../../ids.ts';
import { freeGroupKey } from '../../../shared/fields/structure.ts';
import type { Conn, Row } from '../driver.ts';

/** 搬运计数写进 meta.migrate_v6（裸 SQL：import migrator 会形成循环依赖）。 */
function writeMeta(conn: Conn, key: string, value: string, at: string): void {
  conn.run(
    `INSERT INTO meta (key, value, updated_at) VALUES (:key, :value, :at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value, at },
  );
}

const FIELD_OLD_COLS = 'section_id, key, label, type, group_id, fill, hint, sensitive, sort, spec, default_value';
const FIELD_NEW_COLS = 'section_id, key, label, type, fill, hint, sensitive, sort, spec, default_value';
const ENTRY_FIELD_COLS = 'id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta';
const FIELD_DATA_COLS = 'id, entry_field_id, value, created_at, updated_at';
const EDGE_COLS = 'entry_field_id, attachment_id, role, position, note, created_at';

interface SectionGroup {
  id: string;
  title: string;
  sort: number;
}

/** 组字段的 spec：与普通字段同一套判别联合，多一个 keys。 */
function groupSpec(key: string, label: string, keys: string[]): string {
  return JSON.stringify({ key, label, type: 'group', keys, fill: 'optional' });
}

/** 成员 spec：去掉 `group`（旧形状里的分组引用）。 */
function stripGroupSpec(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw || '{}');
  } catch {
    return raw;
  }
  if (!obj || typeof obj !== 'object' || !('group' in obj)) return raw;
  delete obj.group;
  return JSON.stringify(obj);
}

export function applyV6(db: Conn): void {
  const at = nowIso();

  // ── 1. 捕获 ──
  const groupRows = db.all('SELECT section_id, id, title, sort FROM groups ORDER BY section_id, sort, rowid') as Row[];
  const fieldRows = db.all(`SELECT ${FIELD_OLD_COLS} FROM fields ORDER BY section_id, sort, rowid`) as Row[];
  const entryFieldRows = db.all(`SELECT ${ENTRY_FIELD_COLS} FROM entry_fields ORDER BY rowid`) as Row[];
  const fieldDataRows = db.all(`SELECT ${FIELD_DATA_COLS} FROM field_data ORDER BY rowid`) as Row[];
  const edgeRows = db.all(`SELECT ${EDGE_COLS} FROM entry_attach ORDER BY rowid`) as Row[];

  // ── 2. 折算：groups + group_id → group 字段 ──
  const groupsBySection = new Map<string, SectionGroup[]>();
  for (const g of groupRows) {
    const sid = String(g.section_id);
    const list = groupsBySection.get(sid) || [];
    list.push({ id: String(g.id), title: String(g.title || g.id), sort: Number(g.sort) || 0 });
    groupsBySection.set(sid, list);
  }
  const bySection = new Map<string, Row[]>();
  for (const f of fieldRows) {
    const sid = String(f.section_id);
    const list = bySection.get(sid) || [];
    list.push(f);
    bySection.set(sid, list);
  }

  const plan = new Map<string, { groups: Array<{ key: string; label: string; keys: string[] }>; fields: Row[] }>();
  for (const [sid, list] of bySection) {
    const declared = groupsBySection.get(sid) || [];
    // 字段 key 不能和组 key 撞车（同一张表主键 (section_id, key)）：撞了就给组名加后缀。
    const taken = new Set(list.map((f) => String(f.key)));
    const groupKeyOf = new Map<string, string>();
    for (const g of declared) {
      let key = g.id || 'group';
      key = freeGroupKey(key, taken);
      taken.add(key);
      groupKeyOf.set(g.id, key);
    }
    const members = new Map<string, string[]>();
    for (const g of declared) members.set(g.id, []);
    const orphans: string[] = [];
    for (const f of list) {
      const gid = f.group_id == null ? '' : String(f.group_id);
      if (!gid) { orphans.push(String(f.key)); continue; }
      if (!members.has(gid)) {
        // 引用了没声明的分组（历史自愈行）：补一个组
        let key = gid;
        key = freeGroupKey(key, taken);
        taken.add(key);
        groupKeyOf.set(gid, key);
        members.set(gid, []);
        declared.push({ id: gid, title: gid, sort: 9999 });
      }
      members.get(gid)!.push(String(f.key));
    }
    // 任何字段都没归属的栏目：不硬造组（KV 栏目本来就没有分组的语义）
    const groups = declared.map((g) => ({ key: groupKeyOf.get(g.id) as string, label: g.title, keys: members.get(g.id) || [] }));
    if (orphans.length) {
      const existing = groups.find((g) => g.key === 'root');
      if (existing) existing.keys.push(...orphans);
      else groups.unshift({ key: freeGroupKey('root', taken), label: '未分组', keys: orphans });
    }
    plan.set(sid, { groups, fields: list });
  }

  // ── 3. fields 重建：组行在前 + 叶子行按原 sort ──
  const groupRowsOut: Row[] = [];
  const leafRowsOut: Row[] = [];
  for (const [sid, p] of plan) {
    let sort = 0;
    for (const g of p.groups) {
      groupRowsOut.push({
        section_id: sid, key: g.key, label: g.label, type: 'group',
        fill: 'optional', hint: '', sensitive: 0, sort: sort++,
        spec: groupSpec(g.key, g.label, g.keys), default_value: null,
      });
    }
    for (const f of p.fields) {
      leafRowsOut.push({
        section_id: sid, key: String(f.key), label: String(f.label ?? ''), type: String(f.type),
        fill: String(f.fill || 'normal'), hint: String(f.hint ?? ''), sensitive: Number(f.sensitive) || 0,
        sort: sort++, spec: stripGroupSpec(String(f.spec ?? '{}')), default_value: f.default_value ?? null,
      });
    }
  }
  for (const r of [...groupRowsOut, ...leafRowsOut]) {
    db.run(`INSERT INTO fields_v6 (${FIELD_NEW_COLS}) VALUES (:section_id, :key, :label, :type, :fill, :hint, :sensitive, :sort, :spec, :default_value)`, r);
  }

  // ── 4. entry_fields 重建：存量行 → 新表；每条补上组行 ──
  const rowsByEntry = new Map<string, Row[]>();
  for (const r of entryFieldRows) {
    const eid = String(r.entry_id);
    const list = rowsByEntry.get(eid) || [];
    list.push(r);
    rowsByEntry.set(eid, list);
  }
  for (const [eid, list] of rowsByEntry) {
    const sid = String(db.get('SELECT section_id FROM entries WHERE id = :id', { id: eid })?.section_id ?? '');
    const p = plan.get(sid);
    let pos = Number(list[list.length - 1]?.position ?? -1) + 1;
    for (const r of list) {
      db.run(
        `INSERT INTO entry_fields_v6 (${ENTRY_FIELD_COLS}) VALUES (:id, :entry_id, :template_field_id, :key, :label, :type, :hint, :spec, :fill, :position, :meta)`,
        { ...r, spec: stripGroupSpec(String(r.spec ?? '{}')) },
      );
    }
    for (const g of p?.groups || []) {
      db.run(
        `INSERT INTO entry_fields_v6 (${ENTRY_FIELD_COLS}) VALUES (:id, :entry_id, :template_field_id, :key, :label, :type, :hint, :spec, :fill, :position, :meta)`,
        {
          id: `ef_${eid}_${g.key}`.slice(0, 64), entry_id: eid, template_field_id: null,
          key: g.key, label: g.label, type: 'group', hint: '', spec: groupSpec(g.key, g.label, g.keys),
          fill: 'optional', position: pos++, meta: '{}',
        },
      );
    }
  }

  // ── 5. 换表（先 DROP 子表，CASCADE 会清 field_data / entry_attach，随后原样放回）──
  db.exec('DROP TABLE fields');
  db.exec('ALTER TABLE fields_v6 RENAME TO fields');
  db.exec('CREATE INDEX ix_fields_section ON fields (section_id, sort)');
  db.exec('DROP TABLE entry_fields');
  db.exec('ALTER TABLE entry_fields_v6 RENAME TO entry_fields');
  db.exec('CREATE INDEX ix_entry_fields_entry ON entry_fields (entry_id, position)');
  for (const r of fieldDataRows) {
    db.run(`INSERT INTO field_data (${FIELD_DATA_COLS}) VALUES (:id, :entry_field_id, :value, :created_at, :updated_at)`, r);
  }
  for (const r of edgeRows) {
    db.run(`INSERT INTO entry_attach (${EDGE_COLS}) VALUES (:entry_field_id, :attachment_id, :role, :position, :note, :created_at)`, r);
  }

  // ── 6. 旧结构退役 ──
  db.exec('DROP INDEX IF EXISTS ix_fields_group');
  db.exec('DROP TABLE groups');

  writeMeta(db, 'migrate_v6', JSON.stringify({
    groups: groupRows.length,
    groupsAsFields: groupRowsOut.length,
    fields: fieldRows.length,
    entryFields: entryFieldRows.length + groupRowsOut.length,
    fieldData: fieldDataRows.length,
    edges: edgeRows.length,
  }), at);
}

