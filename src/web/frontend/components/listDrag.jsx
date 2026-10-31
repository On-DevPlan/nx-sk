// 平铺列表的拖拽排序（**原生 HTML5 DnD，不引第三方**）。
//
// 为什么不用 dnd-kit（块拖拽用的那套）：块是嵌套容器、还要顾触屏与键盘，那套值；
// 表格的行 / 列是**平铺列表**，原生 DnD 就够，而且不让前端多一个依赖。
//
// 三个刻意的选择：
//   1. **只有把手可拖**。整行 `draggable` 会跟输入框里的文本选择打架——
//      想选一段文字，结果把整行拖走了。把手是唯一的拖拽入口。
//   2. 落点按**上/下半**（行）或**左/右半**（列）算插入位，画一条 2px 的插入线，
//      不是「整行高亮」——高亮说不清到底会插到哪儿。
//   3. 拖起来的幽灵用**整行**（setDragImage）：搬走的是「这一行」，不是「这个把手」。
import { useCallback, useState } from 'react';
import { reorderAt } from '../listSort.js';

export { reorderAt };

/**
 * @param {(from:number, insertAt:number) => void} onMove 落点回调（插入位语义）
 * @param {{axis?: 'y' | 'x'}} [opts] 默认 'y'（上下分半）；列用 'x'（左右分半）
 */
export function useListDrag(onMove, { axis = 'y' } = {}) {
  const [from, setFrom] = useState(null); // 起点下标；null = 当前没在拖
  const [at, setAt] = useState(null); // { index, after } 插入点

  const reset = useCallback(() => { setFrom(null); setAt(null); }, []);

  /**
   * 拖拽起点。**整项可拖**时用这个（表头格：里面没有输入框，不会跟文本选择打架）；
   * 有输入框的地方用 `handleProps`（只让把手可拖）。
   */
  const dragStartProps = useCallback((index) => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = 'move';
      // 有些环境（老 Safari / 个别 IME）不给 setData，包一层：不影响拖拽本身
      try { e.dataTransfer.setData('text/plain', String(index)); } catch { /* 忽略 */ }
      const whole = e.currentTarget.closest?.('[data-drag-item]') || e.currentTarget;
      if (e.dataTransfer.setDragImage && whole) e.dataTransfer.setDragImage(whole, 10, 8);
      setFrom(index);
    },
    onDragEnd: reset,
  }), [reset]);

  /** 把手：绑到 ⠿ 上（等价于 dragStartProps + 把手的样式与无障碍标注）。 */
  const handleProps = useCallback((index) => ({
    className: 'tf-grip',
    title: '拖动调整顺序',
    'aria-label': '拖动调整顺序',
    ...dragStartProps(index),
  }), [dragStartProps]);

  /** 被排序的那一项（行 / 列 / 表头格）：既是落点判定区，也用来定位「整行」做拖影。 */
  const itemProps = useCallback((index) => ({
    'data-drag-item': '',
    onDragOver: (e) => {
      if (from === null) return; // 不是本列表在拖（或拖的是别的东西）→ 不接管
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = e.currentTarget.getBoundingClientRect();
      const after = axis === 'y'
        ? e.clientY - r.top > r.height / 2
        : e.clientX - r.left > r.width / 2;
      if (!at || at.index !== index || at.after !== after) setAt({ index, after });
    },
    onDrop: (e) => {
      if (from === null) return;
      e.preventDefault();
      const after = at && at.index === index ? at.after : false;
      const target = index + (after ? 1 : 0);
      reset();
      onMove(from, target);
    },
  }), [at, axis, from, onMove, reset]);

  /** 插入线的位置：'' | 'drop-before' | 'drop-after'。 */
  const dropClass = useCallback((index) => {
    if (from === null || !at || at.index !== index) return '';
    return at.after ? ' drop-after' : ' drop-before';
  }, [at, from]);

  return { handleProps, dragStartProps, itemProps, dropClass, draggingIndex: from };
}
