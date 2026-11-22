import { entryStructures, loadStore, mutateStore, saveStore, type Store, type StoreEntry, type StoreTemplate } from '../../core/store.ts';
import { badInput, notFound, conflict } from '../../core/errors.ts';
import { findTemplate, instantiateTemplate, isSensitiveField, templateNames } from '../../core/fields.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { displaySensitive, serializeEntry } from '../../core/render.ts';
import { newId, nowIso } from '../../core/ids.ts';
import { encryptValue, isCipherBlob, maskValue } from '../../core/crypto.ts';
import { resolveVaultKey, sensitiveViewer } from '../../core/vault.ts';
import { BLANK_TEMPLATE_ID } from '../../shared/tree.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
import { addEntry, removeEntry, updateEntry } from './crud.ts';
import { defsForEntry, mustFindTemplate, prepareWrite } from './shared.ts';

/**
 * 密钥直通命令（`key *`）——「存个密钥」不该先说 `--template` 再说 `--set 字段=`。
 *
 * 设计要点：这**不是**第二套业务逻辑。下面每个函数都只是把
 * 「哪个条目模板 + 哪个值字段」定好，再调 addEntry / updateEntry / removeEntry 本身。
 * 所以加解密、打码、快照、--dry-run 全部只有一份实现，不可能与 `entry` 命令分叉。
 */
/**
 * 密钥只认一个普通结构清单字段（`keys`）：名称列 + 密文值列。
 * 旧库里的 KV 条目模板（模板一行、每个键一个条目、字段 `value`）继续可读可写，
 * 但已经不参与新模板的创建——新写的密钥一律进字段，不再长成「一种模板」。
 */
type KeyMode = 'field' | 'legacy';
interface KeyRow { name: string; value?: unknown }
interface KeyTarget {
  sec: StoreTemplate;
  mode: KeyMode;
  fieldKey: string;
  entries: StoreEntry[];
  entry: StoreEntry | null;
}

function keyFieldOf(sec: StoreTemplate): FieldDef | null {
  const fields = (sec.fields || []) as unknown as FieldDef[];
  const named = fields.find((f) => f.type === 'entrylist' && f.key === 'keys');
  if (named) return named;
  return fields.find((f) => {
    if (f.type !== 'entrylist') return false;
    const subs = (f as unknown as { fields?: Array<{ key?: string; sensitive?: boolean }> }).fields || [];
    return subs.some((s) => s.key === 'name') && subs.some((s) => s.key === 'value' && s.sensitive === true);
  }) || null;
}

function legacyValueKeyOf(sec: StoreTemplate): string | null {
  const fields = (sec.fields || []) as unknown as FieldDef[];
  const named = fields.find((f) => f.type === 'secret' && f.key === 'value');
  if (named) return named.key;
  const secrets = fields.filter((f) => f.type === 'secret');
  return secrets.length === 1 ? secrets[0].key : null;
}

function findKeyTemplate(store: Store, ref?: string): StoreTemplate | null {
  if (ref) return findTemplate(store, ref);
  // 默认只认内置 secret；自定义模板必须显式 --template，避免把
  // 「恰好也有 name/value 清单」的模板误当密钥模板。
  return store.templates.find((s) => s.id === 'secret') || null;
}

function keyTarget(store: Store, template: string | undefined, entryRef: string | undefined): KeyTarget {
  const sec = findKeyTemplate(store, template);
  if (!sec) {
    if (template) throw notFound(`找不到条目模板: ${template} —— 现有: ${templateNames(store)}`);
    throw badInput('还没有密钥条目模板：用 `nx-sk template add keys --preset secret` 建一个，'
      + `或直接用 key set（写路径会自动建）。现有条目模板: ${templateNames(store)}`);
  }
  const field = keyFieldOf(sec);
  const legacyKey = legacyValueKeyOf(sec);
  if (!field && !legacyKey) {
    throw badInput(`条目模板「${sec.title}」没有密钥字段：需要一个名为 keys 的结构清单（名称 + 密文值），`
      + '或旧的单值字段 value。');
  }
  const entries = store.entries.filter((e) => e.template === sec.id);
  let entry: StoreEntry | null = null;
  if (entryRef) {
    const wanted = String(entryRef).trim();
    entry = entries.find((e) => e.id === wanted) || entries.find((e) => e.title === wanted) || null;
    if (!entry) throw notFound(`条目模板「${sec.title}」里找不到条目: ${entryRef}`);
  }
  if (field) {
    if (!entry) {
      const filled = entries.filter((e) => {
        const value = (e.values as Record<string, unknown> | undefined)?.[field.key];
        return Array.isArray(value) && value.length > 0;
      });
      if (filled.length > 1) {
        throw conflict(`条目模板「${sec.title}」里有 ${filled.length} 个条目都带密钥列表，`
          + `请用 --entry 指定：${filled.map((e) => `${e.id}（${e.title}）`).join('、')}`);
      }
      entry = filled[0] || (entries.length === 1 ? entries[0] : null);
    }
  }
  return { sec, mode: field ? 'field' : 'legacy', fieldKey: field ? field.key : legacyKey!, entries, entry };
}

/** 密钥名不是文件路径，所以比 assertSafeName 宽松：允许中文与空格，只挡路径分隔符。 */
function assertKeyName(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) throw badInput('密钥名不能为空：nx-sk key set <名称> <值>');
  if (s.length > 64) throw badInput(`密钥名过长（${s.length} > 64）: ${s}`);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`密钥名不能含路径分隔符或 '..': ${JSON.stringify(name)}`);
  }
  return s;
}

function keyRowsOf(entry: StoreEntry | null, fieldKey: string): KeyRow[] {
  const raw = entry?.values?.[fieldKey];
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as KeyRow[];
}

/** 读出字段行并解密；旧模板按条目的 value 字段读，新模板按清单行读。 */
async function revealKeyRows(sec: StoreTemplate, entry: StoreEntry, fieldKey: string): Promise<KeyRow[]> {
  const def = keyFieldOf(sec);
  if (!def) return [];
  const raw = entry.values?.[fieldKey];
  if (!Array.isArray(raw)) return [];
  const decrypt = await sensitiveViewer(sec, [entry]);
  const rows = behaviorOf('entrylist').reveal(def, raw, { decrypt }) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      const rec = row as Record<string, unknown>;
      return { name: String(rec.name ?? ''), value: rec.value };
    })
    .filter((row) => row.name);
}

export async function keyList({ mask, template, entry: entryRef }: { mask?: boolean; template?: string; entry?: string } = {}) {
  const store = await loadStore();
  const target = keyTarget(store, template, entryRef);
  const { sec } = target;

  if (target.mode === 'field') {
    const rows = target.entry ? await revealKeyRows(sec, target.entry, target.fieldKey) : [];
    return {
      template: sec.id,
      templateTitle: sec.title,
      field: target.fieldKey,
      entry: target.entry?.title || null,
      entryId: target.entry?.id || null,
      mode: target.mode,
      mask: !!mask,
      count: rows.length,
      keys: rows.map((row) => ({
        name: row.name,
        value: row.value == null ? null : (mask ? maskValue(String(row.value)) : String(row.value)),
        updatedAt: target.entry?.updatedAt || null,
      })),
    };
  }

  const decrypt = await sensitiveViewer(sec, target.entries);
  return {
    template: sec.id,
    templateTitle: sec.title,
    field: target.fieldKey,
    mode: target.mode,
    mask: !!mask,
    count: target.entries.length,
    keys: target.entries.map((e) => ({
      id: e.id,
      name: e.title,
      value: displaySensitive(e.values?.[target.fieldKey], { mask: !!mask, decrypt }),
      updatedAt: e.updatedAt,
    })),
  };
}

export async function keyGet(name: unknown, { mask, template, entry: entryRef }: { mask?: boolean; template?: string; entry?: string } = {}) {
  const store = await loadStore();
  const target = keyTarget(store, template, entryRef);
  const key = assertKeyName(name);

  if (target.mode === 'field') {
    if (!target.entry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
    const rows = await revealKeyRows(target.sec, target.entry, target.fieldKey);
    const row = rows.find((r) => r.name === key);
    if (!row) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
    return {
      name: key,
      template: target.sec.id,
      templateTitle: target.sec.title,
      field: target.fieldKey,
      entry: target.entry.title,
      entryId: target.entry.id,
      value: row.value == null ? null : (mask ? maskValue(String(row.value)) : String(row.value)),
      mask: !!mask,
      updatedAt: target.entry.updatedAt,
    };
  }

  const legacyEntry = target.entries.find((e) => e.title === key);
  if (!legacyEntry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
  const decrypt = await sensitiveViewer(target.sec, [legacyEntry]);
  return {
    id: legacyEntry.id,
    name: legacyEntry.title,
    template: target.sec.id,
    value: displaySensitive(legacyEntry.values?.[target.fieldKey], { mask: !!mask, decrypt }),
    mask: !!mask,
    updatedAt: legacyEntry.updatedAt,
  };
}

/**
 * 密钥的 SET 语义：不存在就建，存在就覆盖。
 *
 * 新模板里密钥是 `keys` 清单的一行——**不再新增条目**；只有 `key set` 第一次写入、
 * 模板还没有任何条目时，才建一个「密钥」条目来承载这个字段。
 * 旧 KV 模板仍按「一个键一个条目」的旧形状写，数据不动。
 */
export async function keySet(
  name: unknown,
  value: unknown,
  { template, entry, 'dry-run': dryRun }: { template?: string; entry?: string; 'dry-run'?: boolean } = {},
) {
  const key = assertKeyName(name);
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw.trim()) throw badInput(`密钥值不能为空：nx-sk key set ${key} <值>`);

  let store = await loadStore();
  let createdTemplate = false;
  if (!template && !findKeyTemplate(store, undefined)) {
    await mutateStore((s) => {
      const sec = { ...instantiateTemplate('secret', { id: 'secret', title: '密钥', order: 90 }), tags: ['secret', '密钥'], createdAt: nowIso(), updatedAt: nowIso() } as StoreTemplate;
      s.templates.push(sec);
      s.templates.sort((a, b) => a.order - b.order);
    });
    store = await loadStore();
    createdTemplate = true;
  }
  const target = keyTarget(store, template, entry);

  if (target.mode === 'legacy') {
    const existing = target.entries.find((e) => e.title === key);
    if (existing) {
      const decrypt = await sensitiveViewer(target.sec, [existing]);
      if (decrypt) {
        try {
          const plain = String(decrypt(existing.values?.[target.fieldKey]));
          if (plain === raw || maskValue(plain) === raw) {
            return { status: 'skipped', created: false, unchanged: true, name: key, template: target.sec.id, id: existing.id, createdTemplate };
          }
        } catch { /* 解不开就按覆盖处理 */ }
      }
      const r = await updateEntry(existing.title, { set: { [target.fieldKey]: raw }, template: target.sec.id, 'dry-run': dryRun });
      if (r.status === 'skipped') return { ...r, name: key, created: false, template: target.sec.id, createdTemplate };
      return { status: 'ok', created: false, replaced: true, name: key, template: target.sec.id, id: r.id, createdTemplate };
    }
    const r = await addEntry({ template: target.sec.id, title: key, set: { [target.fieldKey]: raw }, 'dry-run': dryRun });
    if (r.status === 'skipped') return { ...r, name: key, created: true, template: target.sec.id, createdTemplate };
    return { status: 'ok', created: true, replaced: false, name: key, template: target.sec.id, id: r.id, createdTemplate };
  }

  if (!target.entry) {
    const r = await addEntry({
      template: target.sec.id,
      title: '密钥',
      set: { [target.fieldKey]: [{ name: key, value: raw }] },
      'dry-run': dryRun,
    });
    if (r.status === 'skipped') return { ...r, name: key, created: true, template: target.sec.id, createdEntry: true, createdTemplate };
    return { status: 'ok', created: true, replaced: false, name: key, template: target.sec.id, field: target.fieldKey, id: r.id, createdEntry: true, createdTemplate };
  }

  const current = keyRowsOf(target.entry, target.fieldKey);
  const shown = await revealKeyRows(target.sec, target.entry, target.fieldKey);
  const old = shown.find((r) => r.name === key);
  if (old && old.value != null && (String(old.value) === raw || maskValue(String(old.value)) === raw)) {
    return {
      status: 'skipped', created: false, unchanged: true, name: key, template: target.sec.id,
      field: target.fieldKey, entry: target.entry.title, id: target.entry.id, createdTemplate,
    };
  }
  const next = current.map((row) => ({ ...row }));
  const idx = next.findIndex((row) => String(row.name) === key);
  if (idx >= 0) next[idx] = { ...next[idx], name: key, value: raw };
  else next.push({ name: key, value: raw });
  const r = await updateEntry(target.entry.title, {
    template: target.sec.id, set: { [target.fieldKey]: next }, 'dry-run': dryRun,
  });
  if (r.status === 'skipped') {
    return { ...r, name: key, created: idx < 0, template: target.sec.id, field: target.fieldKey, entry: target.entry.title, createdTemplate };
  }
  return {
    status: 'ok', created: idx < 0, replaced: idx >= 0, name: key, template: target.sec.id,
    field: target.fieldKey, entry: target.entry.title, id: r.id, createdTemplate,
  };
}

export async function keyRemove(
  name: unknown,
  { template, entry, 'dry-run': dryRun }: { template?: string; entry?: string; 'dry-run'?: boolean } = {},
) {
  const store = await loadStore();
  const target = keyTarget(store, template, entry);
  const key = assertKeyName(name);
  if (target.mode === 'legacy') {
    const found = target.entries.find((e) => e.title === key);
    if (!found) throw notFound(`没有这个密钥: ${key}`);
    return removeEntry(found.id, { 'dry-run': dryRun });
  }

  if (!target.entry) throw notFound(`没有这个密钥: ${key}`);
  const rows = keyRowsOf(target.entry, target.fieldKey);
  const idx = rows.findIndex((row) => String(row.name) === key);
  if (idx < 0) throw notFound(`没有这个密钥: ${key}`);
  const next = rows.filter((_, i) => i !== idx);
  const r = await updateEntry(target.entry.title, {
    template: target.sec.id,
    set: { [target.fieldKey]: next.length ? next : null },
    'dry-run': dryRun,
  });
  if (r.status === 'skipped') {
    return {
      ...r, name: key, template: target.sec.id, field: target.fieldKey, entry: target.entry.title,
      remaining: next.length, removed: { title: key },
    };
  }
  return {
    status: 'ok', name: key, template: target.sec.id, field: target.fieldKey,
    entry: target.entry.title, remaining: next.length, id: r.id, removed: { title: key },
  };
}

/** 同层下一个 sort：新建承载条目时排在同级最后。 */
function nextSortFor(store: Store, parentId: string | null): number {
  const siblings = store.entries.filter((e) => (e.parent ?? null) === parentId);
  return siblings.reduce((max, e) => Math.max(max, Number(e.sort) || 0), -1) + 1;
}

/**
 * 旧「一个密钥一个条目」的公共容器。
 *
 * v7 把旧 KV 表折叠成一个空白条目（标题通常就是模板标题），25 个单值条目挂在
 * 它下面。这个容器没有任何自己的值、所有子条目又都是本次要合并的单值条目时，
 * 它才是安全的承载目标——直接把容器改造成密钥条目，最终树上真的只剩一个节点。
 */
function legacyContainerOf(store: Store, entries: StoreEntry[]): StoreEntry | null {
  if (!entries.length) return null;
  const ids = new Set(entries.map((e) => e.id));
  const parents = new Set(entries.map((e) => e.parent ?? null));
  if (parents.size !== 1) return null;
  const parentId = [...parents][0];
  if (!parentId) return null;
  const parent = store.entries.find((e) => e.id === parentId);
  if (!parent || parent.template !== BLANK_TEMPLATE_ID) return null;
  if (Object.keys(parent.values || {}).length) return null;
  const children = store.entries.filter((e) => e.parent === parentId);
  if (!children.length || children.some((e) => !ids.has(e.id))) return null;
  return parent;
}

/**
 * 把旧单值密钥条目（或新旧混杂的多个承载条目）合并成**一个** `keys` 清单。
 *
 * 用户要的形状：密钥只是普通模板上的一个结构清单字段，清单里的每一行才是一个键；
 * 树上只能有一个承载条目，不能「有多少密钥就有多少条目」。
 *
 * 迁移边界：
 *   - 旧 `value` 先按 sensitiveViewer 解密，再交给 prepareWrite 重新封装成密文；
 *     绝不把旧的密文对象直接挪到新清单里（新旧字段的密文边界不同）。
 *   - 默认目标优先选旧条目的公共空白容器（它的标题/位置原样保留），其次选已有承载条目，
 *     都没有才新建；显式 `--entry` 覆盖。
 *   - 目标若是旧单值条目（自身有旧结构行），拒绝直接改模板——那样 writeStore 会按捕获行
 *     恢复旧结构；这种数据应交给默认容器或新建承载条目。
 *   - 先算、后一次 saveStore（带乐观 rev）；任何解密/结构校验失败都不落盘。
 */
export async function keyConsolidate(
  { template, entry: entryRef, 'dry-run': dryRun }:
  { template?: string; entry?: string; 'dry-run'?: boolean } = {},
) {
  const store = await loadStore();
  const sec = findKeyTemplate(store, template);
  if (!sec) {
    if (template) throw notFound(`找不到条目模板: ${template} —— 现有: ${templateNames(store)}`);
    throw badInput('还没有密钥条目模板：用 `nx-sk template add keys --preset secret` 建一个，'
      + `或直接用 key set（写路径会自动建）。现有条目模板: ${templateNames(store)}`);
  }
  const field = keyFieldOf(sec);
  const legacyKey = legacyValueKeyOf(sec);
  if (!field && !legacyKey) {
    throw badInput(`条目模板「${sec.title}」没有密钥字段：需要一个名为 keys 的结构清单（名称 + 密文值），`
      + '或旧的单值字段 value。');
  }

  const updatedAt = nowIso();
  const preset = instantiateTemplate('secret', {
    id: sec.id,
    title: sec.title,
    order: Number.isFinite(Number(sec.order)) ? Number(sec.order) : undefined,
    createdAt: sec.createdAt ?? undefined,
    updatedAt,
  });
  if (!preset) throw badInput('内置 secret 预设不存在，无法归一密钥模板');
  const updatedSec = {
    ...sec,
    description: preset.description,
    titleField: preset.titleField,
    titleLabel: preset.titleLabel,
    fields: preset.fields,
    updatedAt,
  } as StoreTemplate;

  const mine = store.entries.filter((e) => e.template === sec.id);
  const mode: KeyMode = field ? 'field' : 'legacy';
  const holders: StoreEntry[] = [];
  const rows: KeyRow[] = [];

  if (mode === 'legacy') {
    if (!mine.length) {
      const idx = store.templates.findIndex((t) => t.id === sec.id);
      store.templates[idx] = updatedSec;
      if (!dryRun) await saveStore(store);
      return {
        status: dryRun ? 'skipped' : 'ok', dryRun: !!dryRun, mode, template: sec.id,
        templateTitle: sec.title, fromEntries: 0, removedEntries: 0, rows: 0,
        target: null, templateMigrated: true,
      };
    }
    const decrypt = await sensitiveViewer(sec, mine);
    for (const e of mine) {
      const name = assertKeyName(e.title);
      const raw = e.values?.[legacyKey!];
      let value = '';
      if (isCipherBlob(raw)) {
        if (!decrypt) throw badInput(`密钥「${name}」的值是密文，但当前读不到本机密钥，无法迁移`);
        try {
          value = String(decrypt(raw));
        } catch {
          throw badInput(`密钥「${name}」无法解密，迁移已中止（数据库未改动）`);
        }
      } else if (raw !== null && raw !== undefined) {
        value = String(raw);
      }
      rows.push({ name, value });
      holders.push(e);
    }
  } else {
    const filled = mine.filter((e) => keyRowsOf(e, field!.key).length > 0);
    if (!entryRef && filled.length <= 1) {
      return {
        status: 'unchanged', dryRun: !!dryRun, mode, template: sec.id, templateTitle: sec.title,
        fromEntries: filled.length, removedEntries: 0, rows: filled.length ? keyRowsOf(filled[0], field!.key).length : 0,
        target: filled[0] ? { id: filled[0].id, title: filled[0].title } : null,
      };
    }
    for (const e of filled) {
      holders.push(e);
      for (const row of await revealKeyRows(sec, e, field!.key)) rows.push(row);
    }
  }

  const merged = new Map<string, KeyRow>();
  for (const row of rows) {
    const name = assertKeyName(row.name);
    merged.set(name, { name, value: row.value == null ? '' : String(row.value) });
  }

  let target: StoreEntry | null = null;
  if (entryRef) {
    const wanted = String(entryRef).trim();
    target = store.entries.find((e) => e.id === wanted)
      || store.entries.find((e) => e.title === wanted && (e.template === sec.id || e.template === BLANK_TEMPLATE_ID))
      || null;
    if (!target) throw notFound(`找不到承载条目: ${entryRef}`);
  }
  if (!target) target = legacyContainerOf(store, holders);
  if (!target && mode === 'field') target = holders[0] || null;

  let created = false;
  if (!target) {
    const parent = holders.length ? (holders[0].parent ?? null) : null;
    target = {
      id: newId('e'), template: updatedSec.id, title: sec.title || '密钥', desc: '', tags: [],
      parent, sort: nextSortFor(store, parent), values: {}, createdAt: updatedAt, updatedAt,
    };
    store.entries.push(target);
    created = true;
  }
  if (!created && target.template !== updatedSec.id && target.template !== BLANK_TEMPLATE_ID) {
    throw badInput(`目标条目「${target.title}」不是空白容器或密钥条目，不能直接改模板；`
      + '请用 --entry 指定空白容器/承载条目');
  }
  const ownRows = entryStructures(store).get(target.id) || [];
  if (!created && target.template !== updatedSec.id && ownRows.length) {
    throw badInput(`目标条目「${target.title}」已经有自己的结构行，不能直接改模板；`
      + '请用 --entry 指定空白容器/承载条目');
  }

  // 先按最终密文边界逐行加密，再交给 prepareWrite：结构清单的 coerce 会 trim 普通字符串，
  // 直接送明文会把 PEM 这类尾随换行吃掉。已经是密文对象的行会被 sealEntryList 原样保留。
  const { key: vaultKey } = await resolveVaultKey();
  const sealedRows = [...merged.values()].map((row) => ({
    name: row.name,
    value: encryptValue(vaultKey, row.value == null ? '' : String(row.value)),
  }));
  const incoming = {
    ...(target.values || {}),
    [field?.key || 'keys']: sealedRows.length ? sealedRows : null,
  };
  const sealed = await prepareWrite({
    template: updatedSec,
    ownRows: created ? null : ownRows,
    currentValues: target.values || {},
    incoming,
  });
  target.template = updatedSec.id;
  target.values = { ...target.values, ...sealed.values };
  target.updatedAt = updatedAt;

  const doomed = holders.filter((e) => e.id !== target!.id).map((e) => e.id);
  if (doomed.length) store.entries = store.entries.filter((e) => !doomed.includes(e.id));
  const idx = store.templates.findIndex((t) => t.id === sec.id);
  store.templates[idx] = updatedSec;

  if (!dryRun) await saveStore(store);

  return {
    status: dryRun ? 'skipped' : 'ok',
    dryRun: !!dryRun,
    mode,
    template: updatedSec.id,
    templateTitle: updatedSec.title,
    fromEntries: holders.length,
    removedEntries: doomed.length,
    rows: merged.size,
    target: { id: target.id, title: target.title, created },
    templateMigrated: true,
  };
}

// —— CLI 人读渲染（KV 系列） ——
export function renderKeyList(d: Awaited<ReturnType<typeof keyList>>) {
  const lines = [`${d.count} 个密钥 · 条目模板 ${d.template}`
    + `${'entry' in d && d.entry ? ` · 条目 ${d.entry}` : ''}${d.mask ? ' · 已打码' : ''}`];
  for (const k of d.keys) lines.push(`  ${String(k.name).padEnd(24)} ${k.value}`);
  lines.push('', `取值: nx-sk key get <名称>　　写入: nx-sk key set <名称> <值>　　（要打码加 --mask）`);
  return lines.join('\n');
}

export function renderKeyGet(d: Awaited<ReturnType<typeof keyGet>>) {
  return `${d.name} = ${d.value}${d.mask ? '\n（已打码显示；去掉 --mask 即原文）' : ''}`;
}

/** renderKeySet 的入参：key set 的落盘 / 试运行 / 未变三种结果。 */
interface KeySetView {
  status?: string;
  unchanged?: boolean;
  name?: string;
  template?: string;
  created?: boolean;
  wouldCreate?: unknown;
  wouldChange?: unknown;
}

export function renderKeySet(d: KeySetView) {
  if (d.status === 'skipped' && d.unchanged) return `未改动：${d.name} 的值与现有值相同`;
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange)}`;
  return `${d.created ? '已新建' : '已覆盖'}密钥 ${d.name}（条目模板 ${d.template}）`
    + `\n值已密文落盘；核对用 nx-sk key get ${d.name}`;
}

/** renderKeyRemove 的入参：key remove 的落盘 / 试运行两种结果。 */
interface KeyRemoveView {
  status?: string;
  wouldRemove?: unknown;
  name?: string;
  remaining?: number;
  removed?: { title?: string; name?: string };
}

export function renderKeyRemove(d: KeyRemoveView) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldRemove)}`;
  const name = d.name || d.removed?.name || d.removed?.title || '';
  return `已删除密钥 ${name}${typeof d.remaining === 'number' ? `（清单还剩 ${d.remaining} 行）` : ''}`;
}

/** key consolidate 的人读输出：只报数量与目标条目，不打印任何密钥名/值。 */
export function renderKeyConsolidate(d: Awaited<ReturnType<typeof keyConsolidate>>) {
  if (d.status === 'unchanged') {
    return `无需合并：条目模板 ${d.template} 已经是清单形状，只有 ${d.fromEntries} 个承载条目`
      + (d.target ? `（${d.target.title}，${d.rows} 行）` : '');
  }
  const head = d.status === 'skipped'
    ? '试运行（未落盘）'
    : `已合并密钥：${d.fromEntries} 个旧条目 → 1 个条目（${d.rows} 行）`;
  const target = d.target
    ? `${d.target.created ? '新建' : '复用'}承载条目「${d.target.title}」（${d.target.id}）`
    : '仅归一条目模板';
  return `${head}\n${target}；模板 ${d.template} 已归一为 keys 清单字段`
    + (d.removedEntries ? `，删除 ${d.removedEntries} 个旧条目` : '');
}

// ---------- 关键 key 台账（链接 / 账号 / 密码 / 镜像 的跨条目模板统一列表） ----------
//
// 需求：散在各条目里的「关键 key」（控制台链接、账号、密码、镜像名…）要有一张
// 统一清单，方便一眼拿到、也方便交给 agent 定位修改。
// 匹配规则：字段 key/label 命中启发式 **或** 字段类型是 secret/标记 sensitive。
// **结构清单要展开成行**：场景凭据（deploy 的「凭据清单」）住在清单的行里，
// 只扫顶层字段的话台账就看不见最该看见的那些。
// 值策略：链接类明文（地址是要点击使用的）；账号/密码/token 类一律打码（短值全 *）；
// 其余长文本前 4+尾 4。--reveal 才出原文（密文走解密）。
const KEY_URL_RE = /(url|link|链接|console|入口|registry|仓库|image|镜像)/i;
const KEY_SECRET_RE = /(account|user(?!id)|账号|帐号|password|密码|passwd|pwd|token|secret|apikey|api_key|密钥|身份证|idcard|phone|电话|bank)/i;
const KEY_FIELD_RE = new RegExp(`${KEY_URL_RE.source}|${KEY_SECRET_RE.source}`, 'i');

export async function keysLedger({ template, q, reveal }: { template?: string; q?: unknown; reveal?: boolean } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  let templates = store.templates;
  if (template) templates = [mustFindTemplate(store, template)];
  const out: Array<{ template: string; templateId: string; entry: string; entryId: string; key: string; label: string; sensitive: boolean; value: string }> = [];
  for (const sec of templates) {
    const mine = store.entries.filter((e) => e.template === sec.id);
    if (!mine.length) continue;
    const decrypt = await sensitiveViewer(sec, mine, structures);
    for (const e of mine) {
      const ownRows = structures.get(e.id) || null;
      const item = serializeEntry(sec, e, { decrypt, ownRows });
      for (const def of defsForEntry(sec, ownRows)) {
        const raw = item.values?.[def.key];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;

        // **清单类字段要展开成行**：场景凭据住在清单的行里（deploy 的「凭据清单」、
        // 表格里的「密码」列）—— 只扫顶层字段的话，台账恰好看不见最该看见的那些，
        // 「一条命令看全部凭据」必须真的看得到全部。
        const doc = raw as { rows?: unknown[]; columns?: unknown };
        const listRows = def.type === 'entrylist' && Array.isArray(raw)
          ? (raw as unknown[])
          : (def.type === 'table' && raw && Array.isArray(doc.rows) ? doc.rows : null);
        if (listRows) {
          // 表格的列存在数据里（结构归数据），优先用数据里的那份
          const subs = (def.type === 'table'
            ? (Array.isArray(doc.columns) && doc.columns.length ? doc.columns : (def.columns || []))
            : (def.type === 'entrylist' ? (def.fields || []) : [])) as Array<{ key: string; label?: string; sensitive?: boolean }>;
          for (const row of listRows) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const rowName = String(r.name ?? r['名称'] ?? r.task ?? r['任务'] ?? '');
            for (const [cellKey, cellVal] of Object.entries(r)) {
              if (cellVal === undefined || cellVal === null || String(cellVal).trim() === '') continue;
              const sub = subs.find((x) => x.key === cellKey);
              const cellLabel = sub?.label || cellKey;
              const secretish = sub?.sensitive === true
                || KEY_SECRET_RE.test(cellKey) || KEY_SECRET_RE.test(cellLabel);
              const urlish = KEY_URL_RE.test(cellKey) || KEY_URL_RE.test(cellLabel);
              if (!secretish && !urlish && !KEY_FIELD_RE.test(cellKey) && !KEY_FIELD_RE.test(cellLabel)) continue;
              const s = String(cellVal);
              out.push({
                template: sec.title,
                templateId: sec.id,
                entry: e.title,
                entryId: e.id,
                key: `${def.key}.${cellKey}`,
                label: rowName ? `${rowName} · ${cellLabel}` : cellLabel,
                sensitive: secretish,
                value: reveal ? s
                  : (secretish || isCipherBlob(s)) ? maskValue(s)
                    : urlish ? s
                      : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
              });
            }
          }
          continue;
        }

        const hit = KEY_FIELD_RE.test(def.key) || KEY_FIELD_RE.test(def.label) || def.type === 'secret' || def.sensitive === true;
        if (!hit) continue;
        const s = Array.isArray(raw) ? raw.join('、') : String(raw);
        const isSecretish = def.type === 'secret' || def.sensitive === true || isSensitiveField(sec, def.key) || KEY_SECRET_RE.test(def.key) || KEY_SECRET_RE.test(def.label);
        const isUrlish = KEY_URL_RE.test(def.key) || KEY_URL_RE.test(def.label);
        out.push({
          template: sec.title,
          templateId: sec.id,
          entry: e.title,
          entryId: e.id,
          key: def.key,
          label: def.label,
          sensitive: isSecretish,
          value: reveal ? s
            : (isSecretish || isCipherBlob(s)) ? maskValue(s)
              : isUrlish ? s
                : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
        });
      }
    }
  }
  if (q) {
    const needle = String(q).toLowerCase();
    return { count: out.length, reveal: Boolean(reveal), items: out.filter((x) =>
      [x.template, x.entry, x.key, x.label, x.value].some((v) => String(v).toLowerCase().includes(needle))) };
  }
  return { count: out.length, reveal: Boolean(reveal), items: out };
}

export function renderKeysLedger(d: Awaited<ReturnType<typeof keysLedger>>) {
  if (!d.items.length) return '（没有命中关键 key 的字段——往条目里填 链接/账号/密码/镜像 类字段后这里会出现）';
  const lines = [`关键 key 台账：${d.items.length} 条${d.reveal ? '（明文）' : '（打码；--reveal 看原文）'}`];
  let last = '';
  for (const x of d.items) {
    if (x.template !== last) { lines.push('', `【${x.template}】${x.templateId}`); last = x.template; }
    lines.push(`  ${x.entry}（${x.entryId}）`);
    lines.push(`    ${x.label.padEnd(10)} ${x.key.padEnd(14)} ${x.sensitive ? '[密文] ' : ''}${x.value}`);
  }
  return lines.join('\n');
}

