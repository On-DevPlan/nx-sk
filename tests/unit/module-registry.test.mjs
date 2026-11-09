// 模块注册表自检的**故意写坏**用例：验证「漏登记」不再依赖人记得改清单。
//
// 现在的唯一声明是目录本身（src/modules/<id>/index.js 的 default）。所以「漏登记」
// 不再是「注册表少一行」，而是「目录在、index.js 不在 / 导出形状不对 / id 对不上」——
// 这些都在装载期抛，下面逐条钉住报错文案。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { assertModuleRegistry, listModuleIds, loadModules } = await import('../../src/runtime/module-registry.ts');
const { MODULES } = await import('../../src/runtime/registry.ts');

const moduleSrc = (id, fields = `id: '${id}', title: '${id}', order: 10, actions: []`) => `export default { ${fields} };\n`;

/** 造一个临时模块根目录。临时目录自己也要声明 type:module，否则 .js 会按 CJS 解析。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-sk-mod-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [rel, src] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return dir;
}

async function withFixture(files, fn) {
  const dir = fixture(files);
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('真实目录与注册表一一对应（模块自己就是声明，不存在第二份清单）', () => {
  assert.deepEqual(listModuleIds(), MODULES.map((m) => m.id).sort());
});

test('目录在但没有 index.js → 装载期直接抛', async () => {
  await withFixture({ 'ghost/keep.txt': '' }, async (dir) => {
    await assert.rejects(() => loadModules(dir), /缺少 index\.(ts|js)/);
  });
});

test('index.js 的 id 与目录名不一致 → 装载期直接抛', async () => {
  await withFixture({ 'wrong/index.js': moduleSrc('other') }, async (dir) => {
    await assert.rejects(() => loadModules(dir), /id 与目录名不一致/);
  });
});

test('模块缺 title / order → 装载期直接抛', async () => {
  await withFixture({ 'notitle/index.js': moduleSrc('notitle', "id: 'notitle', order: 1") }, async (dir) => {
    await assert.rejects(() => loadModules(dir), /缺少 title/);
  });
  await withFixture({ 'noorder/index.js': moduleSrc('noorder', "id: 'noorder', title: 'x'") }, async (dir) => {
    await assert.rejects(() => loadModules(dir), /缺少 order/);
  });
});

test('两个模块声明同一个 id → 注册表自检抛', () => {
  assert.throws(() => assertModuleRegistry([{ id: 'a' }, { id: 'a' }]), /模块 id 重复/);
});

test('形状完整的临时模块能正常装载', async () => {
  await withFixture({
    'alpha/index.js': moduleSrc('alpha'),
    'beta/index.js': moduleSrc('beta'),
  }, async (dir) => {
    const mods = await loadModules(dir);
    assert.deepEqual(mods.map((m) => m.id), ['alpha', 'beta']);
  });
});
