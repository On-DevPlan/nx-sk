// persistence.ts —— 快捷键库的延迟常量、尺寸/折叠持久化与 id 生成（纯工具，无 React 依赖）
export const KEY_HOLD_MS = 400;
export const HOVER_OPEN_DELAY = 150;
export const POPUP_CLOSE_DELAY = 200;

export const PREVIEW_COLLAPSED_KEY = 'nx-sk-shortcut:previewCollapsed';
export const SIDEBAR_W_KEY = 'nx-sk-shortcut:sidebarW';
export const PREVIEW_H_KEY = 'nx-sk-shortcut:previewH';
export const SIDEBAR_DEFAULT = 280;
export const PREVIEW_DEFAULT = 200;

export function loadPreviewCollapsed(): boolean {
  try {
    return localStorage.getItem(PREVIEW_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function loadNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  } catch {
    return fallback;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
