// import-parser.ts —— Zero-dependency TOML subset parser for ShortcutLibrary import.
// Supports only the subset defined in the import spec:
//   - [[groups]] array-of-tables headers
//   - [[groups.shortcuts]] nested array-of-tables
//   - name = "..."
//   - combo = "..."
//   - desc = "..."
//   - condition = "..."
//   - # comments

import { labelFor, isModifier } from './keymap.ts';
import type { ShortcutStroke as KeyStroke } from '../../../../../shared/fields/types.ts';

export interface ImportParseResult {
  groups: Array<{
    name: string;
    shortcuts: Array<{
      combo: KeyStroke[];
      description: string;
      condition?: string;
    }>;
  }>;
  errors: string[];
}

// Reverse lookup: display label → KeyboardEvent.code
// Only covers labels that a user might type in an import file.
// 导航簇同时收两种写法:KeyboardEvent.code 原名(PageUp)和键盘上的简写(PgUp),
// 因为用户手写 TOML 时两种都会用,而 labelFor() 最终会归一到 LABEL_MAP 的标签。
// 方向键同理:AI 生成的 TOML 经常把方向键写成英文名(Alt+Left / ArrowUp 等),
// 这里把短名(Up/Down/Left/Right)和 KeyboardEvent.code 原名(ArrowXxx)都收进来,
// 统一归一到 ArrowXxx,避免整条 combo 报「无法识别的按键」。
const LABEL_REVERSE: Record<string, string> = {
  'Ctrl': 'ControlLeft',
  'Shift': 'ShiftLeft',
  'Alt': 'AltLeft',
  '⌘': 'MetaLeft',
  'Enter': 'Enter',
  'Esc': 'Escape',
  'Tab': 'Tab',
  'Space': 'Space',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  'Up': 'ArrowUp',
  'Down': 'ArrowDown',
  'Left': 'ArrowLeft',
  'Right': 'ArrowRight',
  'ArrowUp': 'ArrowUp',
  'ArrowDown': 'ArrowDown',
  'ArrowLeft': 'ArrowLeft',
  'ArrowRight': 'ArrowRight',
  'Backspace': 'Backspace',
  'Delete': 'Delete',
  'Del': 'Delete',
  'Insert': 'Insert',
  'Ins': 'Insert',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PageUp',
  'PgUp': 'PageUp',
  'PageDown': 'PageDown',
  'PgDn': 'PageDown',
};

// Characters that map to their Symbol-key code directly
// (the char itself IS the label, e.g. "-" → "Minus")
const CHAR_TO_CODE: Record<string, string> = {
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
};

/** 还原 TOML basic string 的转义序列。
 *
 *  必须单次遍历:如果先 replace(/\\\\/g,'\\') 再 replace(/\\"/g,'"'),
 *  输入 `\\"` 会先变成 `\"` 再被第二步误判成 `"`,丢掉本该保留的引号。
 *  用一个正则 + callback 一次扫完,每个转义序列只被消费一次。
 *
 *  支持 TOML 规范里 combo/desc/condition 实际会用到的子集:
 *    \\ → \      \" → "      \n → 换行      \r → 回车      \t → 制表
 */
function unescapeBasicString(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_match, ch: string) => {
    switch (ch) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return ch; // '"' 和 '\' 直接还原成自身
    }
  });
}

/** Resolve a display-label combo like "Ctrl+R" to KeyStroke[].
 *  Returns the array on success, or an error string on failure. */
export function resolveCombo(input: string): KeyStroke[] | string {
  const trimmed = input.trim();
  if (!trimmed) return '组合键不能为空';

  const parts = trimmed.split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return '组合键格式无效';

  const strokes: KeyStroke[] = [];
  let hasNonModifier = false;

  for (const part of parts) {
    if (part.length === 1 && CHAR_TO_CODE[part]) {
      const code = CHAR_TO_CODE[part];
      strokes.push({ code, label: part, isModifier: false });
      hasNonModifier = true;
    } else if (LABEL_REVERSE[part]) {
      const code = LABEL_REVERSE[part];
      const label = labelFor(code, part);
      const mod = isModifier(code);
      strokes.push({ code, label, isModifier: mod });
      if (!mod) hasNonModifier = true;
    } else if (isModifier(part) || part === 'Ctrl' || part === 'Shift' || part === 'Alt') {
      // Direct modifier name without labelFor — Ctrl, Shift, Alt
      const code = part === 'Ctrl' ? 'ControlLeft' : part === 'Shift' ? 'ShiftLeft' : 'AltLeft';
      strokes.push({ code, label: part, isModifier: true });
    } else if (part.startsWith('F') && /^F\d{1,2}$/.test(part)) {
      strokes.push({ code: part, label: part, isModifier: false });
      hasNonModifier = true;
    } else if (part === '⌘') {
      strokes.push({ code: 'MetaLeft', label: '⌘', isModifier: true });
    } else if (part.length === 1 && /[A-Za-z0-9]/.test(part)) {
      const upper = part.toUpperCase();
      const code = /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${part}`;
      strokes.push({ code, label: upper, isModifier: false });
      hasNonModifier = true;
    } else {
      return `无法识别的按键: "${part}"`;
    }
  }

  if (!hasNonModifier) return `组合键缺少主键: "${trimmed}" (修饰键不能单独作为快捷键)`;

  return strokes;
}

/** Parse TOML import text into structured data. */
export function parseImportToml(toml: string): ImportParseResult {
  const groups: ImportParseResult['groups'] = [];
  const errors: string[] = [];
  const lines = toml.split('\n');

  let currentGroup: { name: string; shortcuts: Array<{ combo: string; desc: string; condition: string }> } | null = null;
  let inShortcuts = false;
  let pendingDesc: string | null = null;
  let pendingCondition: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) continue;

    // Array-of-tables header: [[groups]]
    if (line === '[[groups]]') {
      if (currentGroup) {
        // Finalize previous group
        finalizeGroup();
      }
      currentGroup = { name: '', shortcuts: [] };
      inShortcuts = false;
      continue;
    }

    // Array-of-tables header: [[groups.shortcuts]]
    if (line === '[[groups.shortcuts]]') {
      inShortcuts = true;
      pendingDesc = null;
      pendingCondition = null;
      continue;
    }

    // Key-value pairs
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      errors.push(`第 ${i + 1} 行: 无法解析 "${raw}"`);
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    const valRaw = line.slice(eqIdx + 1).trim();
    const val = valRaw.startsWith('"') && valRaw.endsWith('"')
      ? unescapeBasicString(valRaw.slice(1, -1))
      : valRaw;

    if (inShortcuts && currentGroup) {
      if (key === 'combo') {
        const desc = pendingDesc ?? '';
        const condition = pendingCondition ?? '';
        pendingDesc = null;
        pendingCondition = null;
        currentGroup.shortcuts.push({ combo: val, desc, condition });
      } else if (key === 'desc') {
        if (currentGroup.shortcuts.length > 0) {
          currentGroup.shortcuts[currentGroup.shortcuts.length - 1].desc = val;
        } else {
          pendingDesc = val;
        }
      } else if (key === 'condition') {
        if (currentGroup.shortcuts.length > 0) {
          currentGroup.shortcuts[currentGroup.shortcuts.length - 1].condition = val;
        } else {
          pendingCondition = val;
        }
      } else
        errors.push(`第 ${i + 1} 行: 未知字段 "${key}"`);
    } else if (!inShortcuts && currentGroup) {
      if (key === 'name') currentGroup.name = val;
      else
        errors.push(`第 ${i + 1} 行: 未知字段 "${key}"`);
    } else {
      errors.push(`第 ${i + 1} 行: 不在任何表头下的字段 "${key}"`);
    }
  }

  // Finalize last group
  if (currentGroup) finalizeGroup();

  function finalizeGroup() {
    if (!currentGroup) return;
    if (!currentGroup.name) {
      errors.push('分组缺少 name 字段,已跳过');
      currentGroup = null;
      return;
    }
    const resolvedShortcuts: ImportParseResult['groups'][0]['shortcuts'] = [];
    for (const sc of currentGroup.shortcuts) {
      const combo = resolveCombo(sc.combo);
      if (typeof combo === 'string') {
        errors.push(`分组 "${currentGroup.name}" · ${sc.combo}: ${combo}`);
        continue;
      }
      resolvedShortcuts.push({
        combo,
        description: sc.desc,
        // 空字符串归一为 undefined,避免表格里到处都是 "条件: "
        condition: sc.condition ? sc.condition : undefined,
      });
    }
    groups.push({ name: currentGroup.name, shortcuts: resolvedShortcuts });
    currentGroup = null;
    inShortcuts = false;
  }

  return { groups, errors };
}
