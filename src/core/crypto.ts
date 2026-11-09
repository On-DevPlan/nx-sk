// 密文原语：AES-256-GCM。只做算法，不认识 store、不认识栏目。
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { blocked, badInput } from './errors.ts';

export const ALG = 'aes-256-gcm';
export const KEY_BYTES = 32; // AES-256
export const BLOB_VERSION = 1;

/** 落盘的密文对象形状（字段都可缺省：历史数据可能来自旧版本）。 */
export interface CipherBlob {
  v?: number;
  alg?: string;
  kid?: string;
  iv: string;
  tag: string;
  ct: string;
}

export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function deriveKey(passphrase: string, salt: Buffer | string): Buffer {
  const s = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'base64');
  // scrypt 默认 N=16384, r=8, p=1 —— 对本机工具足够，且是同步的（无回调地狱）
  return scryptSync(String(passphrase), s, KEY_BYTES);
}

/** 密钥指纹：写进密文，用来在「口令/密钥来源变了」时给出明确报错，而不是静默解不开。 */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * 加密一个字符串值 → 可 JSON 化的密文对象。
 * 明文绝不会以任何形式留在返回值里。
 */
export function encryptValue(key: Buffer, plaintext: unknown): CipherBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    v: BLOB_VERSION,
    alg: ALG,
    kid: keyId(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function isCipherBlob(value: unknown): value is CipherBlob {
  if (!value || typeof value !== 'object') return false;
  const v = value as { ct?: unknown; iv?: unknown };
  return typeof v.ct === 'string' && typeof v.iv === 'string';
}

export function decryptValue(key: Buffer, blob: unknown): string {
  if (!isCipherBlob(blob)) throw badInput('不是合法的密文对象');
  if (blob.alg !== ALG) throw badInput(`不支持的加密算法: ${blob.alg}`);
  if (blob.kid && blob.kid !== keyId(key)) {
    throw blocked(
      '当前密钥与写入时的密钥不一致，无法解密。' +
      '（换过 NX_SK_PASSPHRASE，或删掉过 ~/nx-sk/.vaultkey 都会这样——旧密文只能用旧密钥解）',
    );
  }
  try {
    const decipher = createDecipheriv(ALG, key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw blocked('解密失败：密文已损坏，或密钥不正确。');
  }
}

/**
 * 脱敏展示：`sk-1234567890abcdef` → `sk-1****cdef`。
 * 长度不足以露出首尾时全部打码——**宁可比用户预期更严**，泄露是不可逆的。
 */
export function maskValue(text: unknown): string {
  const s = String(text ?? '');
  if (!s) return '';
  if (s.length <= 10) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(6)}${s.slice(-4)}`;
}
