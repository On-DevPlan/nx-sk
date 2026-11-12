// bindingHits.ts —— 按键 code → 已绑定快捷键的命中查找（键盘 popup 用）
import type { ShortcutGroup } from '../../../../../shared/fields/types.ts';

export interface PopupState {
  code: string;
  rect: DOMRect;
  hits: BindingHit[];
}

export interface BindingHit {
  shortcutId: string;
  groupName: string;
  comboLabel: string;
  description: string;
  condition?: string;
}

export function findBindingsByCode(groups: ShortcutGroup[], code: string): BindingHit[] {
  const hits: BindingHit[] = [];
  for (const g of groups) {
    for (const s of g.shortcuts) {
      if (!s.combo.some((k) => k.code === code)) continue;
      hits.push({
        shortcutId: s.id,
        groupName: g.name,
        comboLabel: s.combo.map((k) => k.label).join('+'),
        description: s.description,
        ...(s.condition ? { condition: s.condition } : {}),
      });
    }
  }
  return hits;
}
