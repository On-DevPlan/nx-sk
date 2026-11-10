// `peek` 外壳：同一种内容（抽屉/面板）的三种呈现方式。
//
// 参考 Notion 的 side peek / center peek / full page：
//   - side     贴窗口右侧，**不遮不挡**——背后的列表还能读、还能滚（默认，也是 source 的现状）
//   - center   居中弹层，带遮罩，焦点锁在面板里（Esc 关闭，Tab 不跑到背后）
//   - fullpage 铺满窗口，适合「这条内容自己就是一页」的编辑（快捷键面板默认这个）
//
// 三态只改**容器**，内容组件不必知道自己现在多大。切换按钮放在面板头，
// 每个用到 peek 的地方都能自由切——不是每个字段各自实现一套。
//
// 可访问性（WCAG 2.2 AA）：
//   - center / fullpage 是 `role="dialog" aria-modal="true"`：背后内容对读屏不可达
//   - 遮罩层点击与 Esc 都能关；关闭后焦点还给打开它的那个元素
//   - Tab / Shift+Tab 在 center / fullpage 里循环；side 保持「不拦焦点」的现状
//   - reduced-motion 下所有进入动画关闭（见 styles.css 的 `.peek` 段）
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PeekMode = 'side' | 'center' | 'fullpage';

/** 三态的顺序与按钮文案。顺序是可见行为：side 在最左，与默认态对齐。 */
export const PEEK_MODES: Array<{ id: PeekMode; label: string; title: string }> = [
  { id: 'side', label: '侧边', title: '侧边显示（不遮挡后面的内容）' },
  { id: 'center', label: '居中', title: '居中弹层（带遮罩，焦点锁在面板内）' },
  { id: 'fullpage', label: '全屏', title: '铺满窗口（适合独自编辑这一条）' },
];

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => (
    !el.hasAttribute('hidden') && el.getClientRects().length > 0
  ));
}

export interface PeekProps {
  /** 给读屏的面板名。 */
  ariaLabel: string;
  /** 头部主标题。 */
  title: ReactNode;
  /** 头部副标题（栏目 · 条目名之类）。 */
  subtitle?: ReactNode;
  /** 头部右侧的小标记（条数等），模式切换按钮之前。 */
  meta?: ReactNode;
  mode: PeekMode;
  onMode: (mode: PeekMode) => void;
  onClose: () => void;
  /** 附加类名（内容自己的样式挂在它下面）。 */
  className?: string;
  children: ReactNode;
}

export function Peek({
  ariaLabel, title, subtitle, meta, mode, onMode, onClose, className, children,
}: PeekProps) {
  const panelRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const modal = mode !== 'side';

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
          <div className="peek-modes" role="group" aria-label="窗口大小">
            {PEEK_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn small ghost${mode === m.id ? ' on' : ''}`}
                aria-pressed={mode === m.id}
                title={m.title}
                onClick={() => onMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn small ghost" onClick={onClose} title="关闭（Esc）">关闭</button>
        </div>
        <div className="peek-body">{children}</div>
      </aside>
    </>
  ), document.body);
}
