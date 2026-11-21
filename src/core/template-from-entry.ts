// 条目 → 模板（core）：把一条条目当前的字段结构抄成模板。
//
// 模板只用于**未来初始化**：不复制值、不回刷存量、不影响条目自身结构行。
// 放进 core 是因为 entries / templates 两个模块都要用同一份规则（模块之间不能互 import）。
import { loadStore, mutateStore, entryStructures } from './store.ts';
import { assertSafeId } from './paths.ts';
import { findTemplate } from './fields.ts';
import { resolveEntry } from './locator.ts';
import { conflict } from './errors.ts';
import { nowIso } from './ids.ts';
import { boardGroupsOf } from '../shared/fields/structure.ts';
import type { FieldDef } from '../shared/fields/types.ts';
import { BLANK_TEMPLATE_ID } from '../shared/tree.ts';
import type { StoreTemplate } from './store-shape.ts';

export async function saveEntryAsTemplate(ref: unknown, { id, title, description, template, order, 'dry-run': dryRun }: {
  id?: string; title?: string; description?: string; template?: string; order?: number; 'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, template);
  const sid = assertSafeId(id || `tpl_${entry.id.replace(/^e_/, '')}`, '条目模板 id');
  if (findTemplate(store, sid)) throw conflict(`条目模板已存在: ${sid}（换个 id）`);
  const from = store.templates.find((s) => s.id === entry.template)
    || store.templates.find((s) => s.blank || s.id === BLANK_TEMPLATE_ID);
  const ownRows = entryStructures(store).get(entry.id) || null;
  // 结构行是保真源（含 group 字段）；没有行才回退到模板字典。
  const defs = (ownRows
    ? ownRows.filter((r) => !(r.meta && (r.meta as { detached?: boolean }).detached)).map((r) => r.spec)
    : (from?.fields || [])) as unknown as FieldDef[];
  const cloned = (defs as unknown as Array<Record<string, unknown>>).map((f) => structuredClone(f)) as unknown as FieldDef[];
  const groups = boardGroupsOf(cloned as any).length;
  const draft: StoreTemplate = {
    id: sid,
    title: title || entry.title || sid,
    description: description || `从条目「${entry.title}」保存的条目模板`,
    order: Number.isFinite(order) ? Number(order) : 50,
    template: null,
    blank: false,
    titleField: from?.titleField ?? null,
    titleLabel: from?.titleLabel || '名称',
    tags: [...new Set([...(from?.tags || []), ...(entry.tags || []), sid, title || entry.title || sid])],
    fields: cloned,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  const summary = {
    id: sid, title: draft.title, description: draft.description, order: draft.order,
    template: null, blank: false, titleLabel: draft.titleLabel,
    tags: draft.tags,
    groups, fields: draft.fields.length, entries: 0,
  };
  if (dryRun) return { status: 'skipped', dryRun: true, wouldCreate: summary };
  await mutateStore((s) => { s.templates.push(draft); });
  return { status: 'ok', created: true, template: summary, fromEntry: entry.id };
}
