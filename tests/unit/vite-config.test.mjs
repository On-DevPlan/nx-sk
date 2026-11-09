// dev 模式的代理分流是**只在 dev 出现的白屏 bug**（prod 构建不打代理，所以永远发现不了）。
// 规则容易在后续改配置时被顺手删掉，所以单测钉住它。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PORT, DEV_VITE_PORT } from '../../src/core/paths.ts';
import viteConfig, { shouldServeLocally } from '../../vite.config.js';

test('前端源码路径交回 Vite，接口路径走代理', () => {
  // 反例现场：src/web/frontend/api/client.js 会被暴露成 /api/client.js，
  // 代理规则会把它当成接口请求转发到后端 → 浏览器拿 JSON 当 ES 模块解析 → 整页白屏
  assert.ok(shouldServeLocally('/api/client.js'), '前端模块路径必须交回 Vite');
  assert.ok(shouldServeLocally('/api/client.js?t=123'), '带 query 也要能分流');
  assert.ok(shouldServeLocally('/App.jsx'));
  assert.ok(shouldServeLocally('/styles.css'));
  assert.ok(shouldServeLocally('/components/ui.jsx'));

  assert.equal(shouldServeLocally('/api/bootstrap'), undefined, '真接口要交给代理');
  assert.equal(shouldServeLocally('/api/sections/job/dump'), undefined);
  assert.equal(shouldServeLocally('/api/entries'), undefined);
  assert.equal(shouldServeLocally('/'), undefined);
  assert.equal(shouldServeLocally(''), undefined);
  assert.equal(shouldServeLocally(undefined), undefined);
});

test('vite 必须绑 127.0.0.1（Node 18+ 默认 IPv6 会让 curl 拿 000）', () => {
  assert.equal(viteConfig.server.host, '127.0.0.1');
  assert.equal(viteConfig.root, 'src/web/frontend');
  assert.equal(viteConfig.build.outDir, '../../../dist/web/public');
});

test('端口只有一个来源：服务端默认端口 == vite 代理目标端口', () => {
  // 散成两处字面量的后果是静默的：改了服务端没改 vite，dev 模式下 /api 全 404，
  // 而报错离「端口」这个根因很远（表现为某个按钮点了没反应）。
  assert.equal(DEFAULT_PORT, 7866, '默认面板端口');
  assert.equal(viteConfig.server.port, DEV_VITE_PORT);
  assert.equal(viteConfig.server.proxy['/api'].target, `http://127.0.0.1:${DEFAULT_PORT}`);
});
