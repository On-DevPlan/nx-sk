// group（分组容器）的后端行为：它没有值，只有「引用哪些字段」。
//
// 0.42 的核心：组是字段，不是条目模板上的第二份结构。所以这条行为刻意做到最轻——
// 值恒为空、不参与完整度、不算附件引用；唯一的实质工作是把 `keys` 规范化
// （去重、去自己、只留字符串），层级修复由 shared/fields/structure.ts 的
// normalizeStructure() 统一收口（读路径与写入路径共用，这里不重复一套）。
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, noSubFields } from './common.ts';

export const groupBehavior: FieldBehavior = {
  cell: false,
  normalizeDef(raw, def) {
    const keys = Array.isArray(raw?.keys) ? raw.keys : [];
    const me = String(def?.key ?? raw?.key ?? '');
    const out: string[] = [];
    for (const k of keys) {
      const key = String(k ?? '').trim();
      if (!key || key === me || out.includes(key)) continue;
      out.push(key);
    }
    def.keys = out;
    if (!def.label) def.label = me;
    // 组不参与「该填什么」——它没有值。
    def.fill = 'optional';
  },
  // 没有值：任何写入都归成 null（存储里也不会出现 group 的值）。
  coerce: () => null,
  reveal: identityReveal,
  refs: () => [],
  remap: identityRemap,
  format: (def, _value) => {
    const keys = Array.isArray(def?.keys) ? def.keys.map(String) : [];
    return [`分组容器 · ${keys.length} 个字段`];
  },
  sensitive: () => false,
  subFields: noSubFields,
};

