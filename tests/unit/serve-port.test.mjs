// serve 的端口协商 + 自动开浏览器策略（core/serve-port.js）。
//
// 这几条是用户最常撞的场景：端口被占时到底是复用旧面板还是顺延，
// 以及「别给我开浏览器」到底认哪个开关。行为必须被钉住，否则以后改一处就悄悄分叉。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import {
  NO_OPEN_ENV, autoOpenEnabled, probePanel, findFreePort, resolvePortConflict,
} from '../../src/core/serve-port.js';
// 必须用本项目真实的 APP_NAME：复用判定就是比 app.name，
// 拿一个别的名字去测，reuse 分支永远测不到（这正是要防的坑）。
import { APP_NAME } from '../../src/core/paths.js';

// —— 1. autoOpenEnabled：命令行 flag 与环境变量是「或」关系 ——

function withEnv(value, fn) {
  const saved = process.env[NO_OPEN_ENV];
  if (value === undefined) delete process.env[NO_OPEN_ENV];
  else process.env[NO_OPEN_ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[NO_OPEN_ENV];
    else process.env[NO_OPEN_ENV] = saved;
  }
}

test('autoOpenEnabled：环境变量未设 + 无 flag → 允许开浏览器', () => {
  withEnv(undefined, () => {
    assert.equal(autoOpenEnabled(false), true);
    assert.equal(autoOpenEnabled(undefined), true);
  });
});

test('autoOpenEnabled：NX_SERVE_NO_OPEN = 1 / true / yes / on → 不开浏览器', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    withEnv(v, () => {
      assert.equal(autoOpenEnabled(false), false, `NX_SERVE_NO_OPEN=${v} 应当关掉自动开浏览器`);
    });
  }
});

test('autoOpenEnabled：NX_SERVE_NO_OPEN=0 不算真值 → 仍然开浏览器', () => {
  withEnv('0', () => {
    assert.equal(autoOpenEnabled(false), true);
  });
});

test('autoOpenEnabled：--no-open 单独就能关掉（哪怕环境变量没设）', () => {
  withEnv(undefined, () => {
    assert.equal(autoOpenEnabled(true), false);
  });
});

// —— 2. probePanel：不是面板的端口一律探测不到 ——

test('probePanel：端口上不是面板 → null', async () => {
  // 只收连接不回话的服务：探测会超时放弃，返回 null（不是面板就别硬认）
  const sockets = [];
  const server = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    assert.equal(await probePanel(port), null);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((ok) => server.close(ok));
  }
});

// —— 3. findFreePort：返回的端口确实能监听 ——

test('findFreePort：返回的端口确实能监听', async () => {
  const probe = net.createServer();
  await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
  const start = probe.address().port;
  await new Promise((ok) => probe.close(ok));

  const port = await findFreePort(start);
  assert.ok(port >= start, `返回的端口 ${port} 不应小于起点 ${start}`);

  const server = net.createServer();
  await new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise((ok) => server.close(ok));
});

// —— 4. resolvePortConflict：自己人复用，别人顺延 ——

/** 起一个只会答 /api/bootstrap 的假面板。 */
function fakePanel(appName) {
  return http.createServer((req, res) => {
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { app: { name: appName } } }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
}

test('resolvePortConflict：端口上是本项目的面板 → reuse（不重复启动）', async () => {
  const server = fakePanel(APP_NAME);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    const d = await resolvePortConflict(port, APP_NAME);
    assert.equal(d.action, 'reuse');
    assert.equal(d.port, port);
    assert.equal(d.occupant, APP_NAME);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});

test('resolvePortConflict：端口上是别的服务 → shift 到下一个空闲端口', async () => {
  const server = fakePanel('someone-else');
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    const d = await resolvePortConflict(port, APP_NAME);
    assert.equal(d.action, 'shift');
    assert.ok(d.port > port, `shift 后的端口 ${d.port} 必须大于原端口 ${port}`);
    assert.equal(d.occupant, 'someone-else');
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
