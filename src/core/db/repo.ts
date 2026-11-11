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

import { fileReferences, MIME_TYPES, type FileRecord } from '../attachments.ts';
import { nowIso } from '../ids.ts';
import { blocked } from '../errors.ts';
import { getMeta, setMeta } from './migrator.ts';
import { tx } from './tx.ts';
import type { Conn, Row } from './driver.ts';
import type { Store, StoreEntry, StoreSection } from '../store-shape.ts';
import { STORE_VERSION } from '../store-shape.ts';
import { POINTER_KINDS } from './identity.ts';

/** 读出来的「未过 normalize 的 json 形状」+ 当时的 rev（facade 拿去收口/记账）。 */
export interface LoadedRaw {
  raw: Store;
  rev: number;
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

/**
 * 读：SELECT 组装出 store.json 时代的形状（**不做旧版本兼容**——
 * 行是 normalize 之后写进去的，version 恒为 STORE_VERSION）。
 */
export function readStore(db: Conn): LoadedRaw {
  const sectionRows = db.all('SELECT * FROM sections ORDER BY rowid');
  const groupRows = db.all('SELECT * FROM groups ORDER BY section_id, sort, rowid');
  const fieldRows = db.all('SELECT * FROM fields ORDER BY section_id, sort, rowid');
  const entryRows = db.all('SELECT * FROM entries ORDER BY rowid');
  const fileRows = db.all("SELECT * FROM attachments WHERE kind = 'file' AND deleted_at IS NULL ORDER BY rowid");
  const settingRows = db.all('SELECT key, value FROM settings ORDER BY key');

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

  const entries = entryRows.map((e): StoreEntry => ({
    id: String(e.id),
    section: String(e.section_id),
    title: String(e.title ?? ''),
    tags: (parseJson(e.tags, []) as unknown[]).map(String),
    values: parseJson(e.values, {}) as Record<string, unknown>,
    createdAt: e.created_at == null ? null : String(e.created_at),
    updatedAt: e.updated_at == null ? null : String(e.updated_at),
  }));

  const files = fileRows.map((f) => parseJson(f.meta, null) as FileRecord | null).filter((x): x is FileRecord => !!x);

  const settings: Record<string, unknown> = {};
  for (const row of settingRows) settings[String(row.key)] = parseJson(row.value, null);

  return {
    raw: { version: STORE_VERSION, settings: settings as unknown as Store['settings'], sections, entries, files },
    rev: getRev(db),
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

    // ── 1. 捕获要跨重写存活的三类东西 ──
    // 显式边（role ≠ inline）：全量重写只重算 inline；attach/source 是用户
    // 未来的显式挂载，删了就丢，先捞出来、父行还在就原样放回去。
    const explicitEntryEdges = conn.all("SELECT * FROM entry_attach WHERE role <> 'inline'");
    const explicitSectionEdges = conn.all("SELECT * FROM section_attach WHERE role <> 'inline'");
    const explicitFieldEdges = conn.all("SELECT * FROM field_attach WHERE role <> 'inline'");
    // 分组 declared：原地保留（新出现的分组才算「声明」；自愈行由导入 hint 或读路径决定）。
    const declaredBefore = new Map<string, number>();
    for (const g of conn.all('SELECT section_id, id, declared FROM groups')) {
      declaredBefore.set(`${String(g.section_id)}\u0000${String(g.id)}`, Number(g.declared));
    }
    // 内部指针（section/entry/field）：attachments 里**不被全量重写删除**的行，
    // 删除钩子只软删（见第 5 步）。
    const livePointers = conn.all(
      `SELECT id, kind, target_key FROM attachments WHERE kind IN ('section','entry','field') AND deleted_at IS NULL`,
    );

    // ── 2. 清空投影（CASCADE 带走 groups/fields/entries/三张边表）──
    // file/url 资源行由 store.files 重建；内部指针行**不删**（它们是软删语义的对象）。
    conn.exec('DELETE FROM sections');
    conn.run('DELETE FROM attachments WHERE kind IN (\'file\', \'url\')');
    conn.exec('DELETE FROM settings');

    // ── 3. 行插入（数组顺序 = rowid 顺序 = 读回顺序；sort 列显式化字段/分组顺序）──
    const insSection = `INSERT INTO sections (id, title, description, "order", template, kv, title_field, title_label, layout, created_at, updated_at)
      VALUES (:id, :title, :description, :order, :template, :kv, :titleField, :titleLabel, :layout, :createdAt, :updatedAt)`;
    const insGroup = 'INSERT INTO groups (section_id, id, title, sort, declared) VALUES (:sectionId, :id, :title, :sort, :declared)';
    const insField = `INSERT INTO fields (section_id, key, label, type, group_id, fill, hint, sensitive, sort, spec)
      VALUES (:sectionId, :key, :label, :type, :groupId, :fill, :hint, :sensitive, :sort, :spec)`;
    const insEntry = `INSERT INTO entries (id, section_id, title, tags, "values", created_at, updated_at)
      VALUES (:id, :sectionId, :title, :tags, :values, :createdAt, :updatedAt)`;
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
        });
      });
    }
    for (const e of store.entries) {
      conn.run(insEntry, {
        id: e.id, sectionId: e.section, title: e.title,
        tags: JSON.stringify(e.tags || []), values: JSON.stringify(e.values || {}),
        createdAt: e.createdAt ?? null, updatedAt: e.updatedAt ?? null,
      });
    }
    for (const [k, v] of Object.entries(store.settings || {})) {
      conn.run(insSetting, { key: k, value: JSON.stringify(v === undefined ? null : v), at });
    }

    // ── 4. 资源行 + inline 边 ──
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
    // 规则只此一份），field_key 填来源字段。显式边在第 5 步放回去。
    const insEntryEdge = `INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at)
      VALUES (:entryId, :attachmentId, :fieldKey, 'inline', :position, '', :at)`;
    for (const rec of store.files) {
      const refs = fileReferences(store, rec);
      refs.forEach((r, i) => {
        conn.run(insEntryEdge, { entryId: r.entryId, attachmentId: rec.id, fieldKey: r.fieldKey, position: i, at });
      });
    }

    // ── 5. 放回显式边 + 删除钩子（软删指向已消失目标的内部指针）──
    const sectionIds = new Set(store.sections.map((s) => s.id));
    const entryIds = new Set(store.entries.map((e) => e.id));
    const fieldKeys = new Set(store.sections.flatMap((s) => (s.fields || []).map((f) => `${s.id}\u0000${String((f as unknown as Record<string, unknown>).key)}`)));
    // 边的另一端：file 行刚重建、内部指针行从不物理删——统一问**当前事务里的表**
    // （deleted_at IS NULL 的活行才算存在；指向已软删指针的显式边随父行一起消失）。
    const liveAttachment = (id: unknown) =>
      !!conn.get('SELECT 1 AS x FROM attachments WHERE id = :id AND deleted_at IS NULL', { id: String(id) });
    for (const r of explicitEntryEdges) {
      if (!entryIds.has(String(r.entry_id)) || !liveAttachment(r.attachment_id)) continue;
      conn.run('INSERT INTO entry_attach (entry_id, attachment_id, field_key, role, position, note, created_at) VALUES (:a,:b,:c,:d,:e,:f,:g)', {
        a: r.entry_id, b: r.attachment_id, c: r.field_key, d: r.role, e: r.position, f: r.note, g: r.created_at,
      });
    }
    for (const r of explicitSectionEdges) {
      if (!sectionIds.has(String(r.section_id)) || !liveAttachment(r.attachment_id)) continue;
      conn.run('INSERT INTO section_attach (section_id, attachment_id, role, position, note, created_at) VALUES (:a,:b,:c,:d,:e,:f)', {
        a: r.section_id, b: r.attachment_id, c: r.role, d: r.position, e: r.note, f: r.created_at,
      });
    }
    for (const r of explicitFieldEdges) {
      const sid = String(r.section_id);
      if (!fieldKeys.has(`${sid}\u0000${String(r.field_key)}`) || !liveAttachment(r.attachment_id)) continue;
      conn.run('INSERT INTO field_attach (section_id, field_key, attachment_id, role, position, note, created_at) VALUES (:a,:b,:c,:d,:e,:f,:g)', {
        a: sid, b: r.field_key, c: r.attachment_id, d: r.role, e: r.position, f: r.note, g: r.created_at,
      });
    }
    // 删除钩子：条目/栏目/字段被删 → 指向它的内部指针行软删（UPDATE deleted_at）。
    // 判据直接问**刚插好的行**（同一事务里读得到自己的写）。
    for (const p of livePointers) {
      const kind = String(p.kind);
      const target = String(p.target_key);
      let exists = false;
      if (kind === 'section') exists = !!conn.get('SELECT 1 AS x FROM sections WHERE id = :t', { t: target });
      else if (kind === 'entry') exists = !!conn.get('SELECT 1 AS x FROM entries WHERE id = :t', { t: target });
      else if (kind === 'field') {
        const i = target.indexOf(':');
        exists = i > 0 && !!conn.get('SELECT 1 AS x FROM fields WHERE section_id = :s AND key = :k', {
          s: target.slice(0, i), k: target.slice(i + 1),
        });
      }
      if (!exists) {
        conn.run('UPDATE attachments SET deleted_at = :at, updated_at = :at WHERE id = :id', { at, id: String(p.id) });
      }
    }

    // ── 6. rev 前进（CAS 语义：锁已在 BEGIN IMMEDIATE 拿到，curRev 不会漂）──
    const newRev = curRev + 1;
    setRev(conn, newRev, at);
    return newRev;
  }, { db, mode: 'IMMEDIATE' });
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
        const i = target.indexOf(':');
        const ok = i > 0 && db.get('SELECT 1 AS x FROM fields WHERE section_id = :s AND key = :k', {
          s: target.slice(0, i), k: target.slice(i + 1),
        });
        if (!ok) out.push(r);
      }
    }
  }
  return out;
}
