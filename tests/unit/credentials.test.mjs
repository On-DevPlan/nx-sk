import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const templates = await import('../../src/modules/templates/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const { loadStore } = await import('../../src/core/store.ts');
const { isCipherBlob, maskValue } = await import('../../src/core/crypto.ts');
const { getTemplate, looksSecretish } = await import('../../src/core/fields.ts');

// 凭据自动化：**大胆写**，但落盘是密文。
//
// 这组用例钉的是 nx-sk 的核心姿态：agent 可以一把 `--set 密码=…` 写进条目模板，
// 不必先声明 schema、不必绕回「密钥」条目模板；而这把密码落盘即 AES-256-GCM 密文。

test('自动登记的凭据键直接建成密文字段：落盘无明文、读回是原文', async () => {
  await templates.addTemplate({ id: 'cloud', title: '我的云平台' });
  await entries.addEntry({
    template: 'cloud',
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
  const got = await entries.getEntry('阿里云', { template: 'cloud' });
  assert.equal(got.values.密码, 'P@ssw0rd-明文');
  assert.equal(got.values.AccessKeyId, 'LTAI5t-明文');

  // 投屏时打码
  const masked = await entries.getEntry('阿里云', { template: 'cloud', mask: true });
  assert.equal(masked.values.密码, maskValue('P@ssw0rd-明文'));
});

test('不像凭据的键仍然是普通字段（别把普通数据全加密成噪音）', async () => {
  await templates.addTemplate({ id: 'plain', title: '普通条目模板' });
  await entries.addEntry({ template: 'plain', title: '甲', set: { 技术博客: 'https://example.com' } });
  const dict = await entries.fieldDictionary({ template: 'plain' });
  const f = dict.templates[0].fields.find((x) => x.key === '技术博客');
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
  await templates.addTemplate({ id: 'svcs2', title: '服务' });
  await templates.updateTemplate('svcs2', {
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
    template: 'svcs2',
    title: '主控台',
    data: { 账号清单: [{ 名称: '生产', 账号: 'ops', 密码: 'p@ss-明文' }] },
  });

  const got = await entries.getEntry('主控台', { template: 'svcs2' });
  assert.deepEqual(got.values.accounts, [{ name: '生产', user: 'ops', pass: 'p@ss-明文' }],
    'label 写入后归到列 key 下；敏感列读回是原文');

  const store = await loadStore();
  const row = store.entries.find((e) => e.title === '主控台').values.accounts[0];
  assert.ok(isCipherBlob(row.pass), '敏感列密文落盘');
  assert.equal(row.user, 'ops');
});

test('deploy 模板自带「凭据清单」：场景凭据写在场景条目模板里，不进密钥条目模板', async () => {
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
  await templates.addTemplate({ id: 'plat', title: '平台' });
  await templates.updateTemplate('plat', {
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
    template: 'plat',
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

// 播种不再自带密钥条目模板：第一次 key set 自动补建 secret（写路径建，读路径不建）。
// 密钥是普通 entrylist 字段，不再是 kv:true 的「表」。
test('没有密钥条目模板时 key set 自动补建 secret（读命令不建）', async () => {
  const before = await loadStore();
  assert.equal(before.templates.some((s) => s.kv), false, '这个用例的前提：没有任何 KV 条目模板');

  // 读命令不建：报「还没有密钥条目模板」而不是悄悄建一个空条目模板
  await assert.rejects(() => entries.keyList({}), /还没有密钥条目模板/);
  assert.equal((await loadStore()).templates.some((s) => s.kv), false);

  // 写命令建：key set 的语义是「我要存」
  const r = await entries.keySet('DEMO_KEY', 'sk-demo-123', {});
  assert.equal(r.createdTemplate, true, '第一次 key set 应顺手把 secret 条目模板建出来');
  const after = await loadStore();
  const sec = after.templates.find((s) => s.id === 'secret');
  assert.ok(sec);
  assert.equal('kv' in sec, false, 'secret 不再是 KV 表');
  const keys = sec.fields.find((f) => f.key === 'keys');
  assert.equal(keys.type, 'entrylist');
  assert.equal(keys.fields.find((f) => f.key === 'value').sensitive, true);

  // 值已经写进去了，且在字段行的密文列里
  const got = await entries.keyGet('DEMO_KEY', {});
  assert.equal(got.value, 'sk-demo-123');
  const holder = after.entries.find((e) => e.template === sec.id);
  assert.ok(holder, '密钥列表要有承载条目');
  assert.ok(isCipherBlob(holder.values.keys[0].value), '密文落盘');
});

test('key 多键写进同一个 keys 清单：list/get/remove 只动那一行，不删承载条目', async () => {
  await templates.addTemplate({ id: 'keybox2', title: '密钥清单2', preset: 'secret' });
  const opts = { template: 'keybox2' };
  const first = await entries.keySet('A_KEY', 'value-a', opts);
  const second = await entries.keySet('B_KEY', 'value-b', opts);
  assert.equal(first.createdEntry, true, '第一次 key set 建承载条目');
  assert.equal(second.entry, '密钥', '后续 key set 复用同一个承载条目');
  assert.equal(second.id, first.id, '同一个承载条目 id');

  const listed = await entries.keyList(opts);
  assert.deepEqual(listed.keys.map((x) => x.name).sort(), ['A_KEY', 'B_KEY']);

  const store = await loadStore();
  const holder = store.entries.find((e) => e.template === 'keybox2');
  assert.equal(holder.values.keys.length, 2, '两个键就是清单里的两行');
  for (const row of holder.values.keys) assert.ok(isCipherBlob(row.value), '每行的值都密文落盘');
  assert.equal(JSON.stringify(store).includes('value-a'), false, '清单里不许出现明文');
  assert.equal(JSON.stringify(store).includes('value-b'), false, '清单里不许出现明文');

  await entries.keyRemove('A_KEY', opts);
  const afterRemove = await loadStore();
  const still = afterRemove.entries.find((e) => e.template === 'keybox2');
  assert.ok(still, '删一行不等于删掉整条承载条目');
  assert.deepEqual(still.values.keys.map((row) => row.name), ['B_KEY']);
  assert.equal((await entries.keyGet('B_KEY', opts)).value, 'value-b', '另一行仍可读');
  await assert.rejects(() => entries.keyGet('A_KEY', opts), /没有|找不到/);

  await entries.keyRemove('B_KEY', opts);
  const emptied = await loadStore();
  const empty = emptied.entries.find((e) => e.template === 'keybox2');
  assert.equal(empty.values.keys, null, '最后一行删完后字段清空，但条目仍在');
});

test('旧单值密钥模板仍按 per-entry 模式读写（不迁移、不丢值）', async () => {
  await templates.addTemplate({
    id: 'oldsec', title: '旧密钥', groups: [{ id: 'main', title: '主' }],
    fields: [{ key: 'value', label: '值', type: 'secret', group: 'main' }],
  });
  await entries.addEntry({ template: 'oldsec', title: 'OLD_KEY', set: { value: 'old-plain' } });

  const got = await entries.keyGet('OLD_KEY', { template: 'oldsec' });
  assert.equal(got.value, 'old-plain');
  const listed = await entries.keyList({ template: 'oldsec' });
  assert.deepEqual(listed.keys.map((x) => x.name), ['OLD_KEY']);

  await entries.keySet('OLD_KEY', 'new-plain', { template: 'oldsec' });
  assert.equal((await entries.keyGet('OLD_KEY', { template: 'oldsec' })).value, 'new-plain');
  const store = await loadStore();
  const row = store.entries.find((e) => e.template === 'oldsec');
  assert.ok(isCipherBlob(row.values.value), 'legacy 写入同样密文落盘');

  await entries.keyRemove('OLD_KEY', { template: 'oldsec' });
  assert.equal((await loadStore()).entries.some((e) => e.template === 'oldsec'), false, 'legacy 模式删的是整条');
});

test('key consolidate 把旧单值密钥合并进公共容器的一个 keys 清单条目（幂等）', async () => {
  await templates.addTemplate({
    id: 'oldsec2', title: '旧密钥2', groups: [{ id: 'main', title: '主' }],
    fields: [{ key: 'value', label: '值', type: 'secret', group: 'main' }],
  });
  const container = await entries.addEntry({ template: '__blank__', title: '旧密钥容器' });
  for (const [name, value] of [['K_A', 'v-a'], ['K_B', 'v-b'], ['K_C', 'v-c\n']]) {
    await entries.addEntry({ template: 'oldsec2', parent: container.id, title: name, set: { value } });
  }

  const dry = await entries.keyConsolidate({ template: 'oldsec2', 'dry-run': true });
  assert.equal(dry.status, 'skipped');
  assert.equal((await loadStore()).entries.filter((e) => e.template === 'oldsec2').length, 3, '试运行不能删除条目');

  const r = await entries.keyConsolidate({ template: 'oldsec2' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'legacy');
  assert.equal(r.fromEntries, 3);
  assert.equal(r.removedEntries, 3, '三个单值子条目都删除');
  assert.equal(r.rows, 3);
  assert.equal(r.target.id, container.id, '公共空白容器本身成为承载条目');
  assert.equal(r.target.created, false);
  assert.equal((await loadStore()).entries.filter((e) => e.template === 'oldsec2').length, 1, '只剩一个承载条目');

  const sec = (await loadStore()).templates.find((t) => t.id === 'oldsec2');
  assert.equal(sec.fields.some((f) => f.key === 'value' && f.type === 'secret'), false, '旧单值字段已归一');
  assert.ok(sec.fields.some((f) => f.key === 'keys' && f.type === 'entrylist'), '模板归一为 keys 清单字段');

  const holder = (await loadStore()).entries.find((e) => e.id === container.id);
  assert.deepEqual(holder.values.keys.map((row) => row.name), ['K_A', 'K_B', 'K_C']);
  for (const row of holder.values.keys) assert.ok(isCipherBlob(row.value), '每个值重新密文落盘');
  assert.equal(JSON.stringify(await loadStore()).includes('v-a'), false, '迁移后不许残留明文');
  assert.equal((await entries.keyGet('K_B', { template: 'oldsec2' })).value, 'v-b');
  assert.equal((await entries.keyGet('K_C', { template: 'oldsec2' })).value, 'v-c\n', '尾随换行必须逐字保留');
  assert.equal((await entries.keyList({ template: 'oldsec2' })).entry, '旧密钥容器');

  const again = await entries.keyConsolidate({ template: 'oldsec2' });
  assert.equal(again.status, 'unchanged', '重复跑是幂等的');
});
