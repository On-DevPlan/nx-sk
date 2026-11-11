// 栏目定位：按 id/标题找栏目、KV 栏目筛选。

import type { Store, StoreSection } from '../store.ts';

/**
 * 栏目定位：**id 或标题都接受**。
 * 放宽的理由：agent 手里往往是人读的名字（「求职」），而不是内部 id。
 * 放 core 是因为每个模块都要用它，而模块之间不许互相 import。
 */
export function findSection(store: Pick<Store, 'sections'> | null | undefined, ref: unknown): StoreSection | null {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return (store?.sections || []).find((x) => x.id === lower)
    || (store?.sections || []).find((x) => x.title === s)
    || null;
}

export function sectionNames(store: Pick<Store, 'sections'> | null | undefined): string {
  const names = (store?.sections || []).map((x) => `${x.id}（${x.title}）`).join('、');
  return names || '（还没有栏目）';
}

/**
 * KV 栏目：`kv: true` 标记的栏目（密钥就是）。它是**一张表**，不是一族条目。
 * `key set/get/list/remove` 默认作用在它上面；面板也据此切换成表格布局。
 */
export function findKvSection(store: Pick<Store, 'sections'> | null | undefined, ref: unknown): StoreSection | null {
  const all = (store?.sections || []).filter((s) => s.kv);
  if (ref) {
    const hit = findSection(store, ref);
    return hit || null;
  }
  return all[0] || null;
}

export function kvSections(store: Pick<Store, 'sections'> | null | undefined): StoreSection[] {
  return (store?.sections || []).filter((s) => s.kv);
}
