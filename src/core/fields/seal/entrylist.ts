// 结构清单的写入封装：normalize 之后，敏感子值与顶层敏感字段同一条边界——
// 密文落盘；面板把打码占位原样回传时保留原密文（不把掩码当新密码存进去）。
// 打码占位与现有密文对不上时必须报错：那多半是「想改密码但只拷了打码值」。
import { badInput } from '../../errors.ts';
import { decryptValue, encryptValue, isCipherBlob, maskValue } from '../../crypto.ts';
import { resolveVaultKey } from '../../vault.ts';
import { behaviorOf } from '../registry.ts';
import { looksMasked } from './common.ts';
import type { SealContext, SealHook } from '../../../shared/fields/types.ts';

export const sealEntryList: SealHook = async ({ def, raw, current }: SealContext) => {
  const rows = raw === null || raw === undefined
    ? null
    : behaviorOf('entrylist').coerce(def, raw) as any[] | null;
  if (!rows) return null;
  const subs = (def.fields || []).filter((s: any) => s.sensitive);
  if (!subs.length) return rows;
  const curRows = Array.isArray(current) ? current : [];
  const out: any[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = { ...rows[i] };
    for (const s of subs) {
      const text = row[s.key];
      if (text === undefined) continue;
      if (looksMasked(text)) {
        const cur = curRows[i]?.[s.key];
        if (isCipherBlob(cur)) {
          try {
            const { key } = await resolveVaultKey();
            if (maskValue(decryptValue(key, cur)) === String(text)) { row[s.key] = cur; continue; }
          } catch { /* 解不开就按新值走，下面照常报错 */ }
        }
        throw badInput(`字段「${def.label}」第 ${i + 1} 行的「${s.label}」收到的是打码占位而非明文。给完整值，或把这一格清掉重填。`);
      }
      const { key } = await resolveVaultKey();
      row[s.key] = encryptValue(key, String(text));
    }
    out.push(row);
  }
  return out;
};
