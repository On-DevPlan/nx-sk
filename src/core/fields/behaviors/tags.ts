import { badInput } from '../../errors.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields } from './common.ts';

export const tagsBehavior: FieldBehavior = {
  cell: true,
  normalizeDef: () => {},
  coerce(def, raw) {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,，、;；\s]+/))
      .map((x) => x.trim()).filter(Boolean);
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list;
  },
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  format: () => null,
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
