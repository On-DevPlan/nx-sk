import { badInput } from '../../errors.ts';
import { fileIdsOf } from '../../attachments.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityReveal, isSensitiveDef, noSubFields } from './common.ts';

/**
 * 值 = 附件 id（或唯一文件名）的**列表**：一个字段可以挂多个附件。
 * **新写入统一存数组**（哪怕只有一个）；历史数据里的字符串单值由 fileIdsOf 按单元素处理。
 * 不校验存在性——附件可能被还原/删掉，前端按「引用的附件不存在」展示。
 */
export const fileBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce(def, raw) {
    const list = fileIdsOf(Array.isArray(raw) ? raw : String(raw).split(/[,，、;；]+/));
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list.length ? list : null;
  },
  reveal: identityReveal,
  refs: (_def, value) => fileIdsOf(value),
  remap: (_def, value, idMap) => {
    const ids = fileIdsOf(value).map((id) => idMap.get(id) || id).filter(Boolean);
    return ids.length ? ids : null;
  },
  format: (_def, value, ctx) => {
    const asFile = (x: unknown): string | null => {
      const rec = ctx.files?.[String(x)];
      return rec ? `${rec.name}　${rec.path}` : null;
    };
    if (Array.isArray(value) && value.length && value.every((x) => asFile(x))) {
      return value.map((x) => asFile(x) as string);
    }
    const one = asFile(value);
    return one ? [one] : null;
  },
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
