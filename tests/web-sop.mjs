// 浏览器 SOP：**一条新条目在 Web 上的完整生命周期**。
//
//   新建条目模板（带模板）→ 新建条目 → 条目内加扩展字段 → 填值 → 保存 →
//   组内拖块换序 → 条目模板属性编辑器里组内字段换序 → 删条目 → 删条目模板
//
// 全程真起服务、真开 Chrome、真点按钮；数据住在一次性 NX_SK_HOME 里，
// 绝不碰用户的真实库。跑法：
//
//   pnpm run test:web                       （本机没有 Chrome / playwright-core 时 skip）
//   NX_SK_CHROME=/path/to/chrome pnpm run test:web
//
// 为什么要有这条：拖拽与「保存」这类交互在服务端断言不到（点没点上只有浏览器知道），
// 只用单测 / 冒烟覆盖不到；这条是它们唯一的回归网。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readZip } from '../src/core/zip.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nx-sk.mjs');

/** 本机 Chrome 的默认位置（可用 NX_SK_CHROME 覆盖）。 */
function chromePath() {
  const fromEnv = process.env.NX_SK_CHROME;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const cands = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return cands.find((p) => existsSync(p)) || null;
}

async function havePlaywright() {
  try {
    await import('playwright-core');
    return true;
  } catch {
    return false;
  }
}

function startServer(port, home) {
  const env = { ...process.env, NX_SK_HOME: home, NX_SK_STORE_DB: join(home, 'nxsk.db') };
  delete env.NX_SK_PASSPHRASE;
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--no-open'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (c) => log.push(String(c)));
  child.stderr.on('data', (c) => log.push(String(c)));
  return { child, log };
}

async function waitUp(base, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${base}/api/templates`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务没起来: ${base}`);
}

const noPlaywright = !(await havePlaywright());
const noChrome = !chromePath();
const skip = noPlaywright ? 'playwright-core 未安装（pnpm i 后再跑）' : (noChrome ? '本机没有 Chrome（用 NX_SK_CHROME 指定）' : false);

test('web SOP：条目模板 / 条目 / 字段 / 保存 / 拖拽 / 删除', { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import('playwright-core');
  const home = await mkdtemp(join(tmpdir(), 'nx-sk-web-'));
  const port = 7900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const { child, log } = startServer(port, home);
  let browser;
  let page;
  let sopEntryId = '';
  const dag = [];
  const shot = async (name) => { if (page) await page.screenshot({ path: join(ROOT, '.tmp', `web-sop-${name}.png`), fullPage: false }).catch(() => {}); };
  const step = async (name, fn) => {
    try {
      await fn();
      dag.push(name);
      process.stdout.write(`  ok · ${name}\n`);
    } catch (e) {
      await shot(name.replace(/[^\w\u4e00-\u9fa5]+/g, '-'));
      throw new Error(`[${name}] ${e?.message || e}`);
    }
  };

  try {
    await waitUp(base);
    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await step('新建条目模板（用项目模板起步）', async () => {
      const tpl = await fetch(`${base}/api/templates/presets`).then((r) => r.json());
      const list = tpl.data?.presets || tpl.presets || [];
      const projects = list.find((x) => x.id === 'projects') || list[0];
      assert.ok(projects, '没有可用模板');
      await page.goto(`${base}/#/templates`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '新建条目模板' }).click();
      const mask = page.locator('.mask');
      await mask.locator('input').nth(0).fill('sop');
      await mask.locator('input').nth(1).fill('SOP 用例');
      await mask.locator('select').selectOption(projects.id);
      await mask.getByRole('button', { name: '创建' }).click();
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).first().waitFor({ timeout: 15_000 });
      const r = await fetch(`${base}/api/templates/sop`);
      assert.equal(r.ok, true, '条目模板没建出来');
    });

    await step('从侧栏新建条目（创建时选模板）', async () => {
      // 任务 #49：根目录「新建条目」必须走统一弹窗，在创建时选择条目模板；
      // 不再默认空白后让用户去条目里自己补字段。
      await page.locator('.sb-new-btn').click();
      const mask = page.locator('.mask');
      await mask.locator('select').selectOption('sop');
      await mask.locator('input').fill('生命周期条目');
      await mask.getByRole('button', { name: '创建条目' }).click();
      await mask.waitFor({ state: 'detached', timeout: 15_000 });
      await page.locator('.entry-title-input').waitFor({ timeout: 15_000 });
      assert.match(page.url(), /entry=/, '没跳到条目页');
      assert.equal(await page.locator('.entry-title-input').inputValue(), '生命周期条目');
      const id = await page.evaluate(() => (location.hash.match(/entry=([^&]+)/) || [])[1]);
      sopEntryId = id;
      const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json());
      const node = boot.data.tree.find((n) => n.id === id);
      assert.equal(node?.template, 'sop', '创建时选的模板没生效');
    });

    await step('在条目下新建子条目默认空白', async () => {
      const pid = sopEntryId;
      await page.getByRole('button', { name: '在「生命周期条目」下新建子条目' }).click();
      const mask = page.locator('.mask');
      assert.equal(await mask.locator('select').inputValue(), '__blank__', '子条目默认继承了父条目的模板');
      await mask.locator('input').fill('生命周期子条目');
      await mask.getByRole('button', { name: '创建条目' }).click();
      await mask.waitFor({ state: 'detached', timeout: 15_000 });
      const cid = await page.evaluate(() => (location.hash.match(/entry=([^&]+)/) || [])[1]);
      const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json());
      const child = boot.data.tree.find((n) => n.id === cid);
      assert.equal(child?.template, '__blank__', '子条目不是空白模板');
      assert.equal(child?.parent, pid, '子条目的父级不对');
      // 回到父条目，后面继续测编辑链路
      await page.goto(`${base}/#/sop?entry=${pid}`, { waitUntil: 'networkidle' });
      await page.locator('.entry-title-input').waitFor({ timeout: 15_000 });
    });

    await step('条目模板页的新建入口也走统一弹窗', async () => {
      await page.goto(`${base}/#/sop`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '收起侧栏' }).click();
      await page.getByRole('button', { name: '新建条目', exact: true }).first().click();
      const mask = page.locator('.mask');
      assert.equal(await mask.locator('select').inputValue(), 'sop', '模板页新建没有默认当前模板');
      await mask.getByRole('button', { name: '取消' }).click();
      await page.getByRole('button', { name: '展开侧栏' }).click();
      await page.goto(`${base}/#/sop?entry=${sopEntryId}`, { waitUntil: 'networkidle' });
    });

    await step('条目内加扩展字段', async () => {
      await page.getByRole('button', { name: /添加字段/ }).click();
      const mask = page.locator('.mask');
      await mask.locator('input').nth(0).fill('budget');
      await mask.locator('input').nth(1).fill('预算');
      await mask.locator('select').nth(1).selectOption({ index: 0 });
      await mask.getByRole('button', { name: '添加', exact: true }).click();
      await page.locator('.blk[data-block="budget"]').waitFor({ timeout: 15_000 });
    });

    await step('填值并保存（保存按钮真的落库）', async () => {
      const budget = page.locator('.blk[data-block="budget"] input');
      await budget.fill('1234');
      await page.locator('.entry-title-input').fill('生命周期条目（改）');
      const save = page.getByRole('button', { name: '保存', exact: true });
      await save.waitFor({ timeout: 8000 });
      await save.click();
      await page.waitForTimeout(1500);
      assert.equal(await save.count(), 0, '点了保存还有「未保存改动」');
      const id = await page.evaluate(() => (location.hash.match(/entry=([^&]+)/) || [])[1]);
      assert.ok(id, '地址里没有 entry id');
      const one = await fetch(`${base}/api/entries/${id}`).then((r) => r.json());
      assert.equal(one.ok, true, '读条目失败');
      assert.equal(String(one.data.values.budget), '1234', '字段值没落库');
      assert.equal(one.data.title, '生命周期条目（改）', '条目名没落库');
    });

    await step('编辑条目标签（Web 弹窗直接 PATCH）', async () => {
      await page.getByRole('button', { name: '编辑条目标签', exact: true }).click();
      const mask = page.locator('.mask');
      const input = mask.locator('input').first();
      await input.fill('sop, E2E, 临时');
      await mask.getByRole('button', { name: '保存标签' }).click();
      await mask.waitFor({ state: 'detached', timeout: 10_000 });
      const id = await page.evaluate(() => (location.hash.match(/entry=([^&]+)/) || [])[1]);
      const one = await fetch(`${base}/api/entries/${id}`).then((r) => r.json());
      assert.deepEqual(one.data.tags, ['sop', 'E2E', '临时'], '条目标签没保存');
    });

    await step('导出树：勾文件夹覆盖子条目，快速导出整棵子树', async () => {
      const parentTitle = '生命周期条目（改）';
      const childTitle = '生命周期子条目';
      const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json());
      const parent = boot.data.tree.find((n) => n.title === parentTitle);
      const child = boot.data.tree.find((n) => n.title === childTitle);
      assert.ok(parent && child, '父/子条目不见了');
      await page.goto(`${base}/#/export`, { waitUntil: 'networkidle' });
      const row = page.locator('.tp-tree-row').filter({ hasText: parentTitle }).first();
      await row.locator('input[type="checkbox"]').check();
      assert.match(await page.locator('.tp-headacts .hint').innerText(), /含子条目 2 条/, '勾文件夹没有覆盖子条目');
      const downloadPromise = page.waitForEvent('download');
      await row.locator('.tp-tree-quick').click();
      const download = await downloadPromise;
      const path = await download.path();
      assert.ok(path, '下载没有落盘');
      const outer = readZip(Buffer.from(await readFile(path)));
      const bundle = JSON.parse(outer.find((f) => f.name === 'bundle.json').data.toString('utf8'));
      assert.equal(bundle.counts.entries, 2, '快速导出没带子条目');
      const childNode = bundle.tree.find((n) => n.id === child.id);
      assert.ok(childNode, '包里的 tree 缺子条目');
      assert.equal(childNode.parent, parent.id, '包里的 tree 丢了父子边');
      // 回到条目页，后面的「存为模板 / 拖块 / 删除」都从这里继续
      await page.goto(`${base}/#/sop?entry=${parent.id}`, { waitUntil: 'networkidle' });
      await page.locator('.entry-title-input').waitFor({ timeout: 15_000 });
    });

    await step('条目快速保存为模板（只抄结构，不抄值）', async () => {
      // 低频动作已收进顶栏「更多」，先展开菜单再点。
      await page.getByRole('button', { name: '更多条目操作', exact: true }).click();
      await page.getByRole('menuitem', { name: /存为模板/ }).click();
      const mask = page.locator('.mask');
      await mask.locator('input').nth(0).fill('sop-copy');
      await mask.locator('input').nth(1).fill('生命周期模板');
      await mask.getByRole('button', { name: '保存为模板' }).click();
      await mask.waitFor({ state: 'detached', timeout: 15_000 });
      const saved = await fetch(`${base}/api/templates/sop-copy`).then((r) => r.json());
      assert.equal(saved.ok, true, '条目另存模板没建出来');
      assert.equal(saved.data.entries, 0, '模板不该带条目');
      assert.ok(saved.data.fieldList.some((f) => f.key === 'budget'), '条目里的扩展字段没抄进模板');
      const source = await fetch(`${base}/api/entries/${await page.evaluate(() => (location.hash.match(/entry=([^&]+)/) || [])[1])}`).then((r) => r.json());
      assert.equal(source.ok, true, '另存模板不应影响原条目');
    });

    await step('块内容不被裁（附图 2 回归）', async () => {
      await page.waitForTimeout(900);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('.blk-body')]
        .filter((b) => b.scrollHeight > b.clientHeight + 2)
        .map((b) => `${b.closest('.blk')?.getAttribute('data-block')}=${b.scrollHeight}>${b.clientHeight}`));
      assert.deepEqual(clipped, [], `这些块的内容被网格高度裁掉了: ${clipped.join(' ')}`);
    });

    await step('组内拖块换序（版式落库）', async () => {
      const panel = page.locator('.panel').filter({ has: page.locator('.blk-head') }).first();
      const heads = panel.locator('.blk .blk-head');
      const before = await panel.evaluate((p) => [...p.querySelectorAll('.blk')].map((b) => b.getAttribute('data-block')));
      assert.ok(before.length >= 2, `这一组只有 ${before.length} 块，无法换序`);
      await heads.nth(1).dragTo(heads.nth(0));
      await page.waitForTimeout(800);
      const after = await panel.evaluate((p) => [...p.querySelectorAll('.blk')].map((b) => b.getAttribute('data-block')));
      assert.notDeepEqual(after, before, '拖块头没有换序');
      await page.waitForTimeout(1600);
      const sec = await fetch(`${base}/api/templates/sop`).then((r) => r.json());
      // 在版式里找同时含这两块的那一组，按 y/x 排序后的首个应该是拖动后的第一块
      const hit = Object.values(sec.data.layout.groups).find((g) => {
        const items = Object.values(g.layouts)[0] || [];
        return items.some((i) => i.i === after[0]) && items.some((i) => i.i === after[1]);
      });
      assert.ok(hit, '版式里找不到这一组');
      // 拖拽只写**当前断点**（不同断点列宽不同，顺序各存各的），所以只要有一个断点
      // 的首块是拖动后的第一块，就算落库成功。
      const ordered = Object.values(hit.layouts)
        .map((items) => items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))[0]?.i)
        .filter(Boolean);
      assert.ok(ordered.includes(after[0]), `没有任何断点记下新顺序（首块: ${ordered.join(' / ')}）`);
    });

    await step('条目模板批量删除默认收起', async () => {
      await page.goto(`${base}/#/templates`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('.tree-check').count(), 0, '默认页不该摆批量勾选框');
      await page.getByRole('button', { name: '更多条目模板操作' }).click();
      await page.getByRole('menuitem', { name: '批量删除…' }).click();
      await page.locator('.tree-batch').waitFor({ timeout: 10_000 });
      assert.ok(await page.locator('.tree-check').count() > 0, '批量模式没有出现勾选框');
      await page.getByRole('button', { name: '退出', exact: true }).click();
      assert.equal(await page.locator('.tree-batch').count(), 0, '退出后批量条还在');
    });

    await step('条目模板属性编辑器里组内字段换序', async () => {
      await page.goto(`${base}/#/templates`, { waitUntil: 'networkidle' });
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).getByRole('button', { name: '更多操作：SOP 用例' }).click();
      await page.getByRole('menuitem', { name: '编辑字段与结构' }).click();
      await page.waitForSelector('.dict');
      const panel = page.locator('.dgrp').filter({ has: page.locator('.drow') }).first();
      const rows = panel.locator('.drow');
      const before = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.d-key')?.textContent?.trim()));
      assert.ok(before.length >= 2, `这一组只有 ${before.length} 个字段，无法换序`);
      await rows.nth(1).locator('.tf-grip').dragTo(rows.nth(0));
      await page.waitForTimeout(1200);
      const after = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.d-key')?.textContent?.trim()));
      assert.notDeepEqual(after, before, '字段拖不动（组内换序回归）');
      const full = await fetch(`${base}/api/templates/sop`).then((r) => r.json());
      const gid = await panel.locator('.dgrp-id').inputValue();
      const keys = full.data.fieldList.find((f) => f.type === 'group' && f.key === gid)?.keys;
      assert.deepEqual(keys, after, '字段顺序没落库');
      // 顺带钉住：组字段自己不许出现在「未归组」假面板里（旧算法在这一步多造一个面板）
      assert.equal(await page.locator('.dgrp.orphans .drow').count(), 0, '「未归组」里出现了组字段');
    });

    // 放在删除之前：删完条目模板再读 /api/templates/sop 会自带一个 404，那是测试自己造的噪音
    await step('浏览器零报错', async () => {
      const real = errors.filter((x) => !/favicon|ERR_ABORTED|net::ERR_FAILED/.test(x));
      assert.deepEqual(real, [], `浏览器里报了错: ${real.slice(0, 3).join(' | ')}`);
    });

    await step('删除条目', async () => {
      await page.goto(`${base}/#/sop`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '更多条目操作', exact: true }).click();
      await page.getByRole('menuitem', { name: /删除条目/ }).click();
      const mask = page.locator('.mask');
      await mask.locator('button').last().click();
      await page.waitForTimeout(1200);
      const r = await fetch(`${base}/api/templates/sop`).then((x) => x.json());
      assert.equal(r.data.entries, 0, '条目没删掉');
    });

    await step('删除条目模板', async () => {
      await page.goto(`${base}/#/templates`, { waitUntil: 'networkidle' });
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).getByRole('button', { name: '更多操作：SOP 用例' }).click();
      await page.getByRole('menuitem', { name: '删除条目模板' }).click();
      const mask = page.locator('.mask');
      await mask.locator('button').last().click();
      await page.waitForTimeout(1000);
      assert.equal((await fetch(`${base}/api/templates/sop`)).ok, false, '条目模板还在');
    });
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (dag.length) process.stdout.write(`  sop: ${dag.join(' → ')}\n`);
    if (log.length && process.env.NX_SK_DEBUG) process.stdout.write(log.join(''));
  }
});
