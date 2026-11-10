// shortcut 字段的纯函数：组合键解析、展示名、值的归一。
//
// 这一层不碰 fs / DOM，服务端（写入归一）、CLI（格式化）和前端（展示）共用同一套
// 键位名字，避免「面板显示 Ctrl，导出变成 ControlLeft」这种不一致。
import type { ShortcutGroup, ShortcutItem, ShortcutStroke } from './fields/types.ts';

interface ModifierDef {
  code: string;
  label: string;
}

const MODIFIERS: Record<string, ModifierDef> = {
  ctrl: { code: 'ControlLeft', label: 'Ctrl' },
  control: { code: 'ControlLeft', label: 'Ctrl' },
  shift: { code: 'ShiftLeft', label: 'Shift' },
  alt: { code: 'AltLeft', label: 'Alt' },
  option: { code: 'AltLeft', label: 'Alt' },
  opt: { code: 'AltLeft', label: 'Alt' },
  meta: { code: 'MetaLeft', label: 'Meta' },
  cmd: { code: 'MetaLeft', label: 'Meta' },
  command: { code: 'MetaLeft', label: 'Meta' },
  win: { code: 'MetaLeft', label: 'Meta' },
  super: { code: 'MetaLeft', label: 'Meta' },
};

/** 常用键的中文/口语别名 → KeyboardEvent.code。 */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape', escape: 'Escape',
  enter: 'Enter', return: 'Enter',
  space: 'Space', spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace', back: 'Backspace',
  delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp',
  pagedown: 'PageDown', pgdn: 'PageDown', pgdown: 'PageDown',
  up: 'ArrowUp', arrowup: 'ArrowUp',
  down: 'ArrowDown', arrowdown: 'ArrowDown',
  left: 'ArrowLeft', arrowleft: 'ArrowLeft',
  right: 'ArrowRight', arrowright: 'ArrowRight',
  comma: 'Comma', period: 'Period', dot: 'Period',
  slash: 'Slash', backslash: 'Backslash',
  semicolon: 'Semicolon', quote: 'Quote',
  bracketleft: 'BracketLeft', bracketright: 'BracketRight',
  minus: 'Minus', equal: 'Equal', backquote: 'Backquote',
  capslock: 'CapsLock', contextmenu: 'ContextMenu',
};

const MODIFIER_ORDER = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

export function isModifierCode(code: string): boolean {
  return MODIFIER_ORDER.includes(code);
}

/** 把一个 code 变成展示名（KeyR → R，Digit1 → 1，NumpadAdd → Num +）。 */
export function labelOfCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) {
    const tail = code.slice(6);
    return tail ? `Num ${tail}` : 'Num';
  }
  if (/^F\d{1,2}$/.test(code)) return code;
  for (const m of Object.values(MODIFIERS)) if (m.code === code) return m.label;
  const alias = Object.entries(KEY_ALIASES).find(([, v]) => v === code);
  if (alias) return alias[0].replace(/^./, (c) => c.toUpperCase());
  return code;
}

function strokeFromToken(token: string): ShortcutStroke {
  const raw = token.trim();
  if (!raw) throw new Error('组合键里有空键位');
  const lower = raw.toLowerCase();
  const mod = MODIFIERS[lower];
  if (mod) return { ...mod, isModifier: true };

  const aliased = KEY_ALIASES[lower];
  if (aliased) return { code: aliased, label: labelOfCode(aliased) };

  if (/^[a-z]$/.test(lower)) return { code: `Key${lower.toUpperCase()}`, label: lower.toUpperCase() };
  if (/^\d$/.test(lower)) return { code: `Digit${lower}`, label: lower };
  if (/^f\d{1,2}$/.test(lower)) return { code: lower.toUpperCase(), label: lower.toUpperCase() };
  // 已经写成 code 的（KeyR / ArrowUp / Numpad1 …）原样收下
  if (/^(Key|Digit|Numpad|Arrow|F\d)[A-Za-z0-9]+$/.test(raw)) {
    return { code: raw, label: labelOfCode(raw) };
  }
  throw new Error(`认不出键位「${raw}」`);
}

function sortCombo(strokes: ShortcutStroke[]): ShortcutStroke[] {
  const rank = (s: ShortcutStroke) => {
    const i = MODIFIER_ORDER.indexOf(s.code);
    return i >= 0 ? i : MODIFIER_ORDER.length;
  };
  return [...strokes].sort((a, b) => rank(a) - rank(b));
}

/**
 * 接受三种写法，统一成 stroke 数组：
 *   - `"Ctrl+Shift+R"`（CLI --set 最省事）
 *   - `["Ctrl", "R"]`
 *   - `[{ code: "KeyR", label: "R" }, ...]`（面板存下来的形态）
 */
export function parseCombo(raw: unknown): ShortcutStroke[] {
  if (raw === null || raw === undefined) throw new Error('缺少 combo（组合键）');
  let tokens: Array<string | ShortcutStroke>;
  if (typeof raw === 'string') {
    tokens = raw.split('+');
  } else if (Array.isArray(raw)) {
    tokens = raw as Array<string | ShortcutStroke>;
  } else {
    tokens = [raw as ShortcutStroke];
  }
  const strokes = tokens.map((token) => {
    if (typeof token === 'string') return strokeFromToken(token);
    if (!token || typeof token !== 'object') throw new Error('combo 里有一项不是字符串或按键对象');
    const code = String((token as ShortcutStroke).code || '').trim();
    if (!code) throw new Error('combo 里有一项缺少 code');
    const label = String((token as ShortcutStroke).label || '').trim() || labelOfCode(code);
    const isModifier = (token as ShortcutStroke).isModifier ?? isModifierCode(code);
    return { code, label, ...(isModifier ? { isModifier: true } : {}) };
  });
  if (!strokes.length) throw new Error('combo 不能为空');
  const codes = strokes.map((s) => s.code);
  if (new Set(codes).size !== codes.length) throw new Error('combo 里有重复键位');
  return sortCombo(strokes);
}

/** `Ctrl+Shift+R` 这种给人看的写法。 */
export function comboLabel(combo: unknown): string {
  if (!Array.isArray(combo) || !combo.length) return '';
  return combo.map((s: any) => String(s?.label || s?.code || '')).filter(Boolean).join('+');
}

function normalizeItem(raw: any, groupIndex: number, itemIndex: number): ShortcutItem {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`第 ${groupIndex + 1} 组第 ${itemIndex + 1} 条不是对象`);
  }
  const combo = parseCombo(raw.combo ?? raw.keys);
  // 说明允许为空：参考实现 `addShortcut` 不做非空校验，面板里「未填写」是合法状态。
  const description = String(raw.description ?? raw.desc ?? '').trim();
  const condition = String(raw.condition ?? '').trim();
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `s${groupIndex + 1}-${itemIndex + 1}`;
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : undefined;
  return {
    id,
    combo,
    description,
    ...(condition ? { condition } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

/**
 * 值的归一：接受数组、`{ groups: [...] }`、JSON 字符串。
 * 错误信息带「第几组第几条」，CLI 直接能看懂该改哪里。
 */
export function normalizeShortcutGroups(raw: unknown): ShortcutGroup[] {
  if (raw === null || raw === undefined) return [];
  let data = raw;
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text) return [];
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('需要一个 JSON 数组，每项形如 { "name": "全局", "shortcuts": [{ "combo": "Ctrl+R", "description": "刷新" }] }');
    }
  }
  let groupsRaw: unknown = data;
  if (!Array.isArray(data) && data && typeof data === 'object' && Array.isArray((data as any).groups)) {
    groupsRaw = (data as any).groups;
  }
  if (!Array.isArray(groupsRaw)) {
    throw new Error('需要一个数组：[{ "name": "全局", "shortcuts": [...] }]');
  }

  const groups: ShortcutGroup[] = [];
  groupsRaw.forEach((g: any, gi) => {
    if (!g || typeof g !== 'object') throw new Error(`第 ${gi + 1} 组不是对象`);
    const name = String(g.name ?? g.title ?? '').trim();
    if (!name) throw new Error(`第 ${gi + 1} 组缺少 name`);
    const itemsRaw = Array.isArray(g.shortcuts) ? g.shortcuts : (Array.isArray(g.items) ? g.items : null);
    if (!itemsRaw) throw new Error(`组「${name}」缺少 shortcuts 数组`);
    const shortcuts = itemsRaw.map((it: unknown, si: number) => normalizeItem(it, gi, si));
    const id = typeof g.id === 'string' && g.id.trim() ? g.id.trim() : `g${gi + 1}`;
    const createdAt = Number.isFinite(g.createdAt) ? Number(g.createdAt) : undefined;
    const updatedAt = Number.isFinite(g.updatedAt) ? Number(g.updatedAt) : undefined;
    groups.push({
      id,
      name,
      shortcuts,
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  });
  return groups;
}
