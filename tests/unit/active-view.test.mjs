// 当前 tab 的解析规则（activeView.js）。
//
// 为什么值得单独测：这里出过的错都**不报错、只是落在错的地方** ——
// 写死 'job' → 删掉 job 后首屏停在不存在的 id；boot 前兜底 → 深链被第一个工具页顶掉。
// 浏览器里看起来「一切正常」，所以只能靠断言钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_VIEW, normalizeViewId, resolveActiveView } from '../../src/web/frontend/activeView.js';

const S = (id) => ({ id, kind: 'section' });
const V = (id) => ({ id, kind: 'view' });
const tabs = [S('job'), S('projects'), V('files'), V('settings')];

test('显式选择优先于默认栏目', () => {
  assert.equal(resolveActiveView('projects', tabs, 'job').id, 'projects');
});

test('没选过 → 落在 settings.defaultSection（这条曾经是没人读的死配置）', () => {
  assert.equal(resolveActiveView('', tabs, 'projects').id, 'projects');
  assert.equal(resolveActiveView('', tabs, '').id, 'job', '没有默认栏目时取第一个 tab');
});

test('默认栏目指向已删除的栏目 → 优雅降到第一个 tab（不报错、不空白）', () => {
  assert.equal(resolveActiveView('', tabs, 'gone').id, 'job');
});

test('显式选择是失效 id（删掉的栏目 / 旧书签）→ 仍按默认栏目落地', () => {
  assert.equal(resolveActiveView('deleted-section', tabs, 'projects').id, 'projects');
});

test('boot 之前绝不兜底（否则深链会被第一个静态工具页顶掉）', () => {
  assert.equal(
    resolveActiveView('', [V('files'), V('settings')], '', { booted: false }),
    null,
    'boot 前 tabs 里只有工具页，兜底会选错',
  );
  // 但显式选择在 boot 前也认：深链要能直接生效
  assert.equal(resolveActiveView('files', [V('files')], '', { booted: false }).id, 'files');
});

test('旧别名仍可解析（#/backup → 导出与备份）', () => {
  assert.equal(LEGACY_VIEW.backup, 'export');
  assert.equal(normalizeViewId('backup'), 'export');
  assert.equal(normalizeViewId(''), '');
  assert.equal(resolveActiveView('backup', [V('export')], '').id, 'export');
});
