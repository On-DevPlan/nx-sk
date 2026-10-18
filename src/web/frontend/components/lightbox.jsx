// 图片放大查看：滚轮缩放 + 拖动平移 + Esc 关闭。
//
// 为什么不是"点开新标签页"：看部署截屏的目的通常是**读里面的一行命令/一个字段**，
// 跳到新标签会丢掉上下文（你还得记住刚才看到哪一步），回来又要重新找。
// 就地放大、看完关掉，是这个场景下唯一不打断思路的做法。
//
// 交互取舍：
//   - 滚轮缩放（鼠标位置不动）+ 拖动平移：截屏细节要靠"凑近看"
//   - 双击 / 「适应」按钮回到初始态：迷路时有个确定的返回点
//   - Esc 与点背景关闭：两个最自然的手势都认
//   - 打开时锁滚动：否则滚轮会把背后的长表单一起滚走
import { useCallback, useEffect, useRef, useState } from 'react';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function Lightbox({ item, onClose }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const boxRef = useRef(null);
  const dragRef = useRef(null);

  const reset = useCallback(() => setT({ scale: 1, x: 0, y: 0 }), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // wheel 必须用原生监听并显式 passive:false —— React 的 onWheel 在部分浏览器上
  // 是 passive 的，preventDefault 会被忽略，于是缩放的同时页面跟着滚。
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setT((prev) => ({ ...prev, scale: clamp(prev.scale * (e.deltaY < 0 ? 1.15 : 0.87), 0.2, 8) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e) => {
    dragRef.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y };
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setT((prev) => ({ ...prev, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  };
  const onPointerUp = (e) => {
    dragRef.current = null;
    if (e.currentTarget.releasePointerCapture) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    }
  };

  const { url, name, downloadUrl, path } = item || {};

  return (
    <div className="lightbox" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox-bar">
        <span className="grow nowrap" title={path || name}>{name || '图片'}</span>
        <span className="mono muted">{Math.round(t.scale * 100)}%</span>
        <button type="button" className="btn small ghost" onClick={() => setT({ scale: 1, x: 0, y: 0 })}>适应</button>
        <button type="button" className="btn small ghost" onClick={() => setT({ scale: 2, x: 0, y: 0 })}>200%</button>
        {downloadUrl ? <a className="btn small ghost" href={downloadUrl}>下载</a> : null}
        <button type="button" className="btn small" onClick={onClose}>关闭</button>
      </div>
      <div
        className="lightbox-stage"
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
      >
        <img
          src={url}
          alt={name || ''}
          draggable={false}
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }}
        />
      </div>
      <div className="lightbox-tip">滚轮缩放 · 拖动查看细节 · 双击复位 · Esc 关闭</div>
    </div>
  );
}
