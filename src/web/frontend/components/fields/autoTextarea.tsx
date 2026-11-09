// 自适应高度 textarea：所见即所得，填多少显示多少。
// 被 textarea 字段与图文（md）字段共用，所以单独一盏文件——两处必须同一套手感。
import { useLayoutEffect, useRef } from 'react';

/**
 * - 初始 `minRows` 行（避免空字段塌成一坨）；输入后按 scrollHeight 撑开
 * - `resize: none` + `overflow: hidden` 关掉浏览器默认的拖拽手柄与滚动条（自适应时两者会打架）
 * - reset 'auto' → 测 scrollHeight → 设回：删字时能正确回缩，而不是黏在上一次的高
 * - 用 useLayoutEffect 而非 useEffect，避免一帧的「旧高度 + 新内容」闪一下
 * - `textareaRef` 供图文字段读光标位置；其余 props 透传（onPaste 等）
 */
export function AutoTextarea({
  value, onChange, minRows = 2, placeholder, disabled, maxLength, maxHeight, textareaRef, ...rest
}: any) {
  const ref = useRef<any>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    // maxHeight 用于长文（图文 SOP 动辄几百行）：不封顶的话 auto-height 会把
    // 整页撑到几千像素，下面的预览和图库全被推到看不见的地方。
    el.style.height = `${maxHeight ? Math.min(h, maxHeight) : h}px`;
    el.style.overflowY = maxHeight && h > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  return (
    <textarea
      {...rest}
      ref={(el) => {
        ref.current = el;
        if (textareaRef) textareaRef.current = el;
      }}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      rows={minRows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      style={{ resize: 'none', overflow: 'hidden', width: '100%' }}
    />
  );
}
