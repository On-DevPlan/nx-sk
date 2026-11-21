import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { applySpec, argSpecsOf, cliPathsOf, compileRoute, compareRoutes, flagSpecsOf, usageOf } = await import('../../src/runtime/spec.ts');
const { loadStore, migrationNote, normalize, STORE_VERSION } = await import('../../src/core/store.ts');
const { FIELD_TYPES, seedEntries, seedTemplates } = await import('../../src/core/fields.ts');
const { computeTable } = await import('../../src/shared/table.ts');

const FAKE = {
  id: 'x.y',
  cli: ['x', 'y'],
  args: ['ref', { name: 'opt', required: false }],
  flags: {
    name: { type: 'string' },
    count: { type: 'number', default: 3 },
    flag: { type: 'boolean' },
    list: { type: 'array' },
    set: { type: 'kv' },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
  run: () => null,
};

test('usageOf 生成完整用法串，布尔 flag 不取值、enum 展开为候选项', () => {
  const u = usageOf(FAKE);
  assert.match(u, /^nx-sk x y <ref> \[opt\]/);
  assert.match(u, /\[--flag\]/);
  assert.match(u, /\[--mode <a\|b>\]/);
  assert.doesNotMatch(u, /\[--flag </, '布尔 flag 不该带取值占位符');
});

test('applySpec：位置参数按 args 顺序具名，多余/缺失都报错并带用法锚点', () => {
  const ctx = applySpec(FAKE, { ref: 'abc' });
  assert.equal(ctx.ref, 'abc');
  assert.equal(ctx.count, 3, '写命令的 default 应被注入');

  assert.throws(() => applySpec(FAKE, {}), (e) => e.code === 'INVALID_INPUT' && e.message.includes('用法:'));
  const withOptional = applySpec(FAKE, { ref: 'a', opt: 'b' });
  assert.equal(withOptional.opt, 'b', '可空位置参数应能绑上');
});

test('applySpec：强转与 enum 校验', () => {
  const ctx = applySpec(FAKE, { ref: 'a', count: '7', flag: 'true', list: 'x,y', set: ['k=v', 'k2=v2'] });
  assert.equal(ctx.count, 7);
  assert.equal(ctx.flag, true);
  assert.deepEqual(ctx.list, ['x', 'y']);
  assert.deepEqual(ctx.set, { k: 'v', k2: 'v2' });
  assert.throws(() => applySpec(FAKE, { ref: 'a', count: 'abc' }), /需要数字/);
  assert.throws(() => applySpec(FAKE, { ref: 'a', mode: 'zzz' }), /只能是/);
});

test('applySpec：未声明的键被丢弃（HTTP body 里的多余字段不该流进 service）', () => {
  const ctx = applySpec(FAKE, { ref: 'a', somethingElse: 'leak' });
  assert.equal('somethingElse' in ctx, false);
});

test('flagSpecsOf / argSpecsOf 归一化字符串写法', () => {
  assert.deepEqual(argSpecsOf({ args: ['a'] }), [{ name: 'a', required: true }]);
  assert.equal(flagSpecsOf({ flags: { f: { type: 'boolean' } } })[0].type, 'boolean');
  assert.deepEqual(cliPathsOf({ cli: [['a', 'b'], ['c', 'd']] }), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(cliPathsOf({ cli: ['a', 'b'] }), [['a', 'b']]);
});

test('compileRoute：路径占位符进 keys，正则能匹配实例', () => {
  const r = compileRoute(['DELETE', '/api/entries/:ref']);
  assert.equal(r.method, 'DELETE');
  assert.deepEqual(r.keys, ['ref']);
  assert.ok(r.regex.test('/api/entries/e_abc123'));
  assert.ok(!r.regex.test('/api/entries/a/b'), '不能跨段匹配');
});

test('compareRoutes：字面量段优先，声明顺序不影响匹配（遮蔽是静默 bug）', () => {
  const literal = { ...compileRoute(['GET', '/api/templates/presets']) };
  const param = { ...compileRoute(['GET', '/api/templates/:ref']) };
  const longer = { ...compileRoute(['GET', '/api/templates/:ref/dump']) };

  const sorted = [param, literal, longer].sort(compareRoutes);
  assert.equal(sorted[0].path, '/api/templates/presets', '字面量必须排最前');
  assert.ok(sorted.indexOf(longer) < sorted.indexOf(param), '段数多的更具体的排在笼统的之前');

  // 反面对照：按声明顺序匹配的话，先声明的 :ref 会把 templates 吃掉
  const naive = [param, literal].find((r) => r.regex.test('/api/templates/presets'));
  assert.equal(naive.path, '/api/templates/:ref', '这就是不加排序会踩的坑');
});

test('normalize：store 文件不存在才播种（只播「字段样例」一个条目模板 + 一条示例条目）；删光了不复活', () => {
  const fresh = normalize(null);
  assert.equal(fresh.templates.filter((s) => !s.blank).length, 1, '不再播种一堆场景条目模板——第一屏是「字段样例」说明书');
  assert.equal(fresh.templates.find((s) => s.id === 'demo').id, 'demo');
  assert.equal(fresh.entries.length, 1, '示例条目跟着播种，否则那些字段只是空格子');
  assert.equal(fresh.entries[0].template, 'demo');
  assert.equal(fresh.settings.defaultTemplate, 'demo');

  const emptied = normalize({ version: 1, settings: {}, templates: [], entries: [] });
  assert.deepEqual(emptied.templates.filter((s) => !s.blank), [], '用户删光了条目模板就不该再播种——否则等于删不掉');
  assert.equal(emptied.templates.some((s) => s.blank), true, '空白模板是内置底座，永远在');
});

test('loadStore：损坏的 store.json 会被挪走，而不是被下次写入覆盖', async () => {
  const dir = process.env.NX_SK_HOME;
  const fsp = await import('node:fs/promises');
  const { join } = await import('node:path');
  const p = join(dir, 'store.json');
  await fsp.writeFile(p, '{ 这不是合法 JSON', 'utf8');

  const store = await loadStore();
  assert.equal(store.entries.length, 1, '恢复 = 重新播种：字段样例 + 它的示例条目');
  const files = await fsp.readdir(dir);
  assert.ok(files.some((f) => f.includes('.corrupt-')), `损坏文件应被保留一份：${files.join(', ')}`);
  assert.ok(!files.includes('store.json'), '损坏文件应从原位置移走');
});

test('seedTemplates：只播「字段样例」，且把**每种**字段类型都摆出来', () => {
  const [demo] = seedTemplates('2026-01-01T00:00:00.000Z');
  assert.equal(demo.id, 'demo');
  const types = new Set(demo.fields.map((x) => x.type));
  for (const t of FIELD_TYPES) {
    if (t === 'secret') continue; // 密文要密钥，播种给不了真值，但类型仍要出现
    assert.ok(types.has(t), `样例条目模板应包含 ${t} 字段`);
  }
  assert.ok(types.has('secret'), 'secret 也在（值留空）');
  assert.ok(demo.fields.length >= FIELD_TYPES.length, `至少每种类型一个，实际 ${demo.fields.length}`);
  assert.equal(demo.titleField, 'name');

  // 示例条目的表格值要能真的算起来（播种直接写 store，不走写入校验）
  const sheet = demo.fields.find((x) => x.key === 'sheet');
  const entry = seedEntries('2026-01-01T00:00:00.000Z')[0];
  const t = computeTable(sheet, entry.values.sheet);
  assert.equal(t.errorCount, 0, `示例表格不该有公式错误：${JSON.stringify(t.errors)}`);
  assert.equal(t.count, 2);
  assert.ok(t.totals.length >= 1, '表尾要有统计');
});

test('v1 → v3 迁移：密钥条目模板缩成单值字段，旧值不删，且留迁移前的原始文件', async () => {
  // 0.36 起旧 JSON 兼容只发生在**首启导入**：切一个全新 home（db 还不存在），
  // 写一份 v1 的 store.json → loadStore 触发导入 + 迁移 + 改名留证。
  const fsp = await import('node:fs/promises');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'nx-sk-v13-'));
  process.env.NX_SK_HOME = dir;
  process.env.NX_SK_STORE = join(dir, 'store.json');
  process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');
  const p = process.env.NX_SK_STORE;

  const v1 = {
    version: 1,
    settings: {},
    templates: [{
      id: 'secret', title: '密钥', description: 'old', order: 20, template: 'secret',
      titleField: 'provider', titleLabel: '密钥名',
      groups: [{ id: 'key', title: '密钥信息' }],
      fields: [
        { key: 'provider', label: '服务商', type: 'select', group: 'key' },
        { key: 'keyValue', label: '密钥值', type: 'secret', group: 'key' },
        { key: 'model', label: '模型标识', type: 'text', group: 'key' },
      ],
    }],
    entries: [{
      id: 'e_old', template: 'secret', title: 'OpenAI', tags: [],
      values: { provider: 'OpenAI', keyValue: 'sk-old-123', model: 'gpt-4o' },
    }],
  };
  await fsp.writeFile(p, JSON.stringify(v1, null, 2), 'utf8');

  const migrated = await loadStore();
  const sec = migrated.templates.find((x) => x.id === 'secret');
  assert.equal(migrated.version, STORE_VERSION, '迁移后版本号必须落到当前版本，否则每次读都会重跑');
  assert.deepEqual(sec.fields.map((f) => f.key), ['key', 'value', 'source', 'sourceGroup'], '字典缩成一个 value 字段，并保留原始资料袋');
  assert.equal('kv' in sec, false, '模板对象里不再有 KV 特例字段');
  assert.equal(sec.titleField, null);
  assert.equal(sec.titleLabel, '条目名');
  assert.equal(migrated.entries[0].values.value, 'sk-old-123', 'keyValue 的值要搬到 value');
  assert.equal(migrated.entries[0].values.model, 'gpt-4o', '其它旧值**不能删**——不再显示 ≠ 删掉');
  assert.equal(migrated.entries[0].values.provider, 'OpenAI');

  const note = migrationNote();
  assert.ok(note && note.from === 1 && note.to === STORE_VERSION, '迁移要留可展示的记录（from → to 都要有）');
  const snap = await fsp.readFile(note.snapshotRaw, 'utf8');
  assert.equal(JSON.parse(snap).version, 1, '留证文件必须是**迁移前**的原始文件，否则退回也没用');

  // 导入成功后 store.json 改名留证（不删除）；DB 成为唯一真相
  const files = await fsp.readdir(dir);
  assert.ok(!files.includes('store.json'), 'store.json 应从原位置挪走');
  assert.ok(files.some((f) => f.startsWith('store.json.imported-')), `应留 imported 证据：${files.join(', ')}`);
  assert.ok(files.includes('nxsk.db'), '迁移结果必须落库（幂等靠这个）');

  const before = files.filter((f) => f.startsWith('store.json.imported-')).length;
  await loadStore();
  const after = (await fsp.readdir(dir)).filter((f) => f.startsWith('store.json.imported-')).length;
  assert.equal(after, before, '第二次读不该再迁移、再多留一份副本');
});

test('没有条目模板可迁时不会瞎迁，版本号照常落到当前', () => {
  const s = normalize({ version: 2, settings: {}, templates: [], entries: [] });
  assert.equal(s._migration, undefined);
  assert.equal(s.version, STORE_VERSION);
});

test('v2 → v3：误当字段用的键值搬进值列，多余字段收掉，旧键不删', () => {
  // 复刻真实事故：面板那行「KV 直填」在密钥条目模板里把 `3123312=xxx` 当成**新字段**登记了，
  // 于是条目模板字段变成 [value, 089, 3123312]，用户看到的是一堆无意义的「模板建议」。
  const v2 = {
    version: 2,
    settings: { kvTemplate: 'secret' },
    templates: [{
      id: 'secret', title: '密钥', description: 'old', order: 20, template: 'secret',
      titleField: null, titleLabel: '密钥名',
      groups: [{ id: 'key', title: '密钥信息' }],
      fields: [
        { key: 'value', label: '密钥值', type: 'secret', group: 'key' },
        { key: '089', label: '089', type: 'text', group: 'key' },
        { key: '3123312', label: '3123312', type: 'text', group: 'key' },
      ],
    }],
    entries: [
      { id: 'e_a', template: 'secret', title: '3123', tags: [], values: { '3123312': 'sk-typed-here' } },
      { id: 'e_b', template: 'secret', title: '3333', tags: [], values: {} },
    ],
  };
  const s = normalize(v2);
  const sec = s.templates.find((x) => x.id === 'secret');

  assert.deepEqual(sec.fields.map((f) => f.key), ['key', 'value', 'source', 'sourceGroup'], '字段收成一个值字段');
  assert.equal('kv' in sec, false, '模板对象里不再有 KV 特例字段');
  assert.equal(s.settings.kvTemplate, undefined, 'v3 起 kvTemplate 这个冗余设置被清掉');

  const a = s.entries.find((e) => e.id === 'e_a');
  assert.equal(a.values.value, 'sk-typed-here', '那个「字段值」其实是用户想存的值，搬进 value');
  assert.equal(a.values['3123312'], 'sk-typed-here', '原键保留（不再显示 ≠ 删掉）');

  const b = s.entries.find((e) => e.id === 'e_b');
  assert.equal(b.values.value, undefined, '空条目不动 —— 迁移不凭空造值');
});

test('已经标了 kv 的旧条目模板再读只做普通归一，不会重复迁移', () => {
  const base = { id: 'secret', title: '密钥', kv: true, fields: [{ key: 'value', label: '密钥值', type: 'secret', group: 'key' }], groups: [{ id: 'key', title: 'K' }] };
  const s = normalize({ version: 3, settings: {}, templates: [base], entries: [] });
  assert.equal(s._migration, undefined);
  const secret = s.templates.find((x) => x.id === 'secret');
  assert.equal('kv' in secret, false, '旧 kv:true 在运行时完全退役');
  assert.ok(secret.fields.some((f) => f.key === 'value' && f.type === 'secret'), '旧单值字段仍可被 key 的 legacy 模式读写');
});

