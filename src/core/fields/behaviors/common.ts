// 字段行为的公共零件。
//
// 只放「多个类型完全一样」的实现，避免 14 个文件各写一遍；有差异的钩子绝不塞进这里。
import { displaySensitive } from '../../sensitive.ts';
import { isPlainRow } from '../../values.ts';
import type { RevealOptions, SubFieldDef } from '../../../shared/fields/types.ts';

/** 是否按密文处理：字段显式 `sensitive`，或类型就是 `secret`。 */
export const isSensitiveDef = (def: any): boolean => def?.sensitive === true || def?.type === 'secret';

/** 标量字段没有子字段。 */
export const noSubFields = (): SubFieldDef[] => [];

/** 不引用附件。 */
export const noRefs = (): string[] => [];

/** 读取侧默认原样带出。 */
export const identityReveal = (_def: any, raw: any, _opts: RevealOptions): unknown => raw;

/** 导入时默认不做 id 重映射。 */
export const identityRemap = (_def: any, value: any, _idMap: Map<string, string>): unknown => value;

/** 文本类字段的写入归一：空串 = 未填（null），否则原样（不 trim 非空值）。 */
export function coerceText(_def: any, raw: any): unknown {
  const s = String(raw);
  return s.trim() === '' ? null : s;
}

/**
 * 清单类的一行：敏感子值走与顶层敏感字段同一条 displaySensitive 边界。
 * 非对象行（坏数据）原样放过。
 */
export function displayRow(
  subs: SubFieldDef[],
  row: any,
  opts: RevealOptions,
): any {
  if (!isPlainRow(row)) return row;
  const sensitiveSubs = subs.filter((s) => s.sensitive);
  if (!sensitiveSubs.length) return row;
  const out: Record<string, unknown> = { ...row };
  for (const s of sensitiveSubs) {
    if (out[s.key] !== undefined && out[s.key] !== null) out[s.key] = displaySensitive(out[s.key], opts);
  }
  return out;
}
