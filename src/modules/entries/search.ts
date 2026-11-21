// 条目检索：给 agent / CLI 的轻量搜索口。
//
// 与 `entry list` 的区别：这里不返回完整 values / 完整度，只返回定位需要的字段，
// 并且把 q 同时扫标题、模板标题、tag、字段标签与非敏感字段值；tag 过滤是名词精确匹配，
// 不是把 tag 拼进全文后碰巧命中。值仍只从 store 读（敏感字段是密文对象，不解密）。
import { entryStructures, loadStore, type StoreEntry } from '../../core/store.ts';
import { notFound } from '../../core/errors.ts';
import { isSensitiveField } from '../../core/fields.ts';
import { isBlank } from '../../core/render.ts';
import { BLANK_TEMPLATE_ID } from '../../shared/tree.ts';
import { defsForEntry, resolveEntry } from './shared.ts';

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.trim()).filter(Boolean);
  return String(raw ?? '').split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean);
}

function flattenText(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) { for (const x of value) flattenText(x, out); return; }
  if (typeof value === 'object') { for (const x of Object.values(value as Record<string, unknown>)) flattenText(x, out); }
}

/** tag 精确匹配：一个条目多 tag；多个查询 tag 默认任一命中，`all` 时全部命中。 */
export function entryMatchesTags(entry: { tags?: string[] }, tags: unknown, mode: 'any' | 'all' = 'any'): boolean {
  const wanted = parseTags(tags);
  if (!wanted.length) return true;
  const own = (entry.tags || []).map(String);
  return mode === 'all' ? wanted.every((t) => own.includes(t)) : wanted.some((t) => own.includes(t));
}

export interface EntrySearchHit {
  id: string; title: string; template: string; templateTitle: string;
  templateTags: string[]; tags: string[]; parent: string | null;
  sort: number; updatedAt: string | null; fields: string[];
}

export async function searchEntries({
  q, tag, template, parent, limit = 50, 'tag-mode': tagMode,
}: {
  q?: unknown; tag?: unknown; template?: string; parent?: string; limit?: number; 'tag-mode'?: string;
} = {}) {
  const mode = tagMode === 'all' ? 'all' : 'any';
  const needle = String(q ?? '').trim().toLowerCase();
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const store = await loadStore();
  const structures = entryStructures(store);
  let list: StoreEntry[] = store.entries;
  if (template) {
    const sec = store.templates.find((s) => s.id === template || s.title === template);
    if (!sec) throw notFound(`找不到条目模板: ${template}`);
    list = list.filter((e) => e.template === sec.id);
  }
  if (parent !== undefined) {
    const pid = parent === '' || parent === 'root' ? null : resolveEntry(store, parent).id;
    list = list.filter((e) => (e.parent ?? null) === pid);
  }
  if (tag !== undefined) list = list.filter((e) => entryMatchesTags(e, tag, mode));

  const hits: EntrySearchHit[] = [];
  for (const e of list) {
    const sec = store.templates.find((s) => s.id === e.template)
      || store.templates.find((s) => s.blank || s.id === BLANK_TEMPLATE_ID);
    if (!sec) continue;
    const ownRows = structures.get(e.id) || null;
    const defs = defsForEntry(sec, ownRows);
    if (needle) {
      const hay: string[] = [e.title, sec.title, sec.id, ...(e.tags || []), ...(sec.tags || []), sec.description];
      for (const def of defs) {
        hay.push(String(def.key), String(def.label ?? ''));
        if (isSensitiveField(sec, def.key)) continue;
        flattenText(e.values?.[def.key], hay);
      }
      if (!hay.join('\n').toLowerCase().includes(needle)) continue;
    }
    hits.push({
      id: e.id, title: e.title, template: e.template, templateTitle: sec.title,
      templateTags: sec.tags || [], tags: e.tags || [], parent: e.parent ?? null,
      sort: Number(e.sort) || 0, updatedAt: e.updatedAt || null,
      fields: defs.filter((d) => !isBlank(e.values?.[d.key])).map((d) => d.key),
    });
  }
  hits.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || String(a.title).localeCompare(String(b.title)));
  return {
    q: needle, tag: parseTags(tag), tagMode: mode, template: template || null,
    total: hits.length, count: Math.min(hits.length, max), limit: max,
    hits: hits.slice(0, max),
  };
}

export function renderEntrySearch(d: Awaited<ReturnType<typeof searchEntries>>) {
  const lines = [`${d.total} 条匹配${d.q ? ` · q=${d.q}` : ''}${d.tag.length ? ` · tag=${d.tag.join(' / ')}` : ''}`];
  for (const h of d.hits) {
    lines.push(`  ${String(h.title).padEnd(24)} ${h.id}　${h.templateTitle}${h.tags.length ? `　#${h.tags.join(' #')}` : ''}`);
  }
  if (d.total > d.count) lines.push(`  …另有 ${d.total - d.count} 条，用 --limit 放大或加 --tag`);
  return lines.join('\n');
}
