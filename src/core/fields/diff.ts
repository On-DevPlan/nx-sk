// 栏目结构对比与合并：分组补全、字段漂移、模板增量合并。

import type { FieldDef } from '../../shared/fields/types.ts';
import type { StoreSection, SectionGroup } from '../store.ts';
import type { FieldTemplateDef } from './templates.ts';

/** 由「字段定义 + 值」推导栏目的分组结构，供 render/面板用。 */
export function groupFields(fields: Array<{ group?: string }> | null | undefined) {
  const order: string[] = [];
  const map = new Map<string, unknown[]>();
  for (const x of fields || []) {
    const g = x.group || 'other';
    if (!map.has(g)) { map.set(g, []); order.push(g); }
    map.get(g)!.push(x);
  }
  return order.map((id) => ({ id, fields: map.get(id) }));
}

/**
 * 分组声明的**唯一补全规则**：字段引用了未声明的分组 → 追加 `{ id, title: id }`。
 *
 * 背景（servers 栏目事故）：CLI 的分组渲染从字段**推导**（groupFields），
 * 面板却读**声明数组**（section.groups）——`--fields` 引用了 `--groups`
 * 没声明的分组时，两端分叉，面板整个字段表单消失而 CLI 看起来一切正常。
 * 所以「分组声明 ⊇ 字段引用」必须是不变量，在 normalize（读写唯一收口）
 * 和 section add 的草稿上调用同一个函数，规则就不可能有第二份。
 */
export function syncSectionGroups<G extends { id: string; title: string }, F extends { key: string; group?: string }>(
  groups: G[] | null | undefined,
  fields: F[] | null | undefined,
): Array<G | { id: string; title: string }> {
  const out: Array<G | { id: string; title: string }> = [...(groups || [])];
  const declared = new Set(out.map((g) => g.id));
  for (const f of fields || []) {
    const gid = f.group || 'other';
    if (!declared.has(gid)) { declared.add(gid); out.push({ id: gid, title: gid }); }
  }
  return out;
}

/**
 * 同一 key 的字段在「栏目 vs 模板」之间哪些属性不同；空数组 = 定义一致。
 *
 * 比较前先**归一**：`fill` 缺省就是 `normal`（`validateFieldDef` 只在非 normal 时落盘），
 * `options`/`maxItems` 缺失与空数组/空值等价。不归一的话，一份「模板里没写 fill、
 * 栏目里写了 fill:normal」的等价定义会被报成漂移，噪音会淹没真正的差异。
 */
// entrylist 的子字段也要参与漂移对比：清单列是结构的一部分，模板把「密码」列标了
// sensitive 而栏目里没有，这种差异必须报出来——否则密文边界在两份定义间悄悄分叉。
// table 的列与统计行同理：列类型（勾选/下拉/数字）和公式改了，值的样子就变了。
const FIELD_CMP_KEYS = ['label', 'type', 'group', 'hint', 'options', 'maxItems', 'sensitive', 'fill', 'fields', 'columns', 'totals'];

/** 字段比较用的读取侧形状（只声明参与漂移对比的键）。 */
interface LooseField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  group?: unknown;
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
    group: f?.group || 'other',
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
 * 模板增量合并：把模板里**尚未出现在栏目**的分组与字段补进去（只增，绝不改/删）。
 *
 * 为什么需要它：栏目实例化时字段字典是**深拷贝**（见 instantiateTemplate），
 * 从此「栏目自己的字段集独立演化」。于是模板后续新增的字段（例如给求职加
 * 「附件资料」组的 4 个 `file` 字段）**不会回溯**到已经存在的栏目——
 * 面板按栏目自己的字典渲染，老栏目里就永远看不到上传入口。
 *
 * 合并规则（尽量少动用户数据）：
 *   - 分组：按模板顺序排列；栏目已有的分组**沿用栏目自己的定义**（标题可能被改过），
 *     模板没有的自定义分组原顺序附在后面。
 *   - 字段：栏目已有的字段原样保留（含用户改过的 label/hint/fill）；缺的模板字段
 *     插到「模板顺序里它前一个字段」之后，未在模板中的自定义字段保持原位。
 *
 * 另外回传 `changedFields`：**同名字段定义已分叉**的清单（只报告，绝不自动改）。
 * 光有「只增不改」的话，模板改了默认 label/hint 是**完全无声**的 ——
 * 用户会以为「同步过了 = 跟模板一致」，实际不一致。把差异摆出来，改不改由人定。
 */
export function mergeTemplate(section: StoreSection | null | undefined, template: FieldTemplateDef | null | undefined) {
  const existingGroups: SectionGroup[] = section?.groups || [];
  const existingFields: FieldDef[] = section?.fields || [];
  const groupById = new Map(existingGroups.map((g) => [g.id, g] as const));
  const fieldKeys = new Set(existingFields.map((f) => f.key));
  const fieldByKeyMap = new Map(existingFields.map((f) => [f.key, f] as const));

  const groups: SectionGroup[] = [];
  const seenGroup = new Set<string>();
  for (const g of template?.groups || []) {
    groups.push(groupById.get(g.id) || { ...g });
    seenGroup.add(g.id);
  }
  for (const g of existingGroups) if (!seenGroup.has(g.id)) groups.push(g);
  const addedGroups = (template?.groups || []).filter((g) => !existingGroups.some((x) => x.id === g.id)).map((g) => g.id);

  const tplOrder = new Map((template?.fields || []).map((f, i) => [f.key, i] as const));
  const fields = [...existingFields];
  const addedFields: string[] = [];
  const changedFields: Array<{ key: string; diff: string[] }> = [];
  for (const tf of template?.fields || []) {
    if (fieldKeys.has(tf.key)) {
      // 同名 = 定义归栏目；只算差异用于提示
      const diff = fieldDrift(fieldByKeyMap.get(tf.key), tf);
      if (diff.length) changedFields.push({ key: tf.key, diff });
      continue;
    }
    // 插到第一个「模板序更靠后」的既有字段之前；找不到就追加到末尾
    const ti = tplOrder.get(tf.key) as number;
    let insertAt = fields.length;
    for (let i = 0; i < fields.length; i += 1) {
      const oi = tplOrder.get(fields[i].key);
      if (oi !== undefined && oi > ti) { insertAt = i; break; }
    }
    fields.splice(insertAt, 0, { ...tf });
    fieldKeys.add(tf.key);
    addedFields.push(tf.key);
  }

  return { groups, fields, addedGroups, addedFields, changedFields };
}

export function fieldByKey(section: Pick<StoreSection, 'fields'> | null | undefined, key: unknown): FieldDef | null {
  return (section?.fields || []).find((x) => x.key === key) || null;
}

export function fieldByLabel(section: Pick<StoreSection, 'fields'> | null | undefined, label: unknown): FieldDef | null {
  const s = String(label || '').trim();
  return (section?.fields || []).find((x) => x.label === s || x.key === s) || null;
}
