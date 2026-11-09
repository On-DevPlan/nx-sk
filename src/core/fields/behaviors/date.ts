// date 与 month 在**顶层字段**上不校验格式（历史数据接受 2026/10/30 这类写法）；
// 严格的 2026-10-29 / 2026-10 只在表格列上生效（见 shared/table.js 的 coerceCell）。
// 这是既有行为，P2 只做搬家，不在这里顺手收紧。
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields,
} from './common.ts';

export const dateBehavior: FieldBehavior = {
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
