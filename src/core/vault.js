// 密钥解析：明文口令永不落盘，落盘的只有随机密钥文件 / 盐。
//
// 两种来源，优先级固定：
//   1. 环境变量 NX_SK_PASSPHRASE → scrypt(口令, ~/nx-sk/.vaultsalt)
//   2. ~/nx-sk/.vaultkey（32 字节随机密钥，首次使用时自动生成，尽量收紧权限）
//
// 同一份密文只能由**同一个**密钥解开。密钥指纹写进密文（core/crypto.js 的 kid），
// 所以换来源时会得到明确的 BLOCKED 报错，而不是静默解出一堆乱码。
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { ENV_PASSPHRASE, displayPath, vaultKeyFile, vaultSaltFile } from './paths.js';
import { chmodPrivate, ensureDir, pathExists } from './fsx.js';
import { KEY_BYTES, decryptValue, deriveKey, isCipherBlob, keyId, newKey } from './crypto.js';

export const SOURCE_ENV = 'env';
export const SOURCE_KEYFILE = 'keyfile';

async function loadOrCreateSalt() {
  const p = vaultSaltFile();
  if (await pathExists(p)) {
    const raw = (await fsp.readFile(p, 'utf8')).trim();
    if (raw) return raw;
  }
  const salt = randomBytes(16);
  await ensureDir(dirname(p));
  await fsp.writeFile(p, salt.toString('base64') + '\n', 'utf8');
  await chmodPrivate(p);
  return salt.toString('base64');
}

async function loadOrCreateKeyFile() {
  const p = vaultKeyFile();
  if (await pathExists(p)) {
    const raw = (await fsp.readFile(p, 'utf8')).trim();
    if (raw) {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length >= KEY_BYTES) return { key: buf.subarray(0, KEY_BYTES), created: false, path: p };
    }
  }
  const key = newKey();
  await ensureDir(dirname(p));
  await fsp.writeFile(p, key.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmodPrivate(p);
  return { key, created: true, path: p };
}

/** 解析当前生效的密钥。会**按需创建**本地密钥文件——所以第一次就能直接用。 */
export async function resolveVaultKey() {
  const passphrase = process.env[ENV_PASSPHRASE];
  if (passphrase) {
    const salt = await loadOrCreateSalt();
    const key = deriveKey(passphrase, salt);
    return { key, source: SOURCE_ENV, saltFile: vaultSaltFile(), keyFile: null, created: false };
  }
  const { key, created, path } = await loadOrCreateKeyFile();
  return { key, source: SOURCE_KEYFILE, saltFile: null, keyFile: path, created };
}

/** 只读状态查询：不创建任何文件，供 bootstrap / 面板展示。 */
export async function vaultStatus() {
  const passphrase = !!process.env[ENV_PASSPHRASE];
  if (passphrase) {
    const salt = vaultSaltFile();
    return {
      ready: true,
      source: SOURCE_ENV,
      keyFile: null,
      saltFile: displayPath(salt),
      saltExists: await pathExists(salt),
      note: '密钥由环境变量 NX_SK_PASSPHRASE 派生（口令不落盘）。',
    };
  }
  const p = vaultKeyFile();
  const exists = await pathExists(p);
  return {
    ready: true,
    source: SOURCE_KEYFILE,
    keyFile: displayPath(p),
    saltFile: null,
    saltExists: false,
    note: exists
      ? '密钥来自本机密钥文件；删掉它会让已存密文无法解密。'
      : '本机密钥文件尚未生成，首次写入密文字段时自动创建。',
  };
}

/** 当前指纹，用于排查「密钥换过没有」。 */
export async function currentKeyId() {
  const { key } = await resolveVaultKey();
  return keyId(key);
}

/**
 * 造一个 `decrypt(blob) => 明文`，交给 core/render.js 做展示层解密。
 *
 * 为什么放在这里：render 是纯函数（可单测、无 IO），而「什么时候允许解密」
 * 是安全决策——把它收成**一个**函数，就不会出现「某个出口忘了打码」。
 * 只有当栏目里真有密文字段、且条目里真有密文时才去解析密钥（避免无谓地生成密钥文件）。
 */
export async function sensitiveViewer(section, entries = []) {
  const sensitive = (section?.fields || []).filter((f) => f.sensitive || f.type === 'secret');
  // 结构清单（entrylist）的敏感子值也是密文落盘：不探行内的话，清单里真有密文时
  // viewer 不会被创建，读出来全变成「需要密钥才能解密」。
  const entryLists = (section?.fields || []).filter((f) => f.type === 'entrylist');
  if (!sensitive.length && !entryLists.length) return undefined;
  const keys = sensitive.map((f) => f.key);
  const subKeysOf = (f) => (f.fields || []).filter((s) => s.sensitive).map((s) => s.key);
  const hasBlob = entries.some((e) => keys.some((k) => isCipherBlob(e?.values?.[k]))
    || entryLists.some((f) => Array.isArray(e?.values?.[f.key]) && e.values[f.key].some((row) => (
      !!row && typeof row === 'object' && subKeysOf(f).some((k) => isCipherBlob(row[k]))
    ))));
  if (!hasBlob) return undefined;
  const { key } = await resolveVaultKey();
  return (blob) => decryptValue(key, blob);
}
