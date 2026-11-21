// 设置模块测试：设置项校验（重点：头部导航分组 navGroups —— 写坏了头部就少一块，
// 所以形状 / 条目模板存在性 / 跨组重复 / 空组都要明确报错）+ 与 store.normalize 的默认值约定。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const settings = await import('../../src/modules/settings/service.ts');
const templates = await import('../../src/modules/templates/service.ts');
const { loadStore, normalize, defaultSettings } = await import('../../src/core/store.ts');

// 播种不再自带那一堆场景条目模板：这里把 navGroups / navHidden / navOrder 用例要引用的建出来。
// 顺序刻意打乱——归一成真实 id 之后，组的语义不该依赖创建顺序。
for (const [id, title, tpl] of [
  ['job', '求职', 'job'],
  ['projects', '项目经历', 'projects'],
  ['internships', '实习', 'internships'],
  ['campus', '校内', 'campus'],
  ['secret', '密钥', 'secret'],
]) {
  await templates.addTemplate({ id, title, preset: tpl });
}

test('默认设置含 navGroups: []，老 store（没有这个键）读一次自动补上', async () => {
  assert.deepEqual(defaultSettings().navGroups, [], '缺省 = 全部条目模板平铺');
  assert.deepEqual(normalize({ settings: { exportFormat: 'md' } }).settings.navGroups, []);
  assert.deepEqual((await loadStore()).settings.navGroups, []);
});

test('navGroups：写数组落盘，组内重复与「id/标题混写」都归一成真实 id', async () => {  const r = await settings.updateSettings({
    set: { navGroups: [{ title: '求职', templates: ['projects', '项目经历', '', 'internships'] }] },
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.set.navGroups, [{ title: '求职', templates: ['projects', 'internships'] }]);
  assert.deepEqual((await loadStore()).settings.navGroups, [{ title: '求职', templates: ['projects', 'internships'] }]);
});

test('navGroups：CLI 传 JSON 字符串也认（--value 形态）', async () => {
  const r = await settings.updateSettings({
    key: 'navGroups',
    value: '[{"title":"A","templates":["projects","internships"]},{"title":"B","templates":["campus"]}]',
  });
  assert.equal(r.set.navGroups.length, 2);
  assert.deepEqual(r.set.navGroups[1], { title: 'B', templates: ['campus'] });
});

test('navGroups 校验：坏形状 / 不存在条目模板 / 跨组重复 / 缺组名 / 空组 —— 都明确报错且不落盘', async () => {
  const before = JSON.stringify((await loadStore()).settings.navGroups);
  const cases = [
    [{ set: { navGroups: { title: 'x' } } }, /数组/],
    [{ set: { navGroups: 'not-json' } }, /JSON/],
    [{ set: { navGroups: [{ templates: ['projects'] }] } }, /缺少 title/],
    [{ set: { navGroups: [{ title: 'A', templates: ['no_such_section'] }] } }, /不存在: no_such_section/],
    [{ set: { navGroups: [{ title: 'A', templates: ['projects'] }, { title: 'B', templates: ['projects'] }] } }, /只能属于一个分组/],
    [{ set: { navGroups: [{ title: '空组', templates: [] }] } }, /没有任何条目模板/],
  ];
  for (const [ctx, re] of cases) {
    await assert.rejects(
      settings.updateSettings(ctx),
      (e) => e.code === 'INVALID_INPUT' && re.test(e.message),
      `应拒绝: ${JSON.stringify(ctx)}`,
    );
  }
  assert.equal(JSON.stringify((await loadStore()).settings.navGroups), before, '校验失败不得落盘');
});

test('navGroups 清空 = 恢复平铺', async () => {
  const r = await settings.updateSettings({ set: { navGroups: [] } });
  assert.deepEqual(r.set.navGroups, []);
  assert.deepEqual((await loadStore()).settings.navGroups, []);
});

test('renderSettings 把数组设置渲染成 JSON（不是 [object Object]）', async () => {
  await settings.updateSettings({ set: { navGroups: [{ title: '求职', templates: ['projects'] }] } });
  const d = await settings.getSettings();
  const text = settings.renderSettings(d);
  assert.ok(text.includes('navGroups'), '设置表里要有这一行');
  assert.ok(text.includes('"title":"求职"'), '数组要序列化出来');
  assert.ok(!text.includes('[object Object]'));
});

test('navGroups 保留组内条目模板顺序（头部展开列表按它渲染，别被自动排序）', async () => {
  const r = await settings.updateSettings({ set: { navGroups: [{ title: 'O', templates: ['secret', 'job', 'campus'] }] } });
  assert.deepEqual(r.set.navGroups[0].templates, ['secret', 'job', 'campus']);
  assert.deepEqual(
    (await loadStore()).settings.navGroups[0].templates,
    ['secret', 'job', 'campus'],
    '顺序必须原样落盘：不能被条目模板 order / 字典序重排',
  );
  await settings.updateSettings({ set: { navGroups: [] } });
});

test('navHidden：隐藏清单校验 + 归一（条目模板必须存在、去重保序、接受单个字符串）', async () => {
  const r = await settings.updateSettings({ set: { navHidden: 'campus' } });
  assert.deepEqual(r.set.navHidden, ['campus']);
  assert.deepEqual((await loadStore()).settings.navHidden, ['campus']);

  // 数组 + 重复 + 不存在的条目模板
  const r2 = await settings.updateSettings({ key: 'navHidden', value: ['campus', 'campus', 'job'] });
  assert.deepEqual(r2.set.navHidden, ['campus', 'job']);
  await assert.rejects(
    settings.updateSettings({ set: { navHidden: ['no_such_section'] } }),
    (e) => e.code === 'INVALID_INPUT' && /不存在/.test(e.message),
  );

  // 只改导航配置不影响标量设置（PATCH 语义）
  assert.deepEqual((await loadStore()).settings.navHidden, ['campus', 'job']);
  await settings.updateSettings({ set: { navHidden: [] } });
  assert.deepEqual((await loadStore()).settings.navHidden, []);
});

test('getSettings 带上条目模板清单（面板的「条目模板管理」按它渲染）', async () => {
  const d = await settings.getSettings();
  assert.ok(Array.isArray(d.templates) && d.templates.length >= 5, '要列出全部条目模板');
  assert.ok(d.templates.every((s) => s.id && s.title && typeof s.entries === 'number'));
  const text = settings.renderSettings(d);
  assert.ok(text.includes('隐藏 0 个'), '人类可读模式要能看出隐藏状态');
});

test('navOrder：平铺顺序校验 + 归一（条目模板必须存在、去重保序、标题也认）', async () => {
  const r = await settings.updateSettings({ set: { navOrder: ['campus', '求职'] } });
  assert.deepEqual(r.set.navOrder, ['campus', 'job'], '写标题也认，统一归一成 id');
  assert.deepEqual((await loadStore()).settings.navOrder, ['campus', 'job']);

  await assert.rejects(
    settings.updateSettings({ set: { navOrder: ['ghost'] } }),
    (e) => e.code === 'INVALID_INPUT' && /平铺顺序里的条目模板不存在: ghost/.test(e.message),
  );

  // 与 navHidden 同构：都是「条目模板 id 清单」，互不影响
  const r2 = await settings.updateSettings({ set: { navHidden: ['campus'], navOrder: ['job', 'campus'] } });
  assert.deepEqual(r2.set.navHidden, ['campus']);
  assert.deepEqual(r2.set.navOrder, ['job', 'campus']);
  await settings.updateSettings({ set: { navHidden: [], navOrder: [] } });
});

test('navOrder / navHidden：CLI 的 JSON 串写法也认（`["a","b"]` 与 `a,b` 等价）', async () => {
  const a = await settings.updateSettings({ set: { navOrder: '["campus","job"]' } });
  assert.deepEqual(a.set.navOrder, ['campus', 'job']);
  const b = await settings.updateSettings({ set: { navOrder: 'job,campus' } });
  assert.deepEqual(b.set.navOrder, ['job', 'campus']);
  await assert.rejects(
    settings.updateSettings({ set: { navOrder: '[bad json' } }),
    (e) => e.code === 'INVALID_INPUT',
  );
  await settings.updateSettings({ set: { navOrder: [] } });
});

// —— defaultTemplate ——
// 它曾经是**死配置**：设置页能改、落盘也存，但没有任何读取方
// （面板初始 tab 来自 localStorage 里写死的 'job'，CLI 也不读它）。
// 现在两件事钉住：写入必须指向真实条目模板（否则又是一个静默失效的配置），
// 以及它不能被「结构化项」那道渲染跳过逻辑吃掉。

test('defaultTemplate：只接受真实存在的条目模板；空串 = 交给面板取第一个', async () => {
  const r = await settings.updateSettings({ set: { defaultTemplate: 'projects' } });
  assert.equal(r.set.defaultTemplate, 'projects');

  // 写标题也认，归一成真实 id
  const byTitle = await settings.updateSettings({ set: { defaultTemplate: '密钥' } });
  assert.equal(byTitle.set.defaultTemplate, 'secret');

  // 指向不存在的条目模板：写入即报错，并列出可选项（不静默存一个永远不生效的值）
  await assert.rejects(
    () => settings.updateSettings({ set: { defaultTemplate: 'no_such_section' } }),
    (e) => e.code === 'INVALID_INPUT' && /默认条目模板不存在/.test(e.message) && /secret/.test(e.message),
  );

  const cleared = await settings.updateSettings({ set: { defaultTemplate: '' } });
  assert.equal(cleared.set.defaultTemplate, '');
});

test('renderSettings 仍然列出 defaultTemplate（带校验器但不是「结构化项」）', async () => {
  const d = await settings.getSettings();
  assert.match(settings.renderSettings(d), /defaultTemplate/);
});

// —— autoSaveFields（任务 #26：编辑后自动保存偏好）——

test('autoSaveFields：默认关闭，老 store（没有这个键）读一次自动补 false', async () => {
  assert.equal(defaultSettings().autoSaveFields, false, '缺省 = 手动保存（保持老行为）');
  assert.equal(normalize({ settings: { defaultTemplate: 'x' } }).settings.autoSaveFields, false);
  assert.equal((await loadStore()).settings.autoSaveFields, false);
});

test('autoSaveFields：布尔值 / CLI 字符串写法都认，且只改这一项（PATCH 语义）', async () => {
  const on = await settings.updateSettings({ set: { autoSaveFields: true } });
  assert.equal(on.set.autoSaveFields, true);
  assert.equal((await loadStore()).settings.autoSaveFields, true);

  for (const v of ['否', 'false', '0', 'no', '']) {
    const r = await settings.updateSettings({ key: 'autoSaveFields', value: v });
    assert.equal(r.set.autoSaveFields, false, `CLI 写法 ${JSON.stringify(v)} 应归一成 false`);
  }
  const yes = await settings.updateSettings({ key: 'autoSaveFields', value: '是' });
  assert.equal(yes.set.autoSaveFields, true);

  // 只动 autoSaveFields：其它设置项原样保留
  const before = (await loadStore()).settings.defaultTemplate;
  await settings.updateSettings({ set: { autoSaveFields: false } });
  assert.equal((await loadStore()).settings.defaultTemplate, before, 'PATCH 不得顺带改别的设置项');
  assert.equal((await loadStore()).settings.autoSaveFields, false);
});

test('renderSettings 用「是/否」展示 autoSaveFields', async () => {
  await settings.updateSettings({ set: { autoSaveFields: true } });
  const text = settings.renderSettings(await settings.getSettings());
  assert.match(text, /autoSaveFields\s+是/, '布尔项要渲染成是/否，不是 true/false');
  await settings.updateSettings({ set: { autoSaveFields: false } });
  assert.match(settings.renderSettings(await settings.getSettings()), /autoSaveFields\s+否/);
});

test('store 不存在：首次读取即落盘，重复读取 id 稳定（否则每次请求都重播种 → 保存 404）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx-sk-seed-'));
  process.env.NX_SK_HOME = dir;
  process.env.NX_SK_STORE = join(dir, 'store.json');
  process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');
  const { dbFile } = await import('../../src/core/paths.ts');

  const first = await loadStore();
  const second = await loadStore();
  assert.equal(first.entries[0].id, second.entries[0].id, '同一库两次读取不应换 id');
  assert.ok((await stat(dbFile())).isFile(), '首次读取应把种子写进 nxsk.db');

  const third = await loadStore();
  assert.equal(third.entries[0].id, first.entries[0].id, '落盘后再读仍是同一套 id');
});


