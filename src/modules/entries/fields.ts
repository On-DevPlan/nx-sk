import {
  detachEntryField, entryStructures, isDetachedField, loadStore, removeEntryFieldRow,
  updateEntryFieldRow, upsertEntryFields, type EntryFieldView, type StoreSection,
} from '../../core/store.ts';
import { assertFieldKey } from '../../core/paths.ts';
import { badInput, conflict, notFound } from '../../core/errors.ts';
import { SOURCE_FIELD, isSensitiveField } from '../../core/fields.ts';
import { serializeEntry } from '../../core/render.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { computeTable, renderTableText } from '../../shared/table.ts';
import { FIELD_TYPES, type FieldDef } from '../../shared/fields/types.ts';
import { getEntry, renderEntryGet, updateEntry } from './crud.ts';
import { defsForEntry, mustFindSection, resolveEntry } from './shared.ts';

/** 字段字典的读侧形状：渲染只读这些键，不同字段类型各带其中一部分。 */
interface FieldDictEntry {
  key: string;
  label: string;
  type: string;
  group: string;
  kind?: string;
  fields?: unknown[] | null;
  columns?: Array<{ label: string; type: string; formula?: string }> | null;
  totals?: unknown[] | null;
  maxRows?: number | null;
  hint?: string;
  options?: string[] | null;
  sensitive?: boolean;
}

/** 字段字典：agent 在填之前必须先看这个，否则只能靠猜字段名。 */
export async function fieldDictionary({ section }: { section?: string } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  const shape = (sec: StoreSection) => {
    // 台账 = 栏目字典 + 各条目的**扩展行**（v3：quickAdd 不进字典，但台账要看得见）。
    // 按 key 去重（字典优先），形状从各自的 spec 出。
    const byKey = new Map<string, Record<string, unknown>>();
    for (const x of sec.fields as unknown as FieldDictEntry[]) byKey.set(x.key, x as unknown as Record<string, unknown>);
    for (const e of store.entries) {
      if (e.section !== sec.id) continue;
      for (const r of structures.get(e.id) || []) {
        if (byKey.has(r.key)) continue;
        // 任务 #20：脱离行不进台账——它已从该条目移除，值也不在 values 里了。
        if (isDetachedField(r)) continue;
        byKey.set(r.key, r.spec as Record<string, unknown>);
      }
    }
    return {
      id: sec.id,
      title: sec.title,
      titleField: sec.titleField,
      titleLabel: sec.titleLabel,
      groups: sec.groups,
      fields: [...byKey.values()].map((x) => ({
        key: String(x.key), label: String(x.label ?? x.key), type: String(x.type || 'text'), group: x.group ? String(x.group) : undefined,
        kind: String(x.kind || ''),
        // 结构清单的列跟着字典出去：agent 写行之前得知道行里允许哪些键
        fields: (x.fields as unknown[] | null) || null,
        // 表格的列（带类型/公式）与统计行同理
        columns: (x.columns as FieldDictEntry['columns']) || null,
        totals: (x.totals as unknown[] | null) || null,
        maxRows: (x.maxRows as number | null) ?? null,
        hint: String(x.hint || ''), options: (x.options as string[] | null) || null,
        sensitive: x.sensitive === true || x.type === 'secret' || isSensitiveField(sec, x.key),
      })),
    };
  };
  if (section) return { count: 1, sections: [shape(mustFindSection(store, section))] };
  return { count: store.sections.length, sections: store.sections.map(shape) };
}

/**
 * entry.add-field：在条目内添加**扩展字段**（显式指定类型/分组）。
 *
 * v3 写时复制语义：只写条目自身的结构行（template_field_id 由 upsert 按字典判定），
 * **不动栏目字典**——字典保持「模板 + 台账」身份。--value 顺手给初值时走
 * updateEntry 的同一条封装链（凭据样键落盘即密文）。
 */
export async function addEntryField(ref: unknown, ctx: {
  key?: unknown; label?: unknown; type?: unknown; group?: unknown; value?: unknown;
  section?: string; 'dry-run'?: boolean;
} = {}) {
  const key = assertFieldKey(String(ctx.key ?? '').trim());
  const type = String(ctx.type || 'text');
  if (!(FIELD_TYPES as readonly string[]).includes(type)) {
    throw badInput(`未知字段类型 "${type}"（可用: ${FIELD_TYPES.join(', ')}）`);
  }
  const store = await loadStore();
  const target = resolveEntry(store, ref, ctx.section);
  const sec = mustFindSection(store, target.section);
  if (sec.kv) {
    throw badInput(`栏目「${sec.title}」是一张 KV 表（一行一个键值对），不给它加字段——要加键用 nx-sk key set <名称> <值>，或在面板 KV 表格里加一行。`);
  }
  const rows = entryStructures(store).get(target.id) || [];
  const hit = rows.find((r) => r.key === key);
  if (hit) throw conflict(`条目已有字段「${key}」（行 ${hit.id}）——直接写值即可：nx-sk entry update ${target.id} --set ${key}=值`);
  const groupIds = (sec.groups || []).map((g) => g.id);
  const group = String(ctx.group ?? '').trim() || groupIds[0] || 'other';
  if (!groupIds.includes(group) && group !== 'other') {
    throw badInput(`栏目「${sec.title}」没有分组 "${group}"（可用: ${groupIds.join(', ') || '无'}）`);
  }
  const def = { key, label: String(ctx.label ?? '').trim() || key, type, group } as unknown as FieldDef;
  if (ctx['dry-run']) {
    return { status: 'skipped', dryRun: true, entry: target.id, wouldAddField: def, wouldSetValue: ctx.value !== undefined && ctx.value !== '' };
  }
  await upsertEntryFields(target.id, [def]);
  const hasInitial = ctx.value !== undefined && ctx.value !== '';
  if (hasInitial) await updateEntry(target.id, { section: sec.id, set: { [key]: ctx.value } });
  const got = await getEntry(target.id, { section: sec.id });
  return { ...got, addedField: def, valueSet: hasInitial };
}

export function renderEntryAddField(d: Awaited<ReturnType<typeof addEntryField>>) {
  if ((d as { status?: string }).status === 'skipped') {
    const w = (d as unknown as { wouldAddField: FieldDef }).wouldAddField;
    return `试运行（未落盘）：将给条目 ${String((d as unknown as { entry: string }).entry)} 添加扩展字段「${w.label}」(${w.key}) · 类型 ${w.type} · 分组 ${String(w.group)}${(d as unknown as { wouldSetValue: boolean }).wouldSetValue ? ' · 带初值' : ''}`;
  }
  const got = d as Awaited<ReturnType<typeof getEntry>> & { addedField: FieldDef; valueSet: boolean };
  return `已添加扩展字段「${got.addedField.label}」(${got.addedField.key}) · 类型 ${got.addedField.type} · 分组 ${String(got.addedField.group)}${got.valueSet ? ' · 已写入初值' : ''}\n${renderEntryGet(got)}`;
}

/**
 * 在**条目自身结构行**里定位一行（任务 #20：返回行本体，不是 spec）。
 * key 精确优先、其次 label；与 resolveOwnRow 同一口径——**含脱离行**（restore 要用它找到藏着的行）。
 */
function findOwnRow(rows: EntryFieldView[], rawKey: unknown): EntryFieldView | null {
  const key = String(rawKey ?? '').trim();
  const byKey = rows.filter((r) => r.key === key);
  if (byKey.length) return byKey[0];
  const byLabel = rows.filter((r) => String(r.label ?? '') === key);
  if (byLabel.length > 1) {
    throw conflict(`字段定位「${key}」在条目自身结构里有 ${byLabel.length} 行命中（${byLabel.map((r) => r.id).join(', ')}），请用键名精确指定`);
  }
  return byLabel[0] || null;
}

/**
 * entry.remove-field：条目级字段移除（任务 #20，v3 写时复制模型）。
 *
 * 三种语义（与栏目字典侧同一条纪律：内置 source 袋不许动）：
 *   - 扩展行（template_field_id NULL）→ **硬删** entry_fields 行，field_data 随 CASCADE 走，
 *     值没了就是没了（面板必须先弹确认）。
 *   - 模板行 → **脱离（detach）**：行保留、meta 记 detached=1；该条目不再渲染/序列化/计完整度
 *     这个字段，**栏目字典与其他条目不受影响**；值仍住在 field_data。
 *   - 已脱离 + --restore → 去掉 detached 标记，值原样回来（脱离从不动 field_data）。
 *
 * 返回该条目最新 getEntry 形状 + `removed|detached|restored` 标记与 `field` 明细。
 */
export async function removeEntryField(ref: unknown, ctx: {
  key?: unknown; section?: string; restore?: boolean; 'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, ctx.section);
  const sec = mustFindSection(store, target.section);
  const rows = entryStructures(store).get(target.id) || [];
  const row = findOwnRow(rows, ctx.key);
  if (!row) {
    throw notFound(`条目「${target.title || target.id}」没有字段: ${String(ctx.key ?? '').trim()}`
      + `（看现有字段: nx-sk entry get ${target.id}；已脱离的用 --restore 恢复）`);
  }
  if (row.key === SOURCE_FIELD.key) {
    throw badInput(`「${SOURCE_FIELD.label}」是每个条目自带的内置字段（与栏目字典同一条纪律：删了下回读又会补回来），不给移除。`);
  }
  const detached = isDetachedField(row);
  const kind: 'template' | 'extension' = row.templateFieldId != null ? 'template' : 'extension';
  const field = { key: row.key, label: row.label || row.key, kind };

  if (ctx.restore) {
    if (!detached) throw badInput(`字段「${field.label}」没有被从本条目移除过，无需恢复`);
    if (ctx['dry-run']) return { status: 'skipped', dryRun: true, entry: target.id, wouldRestore: field };
    const changed = await detachEntryField(target.id, row.id, false);
    if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
    const got = await getEntry(target.id, { section: sec.id });
    return { ...got, restored: true, field };
  }
  if (detached) {
    throw conflict(`字段「${field.label}」已从本条目移除（管理条里点「恢复」可找回，值还在）`);
  }
  if (ctx['dry-run']) return { status: 'skipped', dryRun: true, entry: target.id, wouldRemove: field };
  if (kind === 'extension') {
    const changed = await removeEntryFieldRow(target.id, row.id);
    if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
    const got = await getEntry(target.id, { section: sec.id });
    return { ...got, removed: true, field };
  }
  const changed = await detachEntryField(target.id, row.id, true);
  if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
  const got = await getEntry(target.id, { section: sec.id });
  return { ...got, detached: true, field };
}

export function renderEntryRemoveField(d: Awaited<ReturnType<typeof removeEntryField>>) {
  const x = d as unknown as {
    status?: string; id?: string; entry?: string; field?: { key: string; label: string; kind: string };
    wouldRemove?: { key: string; label: string; kind: string }; wouldRestore?: { key: string; label: string; kind: string };
    removed?: boolean; detached?: boolean; restored?: boolean;
  };
  if (x.status === 'skipped') {
    const w = x.wouldRemove || x.wouldRestore;
    const act = x.wouldRestore ? '恢复' : (w?.kind === 'extension' ? '硬删（值一并删除，不可恢复）' : '从本条目脱离（值保留，可 --restore）');
    return `试运行（未落盘）：将${act}条目 ${String(x.entry)} 的字段「${w?.label}」(${w?.key})`;
  }
  const head = x.restored
    ? `已恢复模板字段「${x.field?.label}」(${x.field?.key}) 到本条目，值原样回来`
    : x.removed
      ? `已删除扩展字段「${x.field?.label}」(${x.field?.key})——行与值一并删除，不可恢复`
      : `已从本条目移除模板字段「${x.field?.label}」(${x.field?.key})——值仍保留，用 nx-sk entry remove-field ${x.id} --key ${x.field?.key} --restore 找回`;
  return `${head}\n${renderEntryGet(d as unknown as Awaited<ReturnType<typeof getEntry>>)}`;
}

/**
 * entry.field-update：改条目结构行的**属性**（任务 #24 验收反馈，块头「⋯ → 编辑字段」）。
 *
 * 只改这一条的显示名与描述（label / hint），**不动栏目字典、不动值**——
 * 与 add-field / remove-field 同一条写时复制纪律：条目是独立的一页，
 * 模板只在创建时初始化它。要改整栏目的字典请用 `section update --set-field`。
 */
export async function updateEntryFieldDef(ref: unknown, ctx: {
  key?: unknown; label?: unknown; hint?: unknown; section?: string; 'dry-run'?: boolean;
} = {}) {
  const label = ctx.label === undefined ? undefined : String(ctx.label).trim();
  const hint = ctx.hint === undefined ? undefined : String(ctx.hint);
  if (label === undefined && hint === undefined) {
    throw badInput('没有要改的属性：给 --label（显示名）或 --hint（描述）');
  }
  if (label !== undefined && !label) throw badInput('--label 不能为空（要恢复成 key 请显式传 key）');
  const store = await loadStore();
  const target = resolveEntry(store, ref, ctx.section);
  const sec = mustFindSection(store, target.section);
  const rows = entryStructures(store).get(target.id) || [];
  const row = findOwnRow(rows, ctx.key);
  if (!row) {
    throw notFound(`条目「${target.title || target.id}」没有字段: ${String(ctx.key ?? '').trim()}`);
  }
  if (row.key === SOURCE_FIELD.key) {
    throw badInput(`「${SOURCE_FIELD.label}」是每个条目自带的内置字段（与栏目字典同一条纪律），不给改属性。`);
  }
  if (isDetachedField(row)) {
    throw conflict(`字段「${row.label || row.key}」已从本条目移除——先恢复（entry remove-field --restore）再改属性`);
  }
  const before = { key: row.key, label: row.label || row.key, hint: row.hint || '' };
  const after = { key: row.key, label: label ?? before.label, hint: hint ?? before.hint };
  if (before.label === after.label && before.hint === after.hint) {
    return { status: 'skipped', reason: 'unchanged', entry: target.id, field: after };
  }
  if (ctx['dry-run']) {
    return { status: 'skipped', dryRun: true, entry: target.id, before, wouldUpdate: after };
  }
  const changed = await updateEntryFieldRow(target.id, row.id, {
    label: label !== undefined ? label : undefined,
    hint: hint !== undefined ? hint : undefined,
  });
  if (!changed) throw notFound(`找不到条目结构行: ${row.id}`);
  const got = await getEntry(target.id, { section: sec.id });
  return { ...got, updated: true, field: after, before };
}

export function renderEntryUpdateField(d: Awaited<ReturnType<typeof updateEntryFieldDef>>) {
  const x = d as unknown as {
    status?: string; reason?: string; dryRun?: boolean; entry?: string;
    field?: { key: string; label: string; hint: string };
    before?: { key: string; label: string; hint: string };
    wouldUpdate?: { key: string; label: string; hint: string };
  };
  if (x.status === 'skipped' && x.reason === 'unchanged') {
    return `没有改动：字段「${x.field?.label}」(${x.field?.key}) 的属性已经是这样`;
  }
  if (x.status === 'skipped') {
    return `试运行（未落盘）：将把条目 ${String(x.entry)} 的字段「${x.before?.label}」改为「${x.wouldUpdate?.label}」`
      + (x.wouldUpdate?.hint !== x.before?.hint ? ` · 描述一并更新` : '');
  }
  return `已更新字段「${x.field?.label}」(${x.field?.key}) 的属性（仅本条目，栏目字典与其他条目不受影响）`
    + `\n${renderEntryGet(d as unknown as Awaited<ReturnType<typeof getEntry>>)}`;
}

// —— 表格字段（table）的现值 ——
//
// 为什么要一条专门的命令：`entry get` 会把整条条目都印出来，而表格常常是这个条目的主体；
// 只想看「这张表现在多少、合计多少」时，一条命令给一张对齐的表比翻整条条目快得多。
// 它**不写**任何东西：计算列与统计行都是现算的，没有第二份状态可以走偏。

export async function getTable(ref: unknown, { field, mask, section }: { field?: unknown; mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const structures = entryStructures(store);
  const ownRows = structures.get(entry.id) || null;
  const defs = defsForEntry(sec, ownRows).filter((f) => f.type === 'table');
  if (!defs.length) {
    throw notFound(`栏目「${sec.title}」没有表格字段（table）。现有字段: ${defsForEntry(sec, ownRows).map((f) => `${f.label}(${f.type})`).join('、')}`);
  }
  const wanted = String(field ?? '').trim();
  const def = wanted
    ? (defs.find((f) => f.key === wanted || f.label === wanted) || null)
    : defs[0];
  if (!def) {
    throw notFound(`栏目「${sec.title}」没有叫「${wanted}」的表格字段（有: ${defs.map((f) => `${f.label}(${f.key})`).join('、')}）`);
  }
  const decrypt = await sensitiveViewer(sec, [entry], structures);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt, ownRows });
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    field: def.key,
    fieldLabel: def.label,
    mask: !!mask,
    table: computeTable(def, serialized.values[def.key]),
  };
}

export function renderTable(d: Awaited<ReturnType<typeof getTable>>) {
  const t = d.table;
  const head = `${d.title || d.id}（${d.id}）· 栏目 ${d.sectionTitle} · 表格「${d.fieldLabel}」${d.field} · ${t.count} 行`
    + (t.errorCount ? ` · ${t.errorCount} 处公式错误` : '')
    + (d.mask ? ' · 已打码' : '');
  const totals = t.totals.length
    ? `\n统计行: ${t.totals.map((x) => x.label).join(' / ')}（每列算不算、怎么算，看列定义的 total；整表表达式写在数据的 totals 里）`
    : '';
  const formulas = t.columns.filter((c) => c.computed);
  const fx = formulas.length ? `\n计算列: ${formulas.map((c) => `${c.label} = ${c.formula}`).join('；')}` : '';
  return `${head}\n${renderTableText(t)}${fx}${totals}`;
}

export function renderFields(d: Awaited<ReturnType<typeof fieldDictionary>>) {
  const lines = [`字段字典：${d.count} 个栏目`];
  for (const s of d.sections) {
    lines.push('', `【${s.title}】${s.id}　条目名字段: ${s.titleField || '（未设）'}　共 ${s.fields.length} 字段`);
    for (const g of s.groups) {
      lines.push(`  ${g.title}（${g.id}）`);
      for (const x of s.fields.filter((f) => f.group === g.id)) {
        const cols = Array.isArray(x.columns)
          ? `  列: ${x.columns.map((c) => `${c.label}[${c.type}${c.formula ? ' 算' : ''}]`).join(' / ')}`
          : '';
        lines.push(`    ${x.key.padEnd(22)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.options ? `  可选: ${x.options.join(' / ')}` : ''}${cols}${x.hint ? `　${x.hint}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}
