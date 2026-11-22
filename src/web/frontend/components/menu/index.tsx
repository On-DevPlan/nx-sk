// 全站唯一的「更多按钮 + 下拉菜单」组件（任务 #9 第 5 轮：样式完全对齐，抽离为一个组件）。
//
// 之前条目头 / 块板 / 条目模板 / 附件页各写一套：条目头用 antd Dropdown（默认样式），
// 块头是手写 portal 菜单，模板页又一份 —— 同一个功能三副面孔。现在收敛到这里：
//
//   **按钮**：一律 `.btn.small.ghost.icon-btn` + asset/icon 的 `dots`（⋯ 触发钮全站长这样）；
//   **面板**：portal 到 body + fixed 定位（块根是 overflow:hidden，antd 弹层会被裁），
//     `.more-menu` 一份样式（styles.css）：纸白 + 弱线 + float 投影，行高 28，hover --hover，
//     danger 项语义红，分隔线发丝；尺寸走 --icon-sm / --fs-core token。
//
// 关闭口径（沿用块菜单验证过的行为）：点任意处 / Esc / 滚动 / 改窗口尺寸都关——
// 菜单不该在页面上「漂着」。
//
// 加新菜单项前先查 asset/icon 的功能登记表：图标只允许引用登记表里的名字，
// 同功能禁止第二颗图标。
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../asset/icon/index.tsx';
import type { IconName } from '../../asset/icon/index.tsx';

/** 一条菜单项；`'divider'` 渲染一条发丝分隔线。 */
export interface MoreMenuItem {
  key: string;
  label: string;
  /** asset/icon 登记表里的图标（可选；菜单项不强制配图标）。 */
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export type MoreMenuEntry = MoreMenuItem | 'divider';

const MENU_W = 176;
const ITEM_H = 29;
const PAD = 8;

export function MoreMenu({ items, label = '更多操作', ariaLabel, title, buttonClass }: {
  /** 菜单项（含 'divider'）。空数组时按钮不渲染——没有动作就不该有一颗死按钮。 */
  items: MoreMenuEntry[];
  /** 无障碍名 + 触发钮的 title（title 未给时）。 */
  label?: string;
  ariaLabel?: string;
  /** 触发钮 tooltip；默认用 label。长说明（如版式操作指南）走这里。 */
  title?: string;
  /** 触发钮的附加类（如块头的 hover 浮现 `.blk-menu-btn`）。 */
  buttonClass?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!at) return undefined;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', close);
    };
  }, [at]);

  if (!items.length) return null;

  const toggle = () => {
    if (at) { setAt(null); return; }
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    // 面板右缘对齐按钮右缘；四周夹在视口内。下方放不下就翻到按钮上方。
    const dividers = items.filter((it) => it === 'divider').length;
    const h = items.length * ITEM_H + dividers * 9 + PAD;
    const x = Math.max(8, Math.min(b.right - MENU_W, window.innerWidth - MENU_W - 8));
    const y = b.bottom + h + 8 > window.innerHeight ? Math.max(8, b.top - h - 8) : b.bottom + 4;
    setAt({ x, y });
  };

  const style: CSSProperties = { left: at?.x, top: at?.y };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`btn small ghost icon-btn${buttonClass ? ` ${buttonClass}` : ''}`}
        title={title ?? label}
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      ><Icon name="dots" size="sm" /></button>
      {at ? createPortal(
        <div className="more-menu" style={style} role="menu" aria-label={ariaLabel ?? label}>
          {items.map((it, i) => (
            it === 'divider'
              ? <div key={`divider-${i}`} className="more-menu-divider" role="separator" />
              : (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  className={it.danger ? 'danger-item' : undefined}
                  disabled={it.disabled}
                  onClick={(e) => { e.stopPropagation(); setAt(null); it.onClick(); }}
                >
                  {it.icon ? <Icon name={it.icon} size="sm" /> : null}
                  <span>{it.label}</span>
                </button>
              )
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
