// 字段值历史的读侧 + 恢复（任务 #27）。
//
// 三件事：
//   - 单个字段：列出 rev 1..N 的版本与当前值，供块头「⋯ → 变化历史」；
//   - 一个条目：把所有字段的历史合成一条按时间倒序的时间线，供详情页「变化历史」；
//   - 恢复：把某一版写回 field_data（core 层做事务），恢复本身再记一条历史。
//
// 密文口径沿用 entry get：默认解密成原文（面板已有「打码显示」开关，那是另一条路），
// 历史值走同一个 displaySensitive，不另开一个「忘了打码」的出口。
import { entryStructures, loadStore, fieldHistoryOf, entryHistoryOf, restoreEntryFieldValue } from '../../core/store.ts';
import { notFound, badInput } from '../../core/errors.ts';
import { displaySensitive } from '../../core/sensitive.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { defsForEntry, resolveEntry, resolveFieldDef, resolveOwnRow } from './shared.ts';
import type { FieldDef } from '../../shared/fields/types.ts';

const OP_LABEL: Record<string, string> = { set: '修改', clear: '清空', restore: '恢复' };

/** 历史值在 API 里的形态：非密文 = 解析后的 JSON；密文 = 解密后的原文（解不开给提示串）。 */
export interface HistoryItem {
  rev: number;
  key: string;
  label: string;
  type: string;
  op: string;
  at: string;
  value: unknown;
  prevValue: unknown;
  sensitive: boolean;
}

function parseStored(text: string | null): unknown {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function present(def: FieldDef | undefined, text: string | null, decrypt?: (blob: unknown) => string): unknown {
  const raw = parseStored(text);
  if (def?.sensitive) return displaySensitive(raw, { decrypt });
  return raw;
}

async function viewerFor(store: Awaited<ReturnType<typeof loadStore>>, entryId: string, sectionId: string) {
  const sec = store.sections.find((s) => s.id === sectionId) || null;
  const entry = store.entries.find((e) => e.id === entryId) || null;
  return sensitiveViewer(sec, entry ? [entry] : [], entryStructures(store));
}

function limitOf(raw: unknown, fallback: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, n));
}

/** 条目内单个字段的历史（rev 倒序）。key 可以是字段 key 或中文标签。 */
export async function getFieldHistory(ref: unknown, key: unknown, { section, limit }: { section?: string; limit?: unknown } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const ownRows = entryStructures(store).get(entry.id) || null;
  const def = resolveOwnRow(ownRows, key) || resolveFieldDef(sec, key);
  if (!def) throw notFound(`条目「${entry.title}」没有字段: ${String(key)}`);

  const data = await fieldHistoryOf(entry.id, def.key, limitOf(limit, 50));
  if (!data) throw notFound(`字段「${def.label || def.key}」还没有结构行`);

  const decrypt = await viewerFor(store, entry.id, sec.id);
  const items: HistoryItem[] = data.rows.map((r) => ({
    rev: r.rev, key: def.key, label: def.label || r.label || def.key, type: def.type || r.type,
    op: r.op, at: r.at,
    value: present(def, r.value, decrypt),
    prevValue: present(def, r.prevValue, decrypt),
    sensitive: def.sensitive === true,
  }));
  return {
    id: entry.id, title: entry.title, section: sec.id, sectionTitle: sec.title,
    field: { key: def.key, label: def.label || def.key, type: def.type },
    current: present(def, data.current, decrypt),
    count: items.length,
    items,
  };
}

/** 一个条目的全字段变化时间线（按时间倒序；已脱离字段不出现）。 */
export async function getEntryHistory(ref: unknown, { section, limit }: { section?: string; limit?: unknown } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const ownRows = entryStructures(store).get(entry.id) || null;
  const defs = new Map<string, FieldDef>(defsForEntry(sec, ownRows).map((d) => [d.key, d]));
  const decrypt = await viewerFor(store, entry.id, sec.id);
  const rows = await entryHistoryOf(entry.id, limitOf(limit, 100));
  const items: HistoryItem[] = rows
    // 已脱离字段的值仍在、历史也在，但它已经不在这一页——时间线不列，避免「幽灵字段」。
    .filter((r) => defs.has(r.key))
    .map((r) => {
      const def = defs.get(r.key);
      return {
        rev: r.rev, key: r.key, label: def?.label || r.label || r.key, type: def?.type || r.type,
        op: r.op, at: r.at,
        value: present(def, r.value, decrypt),
        prevValue: present(def, r.prevValue, decrypt),
        sensitive: def?.sensitive === true,
      };
    });
  return {
    id: entry.id, title: entry.title, section: sec.id, sectionTitle: sec.title,
    count: items.length, items,
  };
}

/** 恢复到某个版本；`--dry-run` 只预览。 */
export async function restoreFieldVersion(ref: unknown, key: unknown, { section, rev, 'dry-run': dryRun }: { section?: string; rev?: unknown; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const ownRows = entryStructures(store).get(entry.id) || null;
  const def = resolveOwnRow(ownRows, key) || resolveFieldDef(sec, key);
  if (!def) throw notFound(`条目「${entry.title}」没有字段: ${String(key)}`);
  const revNo = Math.trunc(Number(rev));
  if (!Number.isFinite(revNo) || revNo <= 0) throw badInput('恢复需要指定版本号：--rev <版本号>（在历史列表里看）');

  const decrypt = await viewerFor(store, entry.id, sec.id);
  if (dryRun) {
    const data = await fieldHistoryOf(entry.id, def.key, 500);
    const target = data?.rows.find((r) => r.rev === revNo);
    if (!target) throw notFound(`字段「${def.label || def.key}」没有版本 ${revNo}`);
    return {
      status: 'skipped', dryRun: true,
      wouldRestore: {
        key: def.key, label: def.label || def.key, rev: revNo,
        from: present(def, data?.current ?? null, decrypt),
        to: present(def, target.value, decrypt),
      },
    };
  }

  const r = await restoreEntryFieldValue(entry.id, def.key, revNo);
  if (r.status === 'missing-field') throw notFound(`条目「${entry.title}」没有字段: ${String(key)}`);
  if (r.status === 'missing-rev') throw notFound(`字段「${def.label || def.key}」没有版本 ${revNo}`);
  return {
    status: 'ok', id: entry.id, key: r.key, label: r.label || def.label || r.key,
    rev: r.rev, changed: r.changed, at: r.at,
    from: present(def, r.from, decrypt),
    to: present(def, r.to, decrypt),
  };
}

// —— CLI 人读渲染 ——

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 88 ? `${s.slice(0, 88)}…` : s;
}

export function renderFieldHistory(d: Awaited<ReturnType<typeof getFieldHistory>>) {
  const lines = [
    `字段「${d.field.label}」（${d.field.key}）· ${d.count} 个历史版本 · 当前值 ${fmtValue(d.current)}`,
  ];
  if (!d.count) lines.push('  （还没有历史：从升级到这个版本之后的第一次修改开始记录）');
  for (const it of d.items) {
    lines.push(`  v${String(it.rev).padStart(3)}  ${it.at}  ${OP_LABEL[it.op] || it.op}  ${fmtValue(it.value)}`);
  }
  if (d.count) lines.push('', `恢复某一版: nx-sk entry field-restore <条目> --key ${d.field.key} --rev <版本号>`);
  return lines.join('\n');
}

export function renderEntryHistory(d: Awaited<ReturnType<typeof getEntryHistory>>) {
  const lines = [`${d.title || d.id}（${d.id}）· 共 ${d.count} 条字段变化（按时间倒序）`];
  if (!d.count) lines.push('  （还没有历史：从升级到这个版本之后的第一次修改开始记录）');
  for (const it of d.items) {
    const arrow = it.op === 'clear' ? `${fmtValue(it.prevValue)} → （清空）`
      : it.op === 'restore' ? `${fmtValue(it.prevValue)} → ${fmtValue(it.value)}（恢复）`
        : it.prevValue === null ? fmtValue(it.value)
          : `${fmtValue(it.prevValue)} → ${fmtValue(it.value)}`;
    lines.push(`  ${it.at}  ${it.label}(${it.key})  v${it.rev}  ${arrow}`);
  }
  return lines.join('\n');
}

export function renderFieldRestore(d: Awaited<ReturnType<typeof restoreFieldVersion>>) {
  if (d.status === 'skipped') {
    const w = d.wouldRestore;
    if (!w) return '试运行（未落盘）：没有可恢复的目标版本';
    return `试运行（未落盘）：字段「${w.label}」将回到 v${w.rev}：${fmtValue(w.from)} → ${fmtValue(w.to)}`;
  }
  if (!d.changed) return `字段「${d.label}」当前就是 v${d.rev} 的值，无需恢复`;
  return `已恢复字段「${d.label}」到 v${d.rev}：${fmtValue(d.from)} → ${fmtValue(d.to)}`
    + `（本次恢复也记为新版本 v${d.rev}，可再恢复回来）`;
}
