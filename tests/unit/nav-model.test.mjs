// 头部导航配置的纯模型单测：增删改、排序、派生、校验。
// 这一层是「管理逻辑」的唯一实现处（表现层只画），所以它必须自己就被钉死。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const m = await import('../../src/web/frontend/components/navModel.js');

const ALL = ['job', 'projects', 'campus', 'servers', 'secret'];

test('configFromSettings / configToPayload：深拷贝往返，不共享引用', () => {
  const settings = { navGroups: [{ title: '求职', sections: ['projects'] }], navHidden: ['servers'] };
  const cfg = m.configFromSettings(settings);
  assert.deepEqual(cfg, { groups: [{ title: '求职', sections: ['projects'] }], hidden: ['servers'], order: [] });

  // 改副本不影响原数据（设置页「放弃改动」的前提）
  cfg.groups[0].sections.push('campus');
  assert.deepEqual(settings.navGroups[0].sections, ['projects']);

  assert.deepEqual(m.configToPayload(cfg), {
    navGroups: [{ title: '求职', sections: ['projects', 'campus'] }],
    navHidden: ['servers'],
    navOrder: [],
  });
});

test('configFromSettings：后端缺字段时给出空配置（老 store 直接可用）', () => {
  assert.deepEqual(m.configFromSettings(undefined), { groups: [], hidden: [], order: [] });
  assert.deepEqual(m.configFromSettings({}), { groups: [], hidden: [], order: [] });
});

test('isDirty：形状等价即视为未改动', () => {
  const a = m.configFromSettings({ navGroups: [{ title: 'A', sections: ['job'] }] });
  const b = structuredClone(a);
  assert.equal(m.isDirty(a, b), false);
  b.hidden.push('job');
  assert.equal(m.isDirty(a, b), true);
});

test('分组：新增 / 改名 / 删除 / 上下移动（越界不动）', () => {
  let cfg = m.emptyConfig();
  cfg = m.addGroup(cfg, '求职');
  cfg = m.addGroup(cfg, '工具');
  assert.deepEqual(cfg.groups.map((g) => g.title), ['求职', '工具']);

  cfg = m.renameGroup(cfg, 0, '求职资料');
  assert.equal(cfg.groups[0].title, '求职资料');

  cfg = m.moveGroup(cfg, 0, 1);
  assert.deepEqual(cfg.groups.map((g) => g.title), ['工具', '求职资料']);
  assert.deepEqual(m.moveGroup(cfg, 0, -1).groups.map((g) => g.title), ['工具', '求职资料'], '越界保持原样');

  cfg = m.removeGroup(cfg, 0);
  assert.deepEqual(cfg.groups.map((g) => g.title), ['求职资料']);
});

test('组成员：加入 / 一个栏目只能属于一个分组 / 移除 / 组内排序', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addGroup(cfg, 'B');
  cfg = m.addSection(cfg, 0, 'job');
  cfg = m.addSection(cfg, 0, 'projects');
  cfg = m.addSection(cfg, 0, 'campus');
  assert.deepEqual(cfg.groups[0].sections, ['job', 'projects', 'campus']);

  // 已在别的组 → 拒绝（不静默搬走，界面上那一条也不该出现）
  const same = m.addSection(cfg, 1, 'job');
  assert.equal(same, cfg, '跨组加入应原样返回');
  assert.deepEqual(m.availableFor(cfg, 1, ALL), ['servers', 'secret'], 'B 组可加入的只剩未归组的');

  cfg = m.moveSection(cfg, 0, 0, 1);
  assert.deepEqual(cfg.groups[0].sections, ['projects', 'job', 'campus']);
  assert.deepEqual(m.moveSection(cfg, 0, 0, -1).groups[0].sections, ['projects', 'job', 'campus'], '越界保持原样');

  cfg = m.removeSection(cfg, 0, 'job');
  assert.deepEqual(cfg.groups[0].sections, ['projects', 'campus']);
});

test('隐藏开关与派生：groupedIds / ungroupedIds', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addSection(cfg, 0, 'job');

  assert.deepEqual(m.groupedIds(cfg), ['job']);
  assert.deepEqual(m.ungroupedIds(cfg, ALL), ['projects', 'campus', 'servers', 'secret']);

  cfg = m.toggleHidden(cfg, 'servers');
  assert.equal(m.isHidden(cfg, 'servers'), true);
  assert.deepEqual(m.groupedIds(cfg), ['job'], '隐藏不影响「属于哪个分组」');
  assert.deepEqual(m.ungroupedIds(cfg, ALL), ['projects', 'campus', 'secret'], '平铺容器不含被隐藏的栏目');

  cfg = m.toggleHidden(cfg, 'servers');
  assert.equal(m.isHidden(cfg, 'servers'), false);
  assert.deepEqual(cfg.hidden, []);
});

test('validate：组名空 / 空组 / 栏目不存在 / 跨组重复 / 隐藏项不存在 —— 都能判红', () => {
  const ok = m.validate(m.addSection(m.addGroup(m.emptyConfig(), 'A'), 0, 'job'), ALL);
  assert.deepEqual(ok, []);

  const cases = [
    [{ groups: [{ title: '  ', sections: ['job'] }], hidden: [] }, /组名/],
    [{ groups: [{ title: 'A', sections: [] }], hidden: [] }, /还没有栏目/],
    [{ groups: [{ title: 'A', sections: ['nope'] }], hidden: [] }, /已不存在，请移除/],
    [{ groups: [{ title: 'A', sections: ['job'] }, { title: 'B', sections: ['job'] }], hidden: [] }, /只能属于一个分组/],
    [{ groups: [], hidden: ['nope'] }, /已不存在/],
  ];
  for (const [cfg, re] of cases) {
    const problems = m.validate(cfg, ALL);
    assert.equal(problems.length >= 1, true, `应报错: ${JSON.stringify(cfg)}`);
    assert.match(problems.map((p) => p.message).join(' | '), re);
  }
});

test('容器模型：containerOf 判定「平铺 / 分组 / 隐藏」，三者互斥', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addSection(cfg, 0, 'job');
  assert.deepEqual(m.containerOf(cfg, 'job'), { kind: 'group', gi: 0, index: 0 });
  assert.deepEqual(m.containerOf(cfg, 'servers', ALL), { kind: 'pool', index: 3 });

  cfg = m.moveToContainer(cfg, 'job', { kind: 'hidden' });
  assert.deepEqual(m.containerOf(cfg, 'job'), { kind: 'hidden', index: 0 });
  assert.deepEqual(cfg.groups[0].sections, [], '进隐藏容器时要先从分组里摘掉');
  assert.deepEqual(cfg.hidden, ['job']);

  // 从隐藏拖回平铺 → 不再是隐藏容器成员
  cfg = m.moveToContainer(cfg, 'job', { kind: 'pool' });
  assert.deepEqual(m.containerOf(cfg, 'job', ALL), { kind: 'pool', index: 0 });
  assert.deepEqual(cfg.hidden, []);

  // 平铺 → 分组（指定位置）
  cfg = m.moveToContainer(cfg, 'job', { kind: 'group', gi: 0 }, 0);
  assert.deepEqual(cfg.groups[0].sections, ['job']);
});

test('容器模型：任何一次移动都只落一处（不会同时存在于两个容器）', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addGroup(cfg, 'B');
  cfg = m.addSection(cfg, 0, 'job');
  cfg = m.moveToContainer(cfg, 'job', { kind: 'group', gi: 1 });
  assert.deepEqual(cfg.groups[0].sections, []);
  assert.deepEqual(cfg.groups[1].sections, ['job']);

  cfg = m.moveToContainer(cfg, 'job', { kind: 'hidden' });
  assert.deepEqual(cfg.groups.flatMap((g) => g.sections), []);
  assert.deepEqual(cfg.hidden, ['job']);

  const inContainers = (c, sid) => c.groups.filter((g) => g.sections.includes(sid)).length + (c.hidden.includes(sid) ? 1 : 0);
  assert.equal(inContainers(cfg, 'job'), 1);
});

test('insertionIndex：同容器内往下拖要减 1，跨容器与末尾不减（预览与实际落点对齐）', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  for (const sid of ['job', 'projects', 'campus']) cfg = m.addSection(cfg, 0, sid);
  assert.deepEqual(cfg.groups[0].sections, ['job', 'projects', 'campus']);

  // 把 job（位置 0）拖到「projects 行之前」（悬停索引 1）→ 插入位 0 = 原地不动
  assert.equal(m.insertionIndex(cfg, 'job', { kind: 'group', gi: 0 }, 1), 0);
  // 拖到「campus 行之前」（悬停 2）→ 插入位 1 → 落到 projects 后面
  assert.equal(m.insertionIndex(cfg, 'job', { kind: 'group', gi: 0 }, 2), 1);
  const moved = m.moveToContainer(cfg, 'job', { kind: 'group', gi: 0 }, m.insertionIndex(cfg, 'job', { kind: 'group', gi: 0 }, 2));
  assert.deepEqual(moved.groups[0].sections, ['projects', 'job', 'campus'], '预览到的顺序就是松手后的顺序');

  // 往**上**拖不减（自身在下方，不影响上方索引）
  assert.equal(m.insertionIndex(cfg, 'campus', { kind: 'group', gi: 0 }, 0), 0);
  // 跨容器不减
  assert.equal(m.insertionIndex(cfg, 'job', { kind: 'hidden' }, 1), 1);
  // 末尾（null）保持 null
  assert.equal(m.insertionIndex(cfg, 'job', { kind: 'group', gi: 0 }, null), null);
});


test('平铺顺序：拖过之后按 order 排；没排过的按栏目自身顺序跟在后面', () => {
  let cfg = m.emptyConfig();
  // 初始：纯栏目顺序（ALL = job, projects, campus, servers, secret）
  assert.deepEqual(m.poolOrder(cfg, ALL), ALL);

  // 把 secret 拖到第 0 位
  cfg = m.moveToContainer(cfg, 'secret', { kind: 'pool' }, 0, ALL);
  assert.deepEqual(m.poolOrder(cfg, ALL), ['secret', 'job', 'projects', 'campus', 'servers']);

  // 再把 job 拖到 projects 之前（悬停索引由调用方换算，这里直接给插入位 2）
  cfg = m.moveToContainer(cfg, 'job', { kind: 'pool' }, 2, ALL);
  assert.deepEqual(m.poolOrder(cfg, ALL), ['secret', 'projects', 'job', 'campus', 'servers']);

  // 没排过的新栏目（allIds 里新加的一个）跟在已排的后面
  const withNew = [...ALL, 'brand_new'];
  assert.deepEqual(m.poolOrder(cfg, withNew), ['secret', 'projects', 'job', 'campus', 'servers', 'brand_new']);
});

test('平铺顺序：进分组 / 隐藏后再拖回，位置按当前顺序重新落位', () => {
  let cfg = m.emptyConfig();
  cfg = m.moveToContainer(cfg, 'servers', { kind: 'pool' }, 0, ALL);
  assert.deepEqual(m.ungroupedIds(cfg, ALL), ['servers', 'job', 'projects', 'campus', 'secret']);

  // 拖进隐藏 → 不在平铺里；再拖回末尾 → 回到队尾
  cfg = m.moveToContainer(cfg, 'servers', { kind: 'hidden' }, null, ALL);
  assert.deepEqual(m.ungroupedIds(cfg, ALL), ['job', 'projects', 'campus', 'secret']);
  cfg = m.moveToContainer(cfg, 'servers', { kind: 'pool' }, null, ALL);
  assert.deepEqual(m.ungroupedIds(cfg, ALL), ['job', 'projects', 'campus', 'secret', 'servers']);
});

test('validate：平铺顺序里出现不存在的栏目要判红', () => {
  const cfg = { groups: [], hidden: [], order: ['job', 'ghost'] };
  const problems = m.validate(cfg, ALL);
  assert.match(problems.map((p) => p.message).join(' | '), /平铺顺序里的栏目 ghost 已不存在/);
});

test('分组角标 = 栏目数，不是条目数之和', () => {
  // 组里 3 个栏目，条目数天差地别：角标必须是 3
  const group = {
    title: '求职资料',
    sections: [
      { id: 'job', title: '求职档案', count: 16 },
      { id: 'projects', title: '项目经历', count: 2 },
      { id: 'campus', title: '校内职务', count: 0 },
    ],
  };
  assert.equal(m.groupSectionCount(group), 3);

  // 曾经的口径：把条目数加起来 = 18，看着像「这个分组有 18 条记录」
  const wrong = group.sections.reduce((n, s) => n + (s.count || 0), 0);
  assert.equal(wrong, 18);
  assert.notEqual(m.groupSectionCount(group), wrong, '角标不能等于条目数之和');
});

test('分组角标：空组与缺字段都按 0，不炸', () => {
  assert.equal(m.groupSectionCount({ title: '空组', sections: [] }), 0);
  assert.equal(m.groupSectionCount({ title: '没有 sections' }), 0);
  assert.equal(m.groupSectionCount(undefined), 0);
});

test('分组角标：只看栏目数，条目数变化不影响角标', () => {
  const before = { title: 'g', sections: [{ id: 'a', count: 1 }, { id: 'b', count: 1 }] };
  const after = { title: 'g', sections: [{ id: 'a', count: 99 }, { id: 'b', count: 0 }] };
  assert.equal(m.groupSectionCount(before), m.groupSectionCount(after));
});
