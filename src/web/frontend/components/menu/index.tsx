// 全站唯一的「更多按钮 + 下拉菜单」组件（任务 #9 第 5 轮，验收纠偏后定稿）。
//
// **基准样式 = 条目头的更多菜单（antd Dropdown）**。第 5 轮第一版做反了——
// 把手写 .blk-menu 面板当基准铺到全站，验收指出「其他跟随条目样式」：
// 所以这里的实现是给统一入口包一层 antd Dropdown，面板走 App.tsx 的
// ConfigProvider 主题，与条目头菜单**逐像素一致**；antd 默认把浮层 portal
// 到 body，块根 overflow:hidden 裁不到（board-bar 的旧用法已验证过）。
//
//   - 触发钮：一律 `.btn.small.ghost.icon-btn` + asset/icon 的 `dots`（⋯ 触发钮全站唯一长相）；
//     `buttonClass` 可附加类（块头传 `.blk-menu-btn` 保留 hover 浮现节奏）。
//   - API 是自定义形状（key / label / icon:IconName / danger / disabled / onClick + 'divider'），
//     调用方不感知 antd；图标只允许引用 asset/icon 功能登记表的名字（同功能禁止第二颗）。
//   - 空 items 不渲染按钮——没有动作就不该有一颗死按钮。
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { Icon } from '../../asset/icon/index.tsx';
import type { IconName } from '../../asset/icon/index.tsx';

/** 一条菜单项；`'divider'` 渲染一条分隔线。 */
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

export function MoreMenu({ items, label = '更多操作', ariaLabel, title, buttonClass }: {
  /** 菜单项（含 'divider'）。空数组时按钮不渲染。 */
  items: MoreMenuEntry[];
  /** 无障碍名 + 触发钮的 title（title 未给时）。 */
  label?: string;
  ariaLabel?: string;
  /** 触发钮 tooltip；默认用 label。长说明（如版式操作指南）走这里。 */
  title?: string;
  /** 触发钮的附加类（如块头的 hover 浮现 `.blk-menu-btn`）。 */
  buttonClass?: string;
}) {
  if (!items.length) return null;

  const menu: MenuProps = {
    items: items.map((it, i) => (
      it === 'divider'
        ? { key: `divider-${i}`, type: 'divider' as const }
        : {
            key: it.key,
            label: it.label,
            icon: it.icon ? <Icon name={it.icon} size="md" /> : undefined,
            danger: it.danger,
            disabled: it.disabled,
          }
    )),
    onClick: ({ key, domEvent }) => {
      const hit = items.find((it): it is MoreMenuItem => it !== 'divider' && it.key === key);
      if (hit) { domEvent.stopPropagation(); hit.onClick(); }
    },
  };

  return (
    <Dropdown trigger={['click']} placement="bottomRight" menu={menu}>
      <button
        type="button"
        className={`btn small ghost icon-btn${buttonClass ? ` ${buttonClass}` : ''}`}
        title={title ?? label}
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        onClick={(e) => e.stopPropagation()}
      ><Icon name="dots" size="sm" /></button>
    </Dropdown>
  );
}
