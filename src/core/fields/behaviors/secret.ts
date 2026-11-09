// secret 的**加密**在写入前处理（entries/service.js 的 prepareValue，需要 vault 密钥、
// 还要识别「面板把打码值原样回传」），不属于 coerce 的纯归一；这里只做形状归一。
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields,
} from './common.ts';

export const secretBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce: coerceText,
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  format: () => null,
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
