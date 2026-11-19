// 浏览器 SOP：**一条新条目在 Web 上的完整生命周期**。
//
//   新建栏目（带模板）→ 新建条目 → 条目内加扩展字段 → 填值 → 保存 →
//   组内拖块换序 → 栏目属性编辑器里组内字段换序 → 删条目 → 删栏目
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
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
      const r = await fetch(`${base}/api/sections`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务没起来: ${base}`);
}

const noPlaywright = !(await havePlaywright());
const noChrome = !chromePath();
const skip = noPlaywright ? 'playwright-core 未安装（pnpm i 后再跑）' : (noChrome ? '本机没有 Chrome（用 NX_SK_CHROME 指定）' : false);

test('web SOP：栏目 / 条目 / 字段 / 保存 / 拖拽 / 删除', { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import('playwright-core');
  const home = await mkdtemp(join(tmpdir(), 'nx-sk-web-'));
  const port = 7900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const { child, log } = startServer(port, home);
  let browser;
  let page;
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

    await step('新建栏目（用项目模板起步）', async () => {
      const tpl = await fetch(`${base}/api/sections/templates`).then((r) => r.json());
      const list = tpl.data?.templates || tpl.templates || [];
      const projects = list.find((x) => x.id === 'projects') || list[0];
      assert.ok(projects, '没有可用模板');
      await page.goto(`${base}/#/sections`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '新建栏目' }).click();
      const mask = page.locator('.mask');
      await mask.locator('input').nth(0).fill('sop');
      await mask.locator('input').nth(1).fill('SOP 用例');
      await mask.locator('select').selectOption(projects.id);
      await mask.getByRole('button', { name: '创建' }).click();
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).first().waitFor({ timeout: 15_000 });
      const r = await fetch(`${base}/api/sections/sop`);
      assert.equal(r.ok, true, '栏目没建出来');
    });

    await step('打开栏目并新建条目', async () => {
      await page.goto(`${base}/#/sop`, { waitUntil: 'networkidle' });
      await page.locator('.col').first().getByRole('button', { name: /新建/ }).first().click();
      const mask = page.locator('.mask');
      await mask.locator('input').first().fill('生命周期条目');
      await mask.getByRole('button', { name: /新建|创建|确定/ }).last().click();
      await page.locator('.entry-title-input').waitFor({ timeout: 15_000 });
      assert.match(page.url(), /entry=/, '新建后没跳到条目页');
      assert.equal(await page.locator('.entry-title-input').inputValue(), '生命周期条目');
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
      const sec = await fetch(`${base}/api/sections/sop`).then((r) => r.json());
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

    await step('栏目属性编辑器里组内字段换序', async () => {
      await page.goto(`${base}/#/sections`, { waitUntil: 'networkidle' });
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).getByRole('button', { name: '编辑' }).click();
      await page.waitForSelector('.dict');
      const panel = page.locator('.dgrp').filter({ has: page.locator('.drow') }).first();
      const rows = panel.locator('.drow');
      const before = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.d-key')?.textContent?.trim()));
      assert.ok(before.length >= 2, `这一组只有 ${before.length} 个字段，无法换序`);
      await rows.nth(1).locator('.tf-grip').dragTo(rows.nth(0));
      await page.waitForTimeout(1200);
      const after = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.d-key')?.textContent?.trim()));
      assert.notDeepEqual(after, before, '字段拖不动（组内换序回归）');
      const full = await fetch(`${base}/api/sections/sop`).then((r) => r.json());
      const gid = await panel.locator('.dgrp-id').inputValue();
      const keys = full.data.fieldList.find((f) => f.type === 'group' && f.key === gid)?.keys;
      assert.deepEqual(keys, after, '字段顺序没落库');
      // 顺带钉住：组字段自己不许出现在「未归组」假面板里（旧算法在这一步多造一个面板）
      assert.equal(await page.locator('.dgrp.orphans .drow').count(), 0, '「未归组」里出现了组字段');
    });

    // 放在删除之前：删完栏目再读 /api/sections/sop 会自带一个 404，那是测试自己造的噪音
    await step('浏览器零报错', async () => {
      const real = errors.filter((x) => !/favicon|ERR_ABORTED|net::ERR_FAILED/.test(x));
      assert.deepEqual(real, [], `浏览器里报了错: ${real.slice(0, 3).join(' | ')}`);
    });

    await step('删除条目', async () => {
      await page.goto(`${base}/#/sop`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '删除条目' }).click();
      const mask = page.locator('.mask');
      await mask.locator('button').last().click();
      await page.waitForTimeout(1200);
      const r = await fetch(`${base}/api/sections/sop`).then((x) => x.json());
      assert.equal(r.data.entries, 0, '条目没删掉');
    });

    await step('删除栏目', async () => {
      await page.goto(`${base}/#/sections`, { waitUntil: 'networkidle' });
      await page.locator('.tree-row', { hasText: 'SOP 用例' }).getByRole('button', { name: /删除/ }).first().click();
      const mask = page.locator('.mask');
      await mask.locator('button').last().click();
      await page.waitForTimeout(1000);
      assert.equal((await fetch(`${base}/api/sections/sop`)).ok, false, '栏目还在');
    });
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (dag.length) process.stdout.write(`  sop: ${dag.join(' → ')}\n`);
    if (log.length && process.env.NX_SK_DEBUG) process.stdout.write(log.join(''));
  }
});
