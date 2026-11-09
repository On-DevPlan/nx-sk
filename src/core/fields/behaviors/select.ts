// 顶层 select **不校验候选**（写错会被原样存下）—— 这是现状，P2 不修，
// 只由 tests/unit/fields-registry.test.ts 固定住，避免将来有人顺手加校验。
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields,
} from './common.ts';

export const selectBehavior: FieldBehavior = {
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
