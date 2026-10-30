// 原型服务端：块级 AI 的 pending 真落目录 + 冲突检测 + 隔离自检
//
// 这是 §十四 的**可运行副本**——原型不再只在内存里演 AI：
//   · pending 落独立运行态目录 `<home>/pending/`（一个 pending 一个文件，目录 0700、文件 0600）
//   · 每个块记 baseHash（suggest 时该块内容的哈希）；apply 时块当前哈希 ≠ baseHash → CONFLICT，不覆盖
//   · pending 不进 store.json、不进导出包 → /isolation 端点真的 grep 一遍并回报
//
// **home 目录的取法与 src/core/paths.js 同源**：环境变量 NX_SK_HOME 优先，没有则用原型自己的沙箱
// （<prototype>/.tmp/home）——绝不碰用户真实的 ~/nx-sk/。
//
// **服务端持有「当前块内容」**（原型里的 server 是这批数据的 owner，浏览器只是视图）：
// 客户端每次改块就 POST 一次 /blocks/:entryId 同步上来，apply 时服务端拿自己的副本算哈希。
// 真实实现里服务端直接读 store，路径不同、语义相同。

import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 src/core/paths.js 同名同义的常量（原型沙箱：没有 NX_SK_HOME 就用 .tmp/home） */
const ENV_HOME = 'NX_SK_HOME';
// 真实的默认 home 是 ~/nx-sk —— **原型不用它**（那是用户的真数据），
// 只在没有 NX_SK_HOME 时退回原型自己的沙箱。语义与 src/core/paths.js 一致，落点不同。

export function appHome() {
  const fromEnv = process.env[ENV_HOME];
  return fromEnv ? resolve(fromEnv) : resolve(PROTOTYPE_HOME);
}

// 原型沙箱根（<prototype>/.tmp/home）——**绝不碰用户真实的 ~/nx-sk/**
const PROTOTYPE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROTOTYPE_HOME = join(PROTOTYPE_DIR, '.tmp', 'home');

export function pendingDir() {
  return join(appHome(), 'pending');
}

export function storeFile() {
  return join(appHome(), 'store.json');
}

export function exportDir() {
  return join(appHome(), 'export');
}

// ── 哈希：稳定序列化后 sha256 ────────────────────────────────

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** 块的 baseHash：只算「内容」，不算 id 之类无关字段的顺序 */
export function blockHash(block) {
  if (!block) return '';
  const content = { ...block };
  delete content.id;          // id 与内容无关，不进哈希
  delete content.children;    // 子块单独算，递归拼进去
  const kids = (block.children || []).map(blockHash).join(',');
  return createHash('sha256').update(`${stable(content)}|${kids}`).digest('hex').slice(0, 16);
}

// ── 服务端状态（这批数据的 owner） ───────────────────────────

/** entryId → 当前的块树（客户端每次改动都同步上来） */
const currentBlocks = new Map();

/** entryId → 条目骨架（标题等），给 store.json 用 */
const entries = new Map();

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 把服务端的当前状态写成 store.json —— pending **绝不**进这里 */
function writeStore() {
  const store = {
    version: 4,
    pendingInStore: false,
    sections: {},
    entries: Object.fromEntries([...entries].map(([k, v]) => [k, v])),
    blocks: Object.fromEntries([...currentBlocks].map(([k, v]) => [k, v])),
  };
  mkdirSync(appHome(), { recursive: true });
  writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8');
}

/** 导出包：栏目 + 条目 + 块，**不含 pending** */
function writeExportBundle() {
  const dir = exportDir();
  mkdirSync(dir, { recursive: true });
  const bundle = {
    formatVersion: 2,
    createdAt: new Date().toISOString(),
    entries: Object.fromEntries([...entries].map(([k, v]) => [k, v])),
    blocks: Object.fromEntries([...currentBlocks].map(([k, v]) => [k, v])),
  };
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf8');
  return join(dir, 'bundle.json');
}

// ── pending 目录 ────────────────────────────────────────────

function ensurePendingDir() {
  const dir = pendingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, recursive: true });
  try { chmodSync(dir, 0o700); } catch { /* Windows 上 chmod 语义有限，失败不致命 */ }
  return dir;
}

function pendingFile(id) {
  return join(pendingDir(), `${id}.json`);
}

/** 如实上报权限位：Windows 上 chmod 改不了 POSIX 位（NTFS ACL 另说），
 *  所以这里报**实际**的 mode，而不是声称 0700。 */
function modeOf(p) {
  try { return `0${(statSync(p).mode & 0o777).toString(8)}`; } catch { return '—'; }
}

function pendingPerms() {
  const dir = pendingDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  return {
    dirMode: modeOf(dir),
    fileModes: files.map((f) => `${f}:${modeOf(join(dir, f))}`),
    platform: process.platform,
    posixSemantics: process.platform !== 'win32',
  };
}

function listPending() {
  const dir = pendingDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f), null))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      entryId: p.entryId,
      createdAt: p.createdAt,
      changes: (p.diffs || []).length + (p.newBlocks || []).length + (p.removedIds || []).length,
      diffs: p.diffs || [],
      newBlocks: p.newBlocks || [],
      removedIds: p.removedIds || [],
      entryTitle: p.entryTitle || p.entryId,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));   // 新 → 旧
}

function readPending(id) {
  return readJson(pendingFile(id), null);
}

function writePending(p) {
  ensurePendingDir();
  const file = pendingFile(p.id);
  writeFileSync(file, JSON.stringify(p, null, 2), 'utf8');
  try { chmodSync(file, 0o600); } catch { /* 同上 */ }
  return file;
}

function dropPending(id) {
  const file = pendingFile(id);
  if (existsSync(file)) rmSync(file, { force: true });
}

// ── 冲突检测（§十四 14.3） ──────────────────────────────────

/** 在块树里找块 */
function findBlock(list, id) {
  for (const b of list || []) {
    if (b.id === id) return b;
    if (b.children) {
      const hit = findBlock(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * apply：逐个 diff 校验 baseHash。
 *  - 块当前哈希 ≠ baseHash → CONFLICT，**不覆盖**
 *  - --force 才强推（仍要显式）
 */
function applyPending(id, opts = {}) {
  const p = readPending(id);
  if (!p) return { status: 'notfound' };

  const blocks = currentBlocks.get(p.entryId) || [];
  const conflicts = [];

  for (const d of p.diffs || []) {
    const cur = findBlock(blocks, d.blockId);
    const curHash = cur ? blockHash(cur) : null;
    if (curHash !== d.baseHash) {
      conflicts.push({ blockId: d.blockId, expected: d.baseHash, actual: curHash });
    }
  }

  if (conflicts.length && !opts.force) {
    return { status: 'conflict', conflicts, pendingId: id };
  }

  // 应用：diff 给出最终内容（不从 segments 重组——重组会丢精度，§十四 14.2）
  const next = JSON.parse(JSON.stringify(blocks));
  for (const d of p.diffs || []) {
    const target = findBlock(next, d.blockId);
    if (target && d.finalText != null) target.text = d.finalText;
  }
  for (const nb of p.newBlocks || []) {
    next.push(nb);
  }
  for (const rid of p.removedIds || []) {
    const i = next.findIndex((b) => b.id === rid);
    if (i >= 0) next.splice(i, 1);
  }
  currentBlocks.set(p.entryId, next);
  writeStore();
  dropPending(id);
  return { status: 'ok', pendingId: id, blocks: next, forced: !!opts.force };
}

// ── 隔离自检：pending 文本不许出现在 store.json / 导出包里 ──

function isolationCheck(needle) {
  ensurePendingDir();
  const pendingFiles = readdirSync(pendingDir()).filter((f) => f.endsWith('.json'));
  const pendingText = pendingFiles
    .map((f) => readFileSync(join(pendingDir(), f), 'utf8'))
    .join('\n');

  writeStore();
  const bundlePath = writeExportBundle();
  const storeText = readFileSync(storeFile(), 'utf8');
  const bundleText = readFileSync(bundlePath, 'utf8');

  const probe = needle || 'pending-marker';
  const inPending = pendingText.includes(probe);
  const inStore = storeText.includes(probe);
  const inBundle = bundleText.includes(probe);

  // **结构泄漏检查**：pending 独有的结构关键词一旦出现在 store / 导出包里，
  // 就说明 pending 记录漏进去了（比查某个字符串更硬）。
  const PENDING_ONLY_KEYS = ['baseHash', 'segments', 'removedIds', 'newBlocks', 'finalText'];
  const leaked = PENDING_ONLY_KEYS.filter((k) => storeText.includes(`"${k}"`) || bundleText.includes(`"${k}"`));

  return {
    probe,
    home: appHome(),
    pendingDir: pendingDir(),
    pendingFiles: pendingFiles.length,
    pendingFileList: pendingFiles,
    perms: pendingPerms(),
    inPending,
    inStore,
    inBundle,
    leakedKeys: leaked,
    ok: inPending && !inStore && !inBundle && leaked.length === 0,
    checks: [
      { what: 'probe 文本在 pending 目录里', pass: inPending },
      { what: 'probe 文本不在 store.json 里', pass: !inStore },
      { what: 'probe 文本不在导出包 bundle.json 里', pass: !inBundle },
      { what: 'store / 导出包里没有 pending 独有的结构字段', pass: leaked.length === 0, detail: leaked },
    ],
  };
}

// ── HTTP 落点（vite 中间件） ────────────────────────────────

function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try { resolveBody(JSON.parse(raw)); } catch { resolveBody({}); }
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

/** vite 插件：给原型挂一个极小的 pending API */
export function pendingApi() {
  return {
    name: 'nx-sk-proto-pending',
    configureServer(server) {
      server.middlewares.use('/proto-api', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.replace(/^\/proto-api/, '');
        try {
          // GET /pending
          if (req.method === 'GET' && path === '/pending') {
            return json(res, 200, { pendings: listPending() });
          }
          // POST /pending —— suggest
          if (req.method === 'POST' && path === '/pending') {
            const body = await readBody(req);
            const id = body.id || `p_${Date.now().toString(36)}`;
            // **baseHash 由服务端算**（用服务端自己的当前副本）——
            // 客户端不许自带 baseHash，否则冲突检测就等于没做（§十四 14.3）。
            const cur = currentBlocks.get(body.entryId) || [];
            const diffs = (body.diffs || []).map((d) => {
              const b = findBlock(cur, d.blockId);
              return {
                blockId: d.blockId,
                baseHash: b ? blockHash(b) : null,
                segments: d.segments || [],
                finalText: d.finalText ?? null,
              };
            });
            const p = {
              id,
              entryId: body.entryId,
              entryTitle: body.entryTitle || body.entryId,
              createdAt: new Date().toISOString(),
              diffs,
              newBlocks: body.newBlocks || [],
              removedIds: body.removedIds || [],
            };
            writePending(p);
            ensurePendingDir();
            return json(res, 200, {
              status: 'pending',
              pendingId: id,
              changes: diffs.length + (p.newBlocks || []).length + (p.removedIds || []).length,
              file: pendingFile(id),
              dir: pendingDir(),
            });
          }
          // POST /pending/:id/apply
          if (req.method === 'POST' && /^\/pending\/[^/]+\/apply$/.test(path)) {
            const id = path.split('/')[2];
            const body = await readBody(req);
            const r = applyPending(id, { force: !!body.force });
            return json(res, r.status === 'conflict' ? 409 : 200, r);
          }
          // POST /pending/:id/reject
          if (req.method === 'POST' && /^\/pending\/[^/]+\/reject$/.test(path)) {
            const id = path.split('/')[2];
            dropPending(id);
            return json(res, 200, { status: 'ok', pendingId: id });
          }
          // POST /blocks —— 客户端把**整份**块树推上来（服务端是 owner）
          // 为什么批量而不是按条目推：按条目推的话，服务端手上是哪个条目取决于
          // 「哪个详情面板恰好挂载着」——挂载顺序一变，服务端的副本就缺块，
          // baseHash 算成 null，冲突检测形同虚设（R14 实测踩到）。
          if (req.method === 'POST' && path === '/blocks') {
            const body = await readBody(req);
            currentBlocks.clear();
            for (const [k, v] of Object.entries(body.blocksByEntry || {})) currentBlocks.set(k, v || []);
            entries.clear();
            for (const [k, v] of Object.entries(body.entriesMeta || {})) entries.set(k, v || {});
            writeStore();
            return json(res, 200, { status: 'ok', entries: currentBlocks.size });
          }
          // POST /blocks/:entryId —— 单条目同步（保留：调试与增量用）
          if (req.method === 'POST' && /^\/blocks\/[^/]+$/.test(path)) {
            const entryId = decodeURIComponent(path.split('/')[2]);
            const body = await readBody(req);
            currentBlocks.set(entryId, body.blocks || []);
            if (body.entry) entries.set(entryId, body.entry);
            writeStore();
            return json(res, 200, { status: 'ok', blocks: (body.blocks || []).length });
          }
          // GET /isolation —— 真去 grep 一遍
          if (req.method === 'GET' && path === '/isolation') {
            return json(res, 200, isolationCheck(url.searchParams.get('probe')));
          }
          return json(res, 404, { status: 'notfound', path });
        } catch (err) {
          return json(res, 500, { status: 'error', message: String(err && err.message) });
        }
      });
    },
  };
}
