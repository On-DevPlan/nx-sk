import { entryStructures, loadStore, mutateStore, type Store, type StoreSection } from '../../core/store.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { findKvSection, findSection, instantiateTemplate, isSensitiveField, sectionNames } from '../../core/fields.ts';
import { displaySensitive, serializeEntry } from '../../core/render.ts';
import { nowIso } from '../../core/ids.ts';
import { isCipherBlob, maskValue } from '../../core/crypto.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { addEntry, removeEntry, updateEntry } from './crud.ts';
import { defsForEntry, mustFindSection } from './shared.ts';

/**
 * KV 直通命令（`key *`）——「存个密钥」不该先说 `--section` 再说 `--set 字段=`。
 *
 * 设计要点：这**不是**第二套业务逻辑。下面每个函数都只是把
 * 「哪个栏目 + 哪个值字段」定好，再调 addEntry / updateEntry / removeEntry 本身。
 * 所以加解密、打码、快照、--dry-run 全部只有一份实现，不可能与 `entry` 命令分叉。
 */
/**
 * 找 KV 表格：默认是**标了 `kv: true` 的栏目**（密钥模板自带），
 * 也可以用 `--section` 指定任何一个「只有一个值字段」的栏目。
 */
async function kvTarget(store: Store, ref?: string): Promise<{ sec: StoreSection; valueKey: string }> {
  const sec = ref
    ? findSection(store, ref)
    : findKvSection(store, undefined);
  if (!sec) {
    if (ref) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
    throw badInput('还没有 KV 栏目：用 `nx-sk section add keys --template secret` 建一个。'
      + `现有栏目: ${sectionNames(store)}`);
  }
  const named = (sec.fields || []).find((x) => x.key === 'value');
  if (named) return { sec, valueKey: named.key };
  if (!sec.fields || !sec.fields.length) throw badInput(`栏目「${sec.title}」没有任何字段，不能当 KV 用`);
  if (sec.fields.length > 1) {
    throw badInput(`栏目「${sec.title}」有 ${sec.fields.length} 个字段，不是 KV（KV 表格只能有一个值字段）`);
  }
  return { sec, valueKey: sec.fields[0].key };
}

/** KV 名称不是文件路径，所以比 assertSafeName 宽松：允许中文与空格，只挡路径分隔符。 */
function assertKeyName(name: unknown): string {
  const s = String(name ?? '').trim();
  if (!s) throw badInput('密钥名不能为空：nx-sk key set <名称> <值>');
  if (s.length > 64) throw badInput(`密钥名过长（${s.length} > 64）: ${s}`);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`密钥名不能含路径分隔符或 '..': ${JSON.stringify(name)}`);
  }
  return s;
}

export async function keyList({ mask, section }: { mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const mine = store.entries.filter((e) => e.section === sec.id);
  const decrypt = await sensitiveViewer(sec, mine);
  return {
    section: sec.id,
    sectionTitle: sec.title,
    valueKey,
    mask: !!mask,
    count: mine.length,
    keys: mine.map((e) => ({
      id: e.id,
      name: e.title,
      value: displaySensitive(e.values?.[valueKey], { mask: !!mask, decrypt }),
      updatedAt: e.updatedAt,
    })),
  };
}

export async function keyGet(name: unknown, { mask, section }: { mask?: boolean; section?: string } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  return {
    id: entry.id,
    name: entry.title,
    section: sec.id,
    value: displaySensitive(entry.values?.[valueKey], { mask: !!mask, decrypt }),
    mask: !!mask,
    updatedAt: entry.updatedAt,
  };
}

/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 */
/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 *
 * 播种不再自带密钥栏目之后，「第一次 `key set`」会撞上「还没有 KV 栏目」。
 * 写路径在这里**自动补建**一个（与 `section add --template secret` 同一模板、同一形状）：
 * `key set` 的语义是「我要存」，被挡回来只会让人去抄一遍建栏目的命令。
 * 读路径（get / list）不建——读不到就是读不到，悄悄建一个空栏目是噪音。
 */
export async function keySet(name: unknown, value: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const key = assertKeyName(name);
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw.trim()) throw badInput(`密钥值不能为空：nx-sk key set ${key} <值>`);

  let store = await loadStore();
  let createdKv = false;
  if (!section && !findKvSection(store, undefined)) {
    await mutateStore((s) => {
      const sec = { ...instantiateTemplate('secret', { id: 'secret', title: '密钥', order: 90 }), createdAt: nowIso(), updatedAt: nowIso() } as StoreSection;
      s.sections.push(sec);
      s.sections.sort((a, b) => a.order - b.order);
    });
    store = await loadStore();
    createdKv = true;
  }
  const { sec, valueKey } = await kvTarget(store, section);

  const existing = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (existing) {
    // 两种「没变」都要认出来，否则会产生无意义的新密文 + 新快照：
    //   ① 明文与现值相同（重复写同一个 key 是常态，agent 会重试）
    //   ② 传进来的是**打码占位**（面板把列表里的值原样回传）
    const decrypt = await sensitiveViewer(sec, [existing]);
    if (decrypt) {
      try {
        const plain = String(decrypt(existing.values?.[valueKey]));
        if (plain === raw || maskValue(plain) === raw) {
          return { status: 'skipped', created: false, unchanged: true, name: key, section: sec.id, id: existing.id, createdKv };
        }
      } catch { /* 解不开（换过密钥）就按覆盖处理 */ }
    }
    const r = await updateEntry(existing.title, { set: { [valueKey]: raw }, section: sec.id, 'dry-run': dryRun });
    if (r.status === 'skipped') return { ...r, name: key, created: false, section: sec.id, createdKv };
    return { status: 'ok', created: false, replaced: true, name: key, section: sec.id, id: r.id, createdKv };
  }

  const r = await addEntry({ section: sec.id, title: key, set: { [valueKey]: raw }, 'dry-run': dryRun });
  if (r.status === 'skipped') return { ...r, name: key, created: true, section: sec.id, createdKv };
  return { status: 'ok', created: true, replaced: false, name: key, section: sec.id, id: r.id, createdKv };
}

export async function keyRemove(name: unknown, { section, 'dry-run': dryRun }: { section?: string; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const { sec } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}`);
  return removeEntry(entry.id, { 'dry-run': dryRun });
}

// —— CLI 人读渲染（KV 系列） ——
export function renderKeyList(d: Awaited<ReturnType<typeof keyList>>) {
  const lines = [`${d.count} 个密钥 · 栏目 ${d.section}${d.mask ? ' · 已打码' : ''}`];
  for (const k of d.keys) lines.push(`  ${String(k.name).padEnd(24)} ${k.value}`);
  lines.push('', `取值: nx-sk key get <名称>　　写入: nx-sk key set <名称> <值>　　（要打码加 --mask）`);
  return lines.join('\n');
}

export function renderKeyGet(d: Awaited<ReturnType<typeof keyGet>>) {
  return `${d.name} = ${d.value}${d.mask ? '\n（已打码显示；去掉 --mask 即原文）' : ''}`;
}

/** renderKeySet 的入参：key set 的落盘 / 试运行 / 未变三种结果。 */
interface KeySetView {
  status?: string;
  unchanged?: boolean;
  name?: string;
  section?: string;
  created?: boolean;
  wouldCreate?: unknown;
  wouldChange?: unknown;
}

export function renderKeySet(d: KeySetView) {
  if (d.status === 'skipped' && d.unchanged) return `未改动：${d.name} 的值与现有值相同`;
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange)}`;
  return `${d.created ? '已新建' : '已覆盖'}密钥 ${d.name}（栏目 ${d.section}）`
    + `\n值已密文落盘；核对用 nx-sk key get ${d.name}`;
}

/** renderKeyRemove 的入参：key remove 的落盘 / 试运行两种结果。 */
interface KeyRemoveView {
  status?: string;
  wouldRemove?: unknown;
  removed?: { title: string };
}

export function renderKeyRemove(d: KeyRemoveView) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldRemove)}`;
  return `已删除密钥 ${d.removed!.title}`;
}

// ---------- 关键 key 台账（链接 / 账号 / 密码 / 镜像 的跨栏目统一列表） ----------
//
// 需求：散在各栏目条目里的「关键 key」（控制台链接、账号、密码、镜像名…）要有一张
// 统一清单，方便一眼拿到、也方便交给 agent 定位修改。
// 匹配规则：字段 key/label 命中启发式 **或** 字段类型是 secret/标记 sensitive。
// **结构清单要展开成行**：场景凭据（deploy 的「凭据清单」）住在清单的行里，
// 只扫顶层字段的话台账就看不见最该看见的那些。
// 值策略：链接类明文（地址是要点击使用的）；账号/密码/token 类一律打码（短值全 *）；
// 其余长文本前 4+尾 4。--reveal 才出原文（密文走解密）。
const KEY_URL_RE = /(url|link|链接|console|入口|registry|仓库|image|镜像)/i;
const KEY_SECRET_RE = /(account|user(?!id)|账号|帐号|password|密码|passwd|pwd|token|secret|apikey|api_key|密钥|身份证|idcard|phone|电话|bank)/i;
const KEY_FIELD_RE = new RegExp(`${KEY_URL_RE.source}|${KEY_SECRET_RE.source}`, 'i');

export async function keysLedger({ section, q, reveal }: { section?: string; q?: unknown; reveal?: boolean } = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  let sections = store.sections;
  if (section) sections = [mustFindSection(store, section)];
  const out: Array<{ section: string; sectionId: string; entry: string; entryId: string; key: string; label: string; sensitive: boolean; value: string }> = [];
  for (const sec of sections) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    if (!mine.length) continue;
    const decrypt = await sensitiveViewer(sec, mine, structures);
    for (const e of mine) {
      const ownRows = structures.get(e.id) || null;
      const item = serializeEntry(sec, e, { decrypt, ownRows });
      for (const def of defsForEntry(sec, ownRows)) {
        const raw = item.values?.[def.key];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;

        // **清单类字段要展开成行**：场景凭据住在清单的行里（deploy 的「凭据清单」、
        // 表格里的「密码」列）—— 只扫顶层字段的话，台账恰好看不见最该看见的那些，
        // 「一条命令看全部凭据」必须真的看得到全部。
        const doc = raw as { rows?: unknown[]; columns?: unknown };
        const listRows = def.type === 'entrylist' && Array.isArray(raw)
          ? (raw as unknown[])
          : (def.type === 'table' && raw && Array.isArray(doc.rows) ? doc.rows : null);
        if (listRows) {
          // 表格的列存在数据里（结构归数据），优先用数据里的那份
          const subs = (def.type === 'table'
            ? (Array.isArray(doc.columns) && doc.columns.length ? doc.columns : (def.columns || []))
            : (def.type === 'entrylist' ? (def.fields || []) : [])) as Array<{ key: string; label?: string; sensitive?: boolean }>;
          for (const row of listRows) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const rowName = String(r.name ?? r['名称'] ?? r.task ?? r['任务'] ?? '');
            for (const [cellKey, cellVal] of Object.entries(r)) {
              if (cellVal === undefined || cellVal === null || String(cellVal).trim() === '') continue;
              const sub = subs.find((x) => x.key === cellKey);
              const cellLabel = sub?.label || cellKey;
              const secretish = sub?.sensitive === true
                || KEY_SECRET_RE.test(cellKey) || KEY_SECRET_RE.test(cellLabel);
              const urlish = KEY_URL_RE.test(cellKey) || KEY_URL_RE.test(cellLabel);
              if (!secretish && !urlish && !KEY_FIELD_RE.test(cellKey) && !KEY_FIELD_RE.test(cellLabel)) continue;
              const s = String(cellVal);
              out.push({
                section: sec.title,
                sectionId: sec.id,
                entry: e.title,
                entryId: e.id,
                key: `${def.key}.${cellKey}`,
                label: rowName ? `${rowName} · ${cellLabel}` : cellLabel,
                sensitive: secretish,
                value: reveal ? s
                  : (secretish || isCipherBlob(s)) ? maskValue(s)
                    : urlish ? s
                      : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
              });
            }
          }
          continue;
        }

        const hit = KEY_FIELD_RE.test(def.key) || KEY_FIELD_RE.test(def.label) || def.type === 'secret' || def.sensitive === true;
        if (!hit) continue;
        const s = Array.isArray(raw) ? raw.join('、') : String(raw);
        const isSecretish = def.type === 'secret' || def.sensitive === true || isSensitiveField(sec, def.key) || KEY_SECRET_RE.test(def.key) || KEY_SECRET_RE.test(def.label);
        const isUrlish = KEY_URL_RE.test(def.key) || KEY_URL_RE.test(def.label);
        out.push({
          section: sec.title,
          sectionId: sec.id,
          entry: e.title,
          entryId: e.id,
          key: def.key,
          label: def.label,
          sensitive: isSecretish,
          value: reveal ? s
            : (isSecretish || isCipherBlob(s)) ? maskValue(s)
              : isUrlish ? s
                : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
        });
      }
    }
  }
  if (q) {
    const needle = String(q).toLowerCase();
    return { count: out.length, reveal: Boolean(reveal), items: out.filter((x) =>
      [x.section, x.entry, x.key, x.label, x.value].some((v) => String(v).toLowerCase().includes(needle))) };
  }
  return { count: out.length, reveal: Boolean(reveal), items: out };
}

export function renderKeysLedger(d: Awaited<ReturnType<typeof keysLedger>>) {
  if (!d.items.length) return '（没有命中关键 key 的字段——往条目里填 链接/账号/密码/镜像 类字段后这里会出现）';
  const lines = [`关键 key 台账：${d.items.length} 条${d.reveal ? '（明文）' : '（打码；--reveal 看原文）'}`];
  let last = '';
  for (const x of d.items) {
    if (x.section !== last) { lines.push('', `【${x.section}】${x.sectionId}`); last = x.section; }
    lines.push(`  ${x.entry}（${x.entryId}）`);
    lines.push(`    ${x.label.padEnd(10)} ${x.key.padEnd(14)} ${x.sensitive ? '[密文] ' : ''}${x.value}`);
  }
  return lines.join('\n');
}
