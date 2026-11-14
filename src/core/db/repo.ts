// Store 对象 ↔ SQLite 行的映射（facade 的两条腿：读组装 / 写全量重写）。
//
// ── 写策略：单事务全量重写（DELETE + CASCADE + INSERT）────────────────
// 本地规模（几十个栏目、几千条条目、几百个附件）下整表重写是微秒级，
// 换来的是「store 对象就是唯一真相、行是它的投影」这条不变量不可能被
// 增量写的漏改打破。**留缝**：所有写都集中在 writeStore 一处，将来要按表
// 增量写，只改这个函数，facade 与调用方一字不动。
//
// ── 乐观并发（rev）──────────────────────────────────────────────────
// meta.rev 是全局写计数：loadStore 记下 rev，saveStore 在写事务里校验
// 「当前 rev == 载入时 rev」，不等就抛 BLOCKED（提示重试）。
// 这修掉 serve + CLI 双进程的 lost-update 大坑：旧版「读-改-写」整份覆盖，
// 两边各改各的，后写的把先写的静默抹掉。
//
// ── 保真口径 ────────────────────────────────────────────────────────
// fields.spec / attachments.meta 存**整条记录**的 JSON（保真源），
// 标量列是查询与约束的镜像——键存在性（原 JSON 里有没有某个键）不靠
// 列的缺省值猜，深比较往返才不会漂。
//
// ── schema v3：条目结构写时复制 ─────────────────────────────────────
// 每个条目自带 entry_fields 行（结构）+ field_data 行（值）。全量重写时
// **存量条目的行原样恢复**（属性不回刷字典——这是「模板只初始化」的落点），
// 只有新条目按字典实例化全部模板行；values 里缺行的键补占位行。
// 行 id 全部走 identity.ts 的确定性派生，搬运/重写/运行时三方同一公式。

import { fileReferences, MIME_TYPES, type FileRecord } from '../attachments.ts';
import { nowIso } from '../ids.ts';
import { blocked } from '../errors.ts';
import { getMeta, setMeta } from './migrator.ts';
import { tx } from './tx.ts';
import type { Conn, Row } from './driver.ts';
import type { Store, StoreEntry, StoreSection, EntryFieldView } from '../store-shape.ts';
import { STORE_VERSION, isDetachedField } from '../store-shape.ts';
import { POINTER_KINDS, entryFieldId, fieldDataId, fieldTargetKey } from './identity.ts';
import { cleanupOrphanHistory, recordFieldChanges, sameStoredValue, type FieldValueChange } from './history.ts';
import type { FieldDef } from '../../shared/fields/types.ts';

/** 读出来的「未过 normalize 的 json 形状」+ 当时的 rev + 条目自身结构行（v3）。 */
export interface LoadedRaw {
  raw: Store;
  rev: number;
  structures: Map<string, EntryFieldView[]>;
}

const REV_KEY = 'rev';

/** 读 rev（没有当 0）。 */
export function getRev(db: Conn): number {
  return Number(getMeta(db, REV_KEY) || '0') || 0;
}

/** 写 rev（必须在事务内）。 */
export function setRev(db: Conn, rev: number, at: string = nowIso()): void {
  setMeta(db, REV_KEY, String(Math.trunc(rev)), at);
}

function parseJson(text: unknown, fallback: unknown): unknown {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** fields.fill / entry_fields.fill 的镜像取值：合法策略原样，其余归 NULL（= normal）。 */
function fillMirror(def: Record<string, unknown> | Row): string | null {
  const v = String((def as Record<string, unknown>).fill ?? '');
  return ['normal', 'optional', 'avoid'].includes(v) ? v : null;
}

/**
 * 读：SELECT 组装出 store.json 时代的形状（**不做旧版本兼容**——
 * 行是 normalize 之后写进去的，version 恒为 STORE_VERSION）。
 * v3：条目的 values 由 entry_fields × field_data 组装（缺数据行的键不出现在 values，
 * 与旧版「没填 = 没有这个键」的键存在性语义逐键一致）。
 */
export function readStore(db: Conn): LoadedRaw {
  const sectionRows = db.all('SELECT * FROM sections ORDER BY rowid');
  const groupRows = db.all('SELECT * FROM groups ORDER BY section_id, sort, rowid');
  const fieldRows = db.all('SELECT * FROM fields ORDER BY section_id, sort, rowid');
  const entryRows = db.all('SELECT * FROM entries ORDER BY rowid');
  const fileRows = db.all("SELECT * FROM attachments WHERE kind = 'file' AND deleted_at IS NULL ORDER BY rowid");
  const settingRows = db.all('SELECT key, value FROM settings ORDER BY key');
  const efRows = db.all(
    `SELECT ef.*, fd.value AS data_value FROM entry_fields ef
     LEFT JOIN field_data fd ON fd.entry_field_id = ef.id
     ORDER BY ef.entry_id, ef.position, ef.key`,
  );

  const groupsBySection = new Map<string, Array<{ id: string; title: string }>>();
  for (const g of groupRows) {
    const list = groupsBySection.get(String(g.section_id)) || [];
    list.push({ id: String(g.id), title: String(g.title) });
    groupsBySection.set(String(g.section_id), list);
  }
  const fieldsBySection = new Map<string, Array<Record<string, unknown>>>();
  for (const f of fieldRows) {
    const list = fieldsBySection.get(String(f.section_id)) || [];
    // spec 是保真源：整条 FieldDef 原样回来（列只是镜像，不参与重建）。
    list.push(parseJson(f.spec, { key: f.key, label: f.label, type: f.type, group: f.group_id || '' }) as unknown as Record<string, unknown>);
    fieldsBySection.set(String(f.section_id), list);
  }

  const sections = sectionRows.map((s): StoreSection => ({
    id: String(s.id),
    title: String(s.title),
    description: String(s.description ?? ''),
    order: Number(s.order) || 0,
    template: s.template == null ? null : String(s.template),
    kv: Number(s.kv) === 1,
    titleField: s.title_field == null ? null : String(s.title_field),
    titleLabel: String(s.title_label ?? '名称'),
    groups: groupsBySection.get(String(s.id)) || [],
    fields: (fieldsBySection.get(String(s.id)) || []) as unknown as StoreSection['fields'],
    layout: parseJson(s.layout, {}),
    createdAt: s.created_at == null ? null : String(s.created_at),
    updatedAt: s.updated_at == null ? null : String(s.updated_at),
  }));

  // 条目结构行（v3）：按 (entry_id, position, key) 排序读回，values 由数据行组装。
  const structures = new Map<string, EntryFieldView[]>();
  const valuesByEntry = new Map<string, Record<string, unknown>>();
  for (const r of efRows) {
    const entryId = String(r.entry_id);
    const view: EntryFieldView = {
      id: String(r.id),
      key: String(r.key),
      label: String(r.label ?? ''),
      type: String(r.type),
      hint: String(r.hint ?? ''),
      fill: r.fill == null ? null : String(r.fill),
      position: Number(r.position) || 0,
      templateFieldId: r.template_field_id == null ? null : String(r.template_field_id),
      spec: parseJson(r.spec, {}) as Record<string, unknown>,
      meta: parseJson(r.meta, {}) as Record<string, unknown>,
    };
    const list = structures.get(entryId) || [];
    list.push(view);
    structures.set(entryId, list);
    // 任务 #20：脱离行（meta.detached）的值**不再进 values**——读边界统一过滤；
    // 数据仍住在 field_data（writeStore 按捕获行原样保留），restore 即回。
    if (r.data_value != null && !isDetachedField(view)) {
      const values = valuesByEntry.get(entryId) || {};
      values[view.key] = parseJson(r.data_value, null);
      valuesByEntry.set(entryId, values);
    }
  }

  const entries = entryRows.map((e): StoreEntry => ({
    id: String(e.id),
    section: String(e.section_id),
    title: String(e.title ?? ''),
    tags: (parseJson(e.tags, []) as unknown[]).map(String),
    values: valuesByEntry.get(String(e.id)) || {},
    createdAt: e.created_at == null ? null : String(e.created_at),
    updatedAt: e.updated_at == null ? null : String(e.updated_at),
  }));

  const files = fileRows.map((f) => parseJson(f.meta, null) as FileRecord | null).filter((x): x is FileRecord => !!x);

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) settings[String(row.key)] = parseJson(row.value, null);

  return {
    raw: { version: STORE_VERSION, settings: settings as unknown as Store['settings'], sections, entries, files },
    rev: getRev(db),
    structures,
  };
}

/** writeStore 的可选输入（导入器用来把「原始 JSON 里声明过的分组」带进 declared 列）。 */
export interface WriteStoreOptions {
  /** 期望的 rev（乐观并发）；null/undefined = 不校验（首启导入、播种）。 */
  expectedRev?: number | null;
  /** 分组 declared 判据覆盖：sectionId → 声明过的 group id 集合（导入路径专用）。 */
  declaredHint?: Record<string, Set<string>> | null;
}

/**
 * 写：单事务全量重写。
 *
 * @returns 新的 rev
 */
export function writeStore(db: Conn, store: Store, { expectedRev = null, declaredHint = null }: WriteStoreOptions = {}): number {
  const at = nowIso();
  return tx((conn) => {
    const curRev = getRev(conn);
    if (expectedRev !== null && expectedRev !== undefined && curRev !== expectedRev) {
      throw blocked(
        `存储已被其它进程修改（本次基于 rev ${expectedRev}，当前 rev ${curRev}），请重试：重新读取后再提交`,
        { expectedRev, currentRev: curRev },
      );
    }

    // ── 1. 捕获要跨重写存活的东西 ──
    // 显式边（role ≠ inline）：全量重写只重算 inline；attach 是用户
    // 未来的显式挂载，删了就丢，先捞出来、父行还在就原样放回去。
    // （v3：边只挂 entry_field_id，entry_id/键要 JOIN entry_fields 才拿得到。）
    const explicitEntryEdges = conn.all(
      `SELECT ef.entry_id AS entry_id, ef.key AS field_key, ea.attachment_id, ea.role, ea.position, ea.note, ea.created_at
       FROM entry_attach ea JOIN entry_fields ef ON ef.id = ea.entry_field_id
       WHERE ea.role <> 'inline'`,
    );
    // 条目结构行 + 值：存量条目**原样恢复**（属性不回刷字典——写时复制的落点）。
    const capturedRows = conn.all(
      `SELECT ef.*, fd.value AS data_value, fd.created_at AS data_created_at, fd.updated_at AS data_updated_at
       FROM entry_fields ef LEFT JOIN field_data fd ON fd.entry_field_id = ef.id
       ORDER BY ef.entry_id, ef.position, ef.key`,
    );
    const capturedByEntry = new Map<string, Row[]>();
    for (const r of capturedRows) {
      const list = capturedByEntry.get(String(r.entry_id)) || [];
      list.push(r);
      capturedByEntry.set(String(r.entry_id), list);
    }
    // 任务 #27：字段值历史的 diff 基线——重建前把「旧值文本」按结构行 id 记下来。
    const oldValues = new Map<string, string>();
    for (const r of capturedRows) {
      if (r.data_value != null) oldValues.set(String(r.id), String(r.data_value));
    }
    // 分组 declared：原地保留（新出现的分组才算「声明」；自愈行由导入 hint 或读路径决定）。
    const declaredBefore = new Map<string, number>();
    for (const g of conn.all('SELECT section_id, id, declared FROM groups')) {
      declaredBefore.set(`${String(g.section_id)}\u0000${String(g.id)}`, Number(g.declared));
    }
    // 内部指针（section/entry/field）：attachments 里**不被全量重写删除**的行，
    // 删除钩子只软删（见第 6 步）。
    const livePointers = conn.all(
      `SELECT id, kind, target_key FROM attachments WHERE kind IN ('section','entry','field') AND deleted_at IS NULL`,
    );

    // ── 2. 清空投影（CASCADE 带走 groups/fields/entries/entry_fields/field_data/边表）──
    // file/url 资源行由 store.files 重建；内部指针行**不删**（它们是软删语义的对象）。
    conn.exec('DELETE FROM sections');
    conn.run('DELETE FROM attachments WHERE kind IN (\'file\', \'url\')');
    conn.exec('DELETE FROM settings');

    // ── 3. 行插入（数组顺序 = rowid 顺序 = 读回顺序；sort 列显式化字段/分组顺序）──
    const insSection = `INSERT INTO sections (id, title, description, "order", template, kv, title_field, title_label, layout, created_at, updated_at)
      VALUES (:id, :title, :description, :order, :template, :kv, :titleField, :titleLabel, :layout, :createdAt, :updatedAt)`;
    const insGroup = 'INSERT INTO groups (section_id, id, title, sort, declared) VALUES (:sectionId, :id, :title, :sort, :declared)';
    const insField = `INSERT INTO fields (section_id, key, label, type, group_id, fill, hint, sensitive, sort, spec, default_value)
      VALUES (:sectionId, :key, :label, :type, :groupId, :fill, :hint, :sensitive, :sort, :spec, :defaultValue)`;
    const insEntry = `INSERT INTO entries (id, section_id, title, tags, created_at, updated_at)
      VALUES (:id, :sectionId, :title, :tags, :createdAt, :updatedAt)`;
    const insSetting = 'INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)';

    for (const s of store.sections) {
      conn.run(insSection, {
        id: s.id, title: s.title, description: s.description, order: s.order,
        template: s.template ?? null, kv: s.kv === true,
        titleField: s.titleField ?? null, titleLabel: s.titleLabel,
        // null 要原样存成 JSON `null`（sanitizeLayout(null) 本来就是 null）——
        // 把 null 折叠成 {} 会让「没配过版式」的栏目读回一个空版式对象，深比较漂。
        layout: s.layout === undefined || s.layout === null ? 'null' : JSON.stringify(s.layout),
        createdAt: s.createdAt ?? null, updatedAt: s.updatedAt ?? null,
      });
      (s.groups || []).forEach((g, i) => {
        const hint = declaredHint?.[s.id];
        const declared = hint ? (hint.has(g.id) ? 1 : 0) : (declaredBefore.get(`${s.id}\u0000${g.id}`) ?? 1);
        conn.run(insGroup, { sectionId: s.id, id: g.id, title: g.title, sort: i, declared });
      });
      (s.fields || []).forEach((f, i) => {
        const def = f as unknown as Record<string, unknown>;
        conn.run(insField, {
          sectionId: s.id, key: String(def.key), label: String(def.label ?? def.key ?? ''),
          type: String(def.type || 'text'),
          groupId: def.group ? String(def.group) : null,
          fill: ['normal', 'optional', 'avoid'].includes(String(def.fill)) ? String(def.fill) : 'normal',
          hint: String(def.hint ?? ''), sensitive: def.sensitive === true,
          sort: i,
          // spec 是保真源：整条 FieldDef（含类型特有键），列只是镜像。
          spec: JSON.stringify(def),
          // 模板默认值（v3）：JSON 文本；没有默认值 = NULL（读回也不该多出键）。
          defaultValue: def.defaultValue === undefined || def.defaultValue === null ? null : JSON.stringify(def.defaultValue),
        });
      });
    }
    for (const e of store.entries) {
      conn.run(insEntry, {
        id: e.id, sectionId: e.section, title: e.title,
        tags: JSON.stringify(e.tags || []),
        createdAt: e.createdAt ?? null, updatedAt: e.updatedAt ?? null,
      });
    }
    for (const [k, v] of Object.entries(store.settings || {})) {
      conn.run(insSetting, { key: k, value: JSON.stringify(v === undefined ? null : v), at });
    }

    // ── 4. 条目结构物化（v3 写时复制的核心）──
    const insEntryField = `INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
      VALUES (:id, :entryId, :templateFieldId, :key, :label, :type, :hint, :spec, :fill, :position, :meta)`;
    const insFieldData = `INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at)
      VALUES (:id, :entryFieldId, :value, :createdAt, :updatedAt)`;
    const structures = new Map<string, EntryFieldView[]>();
    const dictBySection = new Map<string, FieldDef[]>();
    for (const s of store.sections) dictBySection.set(s.id, (s.fields || []) as unknown as FieldDef[]);
    // 任务 #27：本次写入后的值文本（按结构行 id）——写完与 oldValues diff。
    const newValues = new Map<string, string>();

    for (const e of store.entries) {
      const captured = capturedByEntry.get(e.id) || [];
      const dict = dictBySection.get(e.section) || [];
      const dictByKey = new Map(dict.map((d) => [String((d as unknown as Record<string, unknown>).key), d]));
      const rows: EntryFieldView[] = [];
      const rowIdByKey = new Map<string, string>();
      // 捕获行的数据时间戳（created_at 沿用，不让每次重写都「刚创建」）。
      const dataTimes = new Map<string, { created: string | null; updated: string | null }>();
      let position = 0;

      const putRow = (id: string, templateFieldId: string | null, key: string, label: string,
        type: string, hint: string, spec: string, fill: string | null, meta: string): void => {
        conn.run(insEntryField, { id, entryId: e.id, templateFieldId, key, label, type, hint, spec, fill, position, meta });
        rows.push({
          id, key, label, type, hint, fill, position, templateFieldId,
          spec: parseJson(spec, {}) as Record<string, unknown>,
          meta: parseJson(meta, {}) as Record<string, unknown>,
        });
        rowIdByKey.set(key, id);
        position += 1;
      };

      // 任务 #20：脱离行（meta.detached）的键——values 里已经没有它（readStore 过滤），
      // 值必须由**捕获行**原样带回 field_data；缺行补齐循环也永远不许把它「复活」成可见行。
      const detachedKeys = new Set<string>();

      if (captured.length) {
        // 存量条目：原样恢复（属性不回刷字典；detached 的 meta 也原样——脱离状态跨重写存活）。
        for (const r of captured) {
          putRow(String(r.id),
            r.template_field_id == null ? null : String(r.template_field_id),
            String(r.key), String(r.label ?? ''), String(r.type), String(r.hint ?? ''),
            String(r.spec ?? '{}'), r.fill == null ? null : String(r.fill), String(r.meta ?? '{}'));
          dataTimes.set(String(r.key), {
            created: r.data_created_at == null ? null : String(r.data_created_at),
            updated: r.data_updated_at == null ? null : String(r.data_updated_at),
          });
          if (isDetachedField({ meta: parseJson(r.meta, {}) as Record<string, unknown> })) {
            detachedKeys.add(String(r.key));
            if (r.data_value != null) {
              conn.run(insFieldData, {
                id: fieldDataId(String(r.id)), entryFieldId: String(r.id), value: String(r.data_value),
                createdAt: r.data_created_at == null ? (e.createdAt || at) : String(r.data_created_at),
                updatedAt: r.data_updated_at == null ? (e.updatedAt || at) : String(r.data_updated_at),
              });
              newValues.set(String(r.id), String(r.data_value));
            }
          }
        }
      } else {
        // 新条目：按字典实例化**全部**模板行（值缺也留结构——完整度/序列化都按行算）。
        for (const d of dict) {
          const def = d as unknown as Record<string, unknown>;
          const key = String(def.key);
          putRow(entryFieldId(e.id, key), fieldTargetKey(e.section, key), key,
            String(def.label ?? key), String(def.type || 'text'), String(def.hint ?? ''),
            JSON.stringify(def), fillMirror(def), '{}');
        }
      }

      // values 里缺行的键：在字典 → 建模板行（position 追加）；否则 → 扩展占位行。
      // 任务 #20：脱离行也在 rowIdByKey 里（上面按捕获行原样恢复），所以这里天然跳过；
      // 再加一道显式判据——就算调用方塞来了 detached 键的 values，也绝不补出可见行（复活）。
      for (const key of Object.keys(e.values || {})) {
        if (detachedKeys.has(key) || rowIdByKey.has(key)) continue;
        const d = dictByKey.get(key);
        if (d) {
          const def = d as unknown as Record<string, unknown>;
          putRow(entryFieldId(e.id, key), fieldTargetKey(e.section, key), key,
            String(def.label ?? key), String(def.type || 'text'), String(def.hint ?? ''),
            JSON.stringify(def), fillMirror(def), '{}');
        } else {
          const spec = JSON.stringify({ key, label: key, type: 'text' });
          putRow(entryFieldId(e.id, key), null, key, key, 'text', '', spec, null, '{}');
        }
      }

      // 值逐键落 field_data（undefined 跳过；null 落 JSON 'null'——「显式清空」与
      // 「从没填过」在键存在性上等价于旧版 values 列：null 有键、undefined 没键）。
      // 脱离行的值不走这里（上面已按捕获行原样带回），stale 草稿不许覆掉藏着的值。
      for (const [key, value] of Object.entries(e.values || {})) {
        if (value === undefined || detachedKeys.has(key)) continue;
        const rowId = rowIdByKey.get(key);
        if (!rowId) continue;
        const times = dataTimes.get(key);
        conn.run(insFieldData, {
          id: fieldDataId(rowId), entryFieldId: rowId, value: JSON.stringify(value),
          createdAt: times?.created || e.createdAt || at,
          updatedAt: times?.updated || e.updatedAt || at,
        });
        newValues.set(rowId, JSON.stringify(value));
      }

      structures.set(e.id, rows);
    }

    // ── 4.5 字段值历史（任务 #27）──
    // 先清掉「字段行已消失」的历史（等价于 v5 之前的 CASCADE 语义；v5 没有外键），
    // 再对本次真实变化（含清空）追加版本。首次建库/导入（curRev === 0）不记——
    // 初始数据不是「改动」，全量灌一遍历史只会制造噪声。
    cleanupOrphanHistory(conn);
    if (curRev > 0) {
      const changes: FieldValueChange[] = [];
      for (const [id, next] of newValues) {
        const prev = oldValues.get(id) ?? null;
        if (!sameStoredValue(prev, next)) changes.push({ entryFieldId: id, prev, next });
      }
      for (const [id, prev] of oldValues) {
        if (newValues.has(id)) continue;
        // 行还在、值没了 = 显式清空；整行没了（扩展字段硬删）不记（历史已随行清掉）。
        if (conn.get('SELECT 1 AS x FROM entry_fields WHERE id = :id', { id })) {
          changes.push({ entryFieldId: id, prev, next: null });
        }
      }
      if (changes.length) recordFieldChanges(conn, changes, { at });
    }

    // ── 5. 资源行 + inline 边 ──
    // FileRecord → kind='file'：id **原样**（values 里嵌的引用一字不改）；
    // meta 存整条记录（保真源），标量列是查询镜像。
    const insFile = `INSERT INTO attachments
      (id, kind, name, local_path, url, mime, size, hash, storage, target_kind, target_key, dedupe_key, meta, created_at, updated_at)
      VALUES (:id, 'file', :name, :localPath, '', :mime, :size, :hash, 'local', '', '', :dedupeKey, :meta, :createdAt, :updatedAt)`;
    for (const rec of store.files) {
      conn.run(insFile, {
        id: rec.id, name: rec.name, localPath: rec.rel,
        mime: MIME_TYPES[String(rec.ext || '').toLowerCase()] || '',
        size: Number(rec.bytes) || 0, hash: rec.sha256 || '',
        dedupeKey: rec.sha256 || '',
        meta: JSON.stringify(rec),
        createdAt: rec.createdAt || at, updatedAt: rec.updatedAt || at,
      });
    }
    // inline 边：用**现有 fileReferences 逻辑**从 values 重算（三种引用载体都认，
    // 规则只此一份），按条目自身结构行定位挂载点（v3：边挂 entry_field_id）。
    // 扩展行里的 file/md/source 引用也算数——defs 传 structures，不再只看字典。
    const insEntryEdge = `INSERT INTO entry_attach (entry_field_id, attachment_id, role, position, note, created_at)
      VALUES (:entryFieldId, :attachmentId, 'inline', :position, '', :at)`;
    for (const rec of store.files) {
      const refs = fileReferences(store, rec, structures);
      refs.forEach((r, i) => {
        const rowId = (structures.get(r.entryId) || []).find((x) => x.key === r.fieldKey)?.id;
        if (!rowId) return;
        conn.run(insEntryEdge, { entryFieldId: rowId, attachmentId: rec.id, position: i, at });
      });
    }

    // ── 6. 放回显式边 + 删除钩子（软删指向已消失目标的内部指针）──
    const entryIds = new Set(store.entries.map((e) => e.id));
    // 边的另一端：file 行刚重建、内部指针行从不物理删——统一问**当前事务里的表**
    // （deleted_at IS NULL 的活行才算存在；指向已软删指针的显式边随父行一起消失）。
    const liveAttachment = (id: unknown) =>
      !!conn.get('SELECT 1 AS x FROM attachments WHERE id = :id AND deleted_at IS NULL', { id: String(id) });
    for (const r of explicitEntryEdges) {
      if (!entryIds.has(String(r.entry_id)) || !liveAttachment(r.attachment_id)) continue;
      const rowId = (structures.get(String(r.entry_id)) || []).find((x) => x.key === String(r.field_key))?.id;
      if (!rowId) continue;
      conn.run('INSERT INTO entry_attach (entry_field_id, attachment_id, role, position, note, created_at) VALUES (:a,:b,:c,:d,:e,:f)', {
        a: rowId, b: r.attachment_id, c: r.role, d: r.position, e: r.note, f: r.created_at,
      });
    }
    // 删除钩子：条目/栏目/字段被删 → 指向它的内部指针行软删（UPDATE deleted_at）。
    // 判据直接问**刚插好的行**（同一事务里读得到自己的写）。
    // v3：field 指针挂在条目结构行上（target_key = entry_fields.id）。
    for (const p of livePointers) {
      const kind = String(p.kind);
      const target = String(p.target_key);
      let exists = false;
      if (kind === 'section') exists = !!conn.get('SELECT 1 AS x FROM sections WHERE id = :t', { t: target });
      else if (kind === 'entry') exists = !!conn.get('SELECT 1 AS x FROM entries WHERE id = :t', { t: target });
      else if (kind === 'field') exists = !!conn.get('SELECT 1 AS x FROM entry_fields WHERE id = :t', { t: target });
      if (!exists) {
        conn.run('UPDATE attachments SET deleted_at = :at, updated_at = :at WHERE id = :id', { at, id: String(p.id) });
      }
    }

    // ── 7. rev 前进（CAS 语义：锁已在 BEGIN IMMEDIATE 拿到，curRev 不会漂）──
    const newRev = curRev + 1;
    setRev(conn, newRev, at);
    return newRev;
  }, { db, mode: 'IMMEDIATE' });
}

/**
 * 写/修正条目自身结构行（quickAdd 之后由 service 调用）：
 * 占位行（writeStore 建的 type=text）按推断出的 FieldDef 归正——
 * 行存在则 UPDATE label/type/hint/spec/fill（position 不动），不存在则追加到末尾。
 * template_field_id：键在栏目字典里 → 复合串（出身模板），否则 NULL（扩展字段）。
 */
export function upsertEntryFieldRows(conn: Conn, entryId: string, defs: FieldDef[]): void {
  if (!defs.length) return;
  const entry = conn.get('SELECT section_id FROM entries WHERE id = :id', { id: entryId });
  if (!entry) return;
  const sectionId = String(entry.section_id);
  for (const d of defs) {
    const def = d as unknown as Record<string, unknown>;
    const key = String(def.key);
    const id = entryFieldId(entryId, key);
    const templateFieldId = conn.get('SELECT 1 AS x FROM fields WHERE section_id = :s AND key = :k', { s: sectionId, k: key })
      ? fieldTargetKey(sectionId, key)
      : null;
    // node:sqlite 拒绝 SQL 里不存在的命名参数——UPDATE 与 INSERT 各传自己那份。
    const shape = {
      templateFieldId,
      label: String(def.label ?? key),
      type: String(def.type || 'text'),
      hint: String(def.hint ?? ''),
      spec: JSON.stringify(def),
      fill: fillMirror(def),
    };
    if (conn.get('SELECT 1 AS x FROM entry_fields WHERE id = :id', { id })) {
      conn.run('UPDATE entry_fields SET template_field_id = :templateFieldId, label = :label, type = :type, hint = :hint, spec = :spec, fill = :fill WHERE id = :id', { id, ...shape });
    } else {
      const maxPos = Number(conn.scalar('SELECT COALESCE(MAX(position), -1) AS m FROM entry_fields WHERE entry_id = :entryId', { entryId }) ?? -1);
      conn.run(`INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
        VALUES (:id, :entryId, :templateFieldId, :key, :label, :type, :hint, :spec, :fill, :position, '{}')`,
        { id, entryId, key, ...shape, position: maxPos + 1 });
    }
  }
}

/**
 * 任务 #20：条目级字段移除的两个直接写（不动 Store 对象，所以走独立事务 + rev 前进）。
 *
 * detach/restore = 只翻 meta 的 `detached` 标记：行、值、边全保留（restore 即原样回来）。
 * 两者都 bump rev：拿着「移除前 values」的旧 Store 对象再提交会撞 BLOCKED，
 * 而不是把已硬删的行经「values 缺行补占位行」静默复活，或把脱离键的值覆进隐藏行。
 * 行不存在返回 false（调用方据此报 NOT_FOUND，事务里不落任何写）。
 */
export function setEntryFieldDetached(db: Conn, entryId: string, rowId: string, detached: boolean): boolean {
  return tx((conn) => {
    const r = conn.get('SELECT meta FROM entry_fields WHERE id = :id AND entry_id = :entryId', { id: rowId, entryId });
    if (!r) return false;
    const meta = parseJson(r.meta, {}) as Record<string, unknown>;
    if (detached) meta.detached = 1;
    else delete meta.detached;
    conn.run('UPDATE entry_fields SET meta = :meta WHERE id = :id', { meta: JSON.stringify(meta), id: rowId });
    setRev(conn, getRev(conn) + 1, nowIso());
    return true;
  }, { db, mode: 'IMMEDIATE' });
}

/**
 * 条目结构行的**属性**更新（任务 #24 验收反馈：块头「⋯ → 编辑字段」）。
 *
 * 只改这一条的显示名与描述：`label` / `hint` 两个镜像列 + `spec` 里的同名字段
 * （spec 是 FieldDef 的保真源，资源定位与面板读的都是它——不同步就会出现
 * 「块头显示新名、引用浮层显示旧名」）。**不动栏目字典**（写时复制纪律），
 * 值（field_data）也不碰。行不存在返回 false，调用方据此报 NOT_FOUND。
 */
export function updateEntryFieldDef(
  db: Conn,
  entryId: string,
  rowId: string,
  patch: { label?: string; hint?: string },
): boolean {
  return tx((conn) => {
    const r = conn.get('SELECT label, hint, spec FROM entry_fields WHERE id = :id AND entry_id = :entryId', { id: rowId, entryId });
    if (!r) return false;
    const spec = parseJson(r.spec, {}) as Record<string, unknown>;
    const label = patch.label !== undefined ? patch.label : String(r.label ?? spec.label ?? '');
    const hint = patch.hint !== undefined ? patch.hint : String(r.hint ?? spec.hint ?? '');
    spec.label = label;
    spec.hint = hint;
    conn.run('UPDATE entry_fields SET label = :label, hint = :hint, spec = :spec WHERE id = :id', {
      label, hint, spec: JSON.stringify(spec), id: rowId,
    });
    setRev(conn, getRev(conn) + 1, nowIso());
    return true;
  }, { db, mode: 'IMMEDIATE' });
}

/** 扩展行硬删：field_data / entry_attach 随 CASCADE 走；kind='field' 的内部指针按删除钩子口径软删。 */
export function deleteEntryFieldRow(db: Conn, entryId: string, rowId: string): boolean {
  return tx((conn) => {
    const r = conn.get('SELECT 1 AS x FROM entry_fields WHERE id = :id AND entry_id = :entryId', { id: rowId, entryId });
    if (!r) return false;
    const at = nowIso();
    conn.run('DELETE FROM entry_fields WHERE id = :id', { id: rowId });
    // v5 没有外键，历史随结构行一起显式删（行没了，版本不该留）。
    conn.run('DELETE FROM field_history WHERE entry_field_id = :id', { id: rowId });
    conn.run("UPDATE attachments SET deleted_at = :at, updated_at = :at WHERE kind = 'field' AND target_key = :id AND deleted_at IS NULL", { at, id: rowId });
    setRev(conn, getRev(conn) + 1, at);
    return true;
  }, { db, mode: 'IMMEDIATE' });
}

/**
 * sync 第二阶段：把栏目字典传播到存量条目的结构行（只增不改）。
 * 每个条目缺的模板行补上（position 追加）；**新行**若字典 default_value 非空 → 落默认值
 * （已有行不回刷——用户主动留空的格子不该被 sync 填上）。
 */
export function propagateSectionTemplate(conn: Conn, sectionId: string): { entries: number; fieldsAdded: number; defaultsFilled: number } {
  const dict = conn.all('SELECT * FROM fields WHERE section_id = :s ORDER BY sort, rowid', { s: sectionId }) as Row[];
  const entryRows = conn.all('SELECT * FROM entries WHERE section_id = :s ORDER BY rowid', { s: sectionId }) as Row[];
  const at = nowIso();
  const insRow = `INSERT INTO entry_fields (id, entry_id, template_field_id, key, label, type, hint, spec, fill, position, meta)
    VALUES (:id, :entryId, :templateFieldId, :key, :label, :type, :hint, :spec, :fill, :position, '{}')`;
  const insData = `INSERT INTO field_data (id, entry_field_id, value, created_at, updated_at)
    VALUES (:id, :entryFieldId, :value, :at, :at)`;
  let touched = 0;
  let fieldsAdded = 0;
  let defaultsFilled = 0;

  for (const e of entryRows) {
    const entryId = String(e.id);
    const have = new Set((conn.all('SELECT key FROM entry_fields WHERE entry_id = :id', { id: entryId }) as Row[]).map((r) => String(r.key)));
    let maxPos = Number(conn.scalar('SELECT COALESCE(MAX(position), -1) AS m FROM entry_fields WHERE entry_id = :id', { id: entryId }) ?? -1);
    let changed = false;
    for (const f of dict) {
      const key = String(f.key);
      if (have.has(key)) continue;
      maxPos += 1;
      const id = entryFieldId(entryId, key);
      conn.run(insRow, {
        id, entryId, templateFieldId: fieldTargetKey(sectionId, key), key,
        label: String(f.label ?? key), type: String(f.type || 'text'), hint: String(f.hint ?? ''),
        spec: String(f.spec ?? '{}'),
        fill: fillMirror(f),
        position: maxPos,
      });
      fieldsAdded += 1;
      changed = true;
      if (f.default_value != null && String(f.default_value) !== '') {
        conn.run(insData, { id: fieldDataId(id), entryFieldId: id, value: String(f.default_value), at });
        defaultsFilled += 1;
      }
    }
    if (changed) touched += 1;
  }
  return { entries: touched, fieldsAdded, defaultsFilled };
}

/**
 * 一致性检查：kind ∈ ('section','entry','field') 且 deleted_at IS NULL 且 target
 * 不存在 → 漂移（删除钩子该软删却没删到的现场，比如有人绕过 facade 直接删行）。
 * @returns 漂移的指针行
 */
export function findDriftedPointers(db: Conn): Row[] {
  const out: Row[] = [];
  for (const kind of POINTER_KINDS) {
    const rows = db.all(
      "SELECT id, kind, target_key FROM attachments WHERE kind = :kind AND deleted_at IS NULL ORDER BY rowid",
      { kind },
    );
    for (const r of rows) {
      const target = String(r.target_key);
      if (kind === 'section') {
        if (!db.get('SELECT 1 AS x FROM sections WHERE id = :t', { t: target })) out.push(r);
      } else if (kind === 'entry') {
        if (!db.get('SELECT 1 AS x FROM entries WHERE id = :t', { t: target })) out.push(r);
      } else {
        // v3：field 指针的 target_key 是条目结构行 id（entry_fields.id）。
        if (!db.get('SELECT 1 AS x FROM entry_fields WHERE id = :t', { t: target })) out.push(r);
      }
    }
  }
  return out;
}
