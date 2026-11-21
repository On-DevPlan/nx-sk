// 条目模板定位：按 id/标题找条目模板。

import type { Store, StoreTemplate } from '../store.ts';

/**
 * 条目模板定位：**id 或标题都接受**。
 * 放宽的理由：agent 手里往往是人读的名字（「求职」），而不是内部 id。
 * 放 core 是因为每个模块都要用它，而模块之间不许互相 import。
 */
export function findTemplate(store: Pick<Store, 'templates'> | null | undefined, ref: unknown): StoreTemplate | null {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return (store?.templates || []).find((x) => x.id === lower)
    || (store?.templates || []).find((x) => x.title === s)
    || null;
}

export function templateNames(store: Pick<Store, 'templates'> | null | undefined): string {
  const names = (store?.templates || []).map((x) => `${x.id}（${x.title}）`).join('、');
  return names || '（还没有条目模板）';
}

