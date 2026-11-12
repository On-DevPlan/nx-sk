// ShortcutLibrary.tsx —— 快捷键详情面板主体
//
// 结构、类名、交互、动效全部沿用参考实现
// `ve/packages/react-components/src/shortcut-library`：
//   左 sidebar（分组目录）+ 主区（搜索 / 全屏 / 快捷键表）+ 可拖拽键盘预览，
//   外加全屏热力键盘、按键 mapping popup、行 hover tooltip。
// 数据层换成 nx-sk 的 ShortcutGroup / ShortcutItem / ShortcutStroke，
// 所有变更通过 onChange 回写字段值。
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { ShortcutGroup, ShortcutItem, ShortcutStroke } from '../../../../../shared/fields/types.ts';
import Sidebar from './Sidebar.tsx';
import ShortcutTable from './ShortcutTable.tsx';
import PreviewPane from './PreviewPane.tsx';
import MappingPopup from './MappingPopup.tsx';
import FullscreenCanvas from './FullscreenCanvas.tsx';
import ImportModal from './ImportModal.tsx';
import type { ImportParseResult } from './importParser.ts';
import {
  HOVER_OPEN_DELAY, KEY_HOLD_MS, POPUP_CLOSE_DELAY,
  PREVIEW_COLLAPSED_KEY, PREVIEW_DEFAULT, PREVIEW_H_KEY,
  SIDEBAR_DEFAULT, SIDEBAR_W_KEY,
  loadNumber, loadPreviewCollapsed, newId,
} from './persistence.ts';
import { findBindingsByCode, type PopupState } from './bindingHits.ts';
import './library.css';

interface Props {
  groups: ShortcutGroup[];
  onChange: (value: ShortcutGroup[]) => void;
}

export default function ShortcutLibrary({ groups, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groups[0]?.id ?? null);
  const [highlightedCodes, setHighlightedCodes] = useState<Set<string>>(new Set());
  const [hoveredCodes, setHoveredCodes] = useState<Set<string>>(new Set());
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState<boolean>(loadPreviewCollapsed);

  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 500;
  const PREVIEW_MIN = 80;
  const PREVIEW_MAX = 500;

  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadNumber(SIDEBAR_W_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  );
  const [previewHeight, setPreviewHeight] = useState(() =>
    loadNumber(PREVIEW_H_KEY, PREVIEW_DEFAULT, PREVIEW_MIN, PREVIEW_MAX),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<HTMLDivElement | null>(null);
  const sidebarInnerRef = useRef<HTMLDivElement | null>(null);
  const mainPanelRef = useRef<HTMLElement | null>(null);
  const mainInnerRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const previewInnerRef = useRef<HTMLDivElement | null>(null);

  const dragType = useRef<null | 'sidebar' | 'preview'>(null);
  const dragStart = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  const rafId = useRef<number | null>(null);
  const latest = useRef<{ dx: number; dy: number } | null>(null);

  function freezePanels() {
    const pairs: Array<[HTMLElement | null, HTMLElement | null]> = [
      [sidebarPanelRef.current, sidebarInnerRef.current],
      [mainPanelRef.current, mainInnerRef.current],
      [previewRef.current, previewInnerRef.current],
    ];
    for (const [panel, inner] of pairs) {
      if (!panel || !inner) continue;
      inner.style.width = `${panel.clientWidth}px`;
      inner.style.height = `${panel.clientHeight}px`;
      inner.style.contain = 'size layout paint';
    }
  }

  function unfreezePanels() {
    for (const inner of [sidebarInnerRef.current, mainInnerRef.current, previewInnerRef.current]) {
      if (!inner) continue;
      inner.style.width = '';
      inner.style.height = '';
      inner.style.contain = '';
    }
  }

  function startDrag(type: 'sidebar' | 'preview', e: ReactPointerEvent<HTMLElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragType.current = type;
    dragStart.current = { x: e.clientX, y: e.clientY, w: sidebarWidth, h: previewHeight };
    freezePanels();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = type === 'sidebar' ? 'col-resize' : 'row-resize';
    rootRef.current?.classList.add('sl-sl-dragging');
  }

  function frame() {
    rafId.current = null;
    const p = latest.current;
    if (!p) return;
    if (dragType.current === 'sidebar') {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStart.current.w + p.dx));
      rootRef.current?.style.setProperty('--sl-sl-sidebar-w', `${w}px`);
    } else if (dragType.current === 'preview') {
      const h = Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, dragStart.current.h - p.dy));
      previewRef.current?.style.setProperty('--sl-sl-preview-h', `${h}px`);
    }
    latest.current = null;
  }

  function endDrag(e: PointerEvent) {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    rootRef.current?.classList.remove('sl-sl-dragging');
    const t = dragType.current;
    if (t) {
      if (t === 'sidebar') {
        const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStart.current.w + (e.clientX - dragStart.current.x)));
        setSidebarWidth(w);
        try { localStorage.setItem(SIDEBAR_W_KEY, String(w)); } catch { /* ignore */ }
      } else {
        const h = Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, dragStart.current.h - (e.clientY - dragStart.current.y)));
        setPreviewHeight(h);
        try { localStorage.setItem(PREVIEW_H_KEY, String(h)); } catch { /* ignore */ }
      }
    }
    unfreezePanels();
    latest.current = null;
    dragType.current = null;
  }

  const endDragRef = useRef<(e: PointerEvent) => void>(() => {});
  endDragRef.current = endDrag;

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragType.current) return;
      latest.current = { dx: e.clientX - dragStart.current.x, dy: e.clientY - dragStart.current.y };
      if (rafId.current === null) rafId.current = requestAnimationFrame(frame);
    }
    function onUp(e: PointerEvent) {
      endDragRef.current(e);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const SPLIT_STEP = 16;
  function onSplitterKeyDown(type: 'sidebar' | 'preview', e: ReactKeyboardEvent) {
    if (e.key === 'ArrowRight' && type === 'sidebar') {
      e.preventDefault();
      setSidebarWidth((v) => Math.min(SIDEBAR_MAX, v + SPLIT_STEP));
    } else if (e.key === 'ArrowLeft' && type === 'sidebar') {
      e.preventDefault();
      setSidebarWidth((v) => Math.max(SIDEBAR_MIN, v - SPLIT_STEP));
    } else if (e.key === 'ArrowUp' && type === 'preview') {
      e.preventDefault();
      setPreviewHeight((v) => Math.min(PREVIEW_MAX, v + SPLIT_STEP));
    } else if (e.key === 'ArrowDown' && type === 'preview') {
      e.preventDefault();
      setPreviewHeight((v) => Math.max(PREVIEW_MIN, v - SPLIT_STEP));
    }
  }

  const [longPressPopup, setLongPressPopup] = useState<PopupState | null>(null);
  const [heldKeys, setHeldKeys] = useState<Set<string>>(new Set());
  const holdTimers = useRef<Map<string, number>>(new Map());
  const hoverTimer = useRef<number | undefined>(undefined);
  const popupCloseTimer = useRef<number | undefined>(undefined);
  const popupSourceRef = useRef<{ code: string; mode: 'hover' | 'hold' | 'dblclick' } | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const heldKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => { heldKeysRef.current = heldKeys; }, [heldKeys]);

  const [hoveredShortcut, setHoveredShortcut] = useState<{ shortcut: ShortcutItem; rect: DOMRect } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_COLLAPSED_KEY, previewCollapsed ? '1' : '0');
    } catch { /* ignore */ }
  }, [previewCollapsed]);

  // 分组被删/换位置后，选中项跟着落到第一个，避免面板空白。
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) || groups[0] || null;
  useEffect(() => {
    if (!groups.some((g) => g.id === selectedGroupId)) {
      setSelectedGroupId(groups[0]?.id ?? null);
    }
  }, [groups, selectedGroupId]);

  // ── 数据变更（全部回写字段值） ────────────────────────────────

  function addGroup(name: string) {
    const now = Date.now();
    const group: ShortcutGroup = { id: newId('g'), name, shortcuts: [], createdAt: now, updatedAt: now };
    onChange([...groups, group]);
    setSelectedGroupId(group.id);
  }

  function renameGroup(id: string, name: string) {
    onChange(groups.map((g) => (g.id === id ? { ...g, name, updatedAt: Date.now() } : g)));
  }

  function deleteGroup(id: string) {
    const next = groups.filter((g) => g.id !== id);
    onChange(next);
    if (selectedGroupId === id) setSelectedGroupId(next[0]?.id ?? null);
  }

  function addShortcut(combo: ShortcutStroke[], description: string, condition?: string) {
    if (!selectedGroup) return;
    // 与参考实现一致：说明允许为空（列表里显示「未填写」）。
    const now = Date.now();
    const item: ShortcutItem = {
      id: newId('s'),
      combo,
      description: description.trim(),
      ...(condition?.trim() ? { condition: condition.trim() } : {}),
      createdAt: now,
    };
    onChange(groups.map((g) => (
      g.id === selectedGroup.id ? { ...g, shortcuts: [...g.shortcuts, item], updatedAt: now } : g
    )));
  }

  function updateShortcut(id: string, patch: Partial<Pick<ShortcutItem, 'combo' | 'description' | 'condition'>>) {
    if (!selectedGroup) return;
    onChange(groups.map((g) => {
      if (g.id !== selectedGroup.id) return g;
      return {
        ...g,
        updatedAt: Date.now(),
        shortcuts: g.shortcuts.map((s) => {
          if (s.id !== id) return s;
          const next: ShortcutItem = { ...s, ...patch };
          if (!next.condition?.trim()) delete next.condition;
          else next.condition = next.condition.trim();
          return next;
        }),
      };
    }));
  }

  function deleteShortcut(id: string) {
    if (!selectedGroup) return;
    onChange(groups.map((g) => (
      g.id === selectedGroup.id
        ? { ...g, shortcuts: g.shortcuts.filter((s) => s.id !== id), updatedAt: Date.now() }
        : g
    )));
  }

  // ── popup 交互（hover / 长按 / 双击） ─────────────────────────

  const handleLongPress = useCallback((code: string, rect: DOMRect) => {
    const scope = selectedGroup ? [selectedGroup] : [];
    const hits = findBindingsByCode(scope, code);
    popupSourceRef.current = { code, mode: 'hold' };
    setLongPressPopup({ code, rect, hits });
  }, [selectedGroup]);

  const clearPopupCloseTimer = useCallback(() => {
    if (popupCloseTimer.current !== undefined) {
      window.clearTimeout(popupCloseTimer.current);
      popupCloseTimer.current = undefined;
    }
  }, []);

  const startPopupCloseTimer = useCallback(() => {
    clearPopupCloseTimer();
    popupCloseTimer.current = window.setTimeout(() => {
      popupCloseTimer.current = undefined;
      popupSourceRef.current = null;
      setLongPressPopup(null);
    }, POPUP_CLOSE_DELAY);
  }, [clearPopupCloseTimer]);

  const handleLongPressClose = useCallback(() => {
    clearPopupCloseTimer();
    popupSourceRef.current = null;
    setLongPressPopup(null);
  }, [clearPopupCloseTimer]);

  const handleHoverEnter = useCallback((code: string, rect: DOMRect) => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
    clearPopupCloseTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      const scope = selectedGroup ? [selectedGroup] : [];
      const hits = findBindingsByCode(scope, code);
      setLongPressPopup((prev) => {
        if (hits.length === 0) {
          if (prev && popupSourceRef.current?.mode === 'hover' && popupSourceRef.current.code !== code) {
            popupSourceRef.current = null;
            return null;
          }
          return prev;
        }
        popupSourceRef.current = { code, mode: 'hover' };
        return { code, rect, hits };
      });
    }, HOVER_OPEN_DELAY);
  }, [selectedGroup, clearPopupCloseTimer]);

  const handleHoverLeave = useCallback(() => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
    startPopupCloseTimer();
  }, [startPopupCloseTimer]);

  const handleDoubleClickKey = useCallback((code: string, rect: DOMRect) => {
    clearPopupCloseTimer();
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
    const ht = holdTimers.current.get(code);
    if (ht) {
      window.clearTimeout(ht);
      holdTimers.current.delete(code);
    }
    const scope = selectedGroup ? [selectedGroup] : [];
    const hits = findBindingsByCode(scope, code);
    popupSourceRef.current = { code, mode: 'dblclick' };
    setLongPressPopup({ code, rect, hits });
  }, [selectedGroup, clearPopupCloseTimer]);

  const findKeyRect = (code: string): DOMRect | null => {
    const el = document.querySelector(`[data-shortcut-code="${code}"]`);
    if (el instanceof HTMLElement) return el.getBoundingClientRect();
    return null;
  };

  const holdPress = useCallback((code: string) => {
    setHeldKeys((prev) => {
      if (prev.has(code)) return prev;
      const next = new Set(prev);
      next.add(code);
      return next;
    });
    const existing = holdTimers.current.get(code);
    if (existing) window.clearTimeout(existing);
    const t = window.setTimeout(() => {
      holdTimers.current.delete(code);
      const rect = findKeyRect(code) ?? (
        { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect
      );
      handleLongPress(code, rect);
    }, KEY_HOLD_MS);
    holdTimers.current.set(code, t);
  }, [handleLongPress]);

  const holdRelease = useCallback((code: string) => {
    setHeldKeys((prev) => {
      if (!prev.has(code)) return prev;
      const next = new Set(prev);
      next.delete(code);
      return next;
    });
    const t = holdTimers.current.get(code);
    if (t) {
      window.clearTimeout(t);
      holdTimers.current.delete(code);
    }
  }, []);

  // popup 打开时监听 Esc + 外部点击。Esc 用 capture 并 stopPropagation，
  // 否则 Peek 外壳的 Esc 会先把整个面板关掉（这里只该关 popup）。
  useEffect(() => {
    if (!longPressPopup) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      handleLongPressClose();
    }
    function onPointerUp(e: PointerEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.sl-sl-longpress')) return;
      handleLongPressClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [longPressPopup, handleLongPressClose]);

  useEffect(() => {
    const el = popupRef.current;
    if (!el) return undefined;
    el.addEventListener('pointerenter', clearPopupCloseTimer);
    el.addEventListener('pointerleave', startPopupCloseTimer);
    return () => {
      el.removeEventListener('pointerenter', clearPopupCloseTimer);
      el.removeEventListener('pointerleave', startPopupCloseTimer);
    };
  }, [longPressPopup, clearPopupCloseTimer, startPopupCloseTimer]);

  useEffect(() => () => {
    if (popupCloseTimer.current !== undefined) {
      window.clearTimeout(popupCloseTimer.current);
      popupCloseTimer.current = undefined;
    }
  }, []);

  // 物理键盘：按住变蓝，长按弹 mapping popup。
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.repeat) return;
      holdPress(e.code);
    }
    function onKeyUp(e: KeyboardEvent) {
      holdRelease(e.code);
    }
    function onBlur() {
      heldKeysRef.current.forEach((code) => {
        const t = holdTimers.current.get(code);
        if (t) window.clearTimeout(t);
      });
      holdTimers.current.clear();
      setHeldKeys(new Set());
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [holdPress, holdRelease]);

  // 录入高亮 3 秒后清除；长按 popup 期间挂起。
  useEffect(() => {
    if (highlightedCodes.size === 0) return undefined;
    if (longPressPopup) return undefined;
    const t = window.setTimeout(() => setHighlightedCodes(new Set()), 3000);
    return () => window.clearTimeout(t);
  }, [highlightedCodes, longPressPopup]);

  // popup 定位：在键下方，靠近视口边界时翻转。
  const longPressPopupPos = useMemo(() => {
    if (!longPressPopup) return null;
    const POPUP_WIDTH = 260;
    const POPUP_MAX_HEIGHT = 240;
    const VIEWPORT_PAD = 8;
    const GAP = 8;
    const { rect } = longPressPopup;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
    let top = rect.bottom + GAP;
    let left = rect.left;
    if (top + POPUP_MAX_HEIGHT > vh - VIEWPORT_PAD) {
      top = rect.top - GAP - POPUP_MAX_HEIGHT;
      if (top < VIEWPORT_PAD) top = vh - POPUP_MAX_HEIGHT - VIEWPORT_PAD;
    }
    if (left + POPUP_WIDTH > vw - VIEWPORT_PAD) left = vw - POPUP_WIDTH - VIEWPORT_PAD;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    return { top, left };
  }, [longPressPopup]);

  // 行 hover tooltip：出现在行的右侧，垂直居中；靠右边界时改在左侧。
  const rowtipPos = useMemo(() => {
    if (!hoveredShortcut) return null;
    const TOOLTIP_WIDTH = 240;
    const GAP = 8;
    const VIEWPORT_PAD = 8;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const { rect } = hoveredShortcut;
    let left = rect.right + GAP;
    if (left + TOOLTIP_WIDTH > vw - VIEWPORT_PAD) {
      left = rect.left - GAP - TOOLTIP_WIDTH;
      if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    }
    const top = rect.top + rect.height / 2 - 30;
    return { top, left };
  }, [hoveredShortcut]);

  const boundCodes = useMemo(() => (
    selectedGroup
      ? new Set(selectedGroup.shortcuts.flatMap((s) => s.combo.map((k) => k.code)))
      : undefined
  ), [selectedGroup]);

  const total = groups.reduce((n, g) => n + g.shortcuts.length, 0);

  // 导入 TOML：同名分组追加、新分组创建（与参考实现 store.importGroups 语义一致）
  const handleImport = useCallback((data: ImportParseResult) => {
    const stats = { groupsAdded: 0, groupsAppended: 0, shortcutsAdded: 0, errors: [...data.errors] };
    const next: ShortcutGroup[] = groups.map((g) => ({ ...g, shortcuts: [...g.shortcuts] }));
    for (const g of data.groups) {
      const existing = next.find((eg) => eg.name.toLowerCase() === g.name.toLowerCase());
      const now = Date.now();
      const added: ShortcutItem[] = g.shortcuts.map((s) => ({
        id: newId('s'),
        combo: s.combo,
        description: s.description,
        condition: s.condition,
        createdAt: now,
      }));
      if (existing) {
        existing.shortcuts.push(...added);
        existing.updatedAt = now;
        stats.groupsAppended += 1;
      } else {
        next.push({ id: newId('g'), name: g.name, shortcuts: added, createdAt: now, updatedAt: now });
        stats.groupsAdded += 1;
      }
      stats.shortcutsAdded += added.length;
    }
    onChange(next);
    return stats;
  }, [groups, onChange]);

  return (
    <div
      ref={rootRef}
      className="sl-sl-root"
      style={{ ['--sl-sl-sidebar-w' as string]: `${sidebarWidth}px` }}
    >
      <div ref={sidebarPanelRef} className="sl-sl-panel sl-sl-panel--sidebar">
        <div ref={sidebarInnerRef} className="sl-sl-panel__inner">
          <Sidebar
            groups={groups}
            selectedGroupId={selectedGroup?.id ?? null}
            onSelect={setSelectedGroupId}
            onAdd={addGroup}
            onRename={renameGroup}
            onDelete={deleteGroup}
            filter={query}
          />
        </div>
      </div>
      <div
        className="sl-sl-resize-handle sl-sl-resize-handle--col"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-label="调整侧栏宽度"
        tabIndex={0}
        onPointerDown={(e) => startDrag('sidebar', e)}
        onKeyDown={(e) => onSplitterKeyDown('sidebar', e)}
      />

      <main ref={mainPanelRef} className="sl-sl-main">
        <div ref={mainInnerRef} className="sl-sl-panel__inner sl-sl-panel__inner--main">
          <header className="sl-sl-topbar">
            <input
              className="sl-sl-input sl-sl-topbar__search"
              placeholder="搜索组合键或说明 (例如 Ctrl+R / 打开目录)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="sl-sl-btn sl-sl-btn--ghost"
              onClick={() => setImportOpen(true)}
              title="粘贴或上传 TOML 批量导入"
            >
              导入
            </button>
            <button
              className="sl-sl-btn sl-sl-btn--ghost"
              onClick={() => setCanvasOpen(true)}
              disabled={!selectedGroup}
              title="全屏查看当前组的快捷键"
            >
              全屏
            </button>
            <span className="sl-sl-topbar__meta">
              {groups.length} 个分组 · 共 {total} 条
            </span>
          </header>

          {selectedGroup ? (
            <ShortcutTable
              group={selectedGroup}
              query={query}
              onAddShortcut={addShortcut}
              onUpdateShortcut={updateShortcut}
              onDeleteShortcut={deleteShortcut}
              onCapture={setHighlightedCodes}
              onHover={(codes) => setHoveredCodes(codes ?? new Set())}
              onShortcutHover={(shortcut, rect) => {
                if (shortcut && rect) setHoveredShortcut({ shortcut, rect });
                else setHoveredShortcut(null);
              }}
            />
          ) : (
            <div className="sl-sl-empty-state">
              <h2>还没有分组</h2>
              <p>在左侧输入名称(例如 VSCode、Chrome)并点击 +,即可开始管理快捷键。</p>
            </div>
          )}

          <PreviewPane
            previewCollapsed={previewCollapsed}
            previewHeight={previewHeight}
            previewRef={previewRef}
            previewInnerRef={previewInnerRef}
            setPreviewCollapsed={setPreviewCollapsed}
            startDrag={startDrag}
            onSplitterKeyDown={onSplitterKeyDown}
            highlightedCodes={highlightedCodes}
            hoveredCodes={hoveredCodes}
            heldKeys={heldKeys}
            boundCodes={boundCodes}
            holdPress={holdPress}
            holdRelease={holdRelease}
            handleHoverEnter={handleHoverEnter}
            handleHoverLeave={handleHoverLeave}
            handleDoubleClickKey={handleDoubleClickKey}
          />
        </div>
      </main>

      {longPressPopup && longPressPopupPos && (
        <MappingPopup
          popup={longPressPopup}
          pos={longPressPopupPos}
          popupRef={popupRef}
          onClose={handleLongPressClose}
        />
      )}

      {hoveredShortcut && rowtipPos ? createPortal(
        <div className="sl-sl-rowtip" role="tooltip" style={{ top: rowtipPos.top, left: rowtipPos.left }}>
          <div className="sl-sl-rowtip__combo">
            {hoveredShortcut.shortcut.combo.map((k, i) => (
              <span key={`${k.code}-${i}`}>
                {i > 0 && <span style={{ color: 'var(--sl-color-text-mute)', margin: '0 2px' }}>+</span>}
                <kbd className="sl-sl-chip">{k.label}</kbd>
              </span>
            ))}
          </div>
          <div className="sl-sl-rowtip__desc">
            {hoveredShortcut.shortcut.description || <span className="sl-sl-empty">未填写说明</span>}
          </div>
          {hoveredShortcut.shortcut.condition && (
            <div className="sl-sl-rowtip__cond">条件: {hoveredShortcut.shortcut.condition}</div>
          )}
        </div>,
        document.body,
      ) : null}

      <FullscreenCanvas
        open={canvasOpen}
        onClose={() => setCanvasOpen(false)}
        shortcuts={selectedGroup?.shortcuts ?? []}
        groupName={selectedGroup?.name ?? ''}
      />

      {importOpen && (
        <ImportModal
          onImport={handleImport}
          onClose={() => setImportOpen(false)}
          selectedGroupName={selectedGroup?.name}
          selectedGroupShortcuts={selectedGroup?.shortcuts}
        />
      )}
    </div>
  );
}

