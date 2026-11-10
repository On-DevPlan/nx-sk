import { badInput } from '../../errors.ts';
import { normalizeShortcutGroups, comboLabel } from '../../../shared/shortcut.ts';
import type { FieldBehavior } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, isSensitiveDef, noRefs, noSubFields } from './common.ts';

/**
 * 快捷键（分组）：值 = [{ name, shortcuts: [{ combo, description, condition? }] }]。
 *
 * 为什么不做成普通 `tags`：快捷键是「组 → 条目 → 按键」三层，条目要带说明和生效条件，
 * 面板要按组渲染、点击条目高亮键盘图；字符串数组撑不起这些。
 * combo 支持 `"Ctrl+R"`、`["Ctrl","R"]` 和 `[{code,label}]` 三种写法（见 shared/shortcut.ts）。
 */
export const shortcutBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce(def, raw) {
    try {
      return normalizeShortcutGroups(raw);
    } catch (e) {
      throw badInput(`字段「${def.label}」的快捷键有问题：${(e as Error).message}`);
    }
  },
  reveal: identityReveal,
  refs: noRefs,
  remap: identityRemap,
  format: (_def, value) => {
    if (!Array.isArray(value) || !value.length) return null;
    const lines: string[] = [];
    for (const group of value as any[]) {
      const shortcuts = Array.isArray(group?.shortcuts) ? group.shortcuts : [];
      lines.push(`[${group?.name || '未命名'}] ${shortcuts.length} 条`);
      for (const s of shortcuts) {
        const condition = s?.condition ? `（${s.condition}）` : '';
        lines.push(`  ${comboLabel(s?.combo)}　${s?.description || ''}${condition}`);
      }
    }
    return lines;
  },
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};
