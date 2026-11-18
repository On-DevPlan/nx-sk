// 栏目（section）服务层的公共底座：定位、计数、摘要。
import { notFound } from '../../core/errors.ts';
import { findSection, sectionNames } from '../../core/fields.ts';
import { structureOf } from '../../shared/fields/structure.ts';
import type { Store, StoreSection } from '../../core/store.ts';

export function mustFind(store: Store, ref: unknown): StoreSection {
  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

function countEntries(store: Store, id: string): number {
  return store.entries.filter((e) => e.section === id).length;
}

/** summarize 的入参：读侧只用到这些键（草稿在补时间戳前也能直接摘要）。 */
export interface SectionSummaryInput {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  kv?: boolean;
  titleLabel: string;
  fields: Array<{ key: string; type?: string; keys?: unknown }>;
}

/**
 * 字段字典的**读侧形状**：原样字段 + 派生的 `group`（归属组 key）。
 *
 * 组的归属只住在组字段的 `keys` 里；但面板/CLI 读的时候要「这条字段在哪组」，
 * 所以在读出口补一次（同一份推导，见 shared/fields/structure.ts）。
 */
export function fieldListOf(fields: Array<{ key: string; type?: string; keys?: unknown }>): Array<Record<string, unknown>> {
  const view = structureOf(fields);
  const byKey = new Map(fields.map((f) => [String(f.key), f] as const));
  const emit = (key: string, out: Array<Record<string, unknown>>) => {
    const def = byKey.get(key);
    if (!def || out.some((x) => x.key === key)) return;
    out.push({
      ...def,
      group: view.parentOf.get(key) || undefined,
      keys: Array.isArray(def.keys) ? (def.keys as string[]) : undefined,
    });
    // 组字段后面紧跟它的成员（按 keys 顺序）——面板按这个顺序渲染，和块面板一致。
    for (const child of view.groups.get(key) || []) emit(child, out);
  };
  const out: Array<Record<string, unknown>> = [];
  for (const root of view.roots) emit(root, out);
  // 兜底：没有任何组接管的字段（KV 栏目 / ensureRoot:false）也要出现。
  for (const f of fields) emit(String(f.key), out);
  return out;
}

export function summarize(store: Store, s: SectionSummaryInput) {  // 0.42：分组数不再读 `section.groups`（那份结构已经不存在）——
  // 顶层组 = 字段字典里没被别的组接走的 group 字段。
  const roots = structureOf(s.fields as Array<{ key: string; type?: string; keys?: unknown }>).roots.length;
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    order: s.order,
    template: s.template,
    kv: s.kv === true,
    titleLabel: s.titleLabel,
    groups: roots,
    fields: s.fields.length,
    entries: countEntries(store, s.id),
  };
}

