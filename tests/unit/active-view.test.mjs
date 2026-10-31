// 当前 tab 的解析规则（activeView.js）。
//
// 为什么值得单独测：这里出过的错都**不报错、只是落在错的地方** ——
// 写死 'job' → 删掉 job 后首屏停在不存在的 id；boot 前兜底 → 深链被第一个工具页顶掉。
// 浏览器里看起来「一切正常」，所以只能靠断言钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_VIEW, buildHash, normalizeViewId, parseHash, resolveActiveView, resolveDeepLink } from '../../src/web/frontend/activeView.js';

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

test('旧别名仍可解析（#/backup → 设置：备份模块已删，落到设置页）', () => {
  assert.equal(LEGACY_VIEW.backup, 'settings');
  assert.equal(normalizeViewId('backup'), 'settings');
  assert.equal(normalizeViewId(''), '');
  assert.equal(resolveActiveView('backup', [V('settings')], '').id, 'settings');
});

// —— 深链两段（S3）：地址栏 = 当前打开的面板 ——

test('parseHash：两段深链 / 空 hash / 带查询串 / 坏转义都不炸', () => {
  assert.deepEqual(parseHash('#/job'), { sectionId: 'job', entryId: '' });
  assert.deepEqual(parseHash('#/job/e_abc'), { sectionId: 'job', entryId: 'e_abc' });
  assert.deepEqual(parseHash('#/job?x=1'), { sectionId: 'job', entryId: '' }, '旧书签带的查询串要忽略');
  assert.deepEqual(parseHash(''), { sectionId: '', entryId: '' });
  assert.deepEqual(parseHash('#/'), { sectionId: '', entryId: '' });
  assert.deepEqual(parseHash('#/%E6%B1%82%E8%81%8C'), { sectionId: '求职', entryId: '' }, '中文栏目 id 走 URL 编码');
  assert.deepEqual(parseHash('#/%zz'), { sectionId: '%zz', entryId: '' }, '坏转义原样返回，不抛');
  assert.deepEqual(parseHash('#/backup'), { sectionId: 'settings', entryId: '' }, '旧别名在这一层就归一');
});

test('buildHash 与 parseHash 互逆；没有栏目时给空串（不硬凑深链）', () => {
  assert.equal(buildHash('job'), '#/job');
  assert.equal(buildHash('job', 'e_1'), '#/job/e_1');
  assert.equal(buildHash('', 'e_1'), '', '没有栏目就没有可写的深链');
  assert.deepEqual(parseHash(buildHash('求职', 'e_1')), { sectionId: '求职', entryId: 'e_1' });
});

test('resolveDeepLink：栏目 / 条目不存在要能说清是哪一级缺失', () => {
  const secs = [{ id: 'job', entries: [{ id: 'e_1' }] }];
  assert.deepEqual(resolveDeepLink('#/job', secs), { sectionId: 'job', entryId: '', missing: null });
  assert.deepEqual(resolveDeepLink('#/job/e_1', secs), { sectionId: 'job', entryId: 'e_1', missing: null });
  assert.equal(resolveDeepLink('#/ghost', secs).missing, 'section');
  assert.equal(resolveDeepLink('#/job/e_9', secs).missing, 'entry');
  // 条目清单还没拉到（entries 缺席）时不误报「条目不存在」——加载中不等于没有
  assert.equal(resolveDeepLink('#/job/e_9', [{ id: 'job' }]).missing, null);
});
