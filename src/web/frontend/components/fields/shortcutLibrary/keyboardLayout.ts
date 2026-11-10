// 完整 ANSI 104 键布局（与参考实现 shortcut-library/src/data/keyboard-layout.ts 一致）。
// code 必须是 KeyboardEvent.code（e.code 直接命中，不受输入法 / Shift 影响）。

export interface KeyDef {
  code: string;
  label: string;
  /** 宽度，单位 u，默认 1 */
  w?: number;
  /** 副标签（上排字符），如 1 上面的 ! */
  sub?: string;
  /** true = 纯占位，不可交互 */
  spacer?: boolean;
}

const sp = (w: number): KeyDef => ({ code: `__sp${w}`, label: '', w, spacer: true });

/** 主键区：6 行（F 行 / 数字行 / Tab 行 / Caps 行 / Shift 行 / 底行） */
export const MAIN_ROWS: KeyDef[][] = [
  // F 行
  [
    { code: 'Escape', label: 'Esc' },
    sp(1),
    { code: 'F1', label: 'F1' }, { code: 'F2', label: 'F2' },
    { code: 'F3', label: 'F3' }, { code: 'F4', label: 'F4' },
    sp(0.5),
    { code: 'F5', label: 'F5' }, { code: 'F6', label: 'F6' },
    { code: 'F7', label: 'F7' }, { code: 'F8', label: 'F8' },
    sp(0.5),
    { code: 'F9', label: 'F9' }, { code: 'F10', label: 'F10' },
    { code: 'F11', label: 'F11' }, { code: 'F12', label: 'F12' },
  ],
  // 数字行
  [
    { code: 'Backquote', label: '`', sub: '~' },
    { code: 'Digit1', label: '1', sub: '!' }, { code: 'Digit2', label: '2', sub: '@' },
    { code: 'Digit3', label: '3', sub: '#' }, { code: 'Digit4', label: '4', sub: '$' },
    { code: 'Digit5', label: '5', sub: '%' }, { code: 'Digit6', label: '6', sub: '^' },
    { code: 'Digit7', label: '7', sub: '&' }, { code: 'Digit8', label: '8', sub: '*' },
    { code: 'Digit9', label: '9', sub: '(' }, { code: 'Digit0', label: '0', sub: ')' },
    { code: 'Minus', label: '-', sub: '_' }, { code: 'Equal', label: '=', sub: '+' },
    { code: 'Backspace', label: '⌫ Backspace', w: 2 },
  ],
  // Tab 行
  [
    { code: 'Tab', label: 'Tab', w: 1.5 },
    { code: 'KeyQ', label: 'Q' }, { code: 'KeyW', label: 'W' }, { code: 'KeyE', label: 'E' },
    { code: 'KeyR', label: 'R' }, { code: 'KeyT', label: 'T' }, { code: 'KeyY', label: 'Y' },
    { code: 'KeyU', label: 'U' }, { code: 'KeyI', label: 'I' }, { code: 'KeyO', label: 'O' },
    { code: 'KeyP', label: 'P' },
    { code: 'BracketLeft', label: '[', sub: '{' },
    { code: 'BracketRight', label: ']', sub: '}' },
    { code: 'Backslash', label: '\\', sub: '|', w: 1.5 },
  ],
  // Caps 行
  [
    { code: 'CapsLock', label: 'Caps', w: 1.75 },
    { code: 'KeyA', label: 'A' }, { code: 'KeyS', label: 'S' }, { code: 'KeyD', label: 'D' },
    { code: 'KeyF', label: 'F' }, { code: 'KeyG', label: 'G' }, { code: 'KeyH', label: 'H' },
    { code: 'KeyJ', label: 'J' }, { code: 'KeyK', label: 'K' }, { code: 'KeyL', label: 'L' },
    { code: 'Semicolon', label: ';', sub: ':' },
    { code: 'Quote', label: "'", sub: '"' },
    { code: 'Enter', label: '⏎ Enter', w: 2.25 },
  ],
  // Shift 行
  [
    { code: 'ShiftLeft', label: '⇧ Shift', w: 2.25 },
    { code: 'KeyZ', label: 'Z' }, { code: 'KeyX', label: 'X' }, { code: 'KeyC', label: 'C' },
    { code: 'KeyV', label: 'V' }, { code: 'KeyB', label: 'B' }, { code: 'KeyN', label: 'N' },
    { code: 'KeyM', label: 'M' },
    { code: 'Comma', label: ',', sub: '<' },
    { code: 'Period', label: '.', sub: '>' },
    { code: 'Slash', label: '/', sub: '?' },
    { code: 'ShiftRight', label: '⇧ Shift', w: 2.75 },
  ],
  // 底行
  [
    { code: 'ControlLeft', label: 'Ctrl', w: 1.25 },
    { code: 'MetaLeft', label: 'Win', w: 1.25 },
    { code: 'AltLeft', label: 'Alt', w: 1.25 },
    { code: 'Space', label: '', w: 6.25 },
    { code: 'AltRight', label: 'Alt', w: 1.25 },
    { code: 'MetaRight', label: 'Win', w: 1.25 },
    { code: 'ContextMenu', label: 'Menu', w: 1.25 },
    { code: 'ControlRight', label: 'Ctrl', w: 1.25 },
  ],
];

/** 编辑键簇 + 方向键簇（3 列宽，与主键区 6 行对齐） */
export const NAV_ROWS: KeyDef[][] = [
  [{ code: 'PrintScreen', label: 'PrtSc' }, { code: 'ScrollLock', label: 'ScrLk' }, { code: 'Pause', label: 'Pause' }],
  [{ code: 'Insert', label: 'Ins' }, { code: 'Home', label: 'Home' }, { code: 'PageUp', label: 'PgUp' }],
  [{ code: 'Delete', label: 'Del' }, { code: 'End', label: 'End' }, { code: 'PageDown', label: 'PgDn' }],
  [], // Caps 行对应空行（让 nav 簇箭头行位置与主键 Shift 行对齐）
  [sp(1), { code: 'ArrowUp', label: '↑' }, sp(1)],
  [{ code: 'ArrowLeft', label: '←' }, { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' }],
];

/** 小键盘：grid 定位，"+" 与 "Enter" 跨两行，"0" 跨两列 */
export interface NumpadKeyDef extends KeyDef {
  col: number;
  row: number;
  colSpan?: number;
  rowSpan?: number;
}

export const NUMPAD_KEYS: NumpadKeyDef[] = [
  { code: 'NumLock', label: 'Num', col: 1, row: 1 },
  { code: 'NumpadDivide', label: '/', col: 2, row: 1 },
  { code: 'NumpadMultiply', label: '*', col: 3, row: 1 },
  { code: 'NumpadSubtract', label: '−', col: 4, row: 1 },
  { code: 'Numpad7', label: '7', col: 1, row: 2 },
  { code: 'Numpad8', label: '8', col: 2, row: 2 },
  { code: 'Numpad9', label: '9', col: 3, row: 2 },
  { code: 'NumpadAdd', label: '+', col: 4, row: 2, rowSpan: 2 },
  { code: 'Numpad4', label: '4', col: 1, row: 3 },
  { code: 'Numpad5', label: '5', col: 2, row: 3 },
  { code: 'Numpad6', label: '6', col: 3, row: 3 },
  { code: 'Numpad1', label: '1', col: 1, row: 4 },
  { code: 'Numpad2', label: '2', col: 2, row: 4 },
  { code: 'Numpad3', label: '3', col: 3, row: 4 },
  { code: 'NumpadEnter', label: '⏎', col: 4, row: 4, rowSpan: 2 },
  { code: 'Numpad0', label: '0', col: 1, row: 5, colSpan: 2 },
  { code: 'NumpadDecimal', label: '.', col: 3, row: 5 },
];

/** Mac 修饰键改名（可选：宿主传 platform=mac 时替换 label） */
export const MAC_LABEL_OVERRIDES: Record<string, string> = {
  MetaLeft: '⌘', MetaRight: '⌘',
  AltLeft: '⌥', AltRight: '⌥',
  ControlLeft: '⌃', ControlRight: '⌃',
  CapsLock: '⇪', Backspace: '⌫ Delete', Enter: '⏎ Return',
};
