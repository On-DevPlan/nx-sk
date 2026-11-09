import { mdImageIds, rewriteMdImages } from '../../mdimages.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import {
  coerceText, identityReveal, isSensitiveDef, noSubFields,
} from './common.ts';

export const mdBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce: coerceText,
  reveal: identityReveal,
  refs: (_def, value) => mdImageIds(value),
  remap: (_def, value, idMap) => {
    if (typeof value !== 'string') return value;
    return value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m: string, alt: string, id: string) => (
      idMap.has(id) ? `![${alt}](${idMap.get(id)})` : m
    ));
  },
  format: (_def, value, ctx) => {
    // 图文字段：`![说明](f_x)` → `[图片: 说明] 本地路径`，否则 CLI 只吐一串 id。
    const text = rewriteMdImages(String(value), (id: string) => ctx.files?.[id] || null);
    return text.includes('\n') ? text.split('\n') : [text];
  },
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
