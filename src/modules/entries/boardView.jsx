import { useMemo } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Empty } from '../../web/frontend/components/ui.jsx';
import { UNGROUPED, bucketByGroup } from '../../shared/views.js';

/**
 * 看板视图：按某个 select 字段分组，一列 = 一个候选值。
 *
 * **拖卡 = 写操作**（设计 §19.5）：改的是条目的 select 字段值，不是「这一屏的临时状态」，
 * 所以别的视图（表格/精简）立刻能看到同一个改动。写回走 `PATCH /api/entries/:id`
 * （= `entry update --set 字段=值`），前端不持有第二份真相。
 *
 * 两条边界：
 *   · 值不在候选里（字段被改过 / 历史脏数据）→ 进「未分组」列，**不静默丢**；
 *   · 「未分组」列只读作落点（把它当落点等于清空字段，语义要另定，不在这一版含糊实现）。
 *
 * 分桶规则本身在 shared/views.js 的 bucketByGroup —— 纯函数、可单测、只有一份实现。
 */

function Card({ entry, group, columns, mask, onPick, activeId }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card:${entry.id}`,
    data: { id: entry.id, group },
  });
  const style = { transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.35 : 1 };
  const bits = (columns || []).slice(0, 2).map((c) => {
    const v = entry.values ? entry.values[c.key] : undefined;
    if (c.missing) return null;
    if (c.sensitive) return mask ? String(v ?? '') : '••••••';
    if (v === null || v === undefined || v === '') return null;
    if (Array.isArray(v)) return v.length ? v.join('、') : null;
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (typeof v === 'object') return null;
    return String(v);
  }).filter(Boolean);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`board-card${entry.id === activeId ? ' on' : ''}`}
      {...attributes}
      {...listeners}
      onClick={() => onPick && onPick(entry.id)}
      title="拖到别的列 = 改这个字段的值；点一下 = 在右边打开"
    >
      <div className="board-card-title nowrap">{entry.title || '（无名）'}</div>
      {bits.length ? <div className="board-card-meta nowrap">{bits.join(' · ')}</div> : null}
    </div>
  );
}

function Column({ group, label, entries, columns, mask, onPick, activeId, droppable }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${group}`,
    data: { group },
    disabled: !droppable,
  });
  return (
    <div className="board-col">
      <div className="board-colhead">
        <span className="nowrap">{label}</span>
        <span className="muted">{entries.length}</span>
      </div>
      <div ref={setNodeRef} className={`board-drop${isOver && droppable ? ' over' : ''}${droppable ? '' : ' readonly'}`}>
        {entries.length ? entries.map((e) => (
          <Card key={e.id} entry={e} group={group} columns={columns} mask={mask} onPick={onPick} activeId={activeId} />
        )) : <div className="board-empty muted">{droppable ? '拖到这里' : '（空）'}</div>}
      </div>
    </div>
  );
}

export default function BoardView({ entries, columns, groupBy, groupOptions, mask, onMove, onPick, activeId }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // options 的引用要稳定：它进 useMemo 依赖，每次渲染新数组 = 分桶每次重算
  const options = useMemo(() => (Array.isArray(groupOptions) ? groupOptions : []), [groupOptions]);
  const cards = useMemo(() => (columns || []).filter((c) => c.key !== groupBy), [columns, groupBy]);
  const { buckets, ungrouped } = useMemo(
    () => bucketByGroup(entries || [], groupBy, options),
    [entries, groupBy, options],
  );

  if (!groupBy) {
    return <Empty>这个看板视图没有分组字段（section view update &lt;栏目&gt; &lt;视图&gt; --groupby 字段）。</Empty>;
  }
  if (!entries || !entries.length) {
    return <Empty>还没有条目。点右上角「新建条目」，或用 CLI：nx-sk entry add --section …</Empty>;
  }
  if (!options.length) {
    return <Empty>分组字段「{groupBy}」没有候选值（select 字段才有 options），看板无从分列。</Empty>;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={(ev) => {
        const card = ev.active?.data?.current;
        const col = ev.over?.data?.current;
        if (!card || !col || !onMove) return;
        if (String(card.group) === String(col.group)) return;
        // 落点必须是真候选值：「未分组」不是落点（见文件头）
        if (col.group === UNGROUPED) return;
        onMove(card.id, col.group);
      }}
    >
      <div className="board">
        {options.map((o) => (
          <Column
            key={String(o)}
            group={String(o)}
            label={String(o)}
            entries={buckets.get(String(o)) || []}
            columns={cards}
            mask={mask}
            onPick={onPick}
            activeId={activeId}
            droppable
          />
        ))}
        {ungrouped.length ? (
          <Column
            group={UNGROUPED}
            label="未分组"
            entries={ungrouped}
            columns={cards}
            mask={mask}
            onPick={onPick}
            activeId={activeId}
            droppable={false}
          />
        ) : null}
      </div>
    </DndContext>
  );
}
