// 密文封装（seal）的公共零件。
//
// 只放「多个类型完全相同」的实现；有差异的（清单行、表格列）各在自己的文件里。
import { badInput } from '../../errors.ts';
import { decryptValue, encryptValue, isCipherBlob, maskValue } from '../../crypto.ts';
import { resolveVaultKey } from '../../vault.ts';
import type { SealContext, SealHook } from '../../../shared/fields/types.ts';

/**
 * 「这一格拿到的是打码占位吗」。
 *
 * maskValue 对**短值**（≤10 字符）返回全星，对长值返回「前 4 + 6 个星 + 后 4」——
 * 只认「连续 6 个星」会把短密码的打码值（3 位密码 → `***`）当成新密码加密存进去，
 * 下一次读就是 `***`，而且没有任何报错。
 */
export const looksMasked = (text: unknown): boolean => (
  /^\*{3,}$/.test(String(text ?? '')) || String(text ?? '').includes('******')
);

/**
 * 标量敏感值（含 `secret` 类型）：面板把打码后的值原样回传时必须保留原密文，
 * 否则掩码会被当成新密钥存进去。
 *
 * 失败语义：打码占位对不上原密文 → 抛 `badInput`（拒绝写入）；
 * 空值 → `null`（清空）；其余加密后返回。
 */
export const sealScalar: SealHook = async ({ def, raw, current }: SealContext) => {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw);
  if (isCipherBlob(current)) {
    try {
      const { key } = await resolveVaultKey();
      if (maskValue(decryptValue(key, current)) === text) return current;
    } catch { /* 解不开就按新值处理 */ }
  }
  if (looksMasked(text)) {
    throw badInput(`字段「${def.label}」收到的是打码占位而非明文。给完整值，或用 --unset ${def.key} 清空。`);
  }
  const { key } = await resolveVaultKey();
  return encryptValue(key, text);
};
