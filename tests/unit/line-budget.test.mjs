// 单文件行数预算规则的单测：三档边界 + 登记表命中/未命中/陈旧。
//
// 口径与 eslint-rules/line-budget.js 头注释一致：物理行（含空行与注释），
// 所以这里用 N 行 `void 0;` 造文件，`Array.from(...).join('\n')` 得到的行数正好是 N。
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import { lineBudgetWarn, lineBudgetError } from '../../eslint-rules/line-budget.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG_PATH = join(ROOT, 'eslint-line-budget.json');
const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const OPTIONS = {
  warn: config.warn,
  approve: config.approve,
  hard: config.hard,
  registry: config.registry,
};

/** N 行源码（不带结尾换行，物理行数正好 N）。 */
const lines = (n) => Array.from({ length: n }, () => 'void 0;').join('\n');

const SRC = 'C:/proj/nx-sk/src/probe.ts';
const TEST = 'C:/proj/nx-sk/tests/probe.test.mjs';
const SCRIPT = 'C:/proj/nx-sk/scripts/probe.mjs';

const entry = (path, { lineCount = 900, max = 950 } = {}) => ({
  path,
  lines: lineCount,
  max,
  reason: '单测造的数据',
  by: 'test',
  at: '2026-11-12',
});

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

// ---- 提醒档：>=600 且 <800 报 warn；登记了却回落到 <800 报陈旧 ----

ruleTester.run('line-budget-warn', lineBudgetWarn, {
  valid: [
    { code: lines(599), filename: SRC, options: [OPTIONS] },
    // 末尾换行不额外算一行：599 行带结尾换行仍是 599
    { code: `${lines(599)}\n`, filename: SRC, options: [OPTIONS] },
    { code: lines(800), filename: SRC, options: [OPTIONS] },
    { code: lines(1000), filename: SRC, options: [OPTIONS] },
    {
      code: lines(800),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 800, max: 800 })] }],
    },
  ],
  invalid: [
    { code: lines(600), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    { code: `${lines(600)}\n`, filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    { code: lines(601), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    { code: lines(799), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    // 目录覆盖：tests / scripts 与 src 同口径
    { code: lines(600), filename: TEST, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    { code: lines(600), filename: SCRIPT, options: [OPTIONS], errors: [{ messageId: 'overWarn' }] },
    // 陈旧登记：落到 800 以下就该删掉登记
    {
      code: lines(599),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts')] }],
      errors: [{ messageId: 'staleEntry' }],
    },
    {
      code: lines(700),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts')] }],
      errors: [{ messageId: 'staleEntry' }],
    },
  ],
});

// ---- 禁止档：800~999 未登记报错、超上限报错；>=1000 一律报错 ----

ruleTester.run('line-budget-error', lineBudgetError, {
  valid: [
    { code: lines(599), filename: SRC, options: [OPTIONS] },
    { code: lines(799), filename: SRC, options: [OPTIONS] },
    {
      code: lines(800),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 800, max: 800 })] }],
    },
    {
      code: lines(801),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 801, max: 850 })] }],
    },
    {
      code: lines(999),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 999, max: 999 })] }],
    },
  ],
  invalid: [
    { code: lines(800), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overApprove' }] },
    { code: lines(801), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overApprove' }] },
    { code: lines(999), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overApprove' }] },
    // 登记了但涨过 max
    {
      code: lines(900),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 850, max: 880 })] }],
      errors: [{ messageId: 'overMax' }],
    },
    // 硬禁止：1000 起一律报错，登记也救不了
    { code: lines(1000), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overHard' }] },
    { code: lines(1001), filename: SRC, options: [OPTIONS], errors: [{ messageId: 'overHard' }] },
    {
      code: lines(1000),
      filename: SRC,
      options: [{ ...OPTIONS, registry: [entry('src/probe.ts', { lineCount: 999, max: 999 })] }],
      errors: [{ messageId: 'overHard' }, { messageId: 'hardWithEntry' }],
    },
  ],
});

// ---- 登记表本身：路径存在、档位正确、上限合法、陈旧可发现 ----

async function totalLines(relPath) {
  const src = await readFile(join(ROOT, relPath), 'utf8');
  const parts = src.split('\n');
  // 与规则同口径：末尾换行不额外算一行
  return parts.length > 1 && parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

test('阈值固定为 600 / 800 / 1000 且严格递增', () => {
  assert.equal(config.warn, 600);
  assert.equal(config.approve, 800);
  assert.equal(config.hard, 1000);
});

test('登记表只保留 registry 一张表（不允许 >1000 的豁免通道）', () => {
  assert.ok(Array.isArray(config.registry), 'registry 必须是数组');
  assert.ok(!('approved' in config), '旧的 approved 表应已删除');
  assert.ok(!('deferred' in config), '旧的 deferred 表（>1000 豁免）必须删除');
});

test('每条登记都必须写全 path / lines / max / reason / by / at', () => {
  for (const item of config.registry) {
    assert.ok(/^(src|tests|scripts)\//.test(item.path), `登记路径必须落在生效目录内：${item.path}`);
    assert.ok(Number.isInteger(item.lines) && item.lines > 0, `lines 必须是正整数：${item.path}`);
    assert.ok(Number.isInteger(item.max) && item.max > 0, `max 必须是正整数：${item.path}`);
    assert.ok(item.max < config.hard, `max 必须小于硬禁止档 ${config.hard}：${item.path}`);
    assert.ok(item.reason && item.reason.trim().length > 0, `必须写理由：${item.path}`);
    assert.ok(item.by && item.by.trim().length > 0, `必须写登记人：${item.path}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(item.at), `at 必须是 YYYY-MM-DD：${item.path}`);
  }
});

test('登记的路径必须真实存在（改名/删除后条目就失效了）', async () => {
  for (const item of config.registry) {
    let exists = true;
    try {
      await stat(join(ROOT, item.path));
    } catch {
      exists = false;
    }
    assert.ok(exists, `登记指向的文件不存在：${item.path} —— 请删掉这条`);
  }
});

test('登记的文件必须仍在 800~999 档，且不超过登记上限（陈旧登记/上限过期都要报）', async () => {
  for (const item of config.registry) {
    const total = await totalLines(item.path);
    assert.ok(
      total >= config.approve,
      `${item.path} 现在只有 ${total} 行（< ${config.approve}），已不需要登记 —— 请删掉这条`,
    );
    assert.ok(
      total <= item.max,
      `${item.path} 现在 ${total} 行，超过登记上限 ${item.max} —— 要么拆，要么调高 max 并写理由`,
    );
  }
});

test('生效目录覆盖 src / tests / scripts', async () => {
  const { default: flat } = await import('../../eslint.config.js');
  const blocks = flat.filter((b) => b?.rules && 'local/line-budget-error' in b.rules);
  assert.ok(blocks.length > 0, 'eslint.config.js 里找不到行数预算的接线');
  const patterns = blocks.flatMap((b) => (Array.isArray(b.files) ? b.files : [b.files]));
  for (const dir of ['src', 'tests', 'scripts']) {
    assert.ok(
      patterns.some((p) => String(p).startsWith(`${dir}/`)),
      `行数预算必须覆盖 ${dir}/**，当前 files：${patterns.join(', ')}`,
    );
  }
});
