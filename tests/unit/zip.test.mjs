// 零依赖 ZIP：写→读往返、压缩方式、路径安全、坏包识别。
//
// 路径安全不是可选项：导入时会按 zip 里的名字写附件文件，
// 放过 `../` 就是任意文件写入。这里逐条钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createZip, readZip, crc32, assertSafeZipName } = await import('../../src/core/zip.js');

const byName = (list) => new Map(list.map((e) => [e.name, e.data]));

test('store 往返：中文文件名、嵌套目录、二进制内容都不变', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const zip = createZip([
    { name: 'manifest.json', data: '{"title":"容器平台"}' },
    { name: 'attachments/01-校外接入.png', data: png },
    { name: 'notes/说明.txt', data: '中文正文' },
  ]);
  const map = byName(readZip(zip));
  assert.equal(map.size, 3);
  assert.equal(map.get('manifest.json').toString(), '{"title":"容器平台"}');
  assert.deepEqual(map.get('attachments/01-校外接入.png'), png);
  assert.equal(map.get('notes/说明.txt').toString(), '中文正文');
});

test('deflate 往返：压缩后的条目也能正确解出', () => {
  const text = '同一段文字'.repeat(500);
  const zip = createZip([{ name: 'a.txt', data: text }], { compress: true });
  assert.ok(zip.length < Buffer.byteLength(text), 'deflate 后应比原文小');
  assert.equal(readZip(zip)[0].data.toString(), text);
});

test('目录条目跳过；空包返回空数组', () => {
  const zip = createZip([
    { name: 'attachments/', data: '' },
    { name: 'attachments/a.txt', data: 'x' },
  ]);
  assert.deepEqual(readZip(zip).map((e) => e.name), ['attachments/a.txt']);
  assert.deepEqual(readZip(createZip([])), []);
});

test('路径安全：绝对路径、盘符、.. 都拒绝', () => {
  for (const bad of ['/etc/passwd', 'C:/Windows/x', '../x', 'a/../../b', 'a\\..\\b']) {
    assert.throws(() => assertSafeZipName(bad), undefined, bad);
  }
  assert.equal(assertSafeZipName('a/b/c.txt'), 'a/b/c.txt');
});

test('坏包：CRC 不符、缺 EOCD、截断都要报错', () => {
  const zip = createZip([{ name: 'x.txt', data: 'hello' }]);
  const i = zip.indexOf(Buffer.from('hello'));
  const corrupt = Buffer.from(zip);
  corrupt[i] = corrupt[i] ^ 0xff;
  assert.throws(() => readZip(corrupt), /CRC|校验/);

  assert.throws(() => readZip(Buffer.alloc(40)), /EOCD|ZIP/);
  assert.throws(() => readZip(zip.slice(0, zip.length - 10)), /EOCD|ZIP|越界|截断/);
});

test('crc32 与标准值一致（"123456789" → 0xCBF43926）', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

// —— 带口令的信封（securezip） ——
// 目的：同一个导入入口既能吃明文包也能吃加密包；口令错、缺口令、包被改都要明确报错。
import { isEncryptedPackage, openPackage, sealPackage } from '../../src/core/securezip.js';
test('明文包 isEncryptedPackage=false，openPackage 原样返回', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello' }]);
  assert.equal(isEncryptedPackage(zip), false);
  assert.equal(openPackage(zip, ''), zip);
  assert.equal(openPackage(zip, 'anything').equals(zip), true);
});

test('加密 → 解密往返内容一致，且头 8 字节是 magic', () => {
  const zip = createZip([{ name: 'manifest.json', data: '{"x":1}' }]);
  const enc = sealPackage(zip, 'S1cau!@#');
  assert.equal(isEncryptedPackage(enc), true);
  assert.equal(enc.length > zip.length, true);
  const back = openPackage(enc, 'S1cau!@#');
  assert.equal(back.equals(zip), true);
  assert.deepEqual(readZip(back).map((f) => f.name), ['manifest.json']);
});

test('同一个口令加密两次，密文不同（盐与 IV 每次重新随机）', () => {
  const zip = createZip([{ name: 'a.txt', data: 'same' }]);
  const a = sealPackage(zip, 'pw');
  const b = sealPackage(zip, 'pw');
  assert.equal(a.equals(b), false, '两次密文相同说明盐/IV 被复用了');
  assert.equal(openPackage(a, 'pw').equals(openPackage(b, 'pw')), true);
});

test('口令错 / 缺口令 / 内容被改，都会报错而不是解出垃圾', () => {
  const enc = sealPackage(createZip([{ name: 'a.txt', data: 'secret' }]), 'right');
  assert.throws(() => openPackage(enc, 'wrong'), (e) => e.code === 'BLOCKED' && /口令不对|损坏/.test(e.message));
  assert.throws(() => openPackage(enc, ''), (e) => e.code === 'BLOCKED' && /口令/.test(e.message));
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 3] ^= 0xff;
  assert.throws(() => openPackage(tampered, 'right'), (e) => e.code === 'BLOCKED');
});

test('magic 之外的最小长度判定：短 buffer 不会误判为加密包', () => {
  assert.equal(isEncryptedPackage(Buffer.alloc(4)), false);
  assert.equal(isEncryptedPackage(Buffer.from('PK\x03\x04rest')), false);
});
