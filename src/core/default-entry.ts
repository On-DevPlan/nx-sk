// 默认条目（任务 #63）：`settings.defaultEntry` 是 agent 的「当前工作条目」。
//
// 两件事必须住在 core 而不是某个模块：
//   ① 解析规则（id 优先、标题唯一才认）与 core/locator 同一口径，否则 settings 校验、
//      status 上下文、各命令的「省略 ref」会各解释一套；
//   ② 上下文条数上限来自设置，status 与提示词都要用同一个数字。
//
// 这里**不写 store**：谁是默认条目由 settings 模块负责落盘，本文件只读。
import { badInput } from './errors.ts';
import { resolveEntry } from './locator.ts';
import { ancestorsOf, childrenOf } from './tree.ts';
import type { Store, StoreEntry, StoreTemplate } from './store-shape.ts';

/** 默认 5 条：再多 agent 就开始把条目认串（任务 #63 的原始约束）。 */
export const DEFAULT_SCOPE_LIMIT = 5;
export const MAX_SCOPE_LIMIT = 50;

export interface StatusScopeEntry {
  id: string;
  title: string;
  desc: string;
  template: string;
  templateTitle: string;
  parent: string | null;
  /** 相对默认条目的深度：默认条目自己 = 0，直接子条目 = 1…（未设默认条目时为 0）。 */
  depth: number;
  childCount: number;
  isDefault: boolean;
}

/** 设置里的默认条目引用（原样，未归一）。 */
export function defaultEntryRef(store: Store): string {
  return String((store.settings as unknown as Record<string, unknown>).defaultEntry ?? '').trim();
}

/**
 * 默认条目本体。**读侧必须宽容**：条目被删掉之后设置还指着它，
 * 这时不该让整个 status 抛错——返回 null，由 status 提示重新设置。
 */
export function defaultEntryOf(store: Store): StoreEntry | null {
  const ref = defaultEntryRef(store);
  if (!ref) return null;
  try {
    return resolveEntry(store, ref);
  } catch {
    return null;
  }
}

/**
 * 省略 <ref> 的命令走这里：ref 为空 = 用默认条目；给了 ref 就按原规则严格定位。
 *
 * 只在「读 / 改内容」的命令上使用——删除、移动、改名这类破坏性动作必须显式给 id，
 * 否则一次手滑的 `entry remove` 就会删掉默认条目（以及它下面整棵子树）。
 */
export function resolveEntryOr(store: Store, ref: unknown, template?: unknown): StoreEntry {
  const key = String(ref ?? '').trim();
  if (key) return resolveEntry(store, key, template);
  const fallback = defaultEntryOf(store);
  if (fallback) return fallback;
  const hint = defaultEntryRef(store)
    ? `默认条目设置指向的条目已不存在（${defaultEntryRef(store)}），用 nx-sk setting set --set defaultEntry=<条目> 重设`
    : '还没有默认条目：nx-sk setting set --set defaultEntry=<条目id或标题>（或用 nx-sk status 看候选）';
  throw badInput(`缺少条目定位，且没有可用的默认条目。${hint}`);
}

/** status 的上下文条数（设置 + 单次覆盖），夹在 1..50。 */
export function scopeLimitOf(store: Store, override?: unknown): number {
  const raw = override !== undefined && override !== null && override !== ''
    ? override
    : (store.settings as unknown as Record<string, unknown>).entryScopeLimit;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SCOPE_LIMIT;
  return Math.max(1, Math.min(MAX_SCOPE_LIMIT, Math.trunc(n)));
}

function templateTitleOf(store: Store, entry: StoreEntry): string {
  const tpl: StoreTemplate | undefined = store.templates.find((s) => s.id === entry.template);
  return tpl?.title || entry.template;
}

function scopeEntry(store: Store, entry: StoreEntry, depth: number, defaultId: string | null): StatusScopeEntry {
  return {
    id: entry.id,
    title: entry.title || '（无名）',
    desc: String(entry.desc ?? ''),
    template: entry.template,
    templateTitle: templateTitleOf(store, entry),
    parent: entry.parent ?? null,
    depth,
    childCount: childrenOf(store, entry.id).length,
    isDefault: defaultId !== null && entry.id === defaultId,
  };
}

/**
 * 广度优先收集「默认条目 + 它的子孙」；未设默认条目时以根条目为起点。
 * 先子后孙：上下文被截断时，至少把**直接下级**带全，而不是沿着第一条分支钻到第 9 层。
 */
function collectScope(store: Store, root: StoreEntry | null): StatusScopeEntry[] {
  const out: StatusScopeEntry[] = [];
  const seen = new Set<string>();
  const queue: Array<{ entry: StoreEntry; depth: number }> = [];
  if (root) {
    queue.push({ entry: root, depth: 0 });
  } else {
    for (const e of childrenOf(store, null)) queue.push({ entry: e, depth: 0 });
  }
  let guard = 0;
  while (queue.length) {
    const { entry, depth } = queue.shift()!;
    if (seen.has(entry.id) || depth > 64) continue;
    seen.add(entry.id);
    out.push(scopeEntry(store, entry, depth, root?.id ?? null));
    for (const child of childrenOf(store, entry.id)) queue.push({ entry: child, depth: depth + 1 });
    if (++guard > 5000) break;
  }
  return out;
}

/** 一棵子树的总条数（只用于「共 N 条、本次带 M 条」的口径，不参与渲染）。 */
function subtreeSize(store: Store, root: StoreEntry | null): number {
  if (!root) return store.entries.length;
  let n = 0;
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || n > 5000) return;
    seen.add(id);
    n += 1;
    for (const c of childrenOf(store, id)) walk(c.id);
  };
  walk(root.id);
  return n;
}

export interface StatusContext {
  defaultEntry: StatusScopeEntry | null;
  /** 默认条目的祖先链（根 → 父），用来让 agent 知道自己在树的哪儿。 */
  ancestors: Array<{ id: string; title: string }>;
  entries: StatusScopeEntry[];
  scope: { limit: number; count: number; total: number; truncated: boolean; root: 'default' | 'root' };
  prompt: string;
}

/** 提示词：CLI 返回的正文就是它——agent 拿一次 status 就有「该干什么、怎么干」的上下文。 */
export function buildStatus(store: Store, { limit }: { limit?: unknown } = {}): StatusContext {
  const root = defaultEntryOf(store);
  const max = scopeLimitOf(store, limit);
  const full = collectScope(store, root);
  const entries = full.slice(0, max);
  const total = subtreeSize(store, root);
  const truncated = full.length > entries.length;
  const defaultEntry = root ? scopeEntry(store, root, 0, root.id) : null;
  const ancestors = root ? ancestorsOf(store, root.id).map((e) => ({ id: e.id, title: e.title })) : [];
  const staleRef = !root && defaultEntryRef(store) ? defaultEntryRef(store) : '';

  return {
    defaultEntry,
    ancestors,
    entries,
    scope: { limit: max, count: entries.length, total, truncated, root: root ? 'default' : 'root' },
    prompt: renderStatusPrompt({ root, defaultEntry, ancestors, entries, scope: { limit: max, count: entries.length, total, truncated }, staleRef }),
  };
}

function lineOf(e: StatusScopeEntry): string {
  const mark = e.isDefault ? '（默认）' : '';
  const dir = e.childCount ? ` · ${e.childCount} 个子条目` : '';
  const desc = e.desc ? ` —— ${e.desc}` : ' —— （未写说明）';
  const indent = '  '.repeat(Math.min(e.depth, 6));
  return `${indent}- ${e.title}${mark}（${e.id}）· ${e.templateTitle}${dir}${desc}`;
}

function renderStatusPrompt(d: {
  root: StoreEntry | null;
  defaultEntry: StatusScopeEntry | null;
  ancestors: Array<{ id: string; title: string }>;
  entries: StatusScopeEntry[];
  scope: { limit: number; count: number; total: number; truncated: boolean };
  staleRef: string;
}): string {
  const lines: string[] = [];
  lines.push('【你是谁】');
  lines.push('你是 nx-sk（本机个人资源管理器）的操作者。条目是唯一内容节点，条目模板只负责初始化；');
  lines.push('字段结构与值都住在条目上，条目之间可以相互嵌套（有子条目就是文件夹）。');
  lines.push('');
  lines.push('【默认条目】');
  if (d.defaultEntry) {
    const path = d.ancestors.length ? ` · 位置 ${[...d.ancestors.map((a) => a.title), d.defaultEntry.title].join(' › ')}` : ' · 根条目';
    lines.push(`${d.defaultEntry.title}（${d.defaultEntry.id}）· 模板 ${d.defaultEntry.templateTitle}${path}`);
    lines.push(`说明：${d.defaultEntry.desc || '（未写说明——建议 nx-sk entry update --desc "一句话"）'}`);
    lines.push('省略 <ref> 的命令默认作用在它上面。');
  } else if (d.staleRef) {
    lines.push(`设置里的默认条目不在了（${d.staleRef}）。先用下面的候选 / nx-sk entry search 找回条目，再重设：`);
    lines.push('  nx-sk setting set --set defaultEntry=<条目id或标题>');
  } else {
    lines.push('未设置。先选一条要长期操作的条目：');
    lines.push('  nx-sk setting set --set defaultEntry=<条目id或标题>');
    lines.push('设置好之后，省略 <ref> 的命令都会作用在它上面；nx-sk status 会把它和子条目一起带出来。');
  }
  lines.push('');
  lines.push(`【当前上下文 · ${d.scope.count}/${d.scope.total} 条，最多 ${d.scope.limit} 条】`);
  for (const e of d.entries) lines.push(lineOf(e));
  const noDesc = d.entries.filter((e) => !e.desc).length;
  if (noDesc) lines.push(`其中 ${noDesc} 条还没写 desc：nx-sk entry list --missing-desc（补：entry update <id> --desc "…"）`);
  if (!d.entries.length) lines.push('- （库里还没有条目：nx-sk entry add --title 新条目 --desc "一句话"）');
  if (d.scope.truncated) {
    lines.push(`注意：范围里还有 ${d.scope.total - d.scope.count} 条没带出来。条目一多就容易认错，`);
    lines.push('先缩小范围再操作，不要凭标题猜：');
    lines.push('  nx-sk entry context <条目>            # 祖先链 + 直接子条目');
    lines.push('  nx-sk entry list --parent <条目>      # 列出某个父级的直接子条目');
  }
  lines.push('');
  lines.push('【规则】');
  lines.push('1. 省略 <ref> 的命令：entry get / entry update / entry table / entry history / entry field-history /');
  lines.push('   entry add-field / entry field-update / source get / source add / source update / entry context。');
  lines.push('2. 写字段前先看真实字段：nx-sk entry fields --template <id>（字典）或 nx-sk entry get（本条现值）。');
  lines.push('   别猜字段 key；没见过的键会写成扩展字段，写错了要自己清理。');
  lines.push('3. 条目可以嵌套。上下文只带默认条目这一支；要动别处，先 nx-sk entry search / entry context 定位。');
  lines.push('4. 每条条目都应该有 desc（一句话说明「这条是什么」）。新建：entry add --desc "…"；补写：entry update --desc "…"。');
  lines.push('5. 删除 / 移动 / 改标题必须显式给 <id>，不会走默认条目——避免手滑删掉整棵子树。');
  lines.push(`6. 上下文条数上限由设置 entryScopeLimit 控制（当前 ${d.scope.limit}，1–50）。`);
  lines.push('');
  lines.push('【常用命令】');
  lines.push('nx-sk status                          # 这份上下文（--json 取结构化字段）');
  lines.push('nx-sk entry get                       # 读默认条目');
  lines.push('nx-sk entry update --set 字段=值        # 改默认条目');
  lines.push('nx-sk entry add --title 新条目 --parent <id> --desc "一句话"');
  lines.push('nx-sk entry tree --json               # 整棵目录树');
  lines.push('nx-sk setting set --set defaultEntry=<id> --set entryScopeLimit=5');
  return lines.join('\n');
}

/** 给人看的一行摘要（`entry context` 等命令复用）。 */
export function describeEntry(store: Store, entry: StoreEntry): string {
  const tpl = templateTitleOf(store, entry);
  return `${entry.title || '（无名）'}（${entry.id}）· ${tpl}${entry.desc ? ` · ${entry.desc}` : ''}`;
}
