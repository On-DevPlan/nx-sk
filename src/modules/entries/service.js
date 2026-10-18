// 条目（entry）：栏目下的一条记录。
// 写敏感字段时加密、读时**默认原文**（只有显式 --mask 才打码）——
// 这条边界只在这里实现一次，两端共用。
//
// 写入分两趟：趟 A（异步，在草稿 section 上跑）解析字段、加密敏感值；
// 趟 B（同步，在 mutateStore 事务里）只做赋值。这样加密只发生在事务外，
// 事务里没有 await，也就没有「改了一半又抛错」的中间态。
import { loadStore, mutateStore } from '../../core/store.js';
import { assertFieldKey } from '../../core/paths.js';
import { badInput, conflict, notFound } from '../../core/errors.js';
import { BOOL_FALSE, BOOL_TRUE, findKvSection, findSection, isSensitiveField, sectionNames } from '../../core/fields.js';
import { completeness, displaySensitive, isBlank, serializeEntry } from '../../core/render.js';
import { newId, nowIso } from '../../core/ids.js';
import { decryptValue, encryptValue, isCipherBlob, maskValue } from '../../core/crypto.js';
import { resolveVaultKey, sensitiveViewer } from '../../core/vault.js';
import * as att from '../../core/attachments.js';
import { mdImageIds, rewriteMdImages } from '../../core/mdimages.js';
import { displayPath } from '../../core/paths.js';

export function mustFindSection(store, ref) {
  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

/** 条目定位：id 优先，其次唯一标题；重名时报 CONFLICT 让调用方用 id 指定。 */
export function resolveEntry(store, ref, sectionRef) {
  const key = String(ref ?? '').trim();
  if (!key) throw badInput('缺少条目定位：给条目 id（e_...）或条目名');
  let list = store.entries;
  if (sectionRef) list = list.filter((e) => e.section === mustFindSection(store, sectionRef).id);
  const byId = list.find((e) => e.id === key);
  if (byId) return byId;
  const byTitle = list.filter((e) => e.title === key);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw conflict(`有 ${byTitle.length} 条同名条目「${key}」，请用 id 指定: ${byTitle.map((e) => e.id).join(' / ')}`);
  }
  throw notFound(`找不到条目: ${ref}`);
}

function mergeInputs(set, data) {
  const out = {};
  if (data && typeof data === 'object') {
    // 兼容 `{values:{...}}` 与直接扁平 `{字段: 值}` 两种写法
    Object.assign(out, data.values && typeof data.values === 'object' ? data.values : data);
  }
  if (set && typeof set === 'object') Object.assign(out, set);
  return out;
}

function resolveFieldDef(section, rawKey) {
  const key = String(rawKey).trim();
  return (section.fields || []).find((x) => x.key === key || x.label === key) || null;
}

/**
 * 把一个没见过的键登记进草稿字典。
 * key 直接用用户敲的那个词（中文也行）——**写什么就存什么**，不必再记一个英文别名。
 */
function registerField(section, rawKey, rawValue) {
  // KV 栏目**拒绝加字段**：它的形状就是「一行一个键值对」，多一个字段就散了。
  // 这里必须报错而不是静默登记 —— 静默的后果是用户看到一堆无意义的字段名
  // （真实事故：面板那行「KV 直填」把 `3123312=xxx` 登记成了字段，而不是一个新键）。
  if (section.kv) {
    const wanted = String(rawKey).trim();
    throw badInput(
      `栏目「${section.title}」是一张 KV 表（一行一个键值对），不能加字段「${wanted}」。`
      + `你要加的应该是一个**键** —— 用 nx-sk key set ${wanted} <值>，`
      + '或在面板的 KV 表格里加一行。',
    );
  }
  const key = assertFieldKey(String(rawKey).trim());
  const def = {
    key,
    label: key,
    type: inferFieldType(rawValue),
    group: section.groups?.[0]?.id || section.fields?.[0]?.group || 'other',
  };
  section.fields.push(def);
  return def;
}

function normalizeValue(def, raw) {
  if (raw === null || raw === undefined) return null;
  const type = def.type;
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (BOOL_TRUE.includes(s)) return true;
    if (BOOL_FALSE.includes(s)) return false;
    throw badInput(`字段「${def.label}」需要是/否，收到 ${JSON.stringify(raw)}`);
  }
  if (type === 'number') {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) throw badInput(`字段「${def.label}」需要数字，收到 ${JSON.stringify(raw)}`);
    return n;
  }
  if (type === 'tags') {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,，、;；\s]+/)).map((x) => x.trim()).filter(Boolean);
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list;
  }
  if (type === 'file') {
    // 值 = 附件 id（或唯一文件名）的**列表**：一个字段可以挂多个附件（简历传多个版本、
    // 头像多张）。id 全局唯一，天然做到「各条目附件互不串台」；同一份原件被多条条目引用
    // 也没问题（sha256 去重后是同一个 id）。
    // **新写入统一存数组**（哪怕只有一个）——形状一致，下游不必到处判「是串还是表」；
    // 历史数据里的字符串单值读时由 fileIdsOf 按单元素处理，不做迁移。
    // 不校验存在性——附件可能被还原/删掉，前端按「引用的附件不存在」展示。
    const list = att.fileIdsOf(Array.isArray(raw) ? raw : String(raw).split(/[,，、;；]+/));
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list.length ? list : null;
  }
  const s = String(raw);
  return s.trim() === '' ? null : s;
}

async function prepareValue(section, def, raw, current) {
  if (!isSensitiveField(section, def.key)) return normalizeValue(def, raw);
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw);
  // 面板把打码后的值原样回传时，必须保留原密文——否则掩码会被当成新密钥存进去
  if (isCipherBlob(current)) {
    try {
      const { key } = await resolveVaultKey();
      if (maskValue(decryptValue(key, current)) === text) return current;
    } catch { /* 解不开就按新值处理 */ }
  }
  if (text.includes('******')) {
    throw badInput(`字段「${def.label}」收到的是打码占位而非明文。给完整值，或用 --unset ${def.key} 清空。`);
  }
  const { key } = await resolveVaultKey();
  return encryptValue(key, text);
}

/**
 * 新字段的类型推断。**刻意不推 number**：
 * 18 位的身份证号 / 长数字 ID 超过 2^53，推成数字会**静默丢精度**。
 * 值仍是字符串，所以「直接存 kv」不会因为类型推断损坏数据。
 */
// 值像不像附件 id（`f_xxxx`）。用来推断「写了一个没登记过的键」该登记成什么类型：
// `--set 简历附件=f_abc` / `--set 简历附件=f_a,f_b` 应当登记成**附件字段**，
// 而不是一个普通文本字段或 tags。
const looksLikeFileId = (x) => typeof x === 'string' && /^f_[0-9a-z]+$/i.test(x.trim());

function inferFieldType(raw) {
  if (Array.isArray(raw)) {
    if (raw.length && raw.every(looksLikeFileId)) return 'file';
    return 'tags';
  }
  if (looksLikeFileId(raw)) return 'file';
  if (typeof raw === 'string') {
    const parts = raw.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length && parts.every(looksLikeFileId)) return 'file';
  }
  if (typeof raw === 'boolean') return 'bool';
  const s = String(raw).trim().toLowerCase();
  if (BOOL_TRUE.includes(s) || BOOL_FALSE.includes(s)) return 'bool';
  return 'text';
}

/**
 * 趟 A：在草稿 section 上解析字段、算出要写进去的值。
 *
 * **不认识的键不再报错**——直接登记进字段字典再写。
 * 字典从「写入的关卡」降级成「已用字段的台账 + 模板给的填写提示」：
 * 用户想存什么键就存什么键，这才是 KV 该有的手感。
 */
async function prepareWrite({ section, currentValues = {}, incoming }) {
  const draft = structuredClone(section);
  const newFields = [];
  const values = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    let def = resolveFieldDef(draft, rawKey);
    if (!def) {
      def = registerField(draft, rawKey, rawValue);
      newFields.push(def);
    }
    values[def.key] = await prepareValue(draft, def, rawValue, currentValues[def.key]);
  }
  return { values, newFields };
}

function autoTitle(section, values) {
  const v = section.titleField ? values[section.titleField] : undefined;
  return v === undefined || v === null || v === '' ? '' : String(v);
}

export async function listEntries({ section, q } = {}) {
  const store = await loadStore();
  let list = store.entries;
  if (section) list = list.filter((e) => e.section === mustFindSection(store, section).id);
  const viewers = new Map();
  const out = [];
  for (const e of list) {
    const sec = store.sections.find((s) => s.id === e.section);
    if (!sec) continue;
    if (!viewers.has(sec.id)) viewers.set(sec.id, await sensitiveViewer(sec, list.filter((x) => x.section === sec.id)));
    const item = serializeEntry(sec, e, { decrypt: viewers.get(sec.id) });
    if (q) {
      // file 字段值是附件 id（可能挂多个），把解析出的附件名都加进搜索文本，
      // 才能按「简历/成绩单」搜到条目
      const fileNames = sec.fields
        .filter((f) => f.type === 'file')
        .flatMap((f) => att.fileIdsOf(e.values?.[f.key])
          .map((id) => att.findFileRecord(store, id)?.name || ''));
      const hay = [item.title, sec.title, ...fileNames,
        ...Object.values(item.values).map((v) => (v === null ? '' : Array.isArray(v) ? v.join(',') : String(v)))]
        .join('\n').toLowerCase();
      if (!hay.includes(String(q).toLowerCase())) continue;
    }
    out.push({ ...item, sectionTitle: sec.title });
  }
  return { count: out.length, total: store.entries.length, entries: out };
}

export async function getEntry(ref, { mask, section } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt });
  // 附带附件信息：键 = 附件 id / 文件名，值为名称 / 路径 / 链接。
  // 两个来源：`file` 字段挂的附件，以及**图文字段正文里内嵌的图片**（`![说明](f_x)`）——
  // 后者不进来的话，`entry get` 只能打印一串 f_xxx，而人/agent 要的是「这份文件在磁盘哪」。
  const files = {};
  const putFile = (ref) => {
    if (!ref || files[ref]) return;
    const rec = att.findFileRecord(store, ref);
    if (!rec) return;
    const links = att.fileLinks(rec);
    files[ref] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  };
  for (const f of sec.fields.filter((x) => x.type === 'file')) {
    for (const ref of att.fileIdsOf(serialized.values[f.key])) putFile(ref);
  }
  for (const f of sec.fields.filter((x) => x.type === 'md')) {
    for (const id of mdImageIds(serialized.values[f.key])) putFile(id);
  }
  // 字段类型随读出来：CLI 渲染要知道哪个值是「图文」，才能把 f_xxx 换成文件名/路径
  const fieldTypes = {};
  for (const f of sec.fields) fieldTypes[f.key] = f.type;
  return { ...serialized, sectionTitle: sec.title, mask: !!mask, files, fieldTypes };
}

export async function addEntry({ section, title, set, data, tags, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const sec = mustFindSection(store, section);
  const incoming = mergeInputs(set, data);
  if (!Object.keys(incoming).length && !title) {
    throw badInput(`至少要给一个字段：--set ${sec.fields[0]?.label || '字段'}=值（可重复），或 --data @file.json`);
  }

  const { values, newFields } = await prepareWrite({ section: sec, incoming });
  const finalTitle = String(title || autoTitle(sec, values) || '').trim();
  if (!finalTitle) {
    throw badInput(`无法确定条目名：加 --title <名>，或先填上「${sec.titleField || '首个字段'}」字段`);
  }
  const dup = store.entries.find((e) => e.section === sec.id && e.title === finalTitle);
  if (dup) throw conflict(`栏目「${sec.title}」下已有叫「${finalTitle}」的条目（${dup.id}）。要改它就用 entry update，别再加一条。`);

  const entry = {
    id: newId('e'), section: sec.id, title: finalTitle, tags: Array.isArray(tags) ? tags.map(String) : [],
    values, createdAt: nowIso(), updatedAt: nowIso(),
  };
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldCreate: { ...entry, values: maskAll(sec, entry) }, createdFields: newFields.map((f) => f.key) };
  }
  await mutateStore((s) => { s.entries.push(entry); });
  return {
    status: 'ok', created: true, id: entry.id, title: entry.title, section: sec.id,
    completeness: completeness(sec, entry), createdFields: newFields.map((f) => f.key),
  };
}

export async function updateEntry(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = resolveEntry(store, ref, patch.section);
  const sec = mustFindSection(store, target.section);
  const incoming = mergeInputs(patch.set, patch.data);
  const unset = patch.unset || [];

  const changedKeys = [...Object.keys(incoming), ...unset.map((k) => `-${k}`)];
  if (!changedKeys.length && patch.title === undefined && patch.tags === undefined) {
    throw badInput('没有要改的内容：用 --set 字段=值 / --data @file.json / --unset 字段 / --title / --tags');
  }
  // 先把 unset 的字段名解析出来（错别字要在写盘前就报掉）
  const unsetKeys = [];
  for (const k of unset) {
    const def = resolveFieldDef(sec, k);
    if (!def) throw notFound(`栏目「${sec.title}」没有字段: ${k}`);
    unsetKeys.push(def.key);
  }

  const { values, newFields } = await prepareWrite({
    section: sec, currentValues: target.values, incoming,
  });

  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldChange: {
        id: target.id, fields: Object.keys(values), unset: unsetKeys,
        title: patch.title, tags: patch.tags, newFields: newFields.map((f) => f.key),
      },
    };
  }

  // 重名会让 `entry get <名字>` / `key get <名字>` 变成二义（只能靠 id 定位），
  // 所以改名时挡一下：KV 表格改键名、agent 改条目标题都走这里。
  if (patch.title !== undefined && String(patch.title) !== target.title) {
    const dup = store.entries.find((e) => e.id !== target.id && e.section === target.section && e.title === String(patch.title));
    if (dup) throw conflict(`同栏目下已有叫「${patch.title}」的了（${dup.id}）；先合并或删掉那一条。`);
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    const section = s.sections.find((x) => x.id === e.section);
    for (const f of newFields) {
      if (!section.fields.some((x) => x.key === f.key)) section.fields.push(f);
    }
    for (const [k, v] of Object.entries(values)) e.values[k] = v;
    for (const k of unsetKeys) e.values[k] = null;
    if (patch.title !== undefined) e.title = String(patch.title);
    if (Array.isArray(patch.tags)) e.tags = patch.tags.map(String);
    e.updatedAt = nowIso();
    if (newFields.length) section.updatedAt = nowIso();
  });

  const after = await loadStore();
  const finalEntry = after.entries.find((x) => x.id === target.id);
  const finalSec = after.sections.find((x) => x.id === finalEntry.section);
  return {
    status: 'ok', id: finalEntry.id, title: finalEntry.title, section: finalEntry.section,
    // 报**解析后**的字段 key，而不是用户敲的中文标签——调用方/agent 拿它去对比字典
    changed: [...Object.keys(values), ...unsetKeys.map((k) => `-${k}`)],
    newFields: newFields.map((f) => f.key),
    completeness: completeness(finalSec, finalEntry),
  };
}

export async function removeEntry(ref, { section, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, title: target.title, section: target.section } };
  }
  await mutateStore((s) => { s.entries = s.entries.filter((e) => e.id !== target.id); });
  return { status: 'ok', removed: { id: target.id, title: target.title, section: target.section } };
}

/** 字段字典：agent 在填之前必须先看这个，否则只能靠猜字段名。 */
export async function fieldDictionary({ section } = {}) {
  const store = await loadStore();
  const shape = (sec) => ({
    id: sec.id,
    title: sec.title,
    titleField: sec.titleField,
    titleLabel: sec.titleLabel,
    groups: sec.groups,
    fields: sec.fields.map((x) => ({
      key: x.key, label: x.label, type: x.type, group: x.group,
      kind: x.kind || '',
      hint: x.hint || '', options: x.options || null, sensitive: isSensitiveField(sec, x.key),
    })),
  });
  if (section) return { count: 1, sections: [shape(mustFindSection(store, section))] };
  return { count: store.sections.length, sections: store.sections.map(shape) };
}

/**
 * KV 直通命令（`key *`）——「存个密钥」不该先说 `--section` 再说 `--set 字段=`。
 *
 * 设计要点：这**不是**第二套业务逻辑。下面每个函数都只是把
 * 「哪个栏目 + 哪个值字段」定好，再调 addEntry / updateEntry / removeEntry 本身。
 * 所以加解密、打码、快照、--dry-run 全部只有一份实现，不可能与 `entry` 命令分叉。
 */
/**
 * 找 KV 表格：默认是**标了 `kv: true` 的栏目**（密钥模板自带），
 * 也可以用 `--section` 指定任何一个「只有一个值字段」的栏目。
 */
async function kvTarget(store, ref) {
  const sec = ref
    ? findSection(store, ref)
    : findKvSection(store);
  if (!sec) {
    if (ref) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
    throw badInput('还没有 KV 栏目：用 `nx-sk section add keys --template secret` 建一个。'
      + `现有栏目: ${sectionNames(store)}`);
  }
  const named = (sec.fields || []).find((x) => x.key === 'value');
  if (named) return { sec, valueKey: named.key };
  if (!sec.fields || !sec.fields.length) throw badInput(`栏目「${sec.title}」没有任何字段，不能当 KV 用`);
  if (sec.fields.length > 1) {
    throw badInput(`栏目「${sec.title}」有 ${sec.fields.length} 个字段，不是 KV（KV 表格只能有一个值字段）`);
  }
  return { sec, valueKey: sec.fields[0].key };
}

/** KV 名称不是文件路径，所以比 assertSafeName 宽松：允许中文与空格，只挡路径分隔符。 */
function assertKeyName(name) {
  const s = String(name ?? '').trim();
  if (!s) throw badInput('密钥名不能为空：nx-sk key set <名称> <值>');
  if (s.length > 64) throw badInput(`密钥名过长（${s.length} > 64）: ${s}`);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`密钥名不能含路径分隔符或 '..': ${JSON.stringify(name)}`);
  }
  return s;
}

export async function keyList({ mask, section } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const mine = store.entries.filter((e) => e.section === sec.id);
  const decrypt = await sensitiveViewer(sec, mine);
  return {
    section: sec.id,
    sectionTitle: sec.title,
    valueKey,
    mask: !!mask,
    count: mine.length,
    keys: mine.map((e) => ({
      id: e.id,
      name: e.title,
      value: displaySensitive(e.values?.[valueKey], { mask: !!mask, decrypt }),
      updatedAt: e.updatedAt,
    })),
  };
}

export async function keyGet(name, { mask, section } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  return {
    id: entry.id,
    name: entry.title,
    section: sec.id,
    value: displaySensitive(entry.values?.[valueKey], { mask: !!mask, decrypt }),
    mask: !!mask,
    updatedAt: entry.updatedAt,
  };
}

/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 */
export async function keySet(name, value, { section, 'dry-run': dryRun } = {}) {
  const key = assertKeyName(name);
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw.trim()) throw badInput(`密钥值不能为空：nx-sk key set ${key} <值>`);

  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);

  const existing = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (existing) {
    // 两种「没变」都要认出来，否则会产生无意义的新密文 + 新快照：
    //   ① 明文与现值相同（重复写同一个 key 是常态，agent 会重试）
    //   ② 传进来的是**打码占位**（面板把列表里的值原样回传）
    const decrypt = await sensitiveViewer(sec, [existing]);
    if (decrypt) {
      try {
        const plain = String(decrypt(existing.values?.[valueKey]));
        if (plain === raw || maskValue(plain) === raw) {
          return { status: 'skipped', created: false, unchanged: true, name: key, section: sec.id, id: existing.id };
        }
      } catch { /* 解不开（换过密钥）就按覆盖处理 */ }
    }
    const r = await updateEntry(existing.title, { set: { [valueKey]: raw }, section: sec.id, 'dry-run': dryRun });
    if (r.status === 'skipped') return { ...r, name: key, created: false, section: sec.id };
    return { status: 'ok', created: false, replaced: true, name: key, section: sec.id, id: r.id };
  }

  const r = await addEntry({ section: sec.id, title: key, set: { [valueKey]: raw }, 'dry-run': dryRun });
  if (r.status === 'skipped') return { ...r, name: key, created: true, section: sec.id };
  return { status: 'ok', created: true, replaced: false, name: key, section: sec.id, id: r.id };
}

export async function keyRemove(name, { section, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const { sec } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}`);
  return removeEntry(entry.id, { 'dry-run': dryRun });
}

// —— CLI 人读渲染（KV 系列） ——
export function renderKeyList(d) {
  const lines = [`${d.count} 个密钥 · 栏目 ${d.section}${d.mask ? ' · 已打码' : ''}`];
  for (const k of d.keys) lines.push(`  ${String(k.name).padEnd(24)} ${k.value}`);
  lines.push('', `取值: nx-sk key get <名称>　　写入: nx-sk key set <名称> <值>　　（要打码加 --mask）`);
  return lines.join('\n');
}

export function renderKeyGet(d) {
  return `${d.name} = ${d.value}${d.mask ? '\n（已打码显示；去掉 --mask 即原文）' : ''}`;
}

export function renderKeySet(d) {
  if (d.status === 'skipped' && d.unchanged) return `未改动：${d.name} 的值与现有值相同`;
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange)}`;
  return `${d.created ? '已新建' : '已覆盖'}密钥 ${d.name}（栏目 ${d.section}）`
    + `\n值已密文落盘；核对用 nx-sk key get ${d.name}`;
}

export function renderKeyRemove(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldRemove)}`;
  return `已删除密钥 ${d.removed.title}`;
}

function maskAll(section, entry, decrypt, mask) {
  const out = {};
  for (const [k, v] of Object.entries(entry.values)) {
    out[k] = isSensitiveField(section, k) ? displaySensitive(v, { mask, decrypt }) : v;
  }
  return out;
}

// —— CLI 人读渲染 ——
export function renderEntryList(d) {
  const lines = [`${d.count} 条 / 共 ${d.total} 条`];
  for (const e of d.entries) {
    lines.push(`  ${e.id}  ${(e.title || '（无名）').padEnd(16)} ${String(e.completeness.ratio).padStart(3)}% 完整度　[${e.section}]`);
    const missing = e.missing.slice(0, 6).map((m) => m.label).join('、');
    if (missing) lines.push(`      未填: ${missing}${e.missing.length > 6 ? ` 等 ${e.missing.length} 项` : ''}`);
    // 「不填」只报**真的空着**的可选字段。可选字段填了值还列出来，会让人以为
    // 这份数据缺东西（`excluded` 是策略标记，不是空值清单）。
    const skipped = (e.excluded || []).filter((m) => isBlank(e.values?.[m.key]));
    if (skipped.length) {
      lines.push(`      不填: ${skipped.map((m) => m.label).join('、')}（主动跳过，不计入完整度）`);
    }
  }
  lines.push('', '看全部字段: nx-sk entry get <id> --json　或　nx-sk entry fields --section <id>');
  return lines.join('\n');
}

/**
 * 一个字段值渲染成几行文本。
 * - 附件（`file` 字段，值可能是 id 列表）：解析成「附件名　物理路径」，**几个占几行**
 * - 其它数组（tags 之类）：仍旧一行、顿号连接——不要顺手把它们也拆成多行
 */
function valueLines(d, v, type) {
  const asFile = (x) => (d.files && d.files[x] ? `${d.files[x].name}　${d.files[x].path}` : null);
  if (Array.isArray(v) && v.length && v.every((x) => asFile(x))) return v.map(asFile);
  const one = asFile(v);
  if (one) return [one];
  if (Array.isArray(v)) return [v.join('、')];
  if (typeof v === 'boolean') return [v ? '是' : '否'];
  // 图文字段：`![说明](f_x)` → `[图片: 说明] 本地路径`。不换的话 CLI 只会吐一串 id，
  // 而「这个 id 对应哪个文件」正是读的人唯一想知道的。缺附件时保留醒目的「图片缺失」。
  const s = String(v);
  const text = type === 'md' ? rewriteMdImages(s, (id) => d.files?.[id] || null) : s;
  // 多行正文（YAML / Dockerfile / 一段说明）按行拆开再回填缩进。
  // 不拆的话只有第一行带着键名列宽，后面每一行都从第 0 列开始 ——
  // 一段 40 行的清单打印出来像"掉出了表格"，人眼完全没法对。
  return text.includes('\n') ? text.split('\n') : [text];
}

export function renderEntryGet(d) {
  const c = d.completeness || {};
  // 只算**真的空着**的可选字段：填了值的可选字段不属于「跳过」，
  // 否则一份填满的资料会被报成「另有 7 项已标不填」，自相矛盾。
  const skipped = (d.excluded || []).filter((m) => isBlank(d.values?.[m.key]));
  const lines = [
    `${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
    + (skipped.length ? ` · 另有 ${skipped.length} 项已标不填` : '')
    + `${d.mask ? ' · 已打码' : ''}`,
  ];
  for (const [k, v] of Object.entries(d.values)) {
    if (v === null) continue;
    const rendered = valueLines(d, v, d.fieldTypes?.[k]);
    lines.push(`  ${k.padEnd(24)} ${rendered[0]}`);
    for (const extra of rendered.slice(1)) lines.push(`  ${' '.repeat(24)} ${extra}`);
  }
  if (d.missing.length) {
    lines.push('', `未填（${d.missing.length}）: ${d.missing.map((m) => `${m.label}(${m.key})`).join('、')}`);
  }
  // 「不填」和「未填」必须分开说：混在一起会让人以为这些字段还欠着，
  // 而它们恰恰是用户主动决定跳过的。
  if (skipped.length) {
    lines.push('', `不填（${skipped.length}）· 主动跳过、不计入完整度: `
      + skipped.map((m) => `${m.label}(${m.key}｜${m.fillLabel || m.fill})`).join('、'));
  }
  return lines.join('\n');
}

export function renderEntryChange(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove)}`;
  if (d.removed) return `已删除条目 ${d.removed.id}（${d.removed.title}）`;
  const c = d.completeness;
  if (d.created) {
    return `已创建条目 ${d.title}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
      + (d.createdFields?.length ? `\n新增字段: ${d.createdFields.join(', ')}` : '');
  }
  const extra = d.newFields?.length ? `\n新增字段: ${d.newFields.join(', ')}` : '';
  return `已更新条目 ${d.title}（${d.id}）· 改动 ${d.changed.join(', ')} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%${extra}`;
}

export function renderFields(d) {
  const lines = [`字段字典：${d.count} 个栏目`];
  for (const s of d.sections) {
    lines.push('', `【${s.title}】${s.id}　条目名字段: ${s.titleField || '（未设）'}　共 ${s.fields.length} 字段`);
    for (const g of s.groups) {
      lines.push(`  ${g.title}（${g.id}）`);
      for (const x of s.fields.filter((f) => f.group === g.id)) {
        lines.push(`    ${x.key.padEnd(22)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.options ? `  可选: ${x.options.join(' / ')}` : ''}${x.hint ? `　${x.hint}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}
