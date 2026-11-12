// MappingPopup.tsx —— 按键映射 popup（长按 / hover / 双击触发），纯展示
//
// 定位、命中数据、关闭时机全部由容器算好，这里只负责把 DOM 挂到 body 上。
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import type { PopupState } from './bindingHits.ts';

interface Props {
  popup: PopupState;
  pos: { top: number; left: number };
  popupRef: MutableRefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export default function MappingPopup({ popup, pos, popupRef, onClose }: Props) {
  return createPortal(
    <div
      ref={popupRef}
      className="sl-sl-longpress"
      role="dialog"
      aria-label={`按键 ${popup.code} 的映射`}
      style={{ top: pos.top, left: pos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="sl-sl-longpress__head">
        <span className="sl-sl-longpress__title">
          按键 <code>{popup.code}</code> 的映射
        </span>
        <button className="sl-sl-icon-btn" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      {popup.hits.length === 0 ? (
        <div className="sl-sl-longpress__empty">该键尚未被任何分组使用</div>
      ) : (
        <ul className="sl-sl-longpress__list">
          {popup.hits.map((h) => (
            <li key={h.shortcutId} className="sl-sl-longpress__item">
              <div className="sl-sl-longpress__row">
                <span className="sl-sl-longpress__group">{h.groupName}</span>
                <span className="sl-sl-longpress__combo">{h.comboLabel}</span>
              </div>
              <div className="sl-sl-longpress__desc">
                {h.description || <span className="sl-sl-empty">未填写说明</span>}
              </div>
              {h.condition && <div className="sl-sl-longpress__cond">条件: {h.condition}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
