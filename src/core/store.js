// 状态读写：原子写 + 按 mtime 失效的缓存 + 读-改-写事务 + 版本迁移。
// 所有模块都通过这里碰磁盘，不自己拼路径、不自己 JSON.parse。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { displayPath, snapshotDir, storeFile } from './paths.js';
import { ensureDir, pathExists, writeAtomic, writeJsonAtomic } from './fsx.js';
import { instantiateTemplate, seedSections, syncSectionGroups } from './fields.js';
import { nowIso, stamp } from './ids.js';

/** v2：密钥栏目从 8 字段模板改成单字段 KV（名称 → 值）。
 *  v3：栏目有了 `kv` 标记——KV 栏目是一张表（面板渲染成表格，key 命令默认作用在它上面），
 *      并去掉 `settings.kvSection` 这个冗余概念。 */
export const STORE_VERSION = 3;
export const MAX_SNAPSHOTS = 20;
export const MAX_EXPORT_HISTORY = 30;

export function defaultSettings() {
  return {
    exportDir: '', // 空 = ~/nx-sk/export
    exportFormat: 'both', // json | md | both
    includeSecretsInExport: true, // 默认含明文：本机单人工具，自己看不拦自己
    defaultSection: 'job',
  };
}

function emptyStore(seed) {
  const at = nowIso();
  return {
    version: STORE_VERSION,
    settings: defaultSettings(),
    // 只有「store 文件压根不存在」才播种。文件在、但 sections 为空
    // 说明用户自己删光了栏目——这时候再播种会把它变回来，等于删不掉。
    sections: seed ? seedSections(at) : [],
    entries: [],
    exports: [],
  };
}

function normalizeSection(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const out = {
    id: String(raw.id),
    title: String(raw.title || raw.id),
    description: String(raw.description || ''),
    order: Number.isFinite(raw.order) ? raw.order : 50,
    template: raw.template ? String(raw.template) : null,
    kv: raw.kv === true,
    titleField: raw.titleField ? String(raw.titleField) : null,
    titleLabel: String(raw.titleLabel || '名称'),
    groups: Array.isArray(raw.groups) ? raw.groups.map((g) => ({ id: String(g.id), title: String(g.title || g.id) })) : [],
    fields: Array.isArray(raw.fields) ? raw.fields.map((x) => ({ ...x, key: String(x.key), label: String(x.label || x.key) })) : [],
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
  // 「分组声明 ⊇ 字段引用」是栏目不变量：字段引用了没声明的分组，面板的分组表单
  // 会整组消失（真实事故：servers 栏目 groups 为空，Web 端白屏而 CLI 正常）。
  // 放在 normalize 收口——每条读写路径都会过这里，存量数据读一次就自愈。
  out.groups = syncSectionGroups(out.groups, out.fields);
  return out;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    section: String(raw.section || ''),
    title: String(raw.title || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    values: raw.values && typeof raw.values === 'object' ? { ...raw.values } : {},
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

// v1 的密钥模板字段。迁移时**不动 values 里这些键**——只把 keyValue 搬到 value，
// 并把字典缩成单字段。「不再显示」和「删掉」是两件事：删掉就再也找不回来了。
const LEGACY_SECRET_KEYS = ['keyValue', 'provider', 'baseUrl', 'model', 'purpose', 'expiresAt', 'quota', 'note'];

/**
 * v1 → v2：把「密钥」栏目从 8 字段模板迁成单字段 KV。
 *
 * 幂等：只有 `version < 2` 才调用，且落盘后 version 变 2，不会再触发。
 */
function migrateSecretToKv(store) {
  const sec = store.sections.find((s) => s.id === 'secret');
  if (!sec) return null;
  const looksLegacy = sec.fields.some((x) => LEGACY_SECRET_KEYS.includes(x.key))
    && !sec.fields.some((x) => x.key === 'value');
  if (!looksLegacy) return null;

  const tpl = instantiateTemplate('secret', { id: sec.id, title: sec.title, order: sec.order });
  const moved = [];
  for (const e of store.entries.filter((x) => x.section === sec.id)) {
    const v = e.values || (e.values = {});
    const empty = v.value === undefined || v.value === null || v.value === '';
    if (empty && v.keyValue !== undefined && v.keyValue !== null && v.keyValue !== '') {
      v.value = v.keyValue;
      moved.push(e.id);
    }
  }
  sec.groups = tpl.groups;
  sec.fields = tpl.fields;
  sec.titleField = tpl.titleField;
  sec.titleLabel = tpl.titleLabel;
  sec.template = 'secret';
  sec.description = tpl.description;
  sec.updatedAt = nowIso();

  const stillHolding = store.entries
    .filter((e) => e.section === sec.id)
    .reduce((n, e) => n + LEGACY_SECRET_KEYS.filter((k) => k !== 'keyValue'
      && e.values?.[k] !== undefined && e.values?.[k] !== null && e.values?.[k] !== '').length, 0);

  return {
    section: sec.id,
    fieldsBefore: LEGACY_SECRET_KEYS.length + 1,
    fieldsAfter: tpl.fields.length,
    entries: store.entries.filter((e) => e.section === sec.id).length,
    movedValues: moved.length,
    legacyValuesKept: stillHolding,
  };
}

/**
 * v2 → v3：把「密钥」栏目标成 KV 表，并把误当字段用的键值搬进值列。
 *
 * 背景：面板早先那行「KV 直填」在 KV 栏目里也把 `089=xxx` 当成**新字段**登记了
 * （字段名 = `089`），而用户的本意是「加一个新键」。这里把「唯一一个非空且不是 value
 * 的字段值」搬进 value —— 该条目就变成「标题 = 键名，value = 值」的正常样子。
 * 其余留在 values 里的键**一律不删**（不再显示 ≠ 删掉）。
 */
function migrateKvToTable(store, oldSettings) {
  const marked = store.sections.filter((s) => s.kv);
  const target = marked[0]
    || store.sections.find((s) => s.id === String(oldSettings?.kvSection || 'secret'));
  if (!target) return null;

  const tpl = instantiateTemplate('secret', { id: target.id, title: target.title, order: target.order });
  const fieldsBefore = target.fields.length;
  const moved = [];

  for (const e of store.entries.filter((x) => x.section === target.id)) {
    const v = e.values || (e.values = {});
    const valueEmpty = v.value === undefined || v.value === null || v.value === '';
    if (!valueEmpty) continue;
    const others = Object.keys(v).filter((k) => k !== 'value' && v[k] !== undefined && v[k] !== null && v[k] !== '');
    if (others.length === 1) { v.value = v[others[0]]; moved.push(`${e.title}:${others[0]}`); }
  }

  target.kv = true;
  target.fields = tpl.fields;
  target.groups = tpl.groups;
  target.titleField = tpl.titleField;
  target.titleLabel = tpl.titleLabel;
  target.template = 'secret';
  target.description = tpl.description;
  target.updatedAt = nowIso();

  return {
    section: target.id,
    fieldsBefore,
    fieldsAfter: tpl.fields.length,
    movedValues: moved.length,
    movedDetail: moved,
  };
}

export function normalize(data) {
  if (!data || typeof data !== 'object') return emptyStore(true);
  const oldVersion = Number(data.version || 1);
  const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const base = emptyStore(false);
  base.version = STORE_VERSION;
  base.settings = { ...base.settings, ...rawSettings };
  // v3 起 kvSection 没了：哪个栏目是 KV，由栏目自己的 kv 标记说了算
  delete base.settings.kvSection;
  base.sections = (Array.isArray(data.sections) ? data.sections : []).map(normalizeSection).filter(Boolean);
  base.entries = (Array.isArray(data.entries) ? data.entries : []).map(normalizeEntry).filter(Boolean);
  base.exports = Array.isArray(data.exports) ? data.exports.slice(0, MAX_EXPORT_HISTORY) : [];
  if (oldVersion < 2) base._migration = migrateSecretToKv(base);
  if (oldVersion < 3) {
    const m = migrateKvToTable(base, rawSettings);
    if (m) base._migration = { ...(base._migration || {}), ...m };
  }
  return base;
}

let cache = null;
let cachePath = null;
let cacheMtime = -1;
let cacheCorruptNote = null;
let cacheMigrationNote = null;

export function storePathInUse() {
  return storeFile();
}

/** 最近一次读盘时把损坏文件挪走的记录（bootstrap / health 会展示）。 */
export function corruptNote() {
  return cacheCorruptNote;
}

/** 最近一次数据迁移的记录（含原始快照路径），供 bootstrap 展示。 */
export function migrationNote() {
  return cacheMigrationNote;
}

export async function loadStore(explicitPath) {
  const p = explicitPath || storeFile();
  try {
    const st = await fsp.stat(p);
    if (cache && cachePath === p && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    let parsed = null;
    let corrupt = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 读失败**降级返回空结构**（工具不该启动即崩），但先把损坏文件留一份——
      // 直接返回空结构的话，下一次写入就把用户的数据永久覆盖了。
      corrupt = join(p + '.corrupt-' + stamp() + '.json');
      try { await fsp.rename(p, corrupt); } catch { /* 尽力 */ }
      cacheCorruptNote = { from: p, to: corrupt, error: String(e && e.message) };
    }
    const oldVersion = Number((parsed && parsed.version) || 1);
    const next = normalize(parsed);

    if (!corrupt && oldVersion < STORE_VERSION && next._migration) {
      // 迁移前先把**原始文件**原样留一份（不是迁移后的），出问题能整份退回
      const snapshot = join(snapshotDir(), `${stamp()}-migrate-v${oldVersion}-to-v${STORE_VERSION}.json`);
      await ensureDir(snapshotDir());
      try { await fsp.copyFile(p, snapshot); } catch { /* 尽力 */ }
      cacheMigrationNote = {
        from: oldVersion,
        to: STORE_VERSION,
        snapshot: displayPath(snapshot),
        snapshotRaw: snapshot,
        ...next._migration,
      };
      delete next._migration;
      // 就地落盘：version 写进去之后就不会再迁移（幂等）
      await saveStore(next, p);
      return next;
    }

    delete next._migration;
    cache = next;
    cachePath = p;
    // 解析失败时文件已被挪走，mtime 用 -1 强制下次重新判断
    cacheMtime = corrupt ? -1 : st.mtimeMs;
    return cache;
  } catch {
    cache = emptyStore(true);
    cachePath = p;
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storeFile();
  const data = normalize(next);
  delete data._migration;
  await ensureDir(join(p, '..'));
  // 原子写：临时文件 + rename。中断时用户要么看到旧数据，要么看到新数据。
  await writeAtomic(p, JSON.stringify(data, null, 2) + '\n');
  cache = data;
  cachePath = p;
  cacheMtime = -1;
  try { cacheMtime = (await fsp.stat(p)).mtimeMs; } catch { /* 保持 -1 */ }
  return data;
}

/**
 * 读-改-写事务：fn 直接改传入的**深拷贝**；抛错则不落盘。
 * structuredClone 是必需的——直接改缓存对象会让「抛错不落盘」名存实亡。
 */
export async function mutateStore(fn, explicitPath) {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

/** 破坏性写入前留一份可回滚快照。 */
export async function snapshotStore(reason, explicitPath) {
  const cur = await loadStore(explicitPath);
  const dir = snapshotDir();
  await ensureDir(dir);
  const file = join(dir, `${stamp()}-${reason}.json`);
  await writeJsonAtomic(file, cur);
  await pruneSnapshots(dir);
  return file;
}

async function pruneSnapshots(dir) {
  try {
    const items = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    const extra = items.length - MAX_SNAPSHOTS;
    for (let i = 0; i < extra; i++) await fsp.rm(join(dir, items[i]), { force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

export async function listSnapshots() {
  const dir = snapshotDir();
  try {
    const items = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort().reverse();
    const out = [];
    for (const name of items.slice(0, MAX_SNAPSHOTS)) {
      const p = join(dir, name);
      const st = await fsp.stat(p);
      out.push({ name, path: p, bytes: st.size, at: st.mtime.toISOString() });
    }
    return out;
  } catch {
    return [];
  }
}

export async function storeExists() {
  return pathExists(storeFile());
}
