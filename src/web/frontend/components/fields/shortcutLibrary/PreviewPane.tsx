// PreviewPane.tsx —— 主区底部的键盘预览（折叠条 + 只读键盘，拖拽改高）
//
// 纯展示子树：没有自己的 state / effect / memo，尺寸与按键状态全部由容器传入。
import type {
  Dispatch, KeyboardEvent as ReactKeyboardEvent, MutableRefObject,
  PointerEvent as ReactPointerEvent, SetStateAction,
} from 'react';
import Keyboard from './Keyboard.tsx';

interface Props {
  previewCollapsed: boolean;
  previewHeight: number;
  previewRef: MutableRefObject<HTMLElement | null>;
  previewInnerRef: MutableRefObject<HTMLDivElement | null>;
  setPreviewCollapsed: Dispatch<SetStateAction<boolean>>;
  startDrag: (type: 'sidebar' | 'preview', e: ReactPointerEvent<HTMLElement>) => void;
  onSplitterKeyDown: (type: 'sidebar' | 'preview', e: ReactKeyboardEvent) => void;
  highlightedCodes: Set<string>;
  hoveredCodes: Set<string>;
  heldKeys: Set<string>;
  boundCodes: Set<string> | undefined;
  holdPress: (code: string) => void;
  holdRelease: (code: string) => void;
  handleHoverEnter: (code: string, rect: DOMRect) => void;
  handleHoverLeave: () => void;
  handleDoubleClickKey: (code: string, rect: DOMRect) => void;
}

export default function PreviewPane({
  previewCollapsed, previewHeight, previewRef, previewInnerRef, setPreviewCollapsed,
  startDrag, onSplitterKeyDown, highlightedCodes, hoveredCodes, heldKeys, boundCodes,
  holdPress, holdRelease, handleHoverEnter, handleHoverLeave, handleDoubleClickKey,
}: Props) {
  return (
    <>
      {!previewCollapsed && (
        <div
          className="sl-sl-resize-handle sl-sl-resize-handle--row"
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={previewHeight}
          aria-label="调整键盘预览高度"
          tabIndex={0}
          onPointerDown={(e) => startDrag('preview', e)}
          onKeyDown={(e) => onSplitterKeyDown('preview', e)}
        />
      )}
      <section
        ref={previewRef}
        className={`sl-sl-preview ${previewCollapsed ? 'is-collapsed' : ''}`}
        style={previewCollapsed ? undefined : { ['--sl-sl-preview-h' as string]: `${previewHeight}px` }}
      >
        <div ref={previewInnerRef} className="sl-sl-panel__inner sl-sl-panel__inner--preview">
          <div className="sl-sl-preview__head">
            <span className="sl-sl-preview__title">键盘预览</span>
            <span className="sl-sl-preview__hint">
              {previewCollapsed
                ? '已折叠 · 点右侧展开查看按键状态'
                : hoveredCodes.size > 0
                  ? '悬浮在表格行上'
                  : highlightedCodes.size > 0
                    ? '高亮的是最近一次录入的按键'
                    : '在页面上按下任意键试试 →'}
            </span>
            <button
              className="sl-sl-icon-btn sl-sl-preview__toggle"
              title={previewCollapsed ? '展开键盘预览' : '收起键盘预览'}
              aria-label={previewCollapsed ? '展开键盘预览' : '收起键盘预览'}
              aria-expanded={!previewCollapsed}
              onClick={() => setPreviewCollapsed((v) => !v)}
            >
              {previewCollapsed ? '▴' : '▾'}
            </button>
          </div>
          {!previewCollapsed && (
            <Keyboard
              highlightedCodes={highlightedCodes}
              hoveredCodes={hoveredCodes}
              heldKeys={heldKeys}
              boundCodes={boundCodes}
              onPress={holdPress}
              onRelease={holdRelease}
              onKeyHoverEnter={handleHoverEnter}
              onKeyHoverLeave={handleHoverLeave}
              onDoubleClickKey={handleDoubleClickKey}
            />
          )}
        </div>
      </section>
    </>
  );
}
