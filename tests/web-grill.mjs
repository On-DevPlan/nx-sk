// grill 浏览器 SOP：AI 写 JSON → 小按钮 → Peek 三态 → 逐题填 → 确认回写 → 刷新后读回执。
//
// 这条测试只在**浏览器里跑**的原因：字段值形状单测能钉住，但「按钮是否很小、
// 子页面是否真的打开、确认按钮是否等必答答完才解锁」只有点过才知道。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nx-sk.mjs');

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
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--no-open'], {
    env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(String(c)));
  child.stderr.on('data', (c) => log.push(String(c)));
  return { child, log };
}

async function waitUp(base, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`${base}/api/templates`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`服务没起来: ${base}`);
}

const noPlaywright = !(await havePlaywright());
const skip = noPlaywright ? 'playwright-core 未安装（pnpm i 后再跑）' : (chromePath() ? false : '本机没有 Chrome（用 NX_SK_CHROME 指定）');

test('web grill SOP：JSON → 小按钮 → 三态子页面 → 确认回写 → agent 读 ack', { skip, timeout: 240_000 }, async () => {
  const { chromium } = await import('playwright-core');
  const home = await mkdtemp(join(tmpdir(), 'nx-sk-grill-'));
  const port = 7980 + Math.floor(Math.random() * 18);
  const base = `http://127.0.0.1:${port}`;
  const { child, log } = startServer(port, home);
  let browser;
  try {
    await waitUp(base);
    const created = await fetch(`${base}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'demo',
        title: 'Grill 浏览器测试',
        set: {
          grill: {
            schema: 'nx-sk/grill@1',
            title: '先对齐再动手',
            intro: 'AI 替你做了两个假设，逐条确认。',
            prompt: '不要先写，等我确认范围。',
            questions: [
              {
                id: 'scope',
                type: 'single',
                title: '范围包含哪些？',
                required: true,
                options: [
                  { value: 'core', label: '只做核心' },
                  { value: 'all', label: '全做', recommended: true },
                ],
              },
              {
                id: 'notes',
                type: 'text',
                title: '还有什么必须一起确认？',
                required: true,
                placeholder: '例如日志保留多久',
              },
            ],
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.data.id;

    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/#/demo?entry=${id}`, { waitUntil: 'networkidle' });

    const chip = page.locator('.grill-chip');
    await chip.waitFor();
    const chipBox = await chip.boundingBox();
    assert.ok(chipBox && chipBox.height <= 28 && chipBox.width < 260, '入口应该是很小的状态按钮');
    assert.match(await chip.innerText(), /0\/2/);
    await chip.click();
    await page.locator('.grill-panel').waitFor();

    // 三种面板形态：侧边 → 居中 → 整页；最后在整页里继续填
    await page.locator('.peek-mode-trigger').click();
    await page.getByRole('menuitemradio', { name: /侧边预览/ }).click();
    await page.locator('.peek-side').waitFor();
    await page.locator('.peek-mode-trigger').click();
    await page.getByRole('menuitemradio', { name: /居中预览/ }).click();
    await page.locator('.peek-center').waitFor();
    await page.locator('.peek-mode-trigger').click();
    await page.getByRole('menuitemradio', { name: /整页/ }).click();
    await page.locator('.peek-fullpage').waitFor();

    const confirm = page.locator('.grill-confirm');
    assert.equal(await confirm.isDisabled(), true, '必答没答完时确认按钮必须锁住');
    await page.locator('.grill-q[data-grill-q="scope"] .grill-option').filter({ hasText: '全做' }).click();
    await page.locator('.grill-q[data-grill-q="notes"] .grill-input').fill('日志保留 7 天');
    assert.equal(await confirm.isDisabled(), false, '必答全答完后确认按钮应解锁');

    await confirm.click();
    await page.locator('.grill-panel').waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForTimeout(400);
    const dump = await (await fetch(`${base}/api/templates/demo/dump`)).json();
    const doc = dump.data.entries.find((e) => e.id === id).values.grill;
    assert.equal(doc.ack.status, 'acknowledged');
    assert.equal(doc.ack.answered, 2);
    assert.equal(doc.ack.total, 2);
    assert.equal(doc.questions.find((q) => q.id === 'scope').answer, 'all');
    assert.equal(doc.questions.find((q) => q.id === 'notes').answer, '日志保留 7 天');

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.grill-chip').waitFor();
    assert.match(await page.locator('.grill-chip').innerText(), /2\/2/);
    assert.match(await page.locator('.grill-chip').innerText(), /已确认/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    if (process.env.NX_SK_KEEP_WEB_LOG) process.stdout.write(`\n[grill server]\n${log.join('')}`);
  }
});
