import { badInput } from '../../errors.ts';
import { mdImageIds } from '../../mdimages.ts';
import { normalizeSourceItems, sourceItemSummary } from '../../source.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noSubFields } from './common.ts';

/**
 * 原始资料袋：值 = 一组 item（文字/附件/网址）。形状与归一规则见 core/source.js。
 * 三种入口都认：数组（面板/JSON）、JSON 串（--set）、一段普通文字（--set 随手记）。
 */
export const sourceBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce(def, raw) {
    try {
      return normalizeSourceItems(raw);
    } catch (e) {
      throw badInput(`字段「${def.label}」的原始资料有问题：${(e as Error).message}`);
    }
  },
  reveal: identityReveal,
  refs: (_def, value, opts) => {
    const ids: string[] = [];
    if (!Array.isArray(value)) return ids;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      if (item.kind === 'file' && item.fileId) ids.push(item.fileId);
      // text 的底层是 markdown：内嵌 `![x](f_xxx)` 是否算引用由调用点的口径决定
      //（导出打包要算；附件中心的「谁引用了它」不算——这是既有行为，P2 不改）。
      else if (opts?.sourceTextImages && item.kind === 'text' && typeof item.text === 'string') {
        for (const id of mdImageIds(item.text)) ids.push(id);
      }
    }
    return ids;
  },
  remap: (_def, value, idMap) => {
    if (!Array.isArray(value)) return identityRemap(_def, value, idMap);
    return value.map((item) => {
      if (!item || typeof item !== 'object') return item;
      if (item.kind === 'file' && item.fileId && idMap.has(item.fileId)) {
        return { ...item, fileId: idMap.get(item.fileId) };
      }
      if (item.kind === 'text' && typeof item.text === 'string') {
        return {
          ...item,
          text: item.text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m: string, alt: string, id: string) => (
            idMap.has(id) ? `![${alt}](${idMap.get(id)})` : m
          )),
        };
      }
      return item;
    });
  },
  format: (_def, value, ctx) => {
    if (!Array.isArray(value)) return null;
    const kindLabel: Record<string, string> = { text: '文字', file: '附件', url: '网址' };
    return value.map((item: any) => {
      const tag = kindLabel[item.kind] || item.kind || '资料';
      const rec = item.kind === 'file' && item.fileId ? ctx.files?.[item.fileId] : null;
      const body = rec ? `${rec.name}　${rec.path}` : sourceItemSummary(item);
      const mapped = item.mapped?.length ? `　→ 已整理到 ${item.mapped.join('、')}` : '';
      return `[${tag}] ${item.name || body}${body && body !== item.name ? `　${body}` : ''}${mapped}`;
    });
  },
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
