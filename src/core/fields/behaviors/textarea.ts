import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields,
} from './common.ts';

export const textareaBehavior: FieldBehavior = {
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
