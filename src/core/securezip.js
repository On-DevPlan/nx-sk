// 带口令的 ZIP 信封：把一个（可能是几百 MB 的）导出包整体加密。
//
// 为什么不复用备份的 JSON 格式：备份是 JSON（base64 撑大约 1/3），而导出包本身就是二进制
// ZIP，套一层 JSON 只会白涨体积。这里用定长头部 + 密文的二进制信封，体积几乎不变。
//
// 布局（全部大端无关，直接拼接）：
//   magic  'NXSKENC1'   8B   固定，用于「这是不是加密包」的判定
//   salt                16B  scrypt 盐（每次导出都重新随机）
//   iv                  12B  GCM nonce
//   tag                 16B  GCM 认证标签（口令错 / 被改动都会在这里失败）
//   ciphertext          N B  明文 ZIP
//
// 口令**不落盘、不进文件名**；派生沿用 core/crypto 的 scrypt（与密钥库同一套参数）。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './crypto.js';
import { badInput, blocked } from './errors.js';

export const ENC_MAGIC = Buffer.from('NXSKENC1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENC_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;

const asBuffer = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v || []));

/** 只看头 8 字节：加密包与明文 ZIP 因此可以走同一个导入入口。 */
export function isEncryptedPackage(buf) {
  const b = asBuffer(buf);
  return b.length >= HEADER_BYTES && b.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);
}

export function sealPackage(payload, passphrase) {
  const pw = String(passphrase ?? '');
  if (!pw) throw badInput('加密导出需要口令');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
  const ct = Buffer.concat([cipher.update(asBuffer(payload)), cipher.final()]);
  return Buffer.concat([ENC_MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

/**
 * 解开信封：**明文包原样返回**，所以调用方不必先判断类型。
 * 口令错与「包没加密却给了口令」都按「能用就用」处理，只有真正解不开才报错。
 */
export function openPackage(buf, passphrase) {
  const b = asBuffer(buf);
  if (!isEncryptedPackage(b)) return b;

  const pw = String(passphrase ?? '');
  if (!pw) throw blocked('这个包已加密，请输入导出时设置的口令');

  const salt = b.subarray(ENC_MAGIC.length, ENC_MAGIC.length + SALT_BYTES);
  const iv = b.subarray(ENC_MAGIC.length + SALT_BYTES, ENC_MAGIC.length + SALT_BYTES + IV_BYTES);
  const tag = b.subarray(ENC_MAGIC.length + SALT_BYTES + IV_BYTES, HEADER_BYTES);
  const ct = b.subarray(HEADER_BYTES);

  let out;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(pw, salt), iv);
    decipher.setAuthTag(tag);
    out = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM 无法区分「口令错」与「数据被改」，两种都说清楚，别让人以为文件坏了。
    throw blocked('口令不对，或这个文件已损坏');
  }
  // 认证通过但内容不是 ZIP：说明包不是 nx-sk 导出的（或版本不兼容），别当数据问题处理。
  if (out.length < 4 || out[0] !== 0x50 || out[1] !== 0x4b) {
    throw badInput('解密成功但内容不是 ZIP —— 这个文件可能不是 nx-sk 导出包');
  }
  return out;
}
