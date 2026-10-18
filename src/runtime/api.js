// HTTP 路由：由 action.http 编译而来，与 CLI **同源**。
// ctx 拼装顺序固定为「路径占位符 → query（GET/HEAD）或 body（其余）」，
// 之后交给**同一个** applySpec 做校验与强转——两端不会各写一套。
import { AppError, CODES, httpStatusOf, toErrorShape } from '../core/errors.js';
import { ACTIONS } from './registry.js';
import { applySpec, compareRoutes, compileRoute, usageOf } from './spec.js';

// 附件可能是扫描件/照片，base64 再膨胀约 1/3；32MB 上限覆盖绝大多数简历、成绩单与头像
const MAX_BODY = 32 * 1024 * 1024;
// 栏目 ZIP 走**原始二进制**上传（不 base64），上限单独放宽
const MAX_UPLOAD_BODY = 64 * 1024 * 1024;

export const ROUTES = ACTIONS
  .filter((a) => Array.isArray(a.http))
  .map((a) => ({ action: a, ...compileRoute(a.http) }))
  // 字面量段优先：否则 GET /api/sections/templates 会被 GET /api/sections/:ref 遮蔽，
  // 命中哪条取决于 actions 的声明顺序——有人调整顺序就静默错乱。
  .sort(compareRoutes);

export function routeTable() {
  return ROUTES.map((r) => ({ method: r.method, path: r.path, action: r.action.id, summary: r.action.summary }));
}

export function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (m) return { route: r, params: m.slice(1).map((x) => decodeURIComponent(x)) };
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new AppError(CODES.INVALID_INPUT, '请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new AppError(CODES.INVALID_INPUT, '请求体不是合法 JSON');
  }
}

/** 原始二进制 body（ZIP 导入用）：不解码、不 base64。 */
async function readBinaryBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError(CODES.INVALID_INPUT, `上传内容过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** 服务在 127.0.0.1，但用户浏览器里的任意页面都能向它发请求——写操作必须校验 Origin。 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl / agent / 测试）不带 Origin，放行
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function handleApi(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const write = method !== 'GET' && method !== 'HEAD';

  if (write && !originAllowed(req)) {
    return send(res, 403, { ok: false, error: '跨站写操作被拒绝（Origin 不在本机）', code: CODES.BLOCKED });
  }

  const hit = matchRoute(method, url.pathname);
  if (!hit) {
    return send(res, 404, { ok: false, error: `未知接口: ${method} ${url.pathname}`, code: CODES.NOT_FOUND });
  }

  const { route, params } = hit;
  const raw = {};
  route.keys.forEach((k, i) => { raw[k] = params[i]; }); // 路径占位符
  if (!write) {
    for (const [k, v] of url.searchParams) raw[k] = v; // query
  } else if (route.action.binaryBody) {
    // 二进制上传：query 仍然要绑（dry-run / on-conflict），body 读成 Buffer 原样交给 action
    for (const [k, v] of url.searchParams) raw[k] = v;
    try {
      raw.__body = await readBinaryBody(req, route.action.maxBody || MAX_UPLOAD_BODY);
      const name = String(req.headers['x-file-name'] || '');
      if (name) raw.__fileName = decodeURIComponent(name);
    } catch (err) {
      const e = toErrorShape(err);
      return send(res, httpStatusOf(e.code), { ok: false, error: e.message, code: e.code });
    }
  } else {
    // ⚠️ 无条件合并 body，而不是「只有 body 里有才覆盖」——否则无 body 的 DELETE
    // 永远绑不上参数（args 与路由占位符靠「同名」绑定，名字对不上就静默传 undefined）
    Object.assign(raw, await readBody(req).catch((err) => { throw err; }));
  }

  try {
    const ctx = applySpec(route.action, raw);
    // 二进制 body 不是声明式参数，applySpec 会丢掉，这里补回去
    if (route.action.binaryBody) {
      ctx.__body = raw.__body;
      ctx.__fileName = raw.__fileName || '';
    }
    // raw action：直接把文件本体流式写回，不走 JSON 包装（预览/下载附件用）
    if (route.action.raw === true) {
      if (typeof route.action.serveRaw !== 'function') {
        throw new AppError(CODES.INTERNAL, `raw action 缺少 serveRaw: ${route.action.id}`);
      }
      await route.action.serveRaw(ctx, { req, res, url, transport: 'http' });
      return;
    }
    const data = await route.action.run(ctx, { transport: 'http' });
    return send(res, 200, { ok: true, data: data === undefined ? null : data });
  } catch (err) {
    const e = toErrorShape(err);
    // 与 CLI 同一个约定：参数类错误必须带用法串（两端错误码与文本锚点一致）
    if (e.code === CODES.INVALID_INPUT && !e.message.includes('用法:')) {
      e.message += `\n用法: ${usageOf(route.action)}`;
    }
    return send(res, httpStatusOf(e.code), { ok: false, error: e.message, code: e.code });
  }
}
