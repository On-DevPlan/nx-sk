import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pendingApi } from './server/pending.mjs';

// 原型是**独立**的 vite root：主应用的 build（src/web/frontend → src/web/public）不受影响。
// 依赖从仓库根 node_modules 解析（node 的模块解析逐级上溯），所以这里不用再装一遍。
//
// pendingApi：给原型挂一个极小的服务端（/proto-api/*）——
// 块级 AI 的 pending **真落目录**、冲突检测真算哈希、隔离自检真去 grep 一遍。
// 详见 server/pending.mjs 的文件头。
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), pendingApi()],
  server: { port: 5190, host: '127.0.0.1', strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 多页：主页面 + 弹出窗口的宿主页（FlexLayout 的 popout 需要它）
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        popout: fileURLToPath(new URL('./popout.html', import.meta.url)),
      },
    },
  },
});
