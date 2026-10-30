/* 原型服务端 API 客户端 —— /proto-api/*
 *
 * 只有块级 AI 这一块需要服务端（pending 必须跨进程可见，见设计 §十四 14.4）：
 *   GET  /proto-api/pending            列出 pending（真从磁盘目录读）
 *   POST /proto-api/pending            suggest：写一个 pending 文件
 *   POST /proto-api/pending/:id/apply  应用（服务端算 baseHash 冲突）
 *   POST /proto-api/pending/:id/reject 拒绝（删文件）
 *   POST /proto-api/blocks/:entryId    同步「当前块内容」到服务端（服务端是 owner）
 *   GET  /proto-api/isolation          真 grep 一遍 store.json / 导出包
 */

const BASE = '/proto-api';

async function req(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

export async function listPending() {
  const r = await req('/pending');
  return { ...r, pendings: (r.body && r.body.pendings) || [] };
}

export async function suggestPending(payload) {
  return req('/pending', { method: 'POST', body: JSON.stringify(payload) });
}

export async function applyPending(id, { force } = {}) {
  return req(`/pending/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    body: JSON.stringify({ force: !!force }),
  });
}

export async function rejectPending(id) {
  return req(`/pending/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' });
}

export async function syncBlocks(entryId, blocks, entry) {
  return req(`/blocks/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    body: JSON.stringify({ blocks, entry }),
  });
}

/** 整份块树推给服务端（服务端是 owner）——批量是为了不依赖「哪个面板挂着」 */
export async function syncAllBlocks(blocksByEntry, entriesMeta) {
  return req('/blocks', {
    method: 'POST',
    body: JSON.stringify({ blocksByEntry, entriesMeta }),
  });
}

export async function isolationCheck(probe) {
  const q = probe ? `?probe=${encodeURIComponent(probe)}` : '';
  return req(`/isolation${q}`);
}
