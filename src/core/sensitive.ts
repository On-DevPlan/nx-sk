// 敏感值的**展示形态**：默认原文 / mask 打码 / 有 decrypt 才解密。
//
// 从 core/render.js 下沉到这里，是因为字段行为（entrylist / table 的子值展示）
// 也要用它，而行为又会被 render 的序列化出口调用 —— 留在 render 里会成环。
// 为什么这条判据只能有一份：它是安全边界，多一个出口就多一次「某个出口忘打码」的机会。
import { isCipherBlob, maskValue } from './crypto.ts';

/**
 * 三种输入都要处理：
 *   密文对象 → 有 decrypt 就解开，没有就标「需要密钥」
 *   明文     → 历史数据可能存的是明文，原样返回
 *   空       → null
 */
export function displaySensitive(
  raw: unknown,
  { mask = false, decrypt }: { mask?: boolean; decrypt?: (blob: unknown) => string } = {},
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isCipherBlob(raw)) return mask ? maskValue(String(raw)) : String(raw);
  if (!decrypt) return mask ? '[已加密]' : '[需要密钥才能解密]';
  try {
    const plain = decrypt(raw);
    return mask ? maskValue(plain) : plain;
  } catch {
    return '[无法解密：密钥或密文与写入时不一致]';
  }
}
