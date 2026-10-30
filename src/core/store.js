// 状态读写：原子写 + 按 mtime 失效的缓存 + 读-改-写事务 + 版本迁移。
// 所有模块都通过这里碰磁盘，不自己拼路径、不自己 JSON.parse。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { displayPath, migrationDir, storeFile } from './paths.js';
import { ensureDir, pathExists, writeAtomic } from './fsx.js';
import { ensureSourceBuiltin, instantiateTemplate, seedEntries, seedSections, syncSectionGroups } from './fields.js';
import { normalizeFileRecord } from './attachments.js';
// 块（entry.body）的归一在 shared/blocks.js —— 与 shared/table.js 同一条理由：
// 面板不许 import core，而「块怎么算合法」只允许有一份实现。core→shared 允许（见 eslint 注释）。
import { normalizeBlocks } from '../shared/blocks.js';
// 视图配置（section.views）的归一同样在 shared —— 理由同上：面板不许 import core，
// 而「什么算合法视图」只能有一份实现。
import { normalizeViews } from '../shared/views.js';
import { blocked } from './errors.js';
import { nowIso, stamp } from './ids.js';

/** v2：密钥栏目从 8 字段模板改成单字段 KV（名称 → 值）。
 *  v3：栏目有了 `kv` 标记——KV 栏目是一张表（面板渲染成表格，key 命令默认作用在它上面），
 *      并去掉 `settings.kvSection` 这个冗余概念。
 *  v4：条目有了 `body?: Block[]`（块正文，递归）。**只加可选键**，没有迁移函数——
 *      老条目没有 body 就是没有；normalize 会把非法块丢掉，存量数据读一次即安全。
 *      反方向的降级没有保护：老代码读 v4 会把 body 丢掉（白名单重建），所以 v4 必须**拒绝老代码写**。 */
export const STORE_VERSION = 4;

export function defaultSettings() {
  return {
    defaultSection: 'demo',
    // 头部导航分组：[{ title, sections: [栏目 id…] }]，数组顺序 = 显示顺序。
    // 缺省空数组 = 全部栏目平铺（保持老行为）；栏目建得多了再在设置页收拢。
    navGroups: [],
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
    // 示例条目跟着「字段样例」栏目一起播种：没有它，那些字段就只是空格子，
    // 「感受能力边界」就少了最有说服力的那部分。
    entries: seed ? seedEntries(at) : [],
    files: [],
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
  // 「原始资料」袋是每个非 KV 栏目自带的结构（不是可选字段）：存量栏目缺了
  // 读一次就补上，与上面的分组自愈同一条收口路径。规则只此一份，见 ensureSourceBuiltin。
  const ensured = ensureSourceBuiltin(out.groups, out.fields, { kv: out.kv });
  out.groups = ensured.groups;
  out.fields = ensured.fields;
  // 数据库视图（v4 同批）：同样是**可选键**。缺席 = 还没配过，读路径推断一套缺省视图
  // （不落盘，见 shared/views.js 的文件头）。空数组等价于缺席——存一个 `views: []`
  // 只会让「还没配过」和「配过又删光」两件事看起来不一样，实际行为必须一样。
  const views = normalizeViews(raw.views);
  if (views.length) out.views = views;
  // defaultView 必须指向一个**真的存在**的视图；指向空气就丢掉（读的时候退回第一个），
  // 否则面板切到缺省视图时会拿到一个不存在的 id。
  if (raw.defaultView && views.some((v) => v.id === raw.defaultView)) out.defaultView = String(raw.defaultView);
  return out;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const out = {
    id: String(raw.id),
    section: String(raw.section || ''),
    title: String(raw.title || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    values: raw.values && typeof raw.values === 'object' ? { ...raw.values } : {},
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
  // 块正文（v4）：**可选键**，缺席就是没有（不补一个空数组，否则老条目会被无意义地改写）。
  // 非法块在这里丢掉 —— normalize 是每条读写路径的必经点，坏数据读一次即安全。
  if (Array.isArray(raw.body)) out.body = normalizeBlocks(raw.body);
  return out;
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
  base.files = (Array.isArray(data.files) ? data.files : []).map(normalizeFileRecord).filter(Boolean);
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
// 磁盘上那份 store 的版本号 —— 它可以**大于** STORE_VERSION（用户降级跑老代码）。
// normalize 会把版本抹成当前值，所以磁盘版本必须在这里单独记，否则降级守卫就无从判断。
let cacheDiskVersion = STORE_VERSION;

/** 最近一次读盘时的磁盘版本（bootstrap / health 展示「store 由更新版本写入」用）。 */
export function diskVersion() {
  return cacheDiskVersion;
}

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
    cacheDiskVersion = oldVersion;
    const next = normalize(parsed);

    if (!corrupt && oldVersion < STORE_VERSION && next._migration) {
      // 迁移前先把**原始文件**原样留一份（不是迁移后的），出问题能整份退回
      const snapshot = join(migrationDir(), `${stamp()}-migrate-v${oldVersion}-to-v${STORE_VERSION}.json`);
      await ensureDir(migrationDir());
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
      cacheDiskVersion = STORE_VERSION;
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
    cacheDiskVersion = STORE_VERSION;
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storeFile();
  // **降级守卫**（设计 §十一 11.4）：磁盘上的 store 由更新版本写入时，拒绝一切写入。
  // 否则老代码的白名单 normalize 会把新版本才有的键（比如 v4 的 body）**静默丢掉**——
  // 用户降级跑一次、保存一次，块正文就永久没了，而且没有任何报错。
  if (cacheDiskVersion > STORE_VERSION) {
    throw blocked(
      `这份 store 由更新版本的 nx-sk 写入（磁盘版本 v${cacheDiskVersion} > 当前 v${STORE_VERSION}）。`
      + '为避免丢掉新版本才有的数据（块正文等），已拒绝写入。请升级 nx-sk 后再修改。',
    );
  }
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

export async function storeExists() {
  return pathExists(storeFile());
}
