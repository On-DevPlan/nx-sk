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
