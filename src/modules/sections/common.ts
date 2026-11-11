// 栏目（section）服务层的公共底座：定位、计数、摘要。
import { notFound } from '../../core/errors.ts';
import { findSection, sectionNames } from '../../core/fields.ts';
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
  groups: unknown[];
  fields: unknown[];
}

export function summarize(store: Store, s: SectionSummaryInput) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    order: s.order,
    template: s.template,
    kv: s.kv === true,
    titleLabel: s.titleLabel,
    groups: s.groups.length,
    fields: s.fields.length,
    entries: countEntries(store, s.id),
  };
}
