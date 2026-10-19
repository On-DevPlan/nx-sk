import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { validateFieldDef } = sections;
const { loadStore } = await import('../../src/core/store.js');
const { readZip } = await import('../../src/core/zip.js');
const { isCipherBlob, maskValue } = await import('../../src/core/crypto.js');

// entrylist（结构清单）字段：值 = 变长的行对象数组，列在字段定义的 fields 里声明。
// 敏感列与顶层敏感字段同一条边界：密文落盘、默认原文、--mask 打码。

const COLS = [
  { key: 'name', label: '名称' },
  { key: 'url', label: '链接' },
  { key: 'user', label: '账号' },
  { key: 'pass', label: '密码', sensitive: true },
];

async function setupSection(id = 'svcs') {
  await sections.addSection({ id, title: '服务', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection(id, {
    'add-field': { key: 'accounts', label: '账号清单', type: 'entrylist', group: 'main', fields: COLS },
  });
}

test('validateFieldDef：entrylist 必须声明列，列 key 非法/重复要报错', () => {
  assert.throws(() => validateFieldDef({ key: 'a', label: 'A', type: 'entrylist' }), /fields/);
  assert.throws(() => validateFieldDef({ key: 'a', label: 'A', type: 'entrylist', fields: [] }), /fields/);
  // 空 key 被 assertFieldKey 挡下；「1x」这类是合法 key（字段 key 刻意宽松，中文都行）
  assert.throws(
    () => validateFieldDef({ key: 'a', label: 'A', type: 'entrylist', fields: [{ key: '', label: 'X' }] }),
    /key/,
  );
  assert.throws(
    () => validateFieldDef({ key: 'a', label: 'A', type: 'entrylist', fields: [{ key: 'x' }, { key: 'x' }] }),
    /重复/,
  );
  // 非 entrylist 声明 fields 一律拒绝——字典里不该有「定义了也用不上」的键
  assert.throws(() => validateFieldDef({ key: 'b', label: 'B', type: 'text', fields: [{ key: 'x' }] }), /entrylist/);

  const def = validateFieldDef({ key: 'c', label: 'C', type: 'entrylist', fields: [{ key: 'pass', sensitive: true }] });
  assert.equal(def.fields[0].label, 'pass', '列 label 缺省取 key');
  assert.equal(def.fields[0].sensitive, true);
});

test('写入读回：行结构不变、全空行剔除，敏感列密文落盘、默认读原文', async () => {
  await setupSection();
  await entries.addEntry({
    section: 'svcs',
    title: '容器平台',
    data: {
      accounts: [
        { name: '主控台', url: 'https://console.example.com', user: 'ops', pass: 'p@ss-明文1' },
        { user: '   ' },
        { name: '', url: '' },
      ],
    },
  });
  const got = await entries.getEntry('容器平台', { section: 'svcs' });
  assert.deepEqual(got.values.accounts, [
    { name: '主控台', url: 'https://console.example.com', user: 'ops', pass: 'p@ss-明文1' },
  ], '空行剔除；默认读出原文');

  // 落盘形状：敏感列是密文对象，其余是明文
  const store = await loadStore();
  const raw = store.entries.find((e) => e.title === '容器平台').values.accounts[0];
  assert.ok(isCipherBlob(raw.pass), '敏感子值必须密文落盘');
  assert.equal(raw.user, 'ops');
});

test('--mask 打码敏感列；打码占位回传保留原密文；对不上的占位要报错', async () => {
  const masked = await entries.getEntry('容器平台', { section: 'svcs', mask: true });
  assert.equal(masked.values.accounts[0].pass, maskValue('p@ss-明文1'));

  // 面板把打码值原样回传 = 不修改：密文必须原样保留，而不是把掩码存成新密码
  await entries.updateEntry('容器平台', {
    section: 'svcs',
    set: { accounts: [{ name: '主控台-改名', url: 'https://console.example.com', user: 'ops2', pass: masked.values.accounts[0].pass }] },
  });
  const store = await loadStore();
  const row = store.entries.find((e) => e.title === '容器平台').values.accounts[0];
  assert.ok(isCipherBlob(row.pass), '占位回传后仍是原密文');
  assert.equal(row.name, '主控台-改名');

  // 占位与现有密文对不上：多半是「想改密码却只拷了打码值」，当场报错
  await assert.rejects(
    entries.updateEntry('容器平台', { section: 'svcs', set: { accounts: [{ user: 'x', pass: 'ab******yz' }] } }),
    /打码占位/,
  );
});

test('--set 走 JSON 串写法；空串 = 清空', async () => {
  await entries.updateEntry('容器平台', {
    section: 'svcs',
    set: { accounts: JSON.stringify([{ name: '备份入口', user: 'bak' }]) },
  });
  let got = await entries.getEntry('容器平台', { section: 'svcs' });
  assert.deepEqual(got.values.accounts, [{ name: '备份入口', user: 'bak' }]);

  await entries.updateEntry('容器平台', { section: 'svcs', set: { accounts: '' } });
  got = await entries.getEntry('容器平台', { section: 'svcs' });
  assert.equal(got.values.accounts, null);

  await assert.rejects(
    entries.updateEntry('容器平台', { section: 'svcs', set: { accounts: '不是JSON' } }),
    /entrylist/,
  );
});

test('没登记过的键直接写行数组：自动登记成 entrylist 并从行推断列', async () => {
  await entries.addEntry({
    section: 'svcs',
    title: '对象存储',
    data: { links: [{ url: 'https://oss.example.com', note: '控制台' }] },
  });
  const dict = await entries.fieldDictionary({ section: 'svcs' });
  const f = dict.sections[0].fields.find((x) => x.key === 'links');
  assert.equal(f.type, 'entrylist');
  assert.deepEqual(f.fields.map((s) => s.key), ['url', 'note'], '列从行键推断，agent 之后知道行里允许哪些键');

  await assert.rejects(
    entries.updateEntry('对象存储', { section: 'svcs', data: { links: [{ url: 'x', 拼错: 'y' }] } }),
    /没有子字段/,
  );
});

test('dump 的字段字典带列定义；空清单 = 未填，有行 = 已填', async () => {
  const dump = await sections.dump('svcs');
  const f = dump.fields.find((x) => x.key === 'accounts');
  assert.deepEqual(f.fields.map((s) => s.key), ['name', 'url', 'user', 'pass']);
  // 上面的用例把容器平台的 accounts 清空了：清单空 = 未填（null）
  const cleared = dump.entries.find((e) => e.title === '容器平台');
  assert.equal(cleared.values.accounts, null);
  const filled = dump.entries.find((e) => e.title === '对象存储');
  assert.ok(filled.values.links, '有行的清单不是未填');
});

test('CLI 渲染：清单一行一条，用列标签；--mask 时敏感列跟着打码', async () => {
  await entries.updateEntry('容器平台', {
    section: 'svcs',
    data: { accounts: [{ name: '主控台', url: 'https://console.example.com', user: 'ops', pass: 'p@ss-重填2' }] },
  });
  const got = await entries.getEntry('容器平台', { section: 'svcs' });
  const out = entries.renderEntryGet(got);
  assert.match(out, /名称=主控台 · 链接=https:\/\/console\.example\.com · 账号=ops · 密码=p@ss-重填2/, out);

  const masked = await entries.getEntry('容器平台', { section: 'svcs', mask: true });
  const maskedOut = entries.renderEntryGet(masked);
  assert.ok(maskedOut.includes(maskValue('p@ss-重填2')), maskedOut);
  assert.ok(!maskedOut.includes('p@ss-重填2'), '打码模式下原文不能泄漏');
});

test('模板漂移把列定义算进去（列变了要报，别无声分叉）', async () => {
  const { fieldDrift } = await import('../../src/core/fields.js');
  const mine = { key: 'accounts', label: '账号清单', type: 'entrylist', fields: COLS };
  assert.deepEqual(fieldDrift(mine, { ...mine, fields: COLS.map((c) => ({ ...c })) }), [], '等价定义不算漂移');
  const diff = fieldDrift(mine, { ...mine, fields: COLS.map((c) => ({ ...c, sensitive: true })) });
  assert.ok(diff.includes('fields'), `列的 sensitive 变了必须报: ${diff}`);
});

test('导出包里的清单敏感列是明文（密文对象进了包就再也解不开了）', async () => {
  const transfer = await import('../../src/modules/transfer/service.js');
  const { join } = await import('node:path');
  const { readFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'nx-sk-export-'));
  const out = join(dir, 'svcs.zip');
  await transfer.exportToFile('svcs', { out });
  const zip = await readFile(out);
  const manifest = JSON.parse(readZip(zip).find((e) => e.name === 'manifest.json').data.toString());
  const entry = manifest.entries.find((e) => e.title === '容器平台');
  assert.equal(entry.values.accounts[0].pass, 'p@ss-重填2');
  assert.equal(entry.values.accounts[0].user, 'ops');
});
