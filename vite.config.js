import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口从 package.json 的 nxSk 读（服务端 core/paths.js 也读同一处）。
// 这里**不 import core/paths.js**：它用 import.meta.url 推算 PROJECT_ROOT，
// 而 vite 会把配置打包到临时文件再加载，那时 import.meta.url 的基准就变了。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVE_PORT = Number(pkg.nxSk?.port ?? 7866);
const VITE_PORT = Number(pkg.nxSk?.vitePort ?? 5180);

// 前端源码根下的文件会被暴露成 URL：src/web/frontend/api/client.js → /api/client.js。
// 而 /api 又是后端接口前缀，于是**前端自己的模块请求会被代理吞掉**——
// 浏览器拿到一坨 JSON、import 失败，dev 模式下面板直接起不来。
//
// 这是 Vite root 与服务端前缀的天然冲突：靠「目录别叫 api」这种约定防不住，
// 新增一个同名目录就会重现。所以按「是不是前端资源」决定走不走代理。
const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

export function shouldServeLocally(url) {
  const path = String(url || '').split('?')[0];
  return FRONTEND_ASSET.test(path) ? path : undefined; // 真值 = 交回 Vite
}

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: { outDir: '../../../dist/web/public', emptyOutDir: true },
  server: {
    port: VITE_PORT,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${SERVE_PORT}`, bypass: (req) => shouldServeLocally(req.url) },
    },
  },
});
