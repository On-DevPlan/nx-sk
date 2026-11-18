import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const { decryptValue, deriveKey, encryptValue, isCipherBlob, keyId, maskValue, newKey } = await import('../../src/core/crypto.ts');
const { resolveVaultKey, vaultStatus } = await import('../../src/core/vault.ts');
const { completeness, displaySensitive, dumpSection, formatValue, serializeEntry } = await import('../../src/core/render.ts');
const { findSection, groupFields, instantiateTemplate, isSensitiveField } = await import('../../src/core/fields.ts');
const { normalizeStructure, groupKeysOf } = await import('../../src/shared/fields/structure.ts');

const SEC = instantiateTemplate('secret', { id: 'secret', title: '密钥' });
const JOB = instantiateTemplate('job', { id: 'job', title: '求职' });

test('加密往返：明文不出现在密文里，解密拿回原值', () => {
  const key = newKey();
  const blob = encryptValue(key, 'sk-1234567890abcdef');
  assert.ok(isCipherBlob(blob));
  assert.equal(JSON.stringify(blob).includes('sk-1234'), false, '密文对象里不能出现明文片段');
  assert.equal(decryptValue(key, blob), 'sk-1234567890abcdef');
});

test('同一个明文两次加密得到不同的密文（每次独立 IV）', () => {
  const key = newKey();
  assert.notEqual(encryptValue(key, 'same').ct, encryptValue(key, 'same').ct);
});

test('密钥不一致时给 BLOCKED（带指纹），而不是解出乱码', () => {
  const a = newKey();
  const b = newKey();
  assert.notEqual(keyId(a), keyId(b));
  const blob = encryptValue(a, 'top-secret');
  assert.throws(() => decryptValue(b, blob), (e) => e.code === 'BLOCKED' && /密钥不一致/.test(e.message));
});

test('密文被篡改（GCM 认证失败）也报 BLOCKED', () => {
  const key = newKey();
  const blob = encryptValue(key, 'top-secret');
  const tampered = { ...blob, ct: Buffer.from('nope').toString('base64') };
  assert.throws(() => decryptValue(key, tampered), (e) => e.code === 'BLOCKED');
});

test('deriveKey：同口令同盐同结果，换盐即换密钥', () => {
  const k1 = deriveKey('pw', Buffer.from('salt-1234567890').toString('base64'));
  const k2 = deriveKey('pw', Buffer.from('salt-1234567890').toString('base64'));
  const k3 = deriveKey('pw', Buffer.from('another-salt-99').toString('base64'));
  assert.equal(k1.toString('hex'), k2.toString('hex'));
  assert.notEqual(k1.toString('hex'), k3.toString('hex'));
  assert.equal(k1.length, 32);
});

test('maskValue：短值全打码，长值只露首尾', () => {
  assert.equal(maskValue(''), '');
  assert.equal(maskValue('12345'), '*****');
  assert.equal(maskValue('sk-1234567890abcdef'), 'sk-1******cdef');
  assert.ok(!maskValue('sk-1234567890abcdef').includes('234567890ab'), '中间段不能泄漏');
});

test('密钥来源：默认走本机密钥文件，首次解析时自动生成', async () => {
  const st = await vaultStatus();
  assert.equal(st.source, 'keyfile');
  assert.equal(st.saltExists, false);
  const before = await vaultStatus();
  assert.ok(before.note.length > 0);

  const { key, keyFile } = await resolveVaultKey();
  assert.equal(key.length, 32);
  assert.ok(keyFile);
  const fsp = await import('node:fs/promises');
  const raw = (await fsp.readFile(keyFile, 'utf8')).trim();
  assert.equal(Buffer.from(raw, 'base64').length, 32, '密钥文件里只有 base64 的随机密钥，没有口令');
});

test('密钥来源：设了 NX_SK_PASSPHRASE 就走口令派生，且落盐不落口令', async () => {
  process.env.NX_SK_PASSPHRASE = 'correct horse battery staple';
  try {
    const st = await vaultStatus();
    assert.equal(st.source, 'env');
    const { key, saltFile } = await resolveVaultKey();
    const fsp = await import('node:fs/promises');
    const salt = (await fsp.readFile(saltFile, 'utf8')).trim();
    assert.ok(salt.length > 0);
    assert.equal(salt.includes('correct horse'), false, '盐文件里不能有口令');
    assert.equal(key.toString('base64').includes('correct horse'), false);
  } finally {
    delete process.env.NX_SK_PASSPHRASE;
  }
});

test('completeness：给出已填数与未填字段清单', () => {
  const entry = { values: { name: '张三', phone: '13800000000', gender: '' } };
  const c = completeness(JOB, entry);
  assert.equal(c.filled, 2);
  // optional/avoid 字段不计入分母，组字段是容器也不计入：计入数 + 排除数 = 有值的字段总数
  assert.equal(c.total + c.excluded.length, JOB.fields.filter((f) => f.type !== 'group').length);
  assert.ok(c.missing.some((m) => m.key === 'gender'));
  assert.deepEqual(c.missing.map((m) => m.key).includes('name'), false);
});

test('serializeEntry：密文字段默认原文，--mask 才打码', () => {
  const entry = {
    id: 'e_1', section: 'secret', title: 'OpenAI 主号', tags: [],
    values: { value: 'sk-1234567890abcdef' },
    createdAt: null, updatedAt: null,
  };
  const plain = serializeEntry(SEC, entry);
  assert.equal(plain.values.value, 'sk-1234567890abcdef', '本机单人工具：默认不拦自己');
  assert.equal(serializeEntry(SEC, entry, { mask: true }).values.value, 'sk-1******cdef');
  assert.deepEqual(Object.keys(plain.values), ['value'], '密钥栏目就一个字段：KV');
});

test('displaySensitive：默认原文；打码要显式要', () => {
  const key = newKey();
  const blob = encryptValue(key, 'sk-live-abcdefghijklmn');
  const decrypt = (b) => decryptValue(key, b);

  assert.equal(displaySensitive(blob, { decrypt }), 'sk-live-abcdefghijklmn', '默认原文');
  assert.equal(displaySensitive(blob, { decrypt, mask: true }), 'sk-l******klmn', '要打码就显式传 mask');
  assert.equal(displaySensitive(blob, {}), '[需要密钥才能解密]', '没注入 decrypt 时不可能凭空得到明文');
  assert.equal(displaySensitive(blob, { mask: true }), '[已加密]');
  assert.equal(displaySensitive(blob, { decrypt: () => { throw new Error('wrong key'); } }), '[无法解密：密钥或密文与写入时不一致]');
  assert.equal(displaySensitive(null, { decrypt }), null);
});

test('serializeEntry：密文对象经 decrypt 后默认出明文', () => {
  const key = newKey();
  const entry = { id: 'e_2', section: 'secret', title: 'x', tags: [], values: { value: encryptValue(key, 'sk-live-abcdefghijklmn') } };
  const decrypt = (b) => decryptValue(key, b);
  assert.equal(serializeEntry(SEC, entry, { decrypt }).values.value, 'sk-live-abcdefghijklmn');
  assert.equal(serializeEntry(SEC, entry, { decrypt, mask: true }).values.value, 'sk-l******klmn');
  assert.equal(serializeEntry(SEC, entry).values.value, '[需要密钥才能解密]');
});

test('formatValue：bool / tags / 空值 的人读形态一致', () => {
  assert.equal(formatValue(true, { type: 'bool' }), '是');
  assert.equal(formatValue(false, { type: 'bool' }), '否');
  assert.equal(formatValue(['北京', '上海'], { type: 'tags' }), '北京、上海');
  assert.equal(formatValue('', { type: 'text' }), '');
  assert.equal(formatValue(null, { type: 'text' }), '');
});

test('dumpSection：字段台账带 sensitive 标记，值默认原文、mask 时打码', () => {
  const entry = { id: 'e_9', section: 'secret', title: 'x', tags: [], values: { value: 'sk-abcdefghijklmnop' } };
  const d = dumpSection(SEC, [entry]);
  assert.equal(d.section.id, 'secret');
  assert.equal(d.fields.find((f) => f.key === 'value').sensitive, true);
  assert.equal(d.entries[0].values.value, 'sk-abcdefghijklmnop');
  const m = dumpSection(SEC, [entry], { mask: true });
  assert.equal(m.entries[0].values.value.includes('abcdefghij'), false);
  assert.equal(d.count, 1);
});

test('isSensitiveField：type=secret 与显式 sensitive 都算密文', () => {
  assert.equal(isSensitiveField(SEC, 'value'), true);
  assert.equal(isSensitiveField(JOB, 'name'), false);
});

test('findSection：id 与标题都能定位，未命中返回 null', () => {
  const store = { sections: [JOB, SEC] };
  assert.equal(findSection(store, 'job').id, 'job');
  assert.equal(findSection(store, '求职').id, 'job');
  assert.equal(findSection(store, '不存在'), null);
});

test('groupFields：按字段顺序产出分组，组字段不算成员，不丢字段', () => {
  const groups = groupFields(JOB.fields);
  const total = groups.reduce((n, g) => n + g.fields.length, 0);
  const leaves = JOB.fields.filter((f) => f.type !== 'group').length;
  assert.equal(total, leaves, '每个普通字段恰好归一个组，组字段自己是容器不计入');
  assert.equal(groups[0].id, 'basic');
});

test('密钥模板是严格的 KV：一个字段 + 条目名就是键名', () => {
  assert.equal(SEC.fields.length, 1, '存个 key 不该先填一张表');
  assert.equal(SEC.fields[0].key, 'value');
  assert.equal(isSensitiveField(SEC, 'value'), true);
  assert.equal(SEC.titleField, null, '键名就是条目名，不该再从某个字段推导');
  assert.equal(SEC.titleLabel, '密钥名');
  assert.equal(SEC.kv, true, '密钥模板必须自带 kv 标记 —— 面板据此渲染 KV 表格而不是条目列表');
});

// —— 结构不变量（servers 栏目事故回归）——
// 过去「分组声明 ⊇ 字段引用」是两份数据要对账；0.42 起组就是字段，
// 这份不变量由 normalizeStructure 一家收口（读路径与写路径共用）。
test('normalizeStructure：没有组字段时合成根组，把所有普通字段收编进去', () => {
  const out = normalizeStructure([
    { key: 'host', label: '公网IP' },
    { key: 'note', label: '备注' },
  ]);
  assert.deepEqual(out.map((f) => f.key), ['root', 'host', 'note']);
  assert.deepEqual(groupKeysOf(out[0]), ['host', 'note']);
  // 幂等：再跑一遍不产生变化
  assert.deepEqual(normalizeStructure(out), out);
});

test('normalizeStructure：组声明里不存在/自己的成员被剪掉，重复归属先到先得', () => {
  const out = normalizeStructure([
    { key: 'a', type: 'group', keys: ['x', 'a', 'ghost'] },
    { key: 'b', type: 'group', keys: ['x'] },
    { key: 'x', type: 'text' },
  ]);
  assert.deepEqual(groupKeysOf(out.find((f) => f.key === 'a')), ['x'], '自引用与不存在的成员被剪掉');
  assert.deepEqual(groupKeysOf(out.find((f) => f.key === 'b')), [], '同一个字段只归一个组');
});

test('normalizeSection 收口自愈：老形状（groups + field.group）读一次就折成组字段', async () => {
  const { normalize } = await import('../../src/core/store.ts');
  const store = normalize({
    version: 3,
    sections: [{
      id: 'servers', title: '服务器', groups: [{ id: 'basic', title: '基本信息' }],
      fields: [{ key: 'host', label: '公网IP', type: 'text', group: 'basic' }],
    }],
    entries: [],
  });
  const sec = store.sections.find((s) => s.id === 'servers');
  // 组折成字段（旧分组 id 就是组字段 key），外貌与「原始资料」袋一致
  const groupKeys = sec.fields.filter((f) => f.type === 'group').map((f) => f.key);
  assert.ok(groupKeys.includes('basic'), JSON.stringify(groupKeys));
  assert.ok(groupKeys.includes('sourceGroup'));
  assert.ok(!('groups' in sec), '存储里不再有 groups');
  assert.equal(sec.fields.find((f) => f.key === 'host').group, undefined, '字段定义里不再有 group');
  // 自带的「原始资料」袋也一并补齐
  assert.ok(sec.fields.some((f) => f.type === 'source' && f.key === 'source'));
});

