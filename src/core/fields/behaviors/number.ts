import { badInput } from '../../errors.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields } from './common.ts';

export const numberBehavior: FieldBehavior = {
  cell: true,
  normalizeDef: () => {},
  coerce(def, raw) {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) throw badInput(`字段「${def.label}」需要数字，收到 ${JSON.stringify(raw)}`);
    return n;
  },
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  format: () => null,
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
