import { loadStore, mutateStore, type Store, type StoreEntry } from '../../core/store.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { SOURCE_FIELD, SOURCE_GROUP } from '../../core/fields.ts';
import { nowIso } from '../../core/ids.ts';
import * as att from '../../core/attachments.ts';
import { mdImageIds, rewriteMdImages } from '../../core/mdimages.ts';
import { displayPath } from '../../core/paths.ts';
import { normalizeSourceItem, normalizeSourceItems, resolveSourceConflicts, sourceItemTimeLabel } from '../../core/source.ts';
import type { SourceItem } from '../../shared/fields/types.ts';
import { mustFindSection, resolveEntry } from './shared.ts';

// —— 原始资料袋（source 字段）——
//
// 袋是**乱入区**：先原样收下杂乱资料（邮件、截图、PDF 摘录、手抄的表），
// 之后由 agent 或人按栏目字段字典整理成结构化字段。
// 命令族：source list / get / add / remove / ensure。

/** 某条目的袋内容（原始形状）。 */
function sourceItemsOf(entry: StoreEntry | null | undefined): SourceItem[] {
  return normalizeSourceItems(entry?.values?.source) || [];
}

/** 袋里引用的附件解析（名字 / 物理路径 / 链接）——否则只剩一串 f_xxx。 */
/**
 * source 涉及的附件：file item 指向的 + **text（markdown）正文里内嵌的** `![x](f_xxx)`。
 * 渲染（面板解析图片 / CLI 把 id 还原成路径）与完整性检查都以这份为准。
 */
function sourceFiles(store: Store, items: SourceItem[]): Record<string, { id: string; name: string; ext: string; isImage: boolean; path: string; url: string; downloadUrl: string }> {
  const files: Record<string, { id: string; name: string; ext: string; isImage: boolean; path: string; url: string; downloadUrl: string }> = {};
  const put = (id: string | undefined) => {
    if (!id || files[id]) return;
    const rec = att.findFileRecord(store, id);
    if (!rec) return;
    const links = att.fileLinks(rec);
    files[id] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  };
  for (const item of items) {
    if (item.kind === 'file' && item.fileId) put(item.fileId);
    // text 的底层是 markdown：正文里内嵌的 `![x](f_xxx)` 也是正式引用
    else if (item.kind === 'text' && item.text) for (const id of mdImageIds(item.text)) put(id);
  }
  return files;
}

/** source list：各栏目的袋子概况。 */
export async function listSource({ section }: { section?: string } = {}) {
  const store = await loadStore();
  const secs = section
    ? [mustFindSection(store, section)]
    : store.sections.filter((s) => s.kv !== true);
  const out = [];
  for (const sec of secs) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    let items = 0;
    let filled = 0;
    for (const e of mine) {
      const n = sourceItemsOf(e).length;
      if (n) { filled += 1; items += n; }
    }
    out.push({
      section: sec.id,
      sectionTitle: sec.title,
      hasField: sec.fields.some((f) => f.type === 'source'),
      entries: mine.length,
      filled,
      items,
    });
  }
  return { count: out.length, sections: out };
}

/** source get：某条目的袋明细。 */
export async function getSource(ref: unknown, { section }: { section?: string } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const items = sourceItemsOf(entry);
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    hasField: sec.fields.some((f) => f.type === 'source'),
    count: items.length,
    // 当前版本 = 没被取代的；旧的留痕但不算数
    current: items.filter((x) => !x.superseded).length,
    superseded: items.filter((x) => x.superseded).length,
    items,
    files: sourceFiles(store, items),
    updatedAt: entry.updatedAt,
  };
}

/** source add：往袋里加一条（文字 / 文件 / 网址）。 */
export async function addSourceItem(ref: unknown, { section, text, file, url, name, note, mapped, at, supersedes, 'dry-run': dryRun }: {
  section?: string;
  text?: unknown;
  file?: string;
  url?: string;
  name?: string;
  note?: string;
  mapped?: unknown;
  at?: string;
  supersedes?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, target.section);
  if (!sec.fields.some((f) => f.type === 'source')) {
    throw badInput(`栏目「${sec.title}」没有「原始资料」字段（source）——先跑 nx-sk source ensure 补上`);
  }
  const items = sourceItemsOf(target);
  let item = null;
  const extra: { note?: string; mapped?: unknown; at?: string; supersedes?: unknown } = { note, mapped, at };
  if (supersedes) extra.supersedes = Array.isArray(supersedes) ? supersedes : [supersedes];
  if (file) {
    // 文件先进附件库，袋里只留引用。**默认复制不搬走**：「加一条资料」不该把用户本机的
    // 原件搬进库里（那是 `file add` 的语义，且它明写「默认移动」）。
    const outcome = await att.importLocalFile(store, { path: file, copy: true, category: 'other' });
    item = normalizeSourceItem({ kind: 'file', fileId: outcome.record!.id, name: name || outcome.record!.name, ...extra });
    if (!dryRun && !outcome.duplicate) await mutateStore((s) => { s.files.push(outcome.record!); });
  } else if (url) {
    item = normalizeSourceItem({ kind: 'url', url, name, ...extra });
  } else if (text !== undefined && text !== null && String(text).trim() !== '') {
    item = normalizeSourceItem({ kind: 'text', text, name, ...extra });
  } else {
    throw badInput('要给一条资料：--text <文字> | --file <本机路径> | --url <网址>');
  }
  if (!item) throw badInput('这条资料是空的，没东西可加');
  // 冲突判定（同名以新的为准、旧的留痕）在归一层统一发生
  const next = resolveSourceConflicts([...items, item]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: item, count: next.length };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', added: item, count: next.length, current: next.filter((x) => !x.superseded).length, id: target.id, title: target.title, section: sec.id };
}

/**
 * source update：改袋里某一条的**元信息**（名字 / 备注 / 整理去向）。
 *
 * 为什么要它：「整理完要留痕」是双向同步的锚点 —— 一条资料被同步到哪些字段（mapped）
 * 记在它自己身上，下次同步就能知道「这条已经用过」，不会重复整理。
 * 注意**不改正文**（text 永远是原文；改内容 = 删掉重加）。
 */
export async function updateSourceItem(ref: unknown, { section, id, name, note, mapped, at, superseded, 'dry-run': dryRun }: {
  section?: string;
  id?: unknown;
  name?: unknown;
  note?: unknown;
  mapped?: unknown;
  at?: unknown;
  superseded?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) throw notFound(`袋里没有这条资料: ${key}`);
  const item = { ...items[idx] };
  if (name !== undefined) item.name = String(name);
  if (note !== undefined) item.note = String(note);
  if (at !== undefined) item.at = String(at);
  if (superseded !== undefined) {
    if (superseded === true) item.superseded = true;
    else delete item.superseded;
  }
  if (mapped !== undefined) {
    const list = Array.isArray(mapped) ? mapped : String(mapped).split(/[,，、]+/);
    const keys = list.map((x) => String(x).trim()).filter(Boolean);
    if (keys.length) item.mapped = keys;
    else delete item.mapped;
  }
  const next = resolveSourceConflicts([...items.slice(0, idx), item, ...items.slice(idx + 1)]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: item };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', updated: item, count: next.length, id: target.id, title: target.title };
}

/** source remove：从袋里删掉一条。 */
export async function removeSourceItem(ref: unknown, { section, id, 'dry-run': dryRun }: { section?: string; id?: unknown; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) {
    const hint = items.length ? `袋里有 ${items.length} 条，用 nx-sk source get ${target.id} 看 id` : '袋是空的';
    throw notFound(`袋里没有这条资料: ${key}（${hint}）`);
  }
  const [gone] = items.splice(idx, 1);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: gone };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id)!;
    e.values.source = items.length ? items : null;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', removed: gone, count: items.length, id: target.id, title: target.title };
}

/**
 * source ensure：给所有缺「原始资料」字段的栏目补上。
 *
 * 为什么需要它：栏目是**持久化数据**，模板后来新增的字段不会回溯到已建好的栏目
 * （老问题的同一形状，见 `section sync`）。source 字段是「每个栏目都该有」的那种，
 * 所以给一条命令把缺口一次补齐，而不是让用户逐个栏目加。
 */
export async function ensureSourceFields({ 'dry-run': dryRun }: { 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const added: string[] = [];
  const skipped: Array<{ id: string; title: string; why: string }> = [];
  for (const sec of store.sections) {
    if (sec.kv) { skipped.push({ id: sec.id, title: sec.title, why: 'KV 表（形状固定，不加字段）' }); continue; }
    if (sec.fields.some((f) => f.type === 'source')) { skipped.push({ id: sec.id, title: sec.title, why: '已有' }); continue; }
    added.push(sec.id);
  }
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: added, skipped };
  if (!added.length) return { status: 'ok', added: [], skipped, count: 0 };
  await mutateStore((s) => {
    for (const id of added) {
      const sec = s.sections.find((x) => x.id === id);
      if (!sec) continue;
      if (!sec.groups.some((g) => g.id === SOURCE_GROUP.id)) sec.groups.push({ ...SOURCE_GROUP });
      if (!sec.fields.some((f) => f.key === SOURCE_FIELD.key)) sec.fields.push({ ...SOURCE_FIELD });
      sec.updatedAt = nowIso();
    }
  });
  return { status: 'ok', added, skipped, count: added.length };
}

// —— CLI 人读渲染（原始资料） ——
const SOURCE_KIND_LABEL = { text: '文字', file: '附件', url: '网址' };

export function renderSourceList(d: Awaited<ReturnType<typeof listSource>>) {
  const lines = [`原始资料袋 · ${d.count} 个栏目`];
  for (const s of d.sections) {
    const tag = s.hasField ? '' : '　[缺 source 字段：nx-sk source ensure 补上]';
    lines.push(`  ${s.section.padEnd(14)}${s.sectionTitle}　${s.items} 条资料 / ${s.filled} 个条目有袋（栏目共 ${s.entries} 条目）${tag}`);
  }
  lines.push('', '看某个条目的袋: nx-sk source get <条目id>　　加一条: nx-sk source add <条目id> --text "…"');
  return lines.join('\n');
}

export function renderSourceGet(d: Awaited<ReturnType<typeof getSource>>) {
  const lines = [`${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 原始资料 ${d.count} 条`
    + (d.superseded ? `（当前 ${d.current} 条，另有 ${d.superseded} 条被更新的取代、留痕可查）` : '')];
  if (!d.count) {
    lines.push('  （袋子是空的）');
    lines.push('', `加一条: nx-sk source add ${d.id} --text "随手记的一句"`);
    return lines.join('\n');
  }
  for (const item of d.items) {
    const kind = SOURCE_KIND_LABEL[item.kind] || item.kind;
    const mapped = item.mapped?.length ? `　→ 已整理到 ${item.mapped.join('、')}` : '';
    const old = item.superseded ? '　[已被取代，留痕]' : '';
    const when = sourceItemTimeLabel(item);
    lines.push(`  ${item.id}　[${kind}] ${item.name}${when ? `　${when}` : ''}${old}${mapped}`);
    if (item.kind === 'file') {
      const f = item.fileId ? d.files?.[item.fileId] : undefined;
      lines.push(`      ${f ? `${f.name}　${f.path}` : `附件 ${item.fileId}（库里已不存在）`}`);
    } else if (item.kind === 'text') {
      // text 的底层是 markdown：图片引用还原成「[图片: 说明] 本地路径」，外链标注「外链」——
      // CLI 没法显示图，但读者要知道这里本来有图、图在哪。
      const text = rewriteMdImages(item.text, (id) => d.files?.[id] || null);
      for (const line of String(text).split('\n')) lines.push(`      ${line}`);
    } else if (item.kind === 'url') {
      lines.push(`      ${item.url}`);
    }
    if (item.note) lines.push(`      备注: ${item.note}`);
  }
  lines.push('', `整理成结构化字段: nx-sk entry update ${d.id} --data @整理.json`);
  return lines.join('\n');
}

/** renderSourceChange 的入参：source add/update/remove/ensure 的结果共用的读侧形状。 */
interface SourceChangeView {
  status?: string;
  wouldAdd?: unknown;
  wouldChange?: unknown;
  wouldRemove?: unknown;
  added?: unknown;
  removed?: SourceItem | null;
  count?: number;
}

export function renderSourceChange(d: SourceChangeView) {
  if (d.status === 'skipped') {
    // 顺序要紧：ensure 的 wouldAdd 是**栏目 id 数组**，add 的是**一条资料对象**——
    // 数组也是真值，先判 item 会把数组当成资料渲染成 "[undefined] undefined"。
    if (Array.isArray(d.wouldAdd)) {
      return d.wouldAdd.length
        ? `试运行（未落盘）：将给 ${d.wouldAdd.length} 个栏目补上「原始资料」字段：${d.wouldAdd.join('、')}`
        : '试运行（未落盘）：所有栏目都已有「原始资料」字段，无需补';
    }
    if (d.wouldAdd) return `试运行（未落盘）：将加入一条资料 [${(d.wouldAdd as SourceItem).kind}] ${(d.wouldAdd as SourceItem).name}`;
    if (d.wouldRemove) return `试运行（未落盘）：将移除 ${(d.wouldRemove as SourceItem).id}（${(d.wouldRemove as SourceItem).name}）`;
    return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldRemove || {})}`;
  }
  if (d.removed) return `已从资料袋移除 ${d.removed.id}（${d.removed.name}）· 袋里还剩 ${d.count} 条`;
  if (d.added && !Array.isArray(d.added)) return `已加入资料 [${(d.added as SourceItem).kind}] ${(d.added as SourceItem).name} · 袋里共 ${d.count} 条`;
  if (Array.isArray(d.added)) {
    return d.added.length
      ? `已给 ${d.added.length} 个栏目补上「原始资料」字段：${d.added.join('、')}`
      : '所有栏目都已有「原始资料」字段，无需补';
  }
  return '没有改动';
}
