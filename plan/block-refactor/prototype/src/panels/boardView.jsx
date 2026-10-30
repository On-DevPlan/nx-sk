/* 看板投影 —— 看板视图的渲染（栏目面板内的一种视图）
 *
 * 列 = select 字段的候选值；**拖卡 = 改条目的 select 字段值**（写操作，不是本地态）。
 * 真实实现走 `entry update --set <字段>=<新值>`；原型直接改内存数据，语义一致。
 */

import { useMemo } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, useDroppable } from '@dnd-kit/core';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useApp } from '../appctx.jsx';

export default function BoardView({ section, view }) {
  const { openPanel, moveEntryToGroup } = useApp();
  const field = (section.fields || []).find((f) => f.key === view?.groupBy) || null;
  const groups = field?.options || [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const byGroup = useMemo(() => {
    const m = new Map(groups.map((g) => [g, []]));
    for (const e of section.entries || []) {
      const g = e.values?.[field?.key];
      if (m.has(g)) m.get(g).push(e);
    }
    return m;
  }, [section.entries, groups, field]);

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={(e) => {
        const card = e.active.data.current;
        const col = e.over?.data?.current;
        if (!card || !col || !field) return;
        if (card.group === col.group) return;
        moveEntryToGroup(card.id, section.id, field.key, col.group);
      }}
    >
      <div style={{ display: 'flex', gap: 12, padding: 12, alignItems: 'flex-start', overflow: 'auto', height: '100%' }}>
        {groups.map((g) => (
          <Column key={g} group={g} entries={byGroup.get(g) || []} onOpen={openPanel} />
        ))}
      </div>
    </DndContext>
  );
}

function Column({ group, entries, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group}`, data: { group } });
  return (
    <div style={{ width: 220, flexShrink: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{group}</div>
      <div
        ref={setNodeRef}
        style={{
          border: `1px solid ${isOver ? 'var(--mid)' : 'var(--soft-2)'}`,
          borderRadius: 8, padding: 6, minHeight: 60,
          background: isOver ? 'var(--soft)' : undefined,
        }}
      >
        {entries.map((e) => (
          <Card key={e.id} entry={e} group={group} onOpen={onOpen} />
        ))}
        {!entries.length ? <div className="muted" style={{ padding: 4 }}>（空）</div> : null}
      </div>
    </div>
  );
}

function Card({ entry, group, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card:${entry.id}`,
    data: { id: entry.id, group },
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen('detail', { entryId: entry.id }, entry.title)}
      className="nowrap"
    >
      <div
        style={{
          border: '1px solid var(--soft-2)', borderRadius: 6, padding: 6, marginBottom: 4,
          background: 'var(--paper)', cursor: 'grab',
        }}
      >
        <div style={{ fontWeight: 600 }}>{entry.title}</div>
        <div className="muted" style={{ fontSize: 11 }}>
          {entry.values?.phone || entry.values?.name || '—'}
        </div>
      </div>
    </div>
  );
}
