// CLI 面板代理（任务 #22）：portfile 语义 / 面板发现（app 名 + 同库双判据）/
// POST /api/cli 分发口 / proxyRun 与直跑数据等价 / binaryBody 与错误形状等价。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-proxy-');

const panel = await import('../../src/core/panel-port.ts');
const store = await import('../../src/core/store.ts');
const sections = await import('../../src/modules/sections/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const { startServer } = await import('../../src/runtime/server.ts');
const { ACTIONS } = await import('../../src/runtime/registry.ts');
const { applySpec, usageOf } = await import('../../src/runtime/spec.ts');
const { proxyRun } = await import('../../src/runtime/cli-proxy.ts');
const { APP_NAME } = await import('../../src/core/paths.ts');

await store.saveStore(await store.loadStore());
await sections.addSection({
  id: 'px', title: '代理栏目',
  fields: [{ key: 'name', label: '名称', type: 'text', group: 'g' }],
  groups: [{ id: 'g', title: 'G' }],
});
await entries.addEntry({ section: 'px', title: '甲', set: { name: '甲' } });

// —— 1. portfile：写读删与 pid 语义 ——

test('portfile：写/读/形状校验；pid null 与活 pid 都认，脏文件按无档案处理', () => {
  panel.writePanelPortfile(7999, process.pid);
  assert.deepEqual(panel.readPanelPortfile(), { port: 7999, pid: process.pid });
  panel.writePanelPortfile(7998, null);
  assert.deepEqual(panel.readPanelPortfile(), { port: 7998, pid: null });
  writeFileSync(panel.panelPortfilePath(), '{坏 json');
  assert.equal(panel.readPanelPortfile(), null);
  writeFileSync(panel.panelPortfilePath(), JSON.stringify({ port: 'x', pid: 1 }));
  assert.equal(panel.readPanelPortfile(), null, 'port 不是数字 = 无档案');
  writeFileSync(panel.panelPortfilePath(), JSON.stringify({ port: 7999, pid: -3 }));
  assert.equal(panel.readPanelPortfile(), null, 'pid 非法（负数）= 无档案');
  assert.equal(panel.isPidAlive(process.pid), true);
  assert.equal(panel.isPidAlive(2_147_483_646), false);
});

test('portfile：clear 只清自己的（pid 不是本进程就不动）', () => {
  panel.writePanelPortfile(7997, 2_147_483_646); // 别人的（死 pid 也无所谓，clear 只看等不等）
  panel.clearPanelPortfile();
  assert.deepEqual(panel.readPanelPortfile(), { port: 7997, pid: 2_147_483_646 }, '不是本进程写的，不能清');
  panel.writePanelPortfile(7997, process.pid);
  panel.clearPanelPortfile();
  assert.equal(panel.readPanelPortfile(), null, '自己写的要清掉');
  panel.writePanelPortfile(7997, null);
  panel.clearPanelPortfile();
  assert.equal(panel.readPanelPortfile(), null, 'pid null（reuse 补写）退出时也可清');
});

// —— 2. 面板发现：真 server + 同库判据 ——

const server = await startServer({ port: 0 });
const realPort = server.address().port;

test('discoverPanelPort：portfile 指活面板且同库 → 命中；面板关了 → null', async () => {
  panel.writePanelPortfile(realPort, process.pid);
  assert.equal(await panel.discoverPanelPort(), realPort);
  await new Promise((ok) => server.close(ok));
  assert.equal(await panel.discoverPanelPort(), null, '面板关了：档案里的 pid 还活着（是本测试进程），但探测解不出面板 → 回落默认端口 → 也不认');
});

test('discoverPanelPort：库路径不同的面板不认（宁可直跑，不可代理到别的库）', async () => {
  const { storePathInUse } = await import('../../src/core/store.ts');
  // 同进程里 env 两边一致，真 server 测不出「不同库」——用假面板精确控制 bootstrap 的 storePathRaw
  const mk = (storeRaw) => http.createServer((req, res) => {
    if (req.url.startsWith('/api/bootstrap')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { app: { name: APP_NAME }, storePathRaw: storeRaw } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wrong = mk('D:\\elsewhere\\other.db');
  await new Promise((ok) => wrong.listen(0, '127.0.0.1', ok));
  try {
    panel.writePanelPortfile(wrong.address().port, process.pid);
    assert.equal(await panel.discoverPanelPort(), null, 'app 名对得上但库不同 → 不代理');
  } finally {
    await new Promise((ok) => wrong.close(ok));
  }
  const right = mk(storePathInUse());
  await new Promise((ok) => right.listen(0, '127.0.0.1', ok));
  try {
    panel.writePanelPortfile(right.address().port, process.pid);
    assert.equal(await panel.discoverPanelPort(), right.address().port, 'app 名 + 库路径都对 → 认');
  } finally {
    await new Promise((ok) => right.close(ok));
  }
});

// —— 3. /api/cli 分发口 + proxyRun 等价 ——

const server2 = await startServer({ port: 0 });
const port2 = server2.address().port;

async function dispatch(body) {
  const res = await fetch(`http://127.0.0.1:${port2}/api/cli`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('dispatch：未知 action 404；raw 下载口拒绝代理', async () => {
  const ghost = await dispatch({ actionId: 'no.such', ctx: {} });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.code, 'NOT_FOUND');
  const raw = await dispatch({ actionId: 'transfer.export', ctx: { ref: 'px' } });
  assert.equal(raw.status, 400);
  assert.match(raw.json.error, /raw/);
});

test('proxyRun：与直跑等价（读命令 deepEqual；写命令 tags/array 与 kv flag 读回一致）', async () => {
  const list = ACTIONS.find((a) => a.id === 'section.list');
  const ctxList = applySpec(list, {});
  assert.deepEqual(await proxyRun(list, ctxList, port2), await list.run(ctxList, { transport: 'cli' }));

  const add = ACTIONS.find((a) => a.id === 'entry.add');
  await proxyRun(add, applySpec(add, { section: 'px', title: '乙', tags: ['t1', 't2'] }), port2);
  await add.run(applySpec(add, { section: 'px', title: '丙', tags: ['t1', 't2'] }), { transport: 'cli' });
  const gotY = await entries.getEntry('乙', { section: 'px' });
  const gotB = await entries.getEntry('丙', { section: 'px' });
  assert.deepEqual(gotY.tags, gotB.tags, 'array flag 经代理二次 coerce 不变形');
  assert.deepEqual(gotY.tags, ['t1', 't2']);

  const upd = ACTIONS.find((a) => a.id === 'entry.update');
  const r = await proxyRun(upd, applySpec(upd, { ref: '乙', section: 'px', set: { name: '改名' } }), port2);
  assert.equal(r.status, 'ok', 'kv flag 经代理（对象原样）照常工作');
  assert.equal((await entries.getEntry('乙', { section: 'px' })).values.name, '改名');
});

test('proxyRun：错误形状等价——INVALID_INPUT 带用法串、code 一致', async () => {
  const get = ACTIONS.find((a) => a.id === 'entry.get');
  let directErr = null; let proxyErr = null;
  try { await get.run(applySpec(get, { section: 'px' }), { transport: 'cli' }); } catch (e) { directErr = e; }
  try { await proxyRun(get, applySpec(get, { section: 'px' }), port2); } catch (e) { proxyErr = e; }
  assert.ok(directErr && proxyErr, '两边都必须报错（缺 <ref>）');
  assert.equal(proxyErr.code, directErr.code);
  assert.ok(proxyErr.message.includes('用法:'), '代理错误必须带用法串（agent 的锚点）');
});

test('proxyRun：binaryBody——文件读不到时错误文案与直跑一致（不塞 bodyB64，让面板侧 service 报同样的错）', async () => {
  const imp = ACTIONS.find((a) => a.id === 'transfer.import');
  const ctx = applySpec(imp, { ref: 'px', file: 'nx-sk-proxy-不存在.zip' });
  let directErr = null; let proxyErr = null;
  try { await imp.run(ctx, { transport: 'cli' }); } catch (e) { directErr = e; }
  try { await proxyRun(imp, ctx, port2); } catch (e) { proxyErr = e; }
  assert.ok(directErr && proxyErr);
  assert.equal(proxyErr.code, directErr.code);
  // 直跑经 runCli 的 catch 会给 INVALID_INPUT 补用法串，代理在服务端补的是同一条——
  // 两边最终形态必须一致（这是「stdout/错误文案与直跑完全一致」验收的组成部分）。
  const expected = directErr.message.includes('用法:')
    ? directErr.message
    : `${directErr.message}\n用法: ${usageOf(imp)}`;
  assert.equal(proxyErr.message, expected);
});

test('dispatch：GET /api/cli 不存在（只有 POST 形态）', async () => {
  const res = await fetch(`http://127.0.0.1:${port2}/api/cli`);
  assert.equal(res.status, 404);
});

test('APP_NAME 认领判据在 bootstrap 里可观测（代理安全的前提）', async () => {
  const res = await fetch(`http://127.0.0.1:${port2}/api/bootstrap`);
  const j = await res.json();
  assert.equal(j.data.app.name, APP_NAME);
  assert.equal(typeof j.data.storePathRaw, 'string', 'bootstrap 必须报 storePathRaw——discover 的同库判据靠它');
  // 收尾关面板：放在最后一个测试里（node:test 的测试体晚于模块顶层代码执行，
  // 顶层 close() 会在所有测试跑之前就面板关掉——真实踩过的坑）
  await new Promise((ok) => server2.close(ok));
});
