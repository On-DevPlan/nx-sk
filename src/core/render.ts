// 纯渲染逻辑（不碰磁盘、不碰平台）——值格式化、条目序列化、栏目全量视图。
// 放 core 是为了能单测：这些函数决定了「读出去的形状」，是最该被钉住的契约。
//
// 这里**不解密**：解密需要密钥（异步、且属于安全边界），所以由调用方把一个
// `decrypt(blob) => 明文` 传进来（core/vault.js 的 `sensitiveViewer` 负责造它）。
// 这样 render 保持纯函数，而「什么时候允许看明文」仍然只有一个决策点。
import { FILL_LABELS, fillPolicy, isExcludedField, isSensitiveField } from './fields.ts';
// 值的「空/非空」判据与密文展示只有一个实现（P2 下沉，见 core/values.ts / core/sensitive.ts）；
// 这里 re-export，老的 `from './render.ts'` 导入点不受影响。
import { isBlank, isPlainRow, isStoredEmpty } from './values.ts';
import { displaySensitive } from './sensitive.ts';
import { behaviorOf } from './fields/registry.ts';
import type { TableColumnDef } from '../shared/fields/types.ts';
import type { SerializedEntry } from '../shared/model.ts';
import type { EntryFieldView } from './store-shape.ts';
// 版式（块布局）的对齐规则也只有一份：读出去之前先按当前字段自愈一遍，
// 面板与 CLI 才看到同一份「现在实际怎么摆」。
import { groupsForLayout, reconcileLayout } from '../shared/blockLayout.ts';
export { isBlank, isStoredEmpty } from './values.ts';
export { displaySensitive } from './sensitive.ts';

/** 字段定义的读取侧形状：历史数据宽松，这里只列读取时真正会碰的键。 */
export interface ReadField {
  key: string;
  label: string;
  type: string;
  group?: string;
  hint?: string;
  options?: string[] | null;
  fields?: unknown;
  columns?: TableColumnDef[] | unknown | null;
  totals?: unknown;
  summary?: boolean;
  maxRows?: number | null;
  kind?: string;
  fill?: unknown;
  sensitive?: unknown;
}

/**
 * 栏目定义的读取侧形状。
 *
 * 这里区分「永远存在」与「真正可选」：除 `layout` 外，store 归一化后这些键一定在
 * （见 core/store.ts 的 StoreSection / normalizeSection）；`layout` 在播种草稿、
 * 归一之前可能没有，读路径会过 reconcileLayout 自愈。
 */
export interface SectionLike {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  kv: boolean;
  titleField: string | null;
  titleLabel: string;
  groups: unknown;
  layout?: unknown;
  fields: ReadField[];
}

/**
 * 条目的读取侧形状。归一化后 id/section/title/tags/values/时间戳全都在
 * （见 core/store.ts 的 StoreEntry），所以这里不留可选。
 */
export interface EntryLike {
  id: string;
  section: string;
  title: string;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  values: Record<string, unknown>;
}

/** 值 → 人读字符串（bool / tags / 数组 / 标量 / entrylist 行）。 */
export function formatValue(value: unknown): string {
  if (isBlank(value)) return '';
  // 表格文档：按「列名=值 · 列名=值；下一行」压成一行（section dump 的表格放不下多行版）
  const doc = value as { rows?: unknown; columns?: unknown };
  if (typeof value === 'object' && Array.isArray(doc.rows)) {
    const cols = (Array.isArray(doc.columns) ? doc.columns : []) as Array<{ key: string; label?: string }>;
    const labelOf = (k: string) => cols.find((c) => c.key === k)?.label || k;
    return (doc.rows as Array<Record<string, unknown>>).map((row) => Object.entries(row || {})
      .filter(([, v]) => !isBlank(v))
      .map(([k, v]) => `${labelOf(k)}=${typeof v === 'boolean' ? (v ? '是' : '否') : (Array.isArray(v) ? v.join('、') : String(v))}`)
      .join(' · ')).filter(Boolean).join('；');
  }
  if (Array.isArray(value)) {
    // 结构清单的行：`k=v · k=v；k=v` 压成一行——section dump 的表格里放不下多行版
    if (value.length && value.every((x) => isPlainRow(x))) {
      return value.map((row) => Object.entries(row as Record<string, unknown>)
        .filter(([, v]) => !isBlank(v))
        .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? '是' : '否') : String(v)}`)
        .join(' · ')).filter(Boolean).join('；');
    }
    return value.map(String).join('、');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

/** 条目序列化后的读取侧形状（面板 / CLI / dump 共用，声明在 shared）。 */
export type { SerializedEntry };

/**
 * 条目的**唯一序列化出口**（面板、`entry list`、`section dump` 共用一份）。
 * 两个出口各写一遍序列化，迟早会分叉成「CLI 看得到、面板看不到」。
 *
 * v3：传 `ownRows`（条目自身结构行）时按**行**序列化——扩展行里的值也带得出去，
 * 字典改了 label 也不回刷存量条目；不传则退回栏目字典（旧行为，纯函数调用方不受影响）。
 */
export function serializeEntry(
  section: SectionLike,
  entry: EntryLike,
  { mask = false, decrypt, ownRows }: { mask?: boolean; decrypt?: (blob: unknown) => string; ownRows?: EntryFieldView[] | null } = {},
): SerializedEntry {
  const defs: ReadField[] = ownRows ? ownRows.map((r) => r.spec as unknown as ReadField) : section.fields;
  const c = completeness(section, entry, ownRows);
  const values: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = entry.values?.[def.key];
    // 这里用 isStoredEmpty 而不是 isBlank：空表（有列没行）要带出去，否则骨架丢失
    if (isStoredEmpty(raw)) { values[def.key] = null; continue; }
    if (def.type === 'entrylist' && Array.isArray(raw)) {
      values[def.key] = behaviorOf(def.type).reveal(def, raw, { mask, decrypt });
      continue;
    }
    // 表格读出去永远是**自描述的完整文档**：columns / rows / 可选 totals。
    // 列存在数据里，所以读的人（面板、agent、导出）不必再去查栏目字典才知道有哪些列。
    if (def.type === 'table') {
      values[def.key] = behaviorOf(def.type).reveal(def, raw, { mask, decrypt });
      continue;
    }
    values[def.key] = behaviorOf(def.type).sensitive(def)
      ? displaySensitive(raw, { mask, decrypt })
      : raw;
  }
  return {
    id: entry.id,
    section: entry.section,
    title: entry.title,
    tags: entry.tags || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completeness: {
      filled: c.filled,
      total: c.total,
      ratio: c.ratio,
      excluded: c.excluded.length,
      excludedFilled: c.excludedFilled,
    },
    missing: c.missing.map((x) => ({ key: x.key, label: x.label })),
    // 与 missing 并列：这些是**主动不填**的字段，不是「还没填」。
    // 两者混在一起会让「补全清单」和「不填清单」分不开。
    excluded: c.excluded,
    values,
  };
}

/**
 * 完整度：**只统计照常填的字段**。给「AI 帮我补全信息」当导航用。
 *
 * `optional` / `avoid` 两类字段既不计入 `total` 也不计入 `filled`——
 * 否则「还缺 N 项」会永远挂着一批用户主动决定不填的字段，导航就失效了。
 * 它们不会凭空消失：`excluded` 单独列出来，`excludedFilled` 记录其中已填了几个
 * （用户可能没改策略却还是填了值，这个数能提示策略该更新了）。
 *
 * v3：传 `ownRows` 时只统计条目**出身模板**的行（templateFieldId 非 NULL）——
 * 扩展字段是「大胆写」写出来的，不该反过来欠用户一个「未填」。
 */
export function completeness(
  section: SectionLike | null | undefined,
  entry: { values?: Record<string, unknown> } | null | undefined,
  ownRows?: EntryFieldView[] | null,
) {
  const fields: ReadField[] = ownRows
    ? ownRows.filter((r) => r.templateFieldId != null).map((r) => r.spec as unknown as ReadField)
    : section?.fields || [];
  const counted = fields.filter((d) => !isExcludedField(d));
  const excluded = fields.filter((d) => isExcludedField(d));
  const missing: ReadField[] = [];
  let filled = 0;
  for (const def of counted) {
    if (isBlank(entry?.values?.[def.key])) missing.push(def);
    else filled++;
  }
  const total = counted.length;
  return {
    filled,
    total,
    ratio: total ? Math.round((filled / total) * 100) : 0,
    missing,
    excluded: excluded.map((d) => ({ key: d.key, label: d.label, fill: fillPolicy(d), fillLabel: FILL_LABELS[fillPolicy(d) as keyof typeof FILL_LABELS] })),
    excludedFilled: excluded.filter((d) => !isBlank(entry?.values?.[d.key])).length,
  };
}

/** 栏目的纯数据视图：所有条目 + 全部字段（含未填），供 `section dump` 与面板用。 */
export function dumpSection(
  section: SectionLike,
  entries: EntryLike[],
  { mask = false, decrypt, structures }: { mask?: boolean; decrypt?: (blob: unknown) => string; structures?: Map<string, EntryFieldView[]> } = {},
) {
  const mine = entries.filter((e) => e.section === section.id);
  return {
    section: {
      id: section.id,
      title: section.title,
      description: section.description,
      order: section.order,
      template: section.template,
      kv: section.kv === true,
      titleField: section.titleField,
      titleLabel: section.titleLabel,
      fields: section.fields.length,
    },
    groups: section.groups,
    // 正文版式：分组面板的顺序、每块的位置/宽度/高度（按断点）。字段增删后在这里
    // 对齐一次，所以读到的永远能直接渲染——不会出现「引用了已删字段的空块」。
    layout: reconcileLayout(section.layout, groupsForLayout(section)),
    fields: section.fields.map((x) => ({
      key: x.key,
      label: x.label,
      type: x.type,
      group: x.group,
      hint: x.hint || '',
      options: x.options || null,
      // 结构清单的列（子字段）必须跟着字典出去，否则面板渲染不出列、agent 不知道行里该有什么键
      fields: x.fields || null,
      // 表格的列（带类型/公式）与统计行同理：不知道列定义，agent 只能瞎猜行里能写什么
      columns: x.columns || null,
      totals: x.totals || null,
      summary: x.summary === false ? false : undefined,
      maxRows: x.maxRows || null,
      kind: x.kind || '',
      sensitive: isSensitiveField(section, x.key),
      // 填写策略要跟着字段字典出去，否则面板与 agent 不知道哪个格子「不用填」
      fill: fillPolicy(x),
      fillLabel: FILL_LABELS[fillPolicy(x) as keyof typeof FILL_LABELS],
    })),
    count: mine.length,
    entries: mine.map((e) => serializeEntry(section, e, { mask, decrypt, ownRows: structures?.get(e.id) })),
  };
}
