// 条目模板结构对比与合并：分组推导、字段漂移、模板增量合并。
//
// 0.42 起「分组」不再是一份数组：组是 type='group' 的字段（shared/fields/structure.ts）。
// 所以这里不再有 syncTemplateGroups——字段引用与组声明本来就是同一份数据，不会分叉。

import type { FieldDef } from '../../shared/fields/types.ts';
import { boardGroupsOf, groupKeysOf, isGroupDef, structureOf } from '../../shared/fields/structure.ts';
import type { StoreTemplate } from '../store.ts';
import type { FieldTemplateDef } from './templates.ts';
import { templateFieldDefs } from './templates.ts';

/** 由字段字典推导面板分组（顶层组 + 直接成员），供 render/面板用。 */
export function groupFields(fields: readonly FieldDef[] | null | undefined) {
  return boardGroupsOf(fields || []).map((g) => ({ id: g.id, title: g.title, fields: g.fields }));
}

/** 字段所属组的 key（不在任何组里 = undefined）；面板/CLI 显示成员归属用。 */
export function groupKeyOf(fields: readonly FieldDef[] | null | undefined, key: string): string | undefined {
  return structureOf(fields || []).parentOf.get(key);
}

/**
 * 同一 key 的字段在「条目模板 vs 模板」之间哪些属性不同；空数组 = 定义一致。
 *
 * 比较前先**归一**：`fill` 缺省就是 `normal`（`validateFieldDef` 只在非 normal 时落盘），
 * `options`/`maxItems` 缺失与空数组/空值等价。不归一的话，一份「模板里没写 fill、
 * 条目模板里写了 fill:normal」的等价定义会被报成漂移，噪音会淹没真正的差异。
 */
// entrylist 的子字段也要参与漂移对比：清单列是结构的一部分，模板把「密码」列标了
// sensitive 而条目模板里没有，这种差异必须报出来——否则密文边界在两份定义间悄悄分叉。
// table 的列与统计行同理：列类型（勾选/下拉/数字）和公式改了，值的样子就变了。
// 0.42：`group` 换成了组字段的 `keys`——组也是字段，成员的增删同样是结构漂移。
const FIELD_CMP_KEYS = ['label', 'type', 'keys', 'hint', 'options', 'maxItems', 'sensitive', 'fill', 'fields', 'columns', 'totals'];

/** 字段比较用的读取侧形状（只声明参与漂移对比的键）。 */
interface LooseField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  keys?: unknown;
  hint?: unknown;
  options?: unknown;
  maxItems?: unknown;
  sensitive?: unknown;
  fill?: unknown;
  fields?: unknown;
  columns?: unknown;
  totals?: unknown;
}

function normalizedFieldDef(f: LooseField | null | undefined): Record<string, unknown> {
  const options = f?.options;
  const maxItems = f?.maxItems;
  const fields = f?.fields;
  const columns = f?.columns;
  const totals = f?.totals;
  return {
    label: String(f?.label ?? f?.key ?? ''),
    type: f?.type || 'text',
    keys: Array.isArray(f?.keys) ? f.keys.map(String) : [],
    hint: f?.hint ? String(f.hint) : '',
    options: Array.isArray(options) ? options.map(String) : [],
    maxItems: Number.isFinite(maxItems) ? maxItems : null,
    sensitive: f?.sensitive === true,
    fill: f?.fill || 'normal',
    // 子字段只比结构三要素（key/label/sensitive）；hint 是文案，抖动太频繁不值得报
    fields: Array.isArray(fields)
      ? fields.map((s) => ({ key: String(s?.key || ''), label: String(s?.label || s?.key || ''), sensitive: s?.sensitive === true }))
      : null,
    // 表格列：类型与公式决定「这一格怎么算」，改了一定要报
    columns: Array.isArray(columns)
      ? columns.map((s) => ({
        key: String(s?.key || ''), label: String(s?.label || s?.key || ''),
        type: String(s?.type || 'text'), sensitive: s?.sensitive === true, formula: String(s?.formula || ''),
      }))
      : null,
    totals: Array.isArray(totals) ? totals : null,
  };
}

export function fieldDrift(sectionField: LooseField | null | undefined, templateField: LooseField | null | undefined): string[] {
  const a = normalizedFieldDef(sectionField);
  const b = normalizedFieldDef(templateField);
  return FIELD_CMP_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * 模板增量合并：把模板里**尚未出现在条目模板**的字段（含组字段）补进去（只增，绝不改/删）。
 *
 * 为什么需要它：条目模板实例化时字段字典是**深拷贝**（见 instantiateTemplate），
 * 从此「条目模板自己的字段集独立演化」。于是模板后续新增的字段（例如给求职加
 * 「附件资料」组里的 4 个 `file` 字段）**不会回溯**到已经存在的条目模板——
 * 面板按条目模板自己的字典渲染，老条目模板里就永远看不到上传入口。
 *
 * 合并规则（尽量少动用户数据）：
 *   - 字段：条目模板已有的字段原样保留（含用户改过的 label/hint/fill/key 顺序）；
 *     缺的模板字段插到「模板顺序里它前一个字段」之后，未在模板中的自定义字段保持原位。
 *   - 组：模板新增的组成员要**并进**条目模板里同名组字段的 keys（否则新字段会变成孤儿）；
 *     模板新增的组本身也按模板顺序补一条组字段。
 *   - 「原始资料」袋不在模板里（由 ensureSourceBuiltin 收口），合并时不碰。
 *
 * 另外回传 `changedFields`：**同名字段定义已分叉**的清单（只报告，绝不自动改）。
 * 光有「只增不改」的话，模板改了默认 label/hint 是**完全无声**的 ——
 * 用户会以为「同步过了 = 跟模板一致」，实际不一致。把差异摆出来，改不改由人定。
 */
export function mergeTemplate(entryTemplate: StoreTemplate | null | undefined, preset: FieldTemplateDef | null | undefined) {
  const existingFields: FieldDef[] = entryTemplate?.fields || [];
  if (!entryTemplate || !preset) return { fields: existingFields, addedGroups: [], addedFields: [], changedFields: [] };
  const tplFields = templateFieldDefs(preset);
  const existingByKey = new Map(existingFields.map((f) => [f.key, f] as const));
  const tplOrder = new Map(tplFields.map((f, i) => [f.key, i] as const));

  // 1. 字段增量（组字段也走同一条：先当字段插进去，下面再决定 keys）
  const fields: FieldDef[] = [...existingFields];
  const addedFields: string[] = [];
  const addedGroups: string[] = [];
  const changedFields: Array<{ key: string; diff: string[] }> = [];
  for (const tf of tplFields) {
    const hit = existingByKey.get(tf.key);
    if (hit) {
      if (!isGroupDef(tf)) {
        const diff = fieldDrift(hit, tf);
        if (diff.length) changedFields.push({ key: tf.key, diff });
      }
      continue;
    }
    const ti = tplOrder.get(tf.key) as number;
    let insertAt = fields.length;
    for (let i = 0; i < fields.length; i += 1) {
      const oi = tplOrder.get(fields[i].key);
      if (oi !== undefined && oi > ti) { insertAt = i; break; }
    }
    fields.splice(insertAt, 0, { ...tf } as FieldDef);
    existingByKey.set(tf.key, tf as FieldDef);
    addedFields.push(tf.key);
    if (isGroupDef(tf)) addedGroups.push(tf.key);
  }

  // 2. 组成员的增量：模板的组成员并入条目模板同名组（组标题、顺序都沿用条目模板自己的）
  const tplGroups = new Map(tplFields.filter(isGroupDef).map((g) => [String(g.key), groupKeysOf(g)] as const));
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (!isGroupDef(f)) continue;
    const tplKeys = tplGroups.get(String(f.key));
    if (!tplKeys) continue;
    const keys = groupKeysOf(f);
    // 模板里的成员按**模板顺序**排（新字段要落在它模板序的位置上），
    // 条目模板自己的额外成员留在后面——只增不改，但不打乱模板给的次序。
    const merged: string[] = [];
    for (const k of tplKeys) if (existingByKey.has(k) && !merged.includes(k)) merged.push(k);
    for (const k of keys) if (!merged.includes(k)) merged.push(k);
    fields[i] = { ...f, keys: merged } as FieldDef;
  }

  return { fields, addedGroups, addedFields, changedFields };
}

export function fieldByKey(template: Pick<StoreTemplate, 'fields'> | null | undefined, key: unknown): FieldDef | null {
  return (template?.fields || []).find((x) => x.key === key) || null;
}

export function fieldByLabel(template: Pick<StoreTemplate, 'fields'> | null | undefined, label: unknown): FieldDef | null {
  const s = String(label || '').trim();
  return (template?.fields || []).find((x) => x.label === s || x.key === s) || null;
}

