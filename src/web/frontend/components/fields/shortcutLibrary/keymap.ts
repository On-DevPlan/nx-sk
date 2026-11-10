// keymap.ts —— KeyboardEvent.code → 显示标签
// 与参考实现 shortcut-library/src/engine/keymap.ts 保持一致：常用键覆盖，未命中走兜底。

export const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
]);

export const LABEL_MAP: Record<string, string> = {
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  ShiftLeft: 'Shift', ShiftRight: 'Shift',
  AltLeft: 'Alt', AltRight: 'Alt',
  MetaLeft: '⌘', MetaRight: '⌘',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Insert: 'Ins', Home: 'Home', PageUp: 'PgUp', Delete: 'Del', End: 'End', PageDown: 'PgDn',
  Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: '⌫',
  Space: 'Space',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
  Backquote: '`',
};

export function labelFor(code: string, fallbackKey: string): string {
  if (LABEL_MAP[code]) return LABEL_MAP[code];
  if (code.startsWith('Key')) return code.slice(3); // KeyR → R
  if (code.startsWith('Digit')) return code.slice(5); // Digit1 → 1
  if (code.startsWith('F') && /^F\d{1,2}$/.test(code)) return code; // F1..F12
  return fallbackKey.toUpperCase();
}

export function isModifier(code: string): boolean {
  return MODIFIER_CODES.has(code);
}
