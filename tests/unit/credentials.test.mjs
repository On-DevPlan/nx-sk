import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { loadStore } = await import('../../src/core/store.js');
const { isCipherBlob, maskValue } = await import('../../src/core/crypto.js');
const { getTemplate, looksSecretish } = await import('../../src/core/fields.js');

// 凭据自动化：**大胆写**，但落盘是密文。
//
// 这组用例钉的是 nx-sk 的核心姿态：agent 可以一把 `--set 密码=…` 写进栏目，
// 不必先声明 schema、不必绕回「密钥」栏目；而这把密码落盘即 AES-256-GCM 密文。

test('自动登记的凭据键直接建成密文字段：落盘无明文、读回是原文', async () => {
  await sections.addSection({ id: 'cloud', title: '我的云平台' });
  await entries.addEntry({
    section: 'cloud',
    title: '阿里云',
    set: { 账号: 'ops@example.com', 密码: 'P@ssw0rd-明文', AccessKeyId: 'LTAI5t-明文' },
  });

  // 落盘：三个值都是密文对象，明文一个都不许出现
  const store = await loadStore();
  const values = store.entries.find((e) => e.title === '阿里云').values;
  for (const k of ['账号', '密码', 'AccessKeyId']) {
    assert.ok(isCipherBlob(values[k]), `${k} 落盘必须是密文`);
  }
  const raw = JSON.stringify(store);
  assert.ok(!raw.includes('P@ssw0rd-明文'), '明文密码不许进 store.json');
  assert.ok(!raw.includes('LTAI5t-明文'), '明文 AccessKey 不许进 store.json');

  // 读回：默认原文（自己看的东西不拦一道）
  const got = await entries.getEntry('阿里云', { section: 'cloud' });
  assert.equal(got.values.密码, 'P@ssw0rd-明文');
  assert.equal(got.values.AccessKeyId, 'LTAI5t-明文');

  // 投屏时打码
  const masked = await entries.getEntry('阿里云', { section: 'cloud', mask: true });
  assert.equal(masked.values.密码, maskValue('P@ssw0rd-明文'));
});

test('不像凭据的键仍然是普通字段（别把普通数据全加密成噪音）', async () => {
  await sections.addSection({ id: 'plain', title: '普通栏目' });
  await entries.addEntry({ section: 'plain', title: '甲', set: { 技术博客: 'https://example.com' } });
  const dict = await entries.fieldDictionary({ section: 'plain' });
  const f = dict.sections[0].fields.find((x) => x.key === '技术博客');
  assert.equal(f.type, 'text');
});

test('looksSecretish：凭据关键词命中，普通词不命中', () => {
  for (const k of ['密码', '口令', '密钥', '账号', 'token', 'apiKey', 'access_key', 'password', 'secretKey', 'key']) {
    assert.ok(looksSecretish(k), `${k} 应当被当成凭据`);
  }
  for (const k of ['技术博客', '姓名', '城市', '端口', 'monkey', 'keyboard']) {
    assert.ok(!looksSecretish(k), `${k} 不该被当成凭据`);
  }
});

test('结构清单的行可以用**列 label** 写（与顶层 --set 同一口径），并归到列 key 下', async () => {
  await sections.addSection({ id: 'svcs2', title: '服务' });
  await sections.updateSection('svcs2', {
    'add-field': {
      key: 'accounts',
      label: '账号清单',
      type: 'entrylist',
      group: 'main',
      fields: [
        { key: 'name', label: '名称' },
        { key: 'user', label: '账号' },
        { key: 'pass', label: '密码', sensitive: true },
      ],
    },
  });
  await entries.addEntry({
    section: 'svcs2',
    title: '主控台',
    data: { 账号清单: [{ 名称: '生产', 账号: 'ops', 密码: 'p@ss-明文' }] },
  });

  const got = await entries.getEntry('主控台', { section: 'svcs2' });
  assert.deepEqual(got.values.accounts, [{ name: '生产', user: 'ops', pass: 'p@ss-明文' }],
    'label 写入后归到列 key 下；敏感列读回是原文');

  const store = await loadStore();
  const row = store.entries.find((e) => e.title === '主控台').values.accounts[0];
  assert.ok(isCipherBlob(row.pass), '敏感列密文落盘');
  assert.equal(row.user, 'ops');
});

test('deploy 模板自带「凭据清单」：场景凭据写在场景栏目里，不进密钥栏目', async () => {
  const tpl = getTemplate('deploy');
  const creds = tpl.fields.find((f) => f.key === 'creds');
  assert.ok(creds, 'deploy 模板要有凭据清单字段');
  assert.equal(creds.type, 'entrylist');
  const passCol = creds.fields.find((c) => c.key === 'pass');
  const tokenCol = creds.fields.find((c) => c.key === 'token');
  assert.equal(passCol.sensitive, true, '密码列必须密文落盘');
  assert.equal(tokenCol.sensitive, true, '令牌列必须密文落盘');
  assert.ok(tpl.groups.some((g) => g.id === creds.group), '凭据字段所属分组必须在模板里声明');
});

test('entry keys 台账要看得见清单里的凭据（否则「一条命令看全部凭据」是假的）', async () => {
  await sections.addSection({ id: 'plat', title: '平台' });
  await sections.updateSection('plat', {
    'add-field': {
      key: 'creds',
      label: '凭据清单',
      type: 'entrylist',
      group: 'main',
      fields: [
        { key: 'name', label: '名称' },
        { key: 'user', label: '账号' },
        { key: 'pass', label: '密码', sensitive: true },
      ],
    },
  });
  await entries.addEntry({
    section: 'plat',
    title: '生产集群',
    set: { AccessKeyId: 'AK-明文' },
    data: { 凭据清单: [{ 名称: '控制台', 账号: 'ops', 密码: 'p@ss-明文' }] },
  });

  const masked = await entries.keysLedger({});
  const keys = masked.items.map((x) => x.key);
  assert.ok(keys.includes('creds.pass'), `清单里的密码要出现在台账里: ${keys.join('、')}`);
  assert.ok(keys.includes('AccessKeyId'), `顶层密文字段要出现在台账里: ${keys.join('、')}`);
  // 打码后不许露出**完整**的凭据（长值保留首尾 4 位是打码规则本身，不是泄漏）
  for (const secret of ['p@ss-明文', 'AK-明文', 'P@ssw0rd-明文', 'LTAI5t-明文']) {
    assert.ok(!masked.items.some((x) => String(x.value).includes(secret)),
      `打码后的台账泄露了完整凭据「${secret}」`);
  }

  const revealed = await entries.keysLedger({ reveal: true });
  const pass = revealed.items.find((x) => x.key === 'creds.pass');
  assert.equal(pass.value, 'p@ss-明文', '--reveal 出原文');
  assert.equal(pass.sensitive, true);
  assert.match(pass.label, /控制台/, '标签要带上清单行的名称，看得出是哪一组');
});

// 播种不再自带密钥栏目：第一次 key set 自动补建一个（写路径建，读路径不建）。
test('没有 KV 栏目时 key set 自动补建 secret（读命令不建）', async () => {
  const before = await loadStore();
  assert.equal(before.sections.some((s) => s.kv), false, '这个用例的前提：没有任何 KV 栏目');

  // 读命令不建：报「还没有 KV 栏目」而不是悄悄建一个空栏目
  await assert.rejects(() => entries.keyList({}), /还没有 KV 栏目/);
  assert.equal((await loadStore()).sections.some((s) => s.kv), false);

  // 写命令建：key set 的语义是「我要存」
  const r = await entries.keySet('DEMO_KEY', 'sk-demo-123', {});
  assert.equal(r.createdKv, true, '第一次 key set 应顺手把 KV 栏目建出来');
  const after = await loadStore();
  const kv = after.sections.find((s) => s.kv);
  assert.equal(kv.id, 'secret');
  assert.equal(kv.fields.length, 1, '与 secret 模板同形状（单字段 KV）');

  // 值已经写进去了，且是密文
  const got = await entries.keyGet('DEMO_KEY', {});
  assert.equal(got.value, 'sk-demo-123');
  const raw = after.entries.find((e) => e.section === kv.id);
  assert.ok(isCipherBlob(raw.values.value), '密文落盘');
});
