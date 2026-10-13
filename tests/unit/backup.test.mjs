import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathExists, writeAtomic } from '../../src/core/fsx.js';
import { useTempHome } from '../helpers.mjs';

const home = await useTempHome();

const { loadStore, mutateStore } = await import('../../src/core/store.js');
const backup = await import('../../src/modules/backup/service.js');
const { decryptValue, isCipherBlob, maskValue } = await import('../../src/core/crypto.js');
const { resolveVaultKey } = await import('../../src/core/vault.js');
const { instantiateTemplate } = await import('../../src/core/fields.js');
const { filesDir } = await import('../../src/core/paths.js');

// 先造一条数据，让备份/恢复有内容可比
await mutateStore((s) => {
  s.entries.push({
    id: 't1', section: 'job', title: '测试条目', tags: ['x'],
    values: { name: '张三', phone: '13800000000' },
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  });
});

test('加密备份：明文不出现在归档文本里，正确口令可解密', async () => {
  const r = await backup.buildBackup({ password: 'pw-正确-123' });
  const text = JSON.stringify(r.archive);
  assert.equal(text.includes('张三'), false, '备份文件里不能出现明文内容');
  assert.equal(text.includes('13800000000'), false);
  assert.equal(r.archive.kind, backup.BACKUP_KIND);
  assert.ok(r.archive.salt, '备份内含随机盐');
  assert.equal(r.counts.entries, 1);

  const { payload } = backup.decryptBackup(text, 'pw-正确-123');
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].values.name, '张三');
});

test('错误口令：报 BLOCKED 且提示口令不正确，不返回数据', () => {
  // 同步构造一份归档
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
  const text = JSON.stringify({
    app: 'nx-sk', kind: backup.BACKUP_KIND, v: backup.BACKUP_VERSION,
    createdAt: '2026-10-08T00:00:00.000Z', kdf: 'scrypt', salt,
    data: { v: 1, alg: 'aes-256-gcm', kid: 'x', iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', ct: 'AAAA' },
  });
  assert.throws(
    () => backup.decryptBackup(text, 'wrong-password'),
    (e) => e.code === 'BLOCKED' && /口令不正确|损坏/.test(e.message),
  );
});

test('真实归档用错误口令解密也报 BLOCKED', async () => {
  const r = await backup.buildBackup({ password: 'right-pw-123' });
  assert.throws(
    () => backup.decryptBackup(JSON.stringify(r.archive), 'bad-pw-999'),
    (e) => e.code === 'BLOCKED' && /口令不正确/.test(e.message),
  );
});

test('归档被篡改：解密报 BLOCKED', async () => {
  const r = await backup.buildBackup({ password: 'right-pw-123' });
  const tampered = structuredClone(r.archive);
  tampered.data.ct = Buffer.from('tampered-bytes').toString('base64');
  assert.throws(
    () => backup.decryptBackup(JSON.stringify(tampered), 'right-pw-123'),
    (e) => e.code === 'BLOCKED',
  );
});

test('不是备份文件 / 空口令：给 INVALID_INPUT', () => {
  assert.throws(() => backup.decryptBackup('{"hello":1}', 'pw'), /加密备份/);
  assert.throws(() => backup.decryptBackup('not-json', 'pw'), /不是合法 JSON/);
});

test('恢复 --replace：整份替换并留安全快照', async () => {
  const r = await backup.buildBackup({ password: 'restore-pw-1' });
  // 先把当前条目清空，制造「数据丢了」的状态
  await mutateStore((s) => { s.entries = []; });
  assert.equal((await loadStore()).entries.length, 0);

  const out = await backup.restoreBackup({
    content: JSON.stringify(r.archive), password: 'restore-pw-1', replace: true,
  });
  assert.equal(out.status, 'restored');
  assert.equal(out.mode, 'replace');
  assert.ok(out.sections > 0);
  assert.equal(out.entries, 1);
  assert.equal((await loadStore()).entries[0].values.name, '张三');
  assert.ok(await pathExists(out.safetySnapshot), '恢复前应留有安全快照');
});

test('CLI 导出写文件、CLI 导入读文件恢复（缺省合并）', async () => {
  const dir = join(home, 'out');
  const w = await backup.exportBackup({ password: 'cli-pw-123', out: dir });
  assert.equal(w.encrypted, true);
  assert.ok(await pathExists(w.fileRaw));
  assert.ok(w.file.endsWith('.nxskbak'));

  await mutateStore((s) => { s.entries = []; });
  const r = await backup.importBackup({ file: w.fileRaw, password: 'cli-pw-123' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'merge');
  assert.equal(r.addedEntriesTotal, 1);
  assert.equal((await loadStore()).entries.length, 1);

  // --replace 才是整份替换
  const r2 = await backup.importBackup({ file: w.fileRaw, password: 'cli-pw-123', replace: true });
  assert.equal(r2.status, 'restored');
  assert.equal(r2.entries, 1);
});

test('CLI 导入找不到文件时报 INVALID_INPUT', async () => {
  await assert.rejects(
    () => backup.importBackup({ file: join(home, 'no-such.nxskbak'), password: 'x' }),
    (e) => e.code === 'INVALID_INPUT' && /找不到备份文件/.test(e.message),
  );
});

test('缺少口令时报 INVALID_INPUT（不接受空口令）', async () => {
  await assert.rejects(() => backup.buildBackup({ password: '' }), /口令不能为空/);
});

// ── 合并导入（缺省语义）──

test('合并导入：只补空字段，不覆盖已有值', async () => {
  // 备份侧：name + phone 都有
  await mutateStore((s) => {
    s.entries = [{
      id: 't1', section: 'job', title: '测试条目', tags: [],
      values: { name: '张三', phone: '13800000000' },
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    }];
  });
  const r = await backup.buildBackup({ password: 'merge-pw-1' });
  // 本地侧：name 改掉、phone 清空 → 导入应保留李四、补回电话
  await mutateStore((s) => {
    s.entries[0].values.name = '李四';
    delete s.entries[0].values.phone;
  });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-1' });
  assert.equal(out.status, 'ok');
  assert.equal(out.mode, 'merge');
  assert.equal(out.filledTotal, 1);
  assert.equal(out.conflictsTotal, 1);

  const e = (await loadStore()).entries[0];
  assert.equal(e.values.name, '李四', '已有值不能被覆盖');
  assert.equal(e.values.phone, '13800000000', '空字段应被补上');
});

test('合并导入：冲突保留本地，报告里敏感值打码', async () => {
  await mutateStore((s) => {
    s.entries = [{
      id: 'k1', section: 'secret', title: 'E2E_KEY', tags: [],
      values: { value: 'sk-remote-ddddeeeeffff' },
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    }];
  });
  const r = await backup.buildBackup({ password: 'merge-pw-2' });
  // 本地改成另一个值 → 与备份冲突
  await mutateStore((s) => { s.entries[0].values.value = 'sk-local-aaaabbbbcccc'; });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-2' });
  assert.equal(out.conflictsTotal, 1);
  assert.equal(out.conflicts[0].field, 'value');

  const e = (await loadStore()).entries[0];
  assert.equal(e.values.value, 'sk-local-aaaabbbbcccc', '冲突必须保留本地值');

  const reportText = JSON.stringify(out);
  assert.equal(reportText.includes('sk-remote-ddddeeeeffff'), false, '报告不得出现备份明文');
  assert.equal(reportText.includes('sk-local-aaaabbbbcccc'), false, '报告不得出现本地明文');
  assert.ok(reportText.includes(maskValue('sk-remote-ddddeeeeffff')), '备份值应以打码形态出现在报告里');
});

test('合并导入：结构只增不减（补备份多出的字段，保留本地独有）', async () => {
  // 本地 job 先重置成 pristine 模板，再做备份
  await mutateStore((s) => {
    const tpl = instantiateTemplate('job', { id: 'job', title: s.sections.find((x) => x.id === 'job').title, order: 10 });
    const job = s.sections.find((x) => x.id === 'job');
    job.fields = tpl.fields;
    job.groups = tpl.groups;
  });
  const r = await backup.buildBackup({ password: 'merge-pw-3' });

  // 本地：删掉模板字段 phone、加一个自定义字段 myOwn
  await mutateStore((s) => {
    const job = s.sections.find((x) => x.id === 'job');
    job.fields = job.fields.filter((f) => f.key !== 'phone');
    job.fields.push({ key: 'myOwn', label: '自定义', type: 'text', group: 'basic' });
  });
  const before = (await loadStore()).sections.find((x) => x.id === 'job').fields.length;

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-3' });
  assert.equal(out.structureAdded.length, 1);
  assert.deepEqual(out.structureAdded[0].fields, ['phone']);
  assert.deepEqual(out.structureOnlyLocal[0].fields, ['myOwn']);

  const job = (await loadStore()).sections.find((x) => x.id === 'job');
  const keys = job.fields.map((f) => f.key);
  assert.ok(keys.includes('phone'), '备份多出的字段应被补回');
  assert.ok(keys.includes('myOwn'), '本地独有字段必须保留');
  assert.equal(job.fields.length, before + 1, '只增不减：字段数 = 原 + 补回');
});

test('合并导入：KV 栏目按名称匹配，不产生重复条目', async () => {
  await mutateStore((s) => {
    s.entries = [{
      id: 'e_backup', section: 'secret', title: 'SHARE_KEY', tags: [],
      values: { value: 'sk-shared-12345678' },
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    }];
  });
  const r = await backup.buildBackup({ password: 'merge-pw-4' });
  // 本地同名行但 id 不同、值为空 → 应补进本地行，而不是按 id 新增
  await mutateStore((s) => {
    s.entries = [{
      id: 'e_local', section: 'secret', title: 'SHARE_KEY', tags: [],
      values: {},
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    }];
  });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-4' });
  assert.equal(out.addedEntriesTotal, 0, '同名 KV 行不得新增');
  assert.equal(out.filledTotal, 1);
  assert.equal(out.resealed, 1, '敏感补空值应被本机 vaultKey 重新加密');

  const kv = (await loadStore()).entries.filter((e) => e.section === 'secret');
  assert.equal(kv.length, 1);
  assert.equal(kv[0].id, 'e_local');
  const { key: vaultKey } = await resolveVaultKey();
  assert.ok(isCipherBlob(kv[0].values.value), '落盘必须是密文');
  assert.equal(decryptValue(vaultKey, kv[0].values.value), 'sk-shared-12345678');
});

test('合并导入：设置只补缺失键，不动已有值', async () => {
  await mutateStore((s) => {
    s.settings.exportDir = 'D:/备份目录';
    s.settings.customFlag = 'on';
  });
  const r = await backup.buildBackup({ password: 'merge-pw-5' });
  // 本地：清掉自定义键；exportDir 恢复成「有意义的空」
  await mutateStore((s) => {
    delete s.settings.customFlag;
    s.settings.exportDir = '';
  });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-5' });
  assert.ok(out.settingsFilled.includes('customFlag'), '本地没有的键应被补上');
  const st = (await loadStore()).settings;
  assert.equal(st.customFlag, 'on');
  assert.equal(st.exportDir, '', '\'\' 是有意义的空（用默认目录），不能被备份里的路径覆盖');
});

test('合并导入：不动 exports 历史', async () => {
  await mutateStore((s) => { s.exports = [{ id: 'exp-a', at: '2026-10-08T00:00:00.000Z' }]; });
  const r = await backup.buildBackup({ password: 'merge-pw-6' });
  await mutateStore((s) => {
    s.exports = [{ id: 'exp-b', at: '2026-10-12T00:00:00.000Z' }];
    s.entries = [];
  });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'merge-pw-6' });
  assert.equal(out.exportsSkipped, 1);
  const ex = (await loadStore()).exports;
  assert.equal(ex.length, 1);
  assert.equal(ex[0].id, 'exp-b', '本机导出历史必须原样保留');
});

test('v3 --with-files：台账与原件一起导出、合并导入还原', async () => {
  const content = 'hello-attachment';
  const sha = createHash('sha256').update(content).digest('hex');
  await mutateStore((s) => {
    s.files = [{
      id: 'f_test1', category: 'document', name: 'a.txt', rel: 'document/a.txt',
      originalName: 'a.txt', ext: '.txt', bytes: content.length, sha256: sha,
      sourcePath: '', mode: 'upload', tags: [], note: '',
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    }];
  });
  await writeAtomic(join(filesDir(), 'document', 'a.txt'), content);

  const r = await backup.buildBackup({ password: 'files-pw-1', 'with-files': true });
  assert.ok(r.archive.filesData, '带 --with-files 应嵌入附件块');
  assert.equal(r.counts.filesEmbedded, 1);
  const text = JSON.stringify(r.archive);
  assert.equal(text.includes(Buffer.from(content).toString('base64')), false, '原件只能以密文形态出现在归档里');

  // 灾难现场：台账清空 + 物理文件被删
  await mutateStore((s) => { s.files = []; });
  await fsp.rm(join(filesDir(), 'document', 'a.txt'));

  const out = await backup.restoreBackup({ content: text, password: 'files-pw-1' });
  assert.equal(out.files.toAdd, 1);
  assert.equal(out.files.written, 1);

  const store = await loadStore();
  assert.equal(store.files.length, 1);
  assert.equal(store.files[0].id, 'f_test1');
  assert.equal(await fsp.readFile(join(filesDir(), 'document', 'a.txt'), 'utf8'), content);
});

test('v2 归档向后兼容：无 filesData 也能导入，缺原件如实报告', async () => {
  // 当前台账 [f_test1]；备份捕获它，本地清空后用「v2 化」的包导入
  const r = await backup.buildBackup({ password: 'files-pw-2' });
  const v2 = { ...r.archive, v: 2 };
  delete v2.filesData;
  await mutateStore((s) => { s.files = []; });
  await fsp.rm(join(filesDir(), 'document', 'a.txt'), { force: true });

  const out = await backup.restoreBackup({ content: JSON.stringify(v2), password: 'files-pw-2' });
  assert.equal(out.status, 'ok');
  assert.equal(out.files.toAdd, 1);
  assert.equal(out.files.missingBinaryTotal, 1, 'v2 包不带原件，必须如实报告');

  const store = await loadStore();
  assert.equal(store.files.length, 1, '台账行要回来（原件确实缺失）');
  assert.equal(await pathExists(join(filesDir(), 'document', 'a.txt')), false, '不得凭空造出文件');
});

test('回归：导入不再清空附件台账（payload 恒含 files）', async () => {
  // 事故形态：0.5.x–0.6.2 的包没有 files，任何一次导入都把台账归零
  assert.equal((await loadStore()).files.length, 1);
  const r = await backup.buildBackup({ password: 'regress-pw-1' });
  assert.equal(r.counts.files, 1, 'v3 备份必须携带台账');
  await mutateStore((s) => {
    s.entries.push({
      id: 't2', section: 'job', title: '无关变更', tags: [], values: { name: '王五' },
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    });
  });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'regress-pw-1' });
  assert.equal(out.files.kept, 1);
  assert.equal((await loadStore()).files.length, 1, '导入不得清空附件台账');
});

test('dry-run：合并计划不落盘', async () => {
  const storePath = process.env.NX_SK_STORE;
  const r = await backup.buildBackup({ password: 'dry-pw-1' });
  await mutateStore((s) => { s.entries = []; });
  const before = await fsp.readFile(storePath, 'utf8');
  const out = await backup.restoreBackup({
    content: JSON.stringify(r.archive), password: 'dry-pw-1', 'dry-run': true,
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.dryRun, true);
  assert.equal(out.mode, 'merge');
  assert.ok(out.addedEntriesTotal >= 1, '计划应预告会新增的条目');
  assert.equal(await fsp.readFile(storePath, 'utf8'), before, 'dry-run 不得写 store.json');
});

test('合并导入：空库近似全量新增（栏目、条目）', async () => {
  const r = await backup.buildBackup({ password: 'empty-pw-1' });
  await mutateStore((s) => { s.sections = []; s.entries = []; });

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'empty-pw-1' });
  assert.equal(out.status, 'ok');
  assert.equal(out.mode, 'merge');
  assert.ok(out.addedSections.length >= 5, '五个内置栏目应全部按「新增」回来');
  assert.equal((await loadStore()).sections.length, out.addedSections.length);
  assert.equal(out.conflictsTotal, 0);
});
