import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const service = await import('../../src/modules/sections/service.js');
const { mergeTemplate } = await import('../../src/core/fields.js');
const { renderSectionChange } = await service;

// 回归：`removed` 在两条路径上**形状不同**——removeSection 给的是对象
// `{id,title,entries}`，updateSection 给的是**被删字段 key 的数组**。
// 数组恒为真值，所以早先的 `if (d.removed)` 会让 `section update` 永远走删除分支，
// 打印出「已删除栏目 undefined」，而且 `.entries` 还会取到 `Array.prototype.entries`，
// 把 `function entries() { [native code] }` 打进人类可读输出。
test('update 的 removed 是数组时，不能走「已删除栏目」分支', () => {
  const out = renderSectionChange({
    status: 'ok', id: 'job', changed: ['fields'], added: ['skills'], removed: [], snapshot: 'S',
  });
  assert.match(out, /已更新栏目 job/);
  assert.match(out, /新增字段 skills/);
  assert.ok(!out.includes('已删除栏目'), `不该出现「已删除栏目」，实际: ${out}`);
  assert.ok(!out.includes('[native code]'), `不该把 Array.prototype.entries 打进输出，实际: ${out}`);
});

test('没有字段增删时也不误报删除', () => {
  const out = renderSectionChange({
    status: 'ok', id: 'job', changed: ['order'], added: [], removed: [], snapshot: 'S',
  });
  assert.match(out, /已更新栏目 job：order/);
  assert.ok(!out.includes('已删除栏目'));
});

test('真删字段时报「删除字段」，仍不是「已删除栏目」', () => {
  const out = renderSectionChange({
    status: 'ok', id: 'job', changed: ['fields'], added: [], removed: ['skills'], snapshot: 'S',
  });
  assert.match(out, /删除字段 skills/);
  assert.ok(!out.includes('已删除栏目'));
});

test('remove 的对象形状仍走删除分支（别把修复改过头）', () => {
  const out = renderSectionChange({
    status: 'ok', removed: { id: 'job', title: '求职', entries: 3 }, snapshot: 'S',
  });
  assert.match(out, /已删除栏目 job（连带 3 条条目）/);
});

// —— 模板增量合并 / section sync ——
// 背景：栏目字段字典是持久化数据，模板演进（例如给求职加 `file` 类型的「附件资料」组）
// **不会回溯**到已建栏目，老栏目里看不到上传入口。section sync 用来补这个缺口。

test('mergeTemplate 只增不改：补进缺失字段、保留已有定义与自定义字段', () => {
  const section = {
    groups: [{ id: 'a', title: '自定义标题A' }, { id: 'z', title: '自定义组' }],
    fields: [
      { key: 'f1', label: '我自己改过的标签', type: 'text', group: 'a' },
      { key: 'custom', label: '自定义字段', type: 'text', group: 'z' },
    ],
  };
  const template = {
    groups: [{ id: 'a', title: '模板里的A' }, { id: 'b', title: '模板里的B' }],
    fields: [
      { key: 'f1', label: '模板标签', type: 'text', group: 'a' },
      { key: 'f2', label: '新字段', type: 'text', group: 'b' },
    ],
  };
  const r = mergeTemplate(section, template);
  // 已有字段的定义（label）与位置不动
  assert.equal(r.fields[0].key, 'f1');
  assert.equal(r.fields[0].label, '我自己改过的标签');
  // 自定义字段保留
  assert.ok(r.fields.some((f) => f.key === 'custom'));
  // 新字段被补进来
  assert.deepEqual(r.addedFields, ['f2']);
  assert.deepEqual(r.addedGroups, ['b']);
  // 分组：模板顺序优先（a、b），栏目已有的沿用自身标题，自定义分组 z 附在后面
  assert.deepEqual(r.groups.map((g) => g.id), ['a', 'b', 'z']);
  assert.equal(r.groups[0].title, '自定义标题A');
});

test('mergeTemplate 字段插到「模板序前驱」之后，不会被甩到末尾', () => {
  const section = {
    groups: [{ id: 'g', title: 'g' }],
    fields: [
      { key: 'x1', type: 'text', group: 'g' },
      { key: 'x3', type: 'text', group: 'g' },
    ],
  };
  const template = {
    groups: [{ id: 'g', title: 'g' }],
    fields: [
      { key: 'x1', type: 'text', group: 'g' },
      { key: 'x2', type: 'text', group: 'g' }, // 缺失，应插在 x1 与 x3 之间
      { key: 'x3', type: 'text', group: 'g' },
    ],
  };
  const r = mergeTemplate(section, template);
  assert.deepEqual(r.fields.map((f) => f.key), ['x1', 'x2', 'x3']);
});

test('section sync 把模板新增的 file 字段/分组补给老栏目，且可重复执行', async () => {
  // 造一个「老栏目」：从 job 模板建，然后删掉文件字段与 files 分组（模拟模板演进前建的栏目）
  await service.addSection({ id: 'jobsync', title: '求职(旧)', template: 'job' });
  await service.updateSection('jobsync', {
    fields: [
      { key: 'name', label: '姓名', type: 'text', group: 'basic' },
    ],
    groups: [{ id: 'basic', title: '基本信息' }],
  });

  const before = await service.getSection('jobsync');
  assert.ok(!before.fieldList.some((f) => f.type === 'file'), '造数据：不该还有 file 字段');

  const r = await service.syncSection('jobsync');
  assert.equal(r.status, 'ok');
  assert.ok(r.addedFields.includes('resumeFile'));
  assert.ok(r.addedFields.includes('avatar'));
  assert.ok(r.addedGroups.includes('files'));

  const after = await service.getSection('jobsync');
  assert.ok(after.fieldList.some((f) => f.key === 'resumeFile' && f.type === 'file'));
  assert.ok(after.fieldList.some((f) => f.key === 'avatar' && f.type === 'file'));
  assert.ok(after.groupList.some((g) => g.id === 'files'));
  // 原有字段没被动
  assert.equal(after.fieldList.find((f) => f.key === 'name').label, '姓名');

  // 幂等：再跑一次没有可补的
  const again = await service.syncSection('jobsync');
  assert.equal(again.upToDate, true);
  assert.deepEqual(again.addedFields, []);
});

test('section sync 对非模板栏目报错（没有模板可同步）', async () => {
  await service.addSection({ id: 'customsec', title: '自定义', fields: [{ key: 'a', label: 'A', type: 'text' }] });
  await assert.rejects(service.syncSection('customsec'), /模板/);
});

test('renderSectionChange 覆盖 sync / upToDate 分支', () => {
  const synced = renderSectionChange({ status: 'ok', id: 'job', addedGroups: ['files'], addedFields: ['resumeFile'], snapshot: 'S' });
  assert.match(synced, /已同步栏目 job/);
  assert.match(synced, /新增字段 resumeFile/);
  const up = renderSectionChange({ status: 'ok', upToDate: true, id: 'job' });
  assert.match(up, /已是最新/);
});

// —— 模板漂移（只报告，不自动改）——
// 「只增不改」的代价是：模板改了默认 label/hint 时**完全无声**，
// 用户会以为「同步过了 = 跟模板一致」。这里钉住两件事：
// 1) 差异要算出来并明说不会自动改；2) 等价定义不能被误报成差异（否则噪音淹没真差异）。

test('mergeTemplate 报告漂移：同名字段定义不同就列出来，但栏目侧定义不动', () => {
  const section = {
    groups: [{ id: 'a', title: 'A' }],
    fields: [{ key: 'f1', label: '我改过的', type: 'text', group: 'a' }],
  };
  const template = {
    groups: [{ id: 'a', title: 'A' }],
    fields: [{ key: 'f1', label: '模板标签', type: 'text', group: 'a', hint: '模板提示' }],
  };
  const r = mergeTemplate(section, template);
  assert.deepEqual(r.addedFields, []);
  assert.equal(r.changedFields.length, 1);
  assert.equal(r.changedFields[0].key, 'f1');
  assert.ok(r.changedFields[0].diff.includes('label'), JSON.stringify(r.changedFields[0]));
  assert.ok(r.changedFields[0].diff.includes('hint'), JSON.stringify(r.changedFields[0]));
  // 栏目侧原样保留（同步绝不覆盖用户改过的定义）
  assert.equal(r.fields[0].label, '我改过的');
});

test('mergeTemplate：等价定义不算漂移（fill 缺省 = normal、options 缺失 = 空）', () => {
  const section = { groups: [], fields: [{ key: 'x', label: 'X', type: 'text', group: 'g' }] };
  const template = { groups: [], fields: [{ key: 'x', label: 'X', type: 'text', group: 'g', fill: 'normal', options: [] }] };
  assert.deepEqual(mergeTemplate(section, template).changedFields, []);
});

test('renderSectionChange：漂移单独提示，并写明「只增不改」怎么跟进', () => {
  const out = renderSectionChange({
    status: 'ok', upToDate: true, id: 'job',
    addedFields: [], addedGroups: [],
    changedFields: [{ key: 'phone', diff: ['label'] }],
  });
  assert.match(out, /已是最新/);
  assert.match(out, /1 个字段的模板定义已变/);
  assert.match(out, /phone: label/);
  assert.match(out, /只增不改/);
  assert.match(out, /--fields/, '要告诉用户怎么才能真正跟进模板');
});

test('renderSectionChange：没有漂移就不打印提示（老形状也不炸）', () => {
  const out = renderSectionChange({ status: 'ok', upToDate: true, id: 'job' });
  assert.ok(!out.includes('模板定义已变'), out);
});

test('bootstrap 下发 fieldTypes：面板的类型下拉框据此渲染，不再各抄一份', async () => {
  const { bootstrapInfo } = await import('../../src/modules/system/service.js');
  const { FIELD_TYPES } = await import('../../src/core/fields.js');
  const boot = await bootstrapInfo();
  assert.deepEqual(boot.fieldTypes, FIELD_TYPES);
  assert.ok(boot.fieldTypes.includes('file'), 'file 类型必须在列表里');
});

// —— deploy 模板：Docker / K8s 规范资源 ——
// 一个条目 = 一份可复用的配置文件。光存正文不够：还要「放哪」「哪些值要替换」
// 「什么场景用」—— 缺了后三项，正文只是一段没有上下文的 YAML，下次没法照着用。

test('deploy 模板：正文是 textarea，kind 是带候选的 select', async () => {
  const { getTemplate } = await import('../../src/core/fields.js');
  const t = getTemplate('deploy');
  assert.ok(t, 'deploy 模板应存在');
  const byKey = new Map(t.fields.map((x) => [x.key, x]));
  assert.equal(byKey.get('content').type, 'textarea', '正文必须是多行文本');
  assert.equal(byKey.get('kind').type, 'select');
  assert.ok(byKey.get('kind').options.includes('Dockerfile'));
  assert.ok(byKey.get('kind').options.includes('k8s-deployment'));
  assert.ok(byKey.has('path'), '要有「建议落盘路径」');
  assert.ok(byKey.has('vars'), '要有「需替换的变量」');
  assert.equal(t.titleField, 'name');
});

test('deploy 栏目：YAML 正文写入后原样读回（换行与缩进不能被改写）', async () => {
  const entries = await import('../../src/modules/entries/service.js');
  await service.addSection({ id: 'deploytest', title: '部署配置', template: 'deploy' });
  const yaml = 'apiVersion: apps/v1\nkind: Deployment\nspec:/n  replicas: 1';
  await entries.addEntry({
    section: 'deploytest',
    title: 'node-web 部署',
    set: { kind: 'k8s-deployment', content: yaml },
  });
  const got = await entries.getEntry('node-web 部署', { section: 'deploytest' });
  assert.equal(got.values.content, yaml);
});

test('entry get 把多行正文按行拆开（否则整段从第 0 列掉出去）', async () => {
  const entries = await import('../../src/modules/entries/service.js');
  const out = entries.renderEntryGet({
    id: 'e1',
    title: 'node-web 部署',
    section: 'deploy',
    mask: false,
    completeness: { filled: 1, total: 1, ratio: 100 },
    values: { content: 'line1\nline2' },
    missing: [],
    excluded: [],
  });
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.includes('line1'));
  assert.ok(i >= 0, out);
  assert.ok(lines[i + 1].trim() === 'line2', out);
  assert.ok(lines[i + 1].startsWith(' '), `续行要缩进到内容列，实际: ${JSON.stringify(lines[i + 1])}`);
});
