// 设置模块测试：设置项校验（重点：头部导航分组 navGroups —— 写坏了头部就少一块，
// 所以形状 / 栏目存在性 / 跨组重复 / 空组都要明确报错）+ 与 store.normalize 的默认值约定。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const settings = await import('../../src/modules/settings/service.js');
const { loadStore, normalize, defaultSettings } = await import('../../src/core/store.js');

test('默认设置含 navGroups: []，老 store（没有这个键）读一次自动补上', async () => {
  assert.deepEqual(defaultSettings().navGroups, [], '缺省 = 全部栏目平铺');
  assert.deepEqual(normalize({ settings: { exportFormat: 'md' } }).settings.navGroups, []);
  assert.deepEqual((await loadStore()).settings.navGroups, []);
});

test('navGroups：写数组落盘，组内重复与「id/标题混写」都归一成真实 id', async () => {
  const r = await settings.updateSettings({
    set: { navGroups: [{ title: '求职', sections: ['projects', '项目经历', '', 'internships'] }] },
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.set.navGroups, [{ title: '求职', sections: ['projects', 'internships'] }]);
  assert.deepEqual((await loadStore()).settings.navGroups, [{ title: '求职', sections: ['projects', 'internships'] }]);
});

test('navGroups：CLI 传 JSON 字符串也认（--value 形态）', async () => {
  const r = await settings.updateSettings({
    key: 'navGroups',
    value: '[{"title":"A","sections":["projects","internships"]},{"title":"B","sections":["campus"]}]',
  });
  assert.equal(r.set.navGroups.length, 2);
  assert.deepEqual(r.set.navGroups[1], { title: 'B', sections: ['campus'] });
});

test('navGroups 校验：坏形状 / 不存在栏目 / 跨组重复 / 缺组名 / 空组 —— 都明确报错且不落盘', async () => {
  const before = JSON.stringify((await loadStore()).settings.navGroups);
  const cases = [
    [{ set: { navGroups: { title: 'x' } } }, /数组/],
    [{ set: { navGroups: 'not-json' } }, /JSON/],
    [{ set: { navGroups: [{ sections: ['projects'] }] } }, /缺少 title/],
    [{ set: { navGroups: [{ title: 'A', sections: ['no_such_section'] }] } }, /不存在: no_such_section/],
    [{ set: { navGroups: [{ title: 'A', sections: ['projects'] }, { title: 'B', sections: ['projects'] }] } }, /只能属于一个分组/],
    [{ set: { navGroups: [{ title: '空组', sections: [] }] } }, /没有任何栏目/],
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
  await settings.updateSettings({ set: { navGroups: [{ title: '求职', sections: ['projects'] }] } });
  const d = await settings.getSettings();
  const text = settings.renderSettings(d);
  assert.ok(text.includes('navGroups'), '设置表里要有这一行');
  assert.ok(text.includes('"title":"求职"'), '数组要序列化出来');
  assert.ok(!text.includes('[object Object]'));
});

test('navGroups 保留组内栏目顺序（头部展开列表按它渲染，别被自动排序）', async () => {
  const r = await settings.updateSettings({ set: { navGroups: [{ title: 'O', sections: ['secret', 'job', 'campus'] }] } });
  assert.deepEqual(r.set.navGroups[0].sections, ['secret', 'job', 'campus']);
  assert.deepEqual(
    (await loadStore()).settings.navGroups[0].sections,
    ['secret', 'job', 'campus'],
    '顺序必须原样落盘：不能被栏目 order / 字典序重排',
  );
  await settings.updateSettings({ set: { navGroups: [] } });
});

test('navHidden：隐藏清单校验 + 归一（栏目必须存在、去重保序、接受单个字符串）', async () => {
  const r = await settings.updateSettings({ set: { navHidden: 'campus' } });
  assert.deepEqual(r.set.navHidden, ['campus']);
  assert.deepEqual((await loadStore()).settings.navHidden, ['campus']);

  // 数组 + 重复 + 不存在的栏目
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

test('getSettings 带上栏目清单（面板的「栏目管理」按它渲染）', async () => {
  const d = await settings.getSettings();
  assert.ok(Array.isArray(d.sections) && d.sections.length >= 5, '要列出全部栏目');
  assert.ok(d.sections.every((s) => s.id && s.title && typeof s.entries === 'number'));
  const text = settings.renderSettings(d);
  assert.ok(text.includes('隐藏 0 个'), '人类可读模式要能看出隐藏状态');
});

test('navOrder：平铺顺序校验 + 归一（栏目必须存在、去重保序、标题也认）', async () => {
  const r = await settings.updateSettings({ set: { navOrder: ['campus', '求职'] } });
  assert.deepEqual(r.set.navOrder, ['campus', 'job'], '写标题也认，统一归一成 id');
  assert.deepEqual((await loadStore()).settings.navOrder, ['campus', 'job']);

  await assert.rejects(
    settings.updateSettings({ set: { navOrder: ['ghost'] } }),
    (e) => e.code === 'INVALID_INPUT' && /平铺顺序里的栏目不存在: ghost/.test(e.message),
  );

  // 与 navHidden 同构：都是「栏目 id 清单」，互不影响
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
