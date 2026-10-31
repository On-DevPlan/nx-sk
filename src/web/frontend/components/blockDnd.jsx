/* 块拖拽排序的 dnd-kit 包装（S3 触点 8 的「块顺序」部分）。
 *
 * 分工：dnd-kit 管顺序，手写管尺寸——容器块内部布局不参与拖拽。
 * 只支持**顶层**块的排序：容器 children 的拖拽要沿 findContainer 算目标容器，
 * 与「把手在嵌套层级里点不准」两个问题纠缠，留给整壳迁移（S6）一起做。
 *
 * 把手交互：整块可拖会干扰输入框里的文本选择（distance 约束拦不住双击选词），
 * 所以把手只放在块头（blk-drag），listener 绑在把手上。
 */

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * @param {string[]} ids 顶层块 id（顺序即当前顺序）
 * @param {(from:number, to:number) => void} onMove 落点回调（arrayMove 语义）
 */
export default function BlockDnd({ ids, children, onMove }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(ev) => {
        const { active, over } = ev;
        if (!over || active.id === over.id) return;
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0 || from === to) return;
        onMove(from, to);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * 可排序的块外壳。children 是**函数**：拿到把手 props（绑到块头的 ⠿ 上）。
 * @param {{id:string}} props
 */
export function SortableBlk({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        position: 'relative',
        zIndex: isDragging ? 5 : undefined,
      }}
    >
      {children({
        // 拖拽期间禁掉文本选择（松手即恢复）；attributes 是 dnd-kit 的键盘可达性标注
        ...attributes,
        ...listeners,
        role: 'button',
        'aria-label': '拖动排序',
        title: '拖动调整块顺序',
        className: 'blk-drag',
      })}
    </div>
  );
}
