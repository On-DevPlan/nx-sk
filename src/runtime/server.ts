// 零依赖静态 + /api 委派。对构建工具**零感知**——它只服务 dist/web/public/，
// 不管是 dev 还是 prod，所以「dev 能跑、打包后白屏」这类问题不会出现。
import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { DEFAULT_PORT, DEV_VITE_PORT, PUBLIC_DIR } from '../core/paths.ts';
import { handleApi } from './api.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function sendFile(res: ServerResponse, file: string): Promise<boolean> {
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

const NOT_BUILT = [
  '面板还没有构建产物。',
  '',
  `开发模式:  pnpm run dev        （先构建，再 vite :${DEV_VITE_PORT} + serve :${DEFAULT_PORT}）`,
  '生产模式:  pnpm start          （pnpm build → dist，再 serve）',
].join('\n');

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  // 静态服务做 resolve 后前缀校验，别用正则剥 '..'
  let file = resolve(PUBLIC_DIR, rel);
  if (file !== resolve(PUBLIC_DIR) && !file.startsWith(resolve(PUBLIC_DIR) + sep)) {
    return sendText(res, 403, '禁止访问');
  }
  if (!rel) file = join(PUBLIC_DIR, 'index.html');
  if (await sendFile(res, file)) return;
  // SPA 回退：非 /api 的未命中路径交给前端 hash 路由
  if (await sendFile(res, join(PUBLIC_DIR, 'index.html'))) return;
  return sendText(res, 503, NOT_BUILT);
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<Server> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        sendText(res, 500, `内部错误: ${err && err.message ? err.message : String(err)}`);
      });
      return;
    }
    serveStatic(url.pathname, res).catch((err) => {
      sendText(res, 500, `内部错误: ${err && err.message ? err.message : String(err)}`);
    });
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    // 默认只绑 127.0.0.1：这是本机工具，不要暴露到局域网。
    server.listen(port, host, () => ok(server));
  });
}



