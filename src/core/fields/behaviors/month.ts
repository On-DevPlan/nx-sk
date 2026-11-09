// 与 date 同一口径：顶层 month 只做「空串 = 未填」，格式校验留给表格列。
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields,
} from './common.ts';

export const monthBehavior: FieldBehavior = {
  cell: true,
  normalizeDef: () => {},
  coerce: coerceText,
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  format: () => null,
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
