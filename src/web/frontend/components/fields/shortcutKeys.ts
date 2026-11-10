// 键盘图的静态版式：主键区 + 导航区。
//
// `w` 是键帽的**相对宽度**（1 = 一个字母键），行内用 flex-grow 铺开，
// 所以不用记像素、容器多宽都能自适应。`code` 与 KeyboardEvent.code 对齐，
// 面板据此把组合键里的键位点亮。
export interface KeyCap {
  code: string;
  label: string;
  w?: number;
}

export const MAIN_ROWS: KeyCap[][] = [
  [
    { code: 'Escape', label: 'Esc', w: 1.4 },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((n) => ({ code: `Digit${n}`, label: n })),
    { code: 'Minus', label: '-' },
    { code: 'Equal', label: '=' },
    { code: 'Backspace', label: 'Backspace', w: 2 },
  ],
  [
    { code: 'Tab', label: 'Tab', w: 1.6 },
    ...['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'].map((k) => ({ code: `Key${k}`, label: k })),
    { code: 'BracketLeft', label: '[' },
    { code: 'BracketRight', label: ']' },
    { code: 'Backslash', label: '\\', w: 1.4 },
  ],
  [
    { code: 'CapsLock', label: 'Caps', w: 1.8 },
    ...['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'].map((k) => ({ code: `Key${k}`, label: k })),
    { code: 'Semicolon', label: ';' },
    { code: 'Quote', label: "'" },
    { code: 'Enter', label: 'Enter', w: 2.2 },
  ],
  [
    { code: 'ShiftLeft', label: 'Shift', w: 2.4 },
    ...['Z', 'X', 'C', 'V', 'B', 'N', 'M'].map((k) => ({ code: `Key${k}`, label: k })),
    { code: 'Comma', label: ',' },
    { code: 'Period', label: '.' },
    { code: 'Slash', label: '/' },
    { code: 'ShiftRight', label: 'Shift', w: 2.6 },
  ],
  [
    { code: 'ControlLeft', label: 'Ctrl', w: 1.4 },
    { code: 'MetaLeft', label: 'Meta', w: 1.2 },
    { code: 'AltLeft', label: 'Alt', w: 1.2 },
    { code: 'Space', label: 'Space', w: 6.2 },
    { code: 'AltRight', label: 'Alt', w: 1.2 },
    { code: 'MetaRight', label: 'Meta', w: 1.2 },
    { code: 'ContextMenu', label: 'Menu', w: 1.2 },
    { code: 'ControlRight', label: 'Ctrl', w: 1.4 },
  ],
];

export const NAV_ROWS: KeyCap[][] = [
  [{ code: 'PrintScreen', label: 'PrtSc' }, { code: 'ScrollLock', label: 'ScrLk' }, { code: 'Pause', label: 'Pause' }],
  [{ code: 'Insert', label: 'Ins' }, { code: 'Home', label: 'Home' }, { code: 'PageUp', label: 'PgUp' }],
  [{ code: 'Delete', label: 'Del' }, { code: 'End', label: 'End' }, { code: 'PageDown', label: 'PgDn' }],
  [],
  [{ code: '', label: '' }, { code: 'ArrowUp', label: '↑' }, { code: '', label: '' }],
  [{ code: 'ArrowLeft', label: '←' }, { code: 'ArrowDown', label: '↓' }, { code: 'ArrowRight', label: '→' }],
];
