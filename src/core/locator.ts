// 条目定位（core）：id 优先，其次唯一标题；重名时报 CONFLICT 让调用方用 id 指定。
//
// 0.43 从 modules/entries/shared.ts 下沉到这里：templates / tree 模块也要按 ref 找条目，
// 模块之间不能互相 import，定位规则必须只有一份。
import { badInput, conflict, notFound } from './errors.ts';
import { findTemplate } from './fields.ts';
import type { Store, StoreEntry } from './store-shape.ts';

export function resolveEntry(store: Store, ref: unknown, sectionRef?: unknown): StoreEntry {
  const key = String(ref ?? '').trim();
  if (!key) throw badInput('缺少条目定位：给条目 id（e_...）或条目名');
  let list = store.entries;
  if (sectionRef) {
    const s = findTemplate(store, sectionRef);
    if (!s) throw notFound(`找不到条目模板: ${sectionRef}`);
    list = list.filter((e) => e.template === s.id);
  }
  const byId = list.find((e) => e.id === key);
  if (byId) return byId;
  const byTitle = list.filter((e) => e.title === key);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw conflict(`有 ${byTitle.length} 条同名条目「${key}」，请用 id 指定: ${byTitle.map((e) => e.id).join(' / ')}`);
  }
  throw notFound(`找不到条目: ${ref}`);
}
