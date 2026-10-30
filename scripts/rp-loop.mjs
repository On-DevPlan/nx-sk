#!/usr/bin/env node
// rp-loop —— 自引用循环（Ralph 技术）的本地实现
//
// 为什么自己写：skill `rp-loop` 规定的命令面是 `nx-rp loop on|start|stop|…`，
// 但已发布的 @flowot6/nx-rp@0.4.1 **没有 loop 模块**（registry.js 的 MODULES 里
// 只有 system / link / doc / workflow / hook-prompt / hook-skill）——
// 命令报「未知命令: loop」，而项目里的 Stop hook 又指着 `nx-rp loop stop`，
// 于是上一轮的循环**建了状态却从未真正触发**（lastFiredAt: null）。
//
// 这里按 skill 的 [[loop-commands]] 协议原样实现：
//   · 状态落在 ~/.nx-rp/loops/<sha1(cwd 小写)前12位>.json（数组，多会话并行）+ .jsonl 审计
//   · Stop hook 的判决分支与 [[loop-commands]] 第四节一一对应
//   · **退出码恒为 0**，绝不抛错——Stop hook 失败会直接卡住用户会话
//   · `reason` 严格等于 prompt 原文（不含轮次元信息）→ prompt 是稳定前缀，利于 KV cache
//
// 用法：
//   node scripts/rp-loop.mjs on [--scope local|shared|global]
//   node scripts/rp-loop.mjs off
//   node scripts/rp-loop.mjs status
//   node scripts/rp-loop.mjs start "<prompt>" | - [--max-iterations N] [--completion-promise TEXT] [--session-id ID]
//   node scripts/rp-loop.mjs cancel [--id ID]
//   node scripts/rp-loop.mjs log [--limit N]
//   node scripts/rp-loop.mjs stop            # Stop hook 落点

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const LOOPS_DIR = join(HOME, '.nx-rp', 'loops');
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

// ── 状态读写 ────────────────────────────────────────────────

/** 目录哈希：sha1(cwd 小写) 前 12 位（与既有 ~/.nx-rp/loops/*.json 同规则） */
function cwdHash(cwd) {
  return createHash('sha1').update(String(cwd).toLowerCase()).digest('hex').slice(0, 12);
}

function statePaths(cwd) {
  const h = cwdHash(cwd);
  return { json: join(LOOPS_DIR, `${h}.json`), jsonl: join(LOOPS_DIR, `${h}.jsonl`) };
}

function readState(cwd) {
  const p = statePaths(cwd);
  if (!existsSync(p.json)) return { version: 1, loops: [] };
  try {
    const d = JSON.parse(readFileSync(p.json, 'utf8'));
    return Array.isArray(d.loops) ? d : { version: 1, loops: [] };
  } catch {
    // 状态损坏：不当成致命错误，重建成空（循环会被当作「无活跃循环」放行）
    return { version: 1, loops: [] };
  }
}

function writeState(cwd, state) {
  const p = statePaths(cwd);
  mkdirSync(LOOPS_DIR, { recursive: true });
  writeFileSync(p.json, JSON.stringify(state, null, 2), 'utf8');
}

function audit(cwd, entry) {
  const p = statePaths(cwd);
  mkdirSync(LOOPS_DIR, { recursive: true });
  appendFileSync(p.jsonl, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

// ── 参数解析 ────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(a);
  }
  return { flags, positional };
}

async function readPromptArg(arg) {
  if (arg === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return String(arg ?? '').trim();
}

// ── hook 开关（三层） ───────────────────────────────────────

const HOOK_MARK = '__rp_loop__';

function scopeFile(scope) {
  if (scope === 'global') return join(HOME, '.claude', 'settings.json');
  if (scope === 'shared') return join(PROJECT_ROOT, '.claude', 'settings.json');
  return join(PROJECT_ROOT, '.claude', 'settings.local.json');
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function hookEntry() {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: `node "${SELF}" stop`, timeout: 30 }],
    [HOOK_MARK]: true,
  };
}

function cmdOn(flags) {
  const scope = typeof flags.scope === 'string' ? flags.scope : 'local';
  const file = scopeFile(scope);
  const cfg = readJson(file);
  cfg.hooks = cfg.hooks || {};
  const list = Array.isArray(cfg.hooks.Stop) ? cfg.hooks.Stop : [];
  // 摘掉失效的旧条目（上一轮指向不存在的 `nx-rp loop stop`），再挂本脚本
  const kept = list.filter((e) => !(e && e[HOOK_MARK]) && !String(e?.hooks?.[0]?.command || '').includes('nx-rp loop stop'));
  kept.push(hookEntry());
  cfg.hooks.Stop = kept;
  writeJson(file, cfg);
  console.log(`[ok] Stop hook 已挂到 ${file}（scope=${scope}）`);
  console.log('  落点：node "' + SELF + '" stop');
}

function cmdOff() {
  for (const scope of ['local', 'shared', 'global']) {
    const file = scopeFile(scope);
    if (!existsSync(file)) continue;
    const cfg = readJson(file);
    if (!cfg.hooks || !Array.isArray(cfg.hooks.Stop)) continue;
    const before = cfg.hooks.Stop.length;
    cfg.hooks.Stop = cfg.hooks.Stop.filter((e) => !(e && e[HOOK_MARK]));
    if (cfg.hooks.Stop.length === 0) delete cfg.hooks.Stop;
    if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
    if (before !== cfg.hooks.Stop?.length || before !== 0) writeJson(file, cfg);
    console.log(`· ${scope}: ${file} 已摘`);
  }
}

// ── 循环生命周期 ────────────────────────────────────────────

async function cmdStart(flags, positional) {
  const cwd = process.cwd();
  const prompt = await readPromptArg(positional[0]);
  if (!prompt) {
    console.error('[x] prompt 不能为空（多行内容请用 `-` 从 stdin 读）');
    process.exitCode = 1;
    return;
  }
  const maxRaw = flags['max-iterations'];
  const maxIterations = maxRaw === undefined || maxRaw === true ? 20 : Number(maxRaw);
  if (!Number.isFinite(maxIterations) || maxIterations < 0) {
    console.error('[x] --max-iterations 必须是非负整数');
    process.exitCode = 1;
    return;
  }
  const promise = typeof flags['completion-promise'] === 'string' ? flags['completion-promise'] : null;
  const sessionId = (typeof flags['session-id'] === 'string' ? flags['session-id'] : process.env.CLAUDE_CODE_SESSION_ID) || null;

  const state = readState(cwd);
  const loop = {
    id: `loop-${state.loops.length + 1}`,
    active: true,
    iteration: 0,
    maxIterations,
    completionPromise: promise,
    prompt,
    promptVersion: 1,
    promptVersions: [{ v: 1, text: prompt, changedAt: new Date().toISOString() }],
    sessionId,
    claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    cwd,
    startedAt: new Date().toISOString(),
    lastFiredAt: null,
  };
  state.loops.push(loop);
  writeState(cwd, state);
  audit(cwd, { decision: 'start', id: loop.id, maxIterations, hasPromise: !!promise });
  console.log(`[ok] 循环已布防：${loop.id} · 上限 ${maxIterations} 轮 · ${promise ? `承诺词「${promise}」` : '仅轮次（无承诺词）'}`);
  console.log(`  状态文件：${statePaths(cwd).json}`);
}

function cmdCancel(flags) {
  const cwd = process.cwd();
  const state = readState(cwd);
  const id = typeof flags.id === 'string' ? flags.id : null;
  let n = 0;
  for (const l of state.loops) {
    if (!l.active) continue;
    if (id && l.id !== id) continue;
    l.active = false;
    l.endedAt = new Date().toISOString();
    n += 1;
  }
  writeState(cwd, state);
  audit(cwd, { decision: 'cancel', id });
  console.log(`[ok] 已取消 ${n} 个循环（记录保留）`);
}

function cmdStatus() {
  const cwd = process.cwd();
  const state = readState(cwd);
  console.log(`cwd: ${cwd}`);
  console.log(`状态文件: ${statePaths(cwd).json}`);
  if (!state.loops.length) console.log('（无循环记录）');
  for (const l of state.loops) {
    console.log(`- ${l.id} ${l.active ? 'active' : 'inactive'} · ${l.iteration}/${l.maxIterations} 轮`
      + ` · ${l.completionPromise ? `承诺「${l.completionPromise}」` : '仅轮次'}`
      + ` · session=${l.sessionId || l.claudeSessionId || '—'}`);
  }
}

function cmdLog(flags) {
  const cwd = process.cwd();
  const p = statePaths(cwd).jsonl;
  if (!existsSync(p)) { console.log('（无审计日志）'); return; }
  const limit = Number(flags.limit || 20);
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      console.log(`${e.at} ${e.decision} ${e.id || ''} ${e.lastTextChars ?? ''}`);
    } catch { console.log(l); }
  }
}

// ── Stop hook 判决 ──────────────────────────────────────────

/** 认领本会话的循环：先按 session 匹配，再收养「恰好一条无名活跃循环」 */
function pickLoop(loops, sessionId) {
  const active = loops.filter((l) => l.active);
  if (!active.length) return null;
  const exact = active.filter((l) => l.sessionId === sessionId || l.claudeSessionId === sessionId);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 歧义：宁可不动
  const nameless = active.filter((l) => !l.sessionId && !l.claudeSessionId);
  if (nameless.length === 1) return nameless[0];
  return null; // 0 条或多条无名候选 → 放行
}

/** 从 transcript 里取最后一条 assistant 文本；读不到返回 null */
function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 200; i -= 1) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      const msg = rec.message || rec;
      if (!msg || msg.role !== 'assistant') continue;
      const content = msg.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
        : (typeof content === 'string' ? content : '');
      if (text) return text;
    }
  } catch { /* 读不到就当没有 */ }
  return null;
}

async function cmdStop() {
  // Stop hook 的入参是 hook 协议事件 JSON（stdin）
  let event = {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch { event = {}; }

  const cwd = event.cwd || process.cwd();
  const sessionId = event.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  const state = readState(cwd);
  const loop = pickLoop(state.loops, sessionId);

  // 分支 1/2：无活跃循环，或循环不属于本会话 → 放行（不写审计）
  if (!loop) { process.exitCode = 0; return; }

  // 分支 4：命中完成承诺
  if (loop.completionPromise) {
    const text = lastAssistantText(event.transcript_path);
    if (text) {
      const m = text.match(/<promise>([\s\S]*?)<\/promise>/g) || [];
      const hit = m.some((s) => s.replace(/<\/?promise>/g, '').trim() === loop.completionPromise);
      if (hit) {
        loop.active = false;
        loop.endedAt = new Date().toISOString();
        writeState(cwd, state);
        audit(cwd, { decision: 'promise-hit', id: loop.id });
        console.log(JSON.stringify({ systemMessage: `[loop] 命中完成承诺「${loop.completionPromise}」，循环结束。` }));
        process.exitCode = 0;
        return;
      }
    }
  }

  // 分支 3：已达上限
  if (loop.iteration >= loop.maxIterations) {
    loop.active = false;
    loop.endedAt = new Date().toISOString();
    writeState(cwd, state);
    audit(cwd, { decision: 'max-iterations', id: loop.id });
    console.log(JSON.stringify({ systemMessage: `[loop] 循环结束：已达轮次上限 ${loop.maxIterations}。` }));
    process.exitCode = 0;
    return;
  }

  // 分支 5：灌回 prompt
  loop.iteration += 1;
  loop.lastFiredAt = new Date().toISOString();
  writeState(cwd, state);
  const text = lastAssistantText(event.transcript_path);
  audit(cwd, { decision: 'continue', id: loop.id, lastTextChars: text == null ? null : text.length });

  console.log(JSON.stringify({
    decision: 'block',
    reason: loop.prompt,
    systemMessage: `[loop] 第 ${loop.iteration}/${loop.maxIterations} 轮`,
  }));
  process.exitCode = 0;
}

// ── 入口 ────────────────────────────────────────────────────

const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

switch (cmd) {
  case 'on': cmdOn(flags); break;
  case 'off': cmdOff(); break;
  case 'status': cmdStatus(); break;
  case 'start': await cmdStart(flags, positional.slice(1)); break;
  case 'cancel': cmdCancel(flags); break;
  case 'log': cmdLog(flags); break;
  case 'stop': await cmdStop(); break;
  default:
    console.log(`rp-loop —— 自引用循环

  on [--scope local|shared|global]   挂 Stop hook
  off                                摘 Stop hook
  status                             看循环状态
  start "<prompt>" | - [flags]       布防（- 从 stdin 读多行）
  cancel [--id ID]                   取消（不删记录）
  log [--limit N]                    看每轮判决审计
  stop                               Stop hook 落点

  flags: --max-iterations N（默认 20，0 = 无限）
         --completion-promise TEXT（不传 = 仅轮次模式）
         --session-id ID`);
}
