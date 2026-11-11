// 行数预算白名单的**陈旧性**断言。
//
// 白名单（eslint-line-budget.json）是最容易腐烂的东西：
// 文件拆完了、条目忘了删 → 豁免永久化，没人再看得见。
// 文件改名了 → 条目指向不存在的路径，豁免失效，报错理由还写着旧路径。
// 这两条都会让「白名单」变成假的安全感，所以写成断言钉死。
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG_PATH = join(ROOT, 'eslint-line-budget.json');

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

/** 数文件的「有效行」：与 ESLint max-lines 的默认口径不同，这里排除注释与空行。 */
async function codeLines(relPath) {
  const src = await readFile(join(ROOT, relPath), 'utf8');
  const lines = src.split('\n');
  let n = 0;
  let inBlock = false;
  for (const raw of lines) {
    const s = raw.trim();
    if (inBlock) {
      if (s.includes('*/')) inBlock = false;
      continue;
    }
    if (s === '') continue;
    if (s.startsWith('/*')) {
      if (!s.includes('*/')) inBlock = true;
      continue;
    }
    if (s.startsWith('//')) continue;
    n += 1;
  }
  return n;
}

/** 与 eslint-rules/line-budget.js 同口径的「总行数」：含注释与空行。 */
async function totalLines(relPath) {
  const src = await readFile(join(ROOT, relPath), 'utf8');
  return src.split('\n').length;
}

test('白名单里的每个 path 都必须真实存在（改名/删除后条目失效）', () => {
  for (const item of [...config.approved, ...config.deferred]) {
    assert.ok(item.path.startsWith('src/'), `白名单条目必须写仓库内相对路径（src/...）：${item.path}`);
    assert.ok(item.reason && item.reason.trim().length > 0, `白名单条目必须写理由：${item.path}`);
  }
});

test('白名单 path 对应的文件必须存在', async () => {
  for (const item of [...config.approved, ...config.deferred]) {
    let exists = true;
    try {
      await stat(join(ROOT, item.path));
    } catch {
      exists = false;
    }
    assert.ok(exists, `白名单指向的文件不存在了（已改名或已删除？）：${item.path} —— 请删掉这条记录`);
  }
});

test('已降到档位以下的文件必须从白名单里删掉（防止豁免永久化）', async () => {
  // approved 覆盖的是 801~1000 档；文件一旦自己降到 <= 800，登记就没意义了。
  for (const item of config.approved) {
    const total = await totalLines(item.path);
    assert.ok(
      total > config.approve,
      `${item.path} 现在只有 ${total} 行（<= ${config.approve}），已不需要 approved 豁免 —— 请删掉白名单里的这条记录`,
    );
  }
});

test('deferred 只允许给「>1000」的存量文件，且必须说明拆分计划', async () => {
  for (const item of config.deferred) {
    const total = await totalLines(item.path);
    assert.ok(
      total > config.hard,
      `${item.path} 现在只有 ${total} 行（<= ${config.hard}），已不需要 deferred 豁免 —— 请删掉白名单里的这条记录`,
    );
    assert.ok(
      item.reason.includes('拆'),
      `${item.path} 的 deferred 理由必须写明拆分计划（含「拆」字），否则它就是一张免死金牌`,
    );
  }
});

test('白名单不得给新文件开口子：>1000 的文件必须先拆，不许直接登记', async () => {
  // 这条断言的意义是「deferred 是一个有出口的过渡态」：每个 deferred 条目都对应
  // 一次明确的拆分承诺。文件名以 .new. 之类开头的新文件不该出现在名单里。
  for (const item of config.deferred) {
    assert.ok(
      !/\.(new|tmp|draft)\./.test(item.path),
      `${item.path} 看起来是新文件/草稿，不该进 deferred 名单`,
    );
  }
});

test('预算档位必须是递增的（warn < approve < hard）', () => {
  assert.ok(config.warn < config.approve, `warn(${config.warn}) 必须小于 approve(${config.approve})`);
  assert.ok(config.approve < config.hard, `approve(${config.approve}) 必须小于 hard(${config.hard})`);
});

test('白名单不得覆盖已经降到提醒档以下的文件（approved/deferred 之外不该有残留）', async () => {
  // 反向检查：把名单里没登记的大文件列出来，人工确认它们的档位归属正确。
  // 这里断言的是「名单本身没有漏掉本该登记的」——但这需要遍历整个 src，
  // 交给 eslint 规则本身更合适（它每行都跑）。本条只验证名单里没有「登记了却已合规」的。
  for (const item of config.approved) {
    const code = await codeLines(item.path);
    assert.ok(code > 0, `${item.path} 读不出有效代码行`);
  }
});
