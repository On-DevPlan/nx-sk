import { BOOL_FALSE, BOOL_TRUE } from '../../fields.ts';
import { badInput } from '../../errors.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields } from './common.ts';

export const boolBehavior: FieldBehavior = {
  cell: true,
  normalizeDef: () => {},
  coerce(def, raw) {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (BOOL_TRUE.includes(s)) return true;
    if (BOOL_FALSE.includes(s)) return false;
    throw badInput(`字段「${def.label}」需要是/否，收到 ${JSON.stringify(raw)}`);
  },
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  // 只替布尔值：字符串 "true" 这类历史数据继续走通用兜底（String(v)），与重构前一致
  format: (_def, value) => (typeof value === 'boolean' ? [value ? '是' : '否'] : null),
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
