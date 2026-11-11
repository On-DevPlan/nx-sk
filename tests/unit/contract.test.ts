// 契约测试：钉住**面板与 agent 真正依赖的响应形状**。
//
// 为什么要有它：tests/unit/consistency.test.mjs 只查「路由是否存在」，不查返回什么。
// 字段注册表重构（docs/refactor-plan.md P2）会大面积改写内部实现，而序列化出口
// （core/render.js 的 serializeEntry / dumpSection）的形状一旦悄悄变了，
// 面板不会报错、CLI 也照跑，只有用户发现「某列没了」——所以先把形状钉死。
//
// 注意：这里**只断言键与关键语义**，不做逐字节快照。改字段名/删字段会红，
// 多一个字段不会红（加字段是兼容的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from '../helpers.mjs';

// 必须先指到临时 home，再加载任何读 paths 的模块（模块顶层会解析 ENV）。
await useTempHome('nx-sk-contract-');

const { FIELD_TYPES } = await import('../../src/core/fields.ts');
const { loadStore, saveStore } = await import('../../src/core/store.ts');
// 首次运行的播种只活在内存里（store.json 还不存在），每次 loadStore 都会重新播一份、
// 条目 id 也随之变化。先落盘一次，后面「先 list 再 get」才找得到同一条。
await saveStore(await loadStore());
const { bootstrapInfo } = await import('../../src/modules/system/service.ts');
const { listEntries, getEntry, addEntry } = await import('../../src/modules/entries/service.ts');
const { dump } = await import('../../src/modules/sections/service.ts');
const { listFiles } = await import('../../src/modules/files/service.ts');

const keysOf = (o: object) => Object.keys(o).sort();

test('bootstrap：顶层键与字段类型下发', async () => {
  const info = await bootstrapInfo();
  assert.deepEqual(keysOf(info), [
    'app', 'builtin', 'commands', 'corrupt', 'counts', 'envOverrides', 'fieldTypeLabels',
    'fieldTypes', 'home', 'migration', 'sections', 'settings', 'storePath', 'storePathRaw',
    'templates', 'vault',
  ]);
  // 「后端加了一种字段类型、面板下拉框看不到」由这条挡住：下发的就是唯一清单本身。
  assert.deepEqual([...info.fieldTypes], [...FIELD_TYPES]);
  for (const t of FIELD_TYPES) assert.equal(typeof info.fieldTypeLabels[t], 'string');
  assert.deepEqual(keysOf(info.counts), ['commands', 'entries', 'sections']);
  assert.deepEqual(keysOf(info.app), ['label', 'name', 'node', 'platform', 'version']);
  for (const s of info.sections) {
    assert.deepEqual(keysOf(s), [
      'description', 'entries', 'fields', 'id', 'kv', 'order', 'template', 'title', 'titleLabel',
    ]);
  }
});

test('section dump：字段字典 + 条目 + 完整度', async () => {
  const d = await dump('demo');
  for (const k of ['section', 'groups', 'layout', 'fields', 'count', 'entries', 'generatedAt', 'mask', 'groupIndex']) {
    assert.ok(k in d, `section dump 缺 ${k}`);
  }
  assert.deepEqual(keysOf(d.section), [
    'description', 'fields', 'id', 'kv', 'order', 'template', 'title', 'titleField', 'titleLabel',
  ]);
  assert.equal(typeof d.section.fields, 'number', 'section.fields 是数量（字段字典在顶层 fields）');
  for (const f of d.fields) {
    for (const k of ['key', 'label', 'type', 'group', 'hint', 'options', 'sensitive', 'fill', 'fillLabel']) {
      assert.ok(k in f, `字段定义缺 ${k}: ${f.key}`);
    }
  }
  // 全类型覆盖：demo 栏目是「每种类型各一格」，少了就说明类型清单与播种漂移了
  const types = new Set(d.fields.map((f: any) => f.type));
  for (const t of FIELD_TYPES) assert.ok(types.has(t), `demo 栏目缺类型 ${t}`);

  const fieldKeys = d.fields.map((f: any) => f.key).sort();
  for (const e of d.entries) {
    // 条目上除下列键外只允许 `tables`（表格现值，按需附带）
    // #20：`detachedFields`（已脱离模板字段清单）随 serializeEntry 恒输出
    assert.deepEqual(keysOf(e), [
      'completeness', 'createdAt', 'detachedFields', 'entryFields', 'excluded', 'id', 'missing', 'section',
      ...(e.tables ? ['tables'] : []), 'tags', 'title', 'updatedAt', 'values',
    ].sort());
    assert.deepEqual(Object.keys(e.values).sort(), fieldKeys, 'values 的键集必须恒等于字段字典');
    assert.deepEqual(keysOf(e.completeness), ['excluded', 'excludedFilled', 'filled', 'ratio', 'total']);
    // 类型收紧（TODO(P5)，见 docs/refactor-plan.md 的 P5）的运行时兜底：这三项是
    // SerializedEntry 永远存在的字段；即便类型暂时标成可选，dumpSection 出去也必须真有。
    assert.equal(typeof e.id, 'string');
    assert.ok(e.id.length > 0, '条目 id 不能为空');
    assert.equal(typeof e.values, 'object');
    assert.ok(e.values !== null, '条目 values 不能为 null');
    assert.equal(typeof e.completeness.ratio, 'number', '条目必须有 completeness.ratio');
  }
});

test('entry list：count / total / entries', async () => {
  const d = await listEntries({ section: 'demo' });
  assert.deepEqual(keysOf(d), ['count', 'entries', 'total']);
  assert.equal(typeof d.count, 'number');
  assert.equal(typeof d.total, 'number');
  assert.ok(d.entries.length > 0);
  for (const e of d.entries) {
    assert.ok(e.id);
    assert.equal(e.section, 'demo');
    assert.equal(e.sectionTitle, '字段样例');
  }
});

test('entry get：values / fieldTypes / entryFields / tables / files', async () => {
  const list = await listEntries({ section: 'demo' });
  // 被调模块还是 JS（P4 才迁），推断类型很薄；契约测试关心的是运行时形状，边界处放宽。
  const e: any = await getEntry(list.entries[0].id);
  for (const k of ['values', 'fieldTypes', 'entryFields', 'tables', 'files', 'mask', 'sectionTitle', 'completeness']) {
    assert.ok(k in e, `entry get 缺 ${k}`);
  }
  assert.deepEqual(keysOf(e.fieldTypes), keysOf(e.values));
  assert.equal(e.fieldTypes.sheet, 'table');
  assert.equal(e.fieldTypes.accounts, 'entrylist');
  assert.ok(e.entryFields.accounts, '结构清单必须带列定义');
  assert.ok(e.tables.sheet, '表格必须带现值（计算列/统计在读时现算）');
  for (const c of e.tables.sheet.columns) {
    for (const k of ['key', 'label', 'type']) assert.ok(k in c, `表格列缺 ${k}`);
  }
});

test('file list：分页与未引用', async () => {
  const d = await listFiles({});
  for (const k of ['count', 'total', 'totalBytes', 'unlinked', 'root', 'rootRaw', 'sections', 'page', 'files']) {
    assert.ok(k in d, `file list 缺 ${k}`);
  }
  assert.deepEqual(keysOf(d.page), ['count', 'hasMore', 'limit', 'offset', 'total']);
});

test('全类型往返：每种类型都能写入并原样读回', async () => {
  // 取播种条目的值当「每种类型的最小合法值」：播种值就是按 serializeEntry/normalize 的形状写的。
  const seeded = await listEntries({ section: 'demo' });
  const first: any = await getEntry(seeded.entries[0].id);
  const values = first.values;

  // 经 addEntry 走一遍 normalize（每种类型的 coerce 分派点），再读回。
  const created = await addEntry({ section: 'demo', title: '往返测试条目', data: JSON.parse(JSON.stringify(values)) });
  const read: any = await getEntry(created.id);
  const fieldKeys = Object.keys(values).sort();
  assert.deepEqual(Object.keys(read.values).sort(), fieldKeys);

  for (const key of fieldKeys) {
    const type = read.fieldTypes[key];
    const before = values[key];
    const after = read.values[key];
    if (before === null) continue;
    if (type === 'table') {
      assert.deepEqual(Object.keys(after.columns), Object.keys(before.columns));
      assert.equal(after.rows.length, before.rows.length);
      continue;
    }
    assert.deepEqual(after, before, `${type} 字段 ${key} 往返后变了`);
  }
});

