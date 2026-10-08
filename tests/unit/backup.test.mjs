import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathExists } from '../../src/core/fsx.js';
import { useTempHome } from '../helpers.mjs';

const home = await useTempHome();

const { loadStore, mutateStore } = await import('../../src/core/store.js');
const backup = await import('../../src/modules/backup/service.js');

// 先造一条数据，让备份/恢复有内容可比
await mutateStore((s) => {
  s.entries.push({
    id: 't1', section: 'job', title: '测试条目', tags: ['x'],
    values: { name: '赵刘学', phone: '13800000000' },
    createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  });
});

test('加密备份：明文不出现在归档文本里，正确口令可解密', async () => {
  const r = await backup.buildBackup({ password: 'pw-正确-123' });
  const text = JSON.stringify(r.archive);
  assert.equal(text.includes('赵刘学'), false, '备份文件里不能出现明文内容');
  assert.equal(text.includes('13800000000'), false);
  assert.equal(r.archive.kind, backup.BACKUP_KIND);
  assert.ok(r.archive.salt, '备份内含随机盐');
  assert.equal(r.counts.entries, 1);

  const { payload } = backup.decryptBackup(text, 'pw-正确-123');
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].values.name, '赵刘学');
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

test('恢复：整份替换并留安全快照', async () => {
  const r = await backup.buildBackup({ password: 'restore-pw-1' });
  // 先把当前条目清空，制造「数据丢了」的状态
  await mutateStore((s) => { s.entries = []; });
  assert.equal((await loadStore()).entries.length, 0);

  const out = await backup.restoreBackup({ content: JSON.stringify(r.archive), password: 'restore-pw-1' });
  assert.equal(out.status, 'restored');
  assert.equal(out.sections > 0, true);
  assert.equal(out.entries, 1);
  assert.equal((await loadStore()).entries[0].values.name, '赵刘学');
  assert.ok(await pathExists(out.safetySnapshot), '恢复前应留有安全快照');
});

test('CLI 导出写文件、CLI 导入读文件恢复', async () => {
  const dir = join(home, 'out');
  const w = await backup.exportBackup({ password: 'cli-pw-123', out: dir });
  assert.equal(w.encrypted, true);
  assert.ok(await pathExists(w.fileRaw));
  assert.ok(w.file.endsWith('.nxskbak'));

  await mutateStore((s) => { s.entries = []; });
  const r = await backup.importBackup({ file: w.fileRaw, password: 'cli-pw-123' });
  assert.equal(r.entries, 1);
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
