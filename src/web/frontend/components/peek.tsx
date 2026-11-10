// `peek` 外壳：同一种内容（抽屉/面板）的三种呈现方式。
//
// 参考 Notion 的 side peek / center peek / full page：
//   - side     贴窗口右侧，**不遮不挡**——背后的列表还能读、还能滚（默认，也是 source 的现状）
//   - center   居中弹层，带遮罩，焦点锁在面板里（Esc 关闭，Tab 不跑到背后）
//   - fullpage 铺满窗口，适合「这条内容自己就是一页」的编辑（快捷键面板默认这个）
//
// #6：头部按钮改成 Notion「打开方式」菜单（截图对照见 docs/behavior-parity.md §0.30.0）：
//   四项形态 + 「新标签页」深链 + 分隔线 + 「编辑默认视图」二级菜单。
//   尺寸/间距/勾选位置按截图量取（见 CSS 注释），不引入图标库，一律内联 SVG。
//
// 可访问性（WCAG 2.2 AA）：
//   - center / fullpage 是 `role="dialog" aria-modal="true"`：背后内容对读屏不可达
//   - 遮罩层点击与 Esc 都能关；关闭后焦点还给打开它的那个元素
//   - Tab / Shift+Tab 在 center / fullpage 里循环；side 保持「不拦焦点」的现状
//   - 菜单：role=menu / menuitemradio，↑↓ Home End 移动，→ 进二级，← 退二级，
//     Esc 只关菜单（stopPropagation，不连带关面板），关菜单后焦点回触发按钮
//   - reduced-motion 下所有进入动画关闭（见 styles.css 的 `.peek` 段）
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PeekMode = 'side' | 'center' | 'fullpage';

/** 菜单里的三项形态。顺序是可见行为：side 在最上，与默认态对齐。 */
export const PEEK_MODES: Array<{ id: PeekMode; label: string; title: string }> = [
  { id: 'side', label: '侧边预览', title: '侧边预览（不遮挡后面的内容）' },
  { id: 'center', label: '居中预览', title: '居中预览（带遮罩，焦点锁在面板内）' },
  { id: 'fullpage', label: '整页', title: '整页（铺满窗口，适合独自编辑这一条）' },
];

const MODES = PEEK_MODES.map((m) => m.id);
const STORAGE_PREFIX = 'nx-sk-peek-default:';

function isPeekMode(value: unknown): value is PeekMode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}

/** 「编辑默认视图」写进 localStorage 的形态；隐私模式下读写失败就退回 fallback。 */
export function peekDefault(key: string, fallback: PeekMode): PeekMode {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    return isPeekMode(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function setPeekDefault(key: string, mode: PeekMode): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, mode);
  } catch {
    /* 隐私模式/配额满：默认视图不持久化，但当前切换仍然生效 */
  }
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => (
    !el.hasAttribute('hidden') && el.getClientRects().length > 0
  ));
}

/* ── 内联图标（16×16，Notion 菜单的线性图标同构） ───────────────── */

function IconSide() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3.5" y="3.7" width="3.4" height="8.6" rx="1.1" fill="currentColor" />
    </svg>
  );
}

function IconCenter() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="5.2" y="4.8" width="5.6" height="6.4" rx="1.1" fill="currentColor" />
    </svg>
  );
}

function IconFull() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.6 5.9h8.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function IconNewTab() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <rect x="4.6" y="2.4" width="8.9" height="9.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="4.8" width="8.9" height="8.8" rx="2" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconDefault() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path d="M2.6 5.2h10.8M2.6 10.8h10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6.1" cy="5.2" r="1.7" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="10.8" r="1.7" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path d="M3.2 8.4l3.1 3.1 6.5-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModeIcon({ mode }: { mode: PeekMode }) {
  if (mode === 'center') return <IconCenter />;
  if (mode === 'fullpage') return <IconFull />;
  return <IconSide />;
}

export interface PeekProps {
  /** 给读屏的面板名。 */
  ariaLabel: string;
  /** 头部主标题。 */
  title: ReactNode;
  /** 头部副标题（栏目 · 条目名之类）。 */
  subtitle?: ReactNode;
  /** 头部右侧的小标记（条数等），模式按钮之前。 */
  meta?: ReactNode;
  mode: PeekMode;
  onMode: (mode: PeekMode) => void;
  onClose: () => void;
  /** 附加类名（内容自己的样式挂在它下面）。 */
  className?: string;
  /** 「新标签页」的目标（`#/<栏目>?entry=<id>`）；不给则菜单里不出现这一项。 */
  newTabHref?: string;
  /** 「编辑默认视图」的持久化键（source / shortcut）；不给则二级菜单不出现。 */
  persistKey?: string;
  /** 没有存过默认值时用哪个形态（source=side，shortcut=fullpage）。 */
  defaultMode?: PeekMode;
  children: ReactNode;
}

export function Peek({
  ariaLabel, title, subtitle, meta, mode, onMode, onClose, className,
  newTabHref, persistKey, defaultMode = 'side', children,
}: PeekProps) {
  const panelRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const modal = mode !== 'side';

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [defaultView, setDefaultView] = useState<PeekMode>(() => (
    persistKey ? peekDefault(persistKey, defaultMode) : defaultMode
  ));

  const closeMenu = (focusTrigger = false) => {
    setMenuOpen(false);
    setSubOpen(false);
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  // 关闭后把焦点还给打开它的元素。只在这个焦点「已经丢在面板里 / body 上」时归还，
  // 避免和内容自己的焦点策略（例如 source 关闭后聚焦折叠条）打架。
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    restoreRef.current = opener && opener !== document.body ? opener : null;
    return () => {
      const el = restoreRef.current;
      if (!el || !document.contains(el)) return;
      const active = document.activeElement;
      if (active === document.body || active === null || panel?.contains(active)) {
        el.focus({ preventScroll: true });
      }
    };
  }, []);

  // 弹层态锁背景滚动；side 不锁（现状：侧栏打开时仍可滚左边）。
  useEffect(() => {
    if (!modal) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [modal]);

  // Esc 挂在 window（冒泡），与迁移前 source 的监听位置一致：
  // 内部 Lightbox 在 document 上 stopPropagation 时，Esc 只关 Lightbox、不连带关面板。
  // 菜单自己的 Esc 会 stopPropagation，所以「先关菜单、再按一次才关面板」。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 焦点陷阱只在 center / fullpage 生效：Tab 到边界就绕回另一端；
  // 焦点意外落到面板外（例如点了遮罩）时拉回第一项。
  useEffect(() => {
    if (!modal) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
      if (!root) return;
      const list = focusableIn(root);
      if (!list.length) { e.preventDefault(); root.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !root.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  // 菜单打开：焦点落到当前选中项（Notion 同款）；点外面关闭。
  useEffect(() => {
    if (!menuOpen) return undefined;
    const el = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
      || menuRef.current?.querySelector<HTMLElement>('[data-peek-row]');
    el?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  const pickMode = (next: PeekMode) => {
    onMode(next);
    closeMenu(true);
  };

  const pickDefault = (next: PeekMode) => {
    if (persistKey) setPeekDefault(persistKey, next);
    setDefaultView(next);
    // 默认视图同时作用于「现在」：Notion 的默认项就是让这个页面按该形态打开，
    // 只写盘不改当前形态会让人以为没生效。
    onMode(next);
    closeMenu(true);
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = menuRef.current;
    if (!root) return;
    if (e.key === 'Escape') {
      // 只关菜单：不回传给 window 的「关闭面板」
      e.stopPropagation();
      if (subOpen) { setSubOpen(false); focusRow(menuRef.current, 'default'); } else { closeMenu(true); }
      return;
    }
    if (e.key === 'ArrowLeft' && subOpen) {
      e.preventDefault();
      setSubOpen(false);
      focusRow(menuRef.current, 'default');
      return;
    }
    if (e.key === 'ArrowRight') {
      const active = document.activeElement as HTMLElement | null;
      if (persistKey && active?.dataset.peekRow === 'default') {
        e.preventDefault();
        setSubOpen(true);
        focusRow(menuRef.current, 'default-option', defaultView);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rows = menuRows(root);
      if (!rows.length) return;
      const active = document.activeElement as HTMLElement | null;
      const at = rows.indexOf(active as HTMLElement);
      let next = 0;
      if (e.key === 'End') next = rows.length - 1;
      else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % rows.length;
      else if (e.key === 'ArrowUp') next = at <= 0 ? rows.length - 1 : at - 1;
      rows[next].focus();
    }
  };

  return createPortal((
    <>
      {modal ? (
        <div
          className="peek-backdrop"
          aria-hidden
          onMouseDown={(e) => {
            // 先挡住默认的焦点转移：否则 mousedown 的默认行为会在卸载后把焦点丢给 body，
            // 覆盖掉「关闭后焦点还给打开者」。
            e.preventDefault();
            if (e.target === e.currentTarget) onClose();
          }}
        />
      ) : null}
      <aside
        ref={panelRef}
        className={`peek peek-${mode}${className ? ` ${className}` : ''}`}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal ? true : undefined}
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        <div className="peek-head">
          <strong className="nowrap">{title}</strong>
          {subtitle ? <span className="muted nowrap">{subtitle}</span> : null}
          <span className="grow" />
          {meta}
          <div className="peek-mode-wrap" ref={wrapRef}>
            <button
              ref={triggerRef}
              type="button"
              className="peek-mode-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`打开方式（当前：${modeLabel(mode)}）`}
              title={`打开方式（当前：${modeLabel(mode)}）`}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              <ModeIcon mode={mode} />
              <span className="peek-mode-caret" aria-hidden />
            </button>
            {menuOpen ? (
              <div
                ref={menuRef}
                className="peek-menu"
                role="menu"
                aria-label="打开方式"
                onKeyDown={onMenuKey}
              >
                {PEEK_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === m.id}
                    data-peek-row={m.id}
                    className="peek-menu-row"
                    title={m.title}
                    onClick={() => pickMode(m.id)}
                  >
                    <span className="peek-menu-icon"><ModeIcon mode={m.id} /></span>
                    <span className="peek-menu-label">{m.label}</span>
                    <span className="peek-menu-check">{mode === m.id ? <IconCheck /> : null}</span>
                  </button>
                ))}
                {newTabHref ? (
                  <a
                    role="menuitem"
                    data-peek-row="newtab"
                    className="peek-menu-row"
                    href={newTabHref}
                    target="_blank"
                    rel="noreferrer"
                    title="在新标签页打开这一条"
                    onClick={() => closeMenu()}
                  >
                    <span className="peek-menu-icon"><IconNewTab /></span>
                    <span className="peek-menu-label">新标签页</span>
                    <span className="peek-menu-check" />
                  </a>
                ) : null}
                {persistKey ? (
                  <>
                    <div className="peek-menu-sep" role="separator" />
                    <div
                      className="peek-menu-subwrap"
                      onMouseEnter={() => setSubOpen(true)}
                      onMouseLeave={() => setSubOpen(false)}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-peek-row="default"
                        aria-haspopup="menu"
                        aria-expanded={subOpen}
                        className="peek-menu-row"
                        onClick={() => setSubOpen(true)}
                      >
                        <span className="peek-menu-icon"><IconDefault /></span>
                        <span className="peek-menu-label">编辑默认视图</span>
                        <span className="peek-menu-check"><span className="peek-menu-chev" aria-hidden /></span>
                      </button>
                      {subOpen ? (
                        <div className="peek-submenu" role="menu" aria-label="默认视图">
                          {PEEK_MODES.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={defaultView === m.id}
                              data-peek-row="default-option"
                              data-mode={m.id}
                              className="peek-menu-row"
                              title={`以后打开默认用「${m.label}」`}
                              onClick={() => pickDefault(m.id)}
                            >
                              <span className="peek-menu-label">{m.label}</span>
                              <span className="peek-menu-check">{defaultView === m.id ? <IconCheck /> : null}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="btn small ghost" onClick={onClose} title="关闭（Esc）">关闭</button>
        </div>
        <div className="peek-body">{children}</div>
      </aside>
    </>
  ), document.body);
}

function modeLabel(mode: PeekMode): string {
  return PEEK_MODES.find((m) => m.id === mode)?.label || mode;
}

/** 菜单里当前可见的行（二级展开时含二级项），顺序即 DOM 顺序。 */
function menuRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-peek-row]')].filter((el) => el.getClientRects().length > 0);
}

function focusRow(menu: HTMLElement | null, row: string, mode?: PeekMode) {
  requestAnimationFrame(() => {
    const selector = mode
      ? `[data-peek-row="${row}"][data-mode="${mode}"]`
      : `[data-peek-row="${row}"]`;
    menu?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  });
}
