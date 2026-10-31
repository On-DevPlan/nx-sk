// 块级 AI 的 pending 层（S4）：**提议落在运行态目录，应用才写 store**。
//
// 三层分工，别混：
//   1. 谁产生提议 —— 不在这里。nx-sk 不自带大模型：提议由调用方（agent 或外部模型）
//      产出后经 `entry ai suggest --from @proposal.json` 交进来。CLI 与面板因此
//      **同语义**：agent 走 CLI，人在面板上审同一条 pending。
//   2. 本文件 —— 把「当前正文」与「提议正文」比出差异、算出每块的 baseHash、
//      落一个 pending 文件、并提供查询/应用/拒绝所需的读写。
//   3. service.js —— 应用时把它写进 store（走 mutateStore，secret 块照常加密）。
//
// 为什么 pending 不落 store.json：pending 里可能有明文密钥（AI 提议的 secret 块），
// 落进 store 就等于把它写进了备份与导出面（设计 §10.7 / §14.4）。
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { badInput, notFound } from '../../core/errors.js';
import { newId, nowIso } from '../../core/ids.js';
import { displayPath, pendingDir } from '../../core/paths.js';
import {
  BLOCK_LABELS, blockText, diffText, isContainerType, normalizeBlock, validatePending, walkBlocks,
} from '../../shared/blocks.js';

const PENDING_RE = /^p_[a-z0-9]+$/;

/**
 * 键序稳定的 JSON。哈希只回答「内容变了没」这一个问题，**不能受键序影响**——
 * 否则 `{a,b}` 与 `{b,a}` 会被判成「改过」，用户看到一堆假 diff。
 */
function stableJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

/**
 * 块内容指纹。**服务端算**（设计 §14.6-1）：客户端自带 baseHash 时，服务端副本
 * 落后一步就会算成 null，冲突检测形同虚设。
 */
export function blockHash(block) {
  return createHash('sha256').update(stableJson(block)).digest('hex').slice(0, 16);
}

/** 递归补齐块 id（提议里新块可以不带 id，服务端定），非法形状在下面归一暴露。 */
function ensureIds(raw, at) {
  if (!raw || typeof raw !== 'object') throw badInput(`${at} 不是块对象`);
  const out = { ...raw, id: String(raw.id || newId('b')) };
  if (Array.isArray(raw.children)) {
    out.children = raw.children.map((c, i) => ensureIds(c, `${at}.children[${i}]`));
  }
  return out;
}

/** 提议正文的归一：**坏块明确报错**，不静默丢弃（丢弃 = 用户以为改了其实没改）。 */
export function normalizeProposal(list) {
  if (!Array.isArray(list)) throw badInput('提议必须是块数组（[ { type, ... } ]）');
  return list.map((raw, i) => {
    const at = `blocks[${i}]`;
    const block = normalizeBlock(ensureIds(raw, at));
    if (!block) throw badInput(`${at} 块不合法（type=${JSON.stringify(raw && raw.type)}）：类型不在词汇表里或缺字段`);
    return block;
  });
}

function indexBlocks(list) {
  const map = new Map();
  walkBlocks(list || [], (b) => { if (b && b.id) map.set(b.id, b); });
  return map;
}

/**
 * 两份正文的差异 → `{ diffs, newBlocks, removedIds }`（对应 demo 的三组）。
 *
 * 三条细节：
 *   · **容器块不进 diffs**：column/section 的哈希含 children，子块一改父块哈希就变，
 *     照实报会得到「父块+子块都在改」的假噪声。容器的改动由它的子块表达。
 *   · **secret 块不产生字符级 diff**：明文只在 pending 里，给 UI 的只有「变了」。
 *   · **secret 块要按明文比**：store 里是密文、提议里是明文（AI 拿到的是 `block list`
 *     的输出），直接比哈希会把「一个字没动的密钥」全报成改动。`plain` 是
 *     `id → 解密后的块` 的映射，只用于「变了没」的判定；baseHash 仍取自 store 里的原块。
 */
export function diffBodies(current, next, { plain } = {}) {
  const before = indexBlocks(current);
  const after = indexBlocks(next);
  const diffs = [];
  const newBlocks = [];
  const removedIds = [];
  const cmpOf = (id, fallback) => (plain && plain.has(id) ? plain.get(id) : fallback);

  for (const [id, b] of after) {
    const prev = before.get(id);
    if (!prev) { newBlocks.push(b); continue; }
    const baseHash = blockHash(prev);
    if (blockHash(cmpOf(id, prev)) === blockHash(b)) continue;
    if (isContainerType(b.type) && isContainerType(prev.type)) continue;

    const secret = b.type === 'secret' || prev.type === 'secret';
    const textBefore = blockText(prev);
    const textAfter = blockText(b);
    const textual = !secret && prev.type === b.type && (textBefore !== '' || textAfter !== '');
    diffs.push({
      blockId: id,
      type: b.type,
      baseHash,
      secret,
      structural: !secret && !textual,
      segments: secret
        ? [{ op: 'del', text: '（密文块旧值）' }, { op: 'ins', text: '（密文块新值）' }]
        : textual ? diffText(textBefore, textAfter) : [],
    });
  }
  for (const id of before.keys()) if (!after.has(id)) removedIds.push(id);
  return { diffs, newBlocks, removedIds };
}

/**
 * 生成 pending（纯计算 + 落一个文件），不碰 store。
 *
 * `scopeBlockId` 是 `--block`：只允许这一块变；提议顺手动了别的就明确拒绝。
 */
export function createPending({ entry, section, blocks, prompt, scopeBlockId, dryRun, plain }) {
  const current = Array.isArray(entry.body) ? entry.body : [];
  const next = normalizeProposal(blocks);
  const scope = scopeBlockId ? String(scopeBlockId) : '';

  let { diffs, newBlocks, removedIds } = diffBodies(current, next, { plain });
  if (scope) {
    const outside = [
      ...diffs.map((d) => d.blockId),
      ...newBlocks.map((b) => b.id),
      ...removedIds,
    ].filter((id) => id !== scope);
    if (outside.length) {
      throw badInput(`--block 只允许改 ${scope}，但提议还动了：${outside.join(', ')}`);
    }
    diffs = diffs.filter((d) => d.blockId === scope);
    newBlocks = [];
    removedIds = [];
    if (!diffs.length) throw badInput(`--block ${scope}：提议里这一块与当前内容一致（没得改）`);
  }

  const record = {
    id: newId('p'),
    status: 'pending',
    createdAt: nowIso(),
    entryId: entry.id,
    entryTitle: entry.title,
    sectionId: (section && section.id) || entry.section || '',
    sectionTitle: (section && section.title) || '',
    prompt: String(prompt || ''),
    scopeBlockId: scope || null,
    diffs,
    newBlocks,
    removedIds,
    // 应用时用这份最终正文整体替换（不从 segments 重组——重组会丢精度）
    blocks: next,
  };
  // dryRun 只算不落盘（试运行不该在磁盘上留痕）
  if (!dryRun) writePending(record);
  return record;
}

export function writePending(record) {
  const dir = pendingDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // POSIX 上收紧到 0700；Windows 的 chmod 改不了 ACL（设计 §14.6-3），失败不阻断
  try { chmodSync(dir, 0o700); } catch { /* 见上 */ }
  const file = join(dir, `${record.id}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** pending 文件路径。id 先过白名单，**不接受任何路径成分**（否则就是任意文件读）。 */
export function pendingFile(id) {
  const s = String(id || '');
  if (!PENDING_RE.test(s)) throw badInput(`pending id 非法: ${JSON.stringify(id)}（形如 p_xxx）`);
  return join(pendingDir(), `${s}.json`);
}

export function readPending(id) {
  const file = pendingFile(id);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw notFound(`找不到 pending: ${id}（已应用 / 已拒绝，或从未存在）`);
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw badInput(`pending 文件不是合法 JSON（未应用）: ${displayPath(file)}`);
  }
  const shapeErrors = validatePending(rec);
  if (shapeErrors.length) throw badInput(`pending 结构不合法（未应用）:\n- ${shapeErrors.join('\n- ')}`);
  // **这里不跑 validateBlocks**：pending 里的 secret 块是**明文**（AI 的提议还没加密），
  // 而 validateBlocks 会合理地拒收「value 不是密文」的 secret 块。块的业务校验在落盘那一侧做：
  // setEntryBody → sealBlocks（加密）→ assertBodyOk。校验位置错了只会把合法提议挡在门外。
  return rec;
}

export function deletePending(id) {
  rmSync(pendingFile(id), { force: true });
}

/** 列 pending（新的在前）。坏文件跳过——一条坏 pending 不该让整个列表 500。 */
export function listPending({ entryId } = {}) {
  const dir = pendingDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('p_') && n.endsWith('.json'));
  } catch {
    return []; // 目录还没有 = 没有 pending，不是错误
  }
  const out = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      if (entryId && rec.entryId !== entryId) continue;
      out.push(rec);
    } catch { /* 坏文件跳过，见上 */ }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * 给面板看的形状：**不带 blocks**（那一份有明文密钥）。
 * secret 块只在 diffs 里报「变了」，新块也只给标签不给值。
 */
export function publicPending(rec) {
  const diffs = (rec.diffs || []).map((d) => ({
    blockId: d.blockId,
    type: d.type,
    secret: !!d.secret,
    structural: !!d.structural,
    segments: d.segments || [],
  }));
  const newBlocks = (rec.newBlocks || []).map((b) => ({
    id: b.id,
    type: b.type,
    label: BLOCK_LABELS[b.type] || b.type,
    text: b.type === 'secret' ? '（密文块）' : blockText(b),
  }));
  const removedIds = rec.removedIds || [];
  return {
    id: rec.id,
    status: rec.status || 'pending',
    createdAt: rec.createdAt,
    entryId: rec.entryId,
    entryTitle: rec.entryTitle,
    sectionId: rec.sectionId,
    sectionTitle: rec.sectionTitle,
    prompt: rec.prompt || '',
    scopeBlockId: rec.scopeBlockId || null,
    diffs,
    newBlocks,
    removedIds,
    changes: diffs.length + newBlocks.length + removedIds.length,
  };
}

// ── 文本输出（CLI）──────────────────────────────────────────

export function renderAiSuggest(d) {
  if (d.status === 'noop') {
    return `未产生提议：提议内容与当前正文一致（${d.entryTitle} · ${d.entryId}），没有待审的东西`;
  }
  const lines = [
    `AI 提议已生成，**未写入 store**：${d.pendingId}`,
    `条目：${d.entryTitle}（${d.entryId}）${d.sectionTitle ? ` · 栏目 ${d.sectionTitle}` : ''}`,
    `改动：改 ${d.changed} 块 · 新增 ${d.added} 块 · 删除 ${d.removed} 块${d.scopeBlockId ? ` · 只动 ${d.scopeBlockId}` : ''}`,
  ];
  if (d.prompt) lines.push(`指令：${d.prompt}`);
  lines.push(`应用：entry ai apply ${d.pendingId}    （写 store；写前建议先 transfer export）`);
  lines.push(`拒绝：entry ai reject ${d.pendingId}   （直接删掉这条提议，数据不变）`);
  return lines.join('\n');
}

export function renderAiList(d) {
  const list = d.pendings || [];
  const where = d.entryTitle ? `（${d.entryTitle}）` : '';
  if (!list.length) return `没有待审的 AI 提议${where}`;
  const lines = [`待审 AI 提议 ${list.length} 条${where}（新的在前）`];
  for (const p of list) {
    lines.push(`- ${p.id}  ${p.entryTitle}  改 ${p.diffs.length} · 新增 ${p.newBlocks.length} · 删 ${p.removedIds.length}  ${p.createdAt}${p.prompt ? `  指令：${p.prompt}` : ''}`);
  }
  return lines.join('\n');
}

export function renderAiApply(d) {
  if (d.status === 'conflict') {
    return `未应用（CONFLICT）：这些块在提议之后被改过 → ${d.conflictIds.join(', ')}\n`
      + '确认要覆盖就加 --force（仍会先留迁移快照）；想保留你的改动就先 reject 这条提议重来。';
  }
  if (d.status === 'skipped') return `试运行（未写入）：将应用 ${d.pendingId}，改 ${d.changed} · 新增 ${d.added} · 删 ${d.removed}`;
  return `已应用 ${d.pendingId}：改 ${d.changed} 块 · 新增 ${d.added} 块 · 删除 ${d.removed} 块 → 条目 ${d.entryTitle} 现有 ${d.blocks} 块`;
}

export function renderAiReject(d) {
  if (d.status === 'skipped') return `试运行（未删除）：将拒绝 ${d.pendingId}`;
  return `已拒绝 ${d.pendingId}（pending 已删除，store 未动）`;
}
