import type { MouseEvent as ReactMouseEvent } from 'react';
import { Empty } from '../../components/ui.tsx';
import { shortcutCount } from '../../components/fields/shortcut.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';

/**
 * 左栏条目列表（含拖宽分隔条）。纯展示：选中态、勾选集合与回调全部由容器传入，
 * 这里不持有任何 state/hook，DOM 与 className 与拆分前逐字一致。
 */
export default function EntryListColumn({
  listW,
  sectionId,
  entries,
  count,
  selected,
  allPicked,
  shortcutDefs,
  draftId,
  dragging,
  onToggleAll,
  onClear,
  onTogglePick,
  onPick,
  onCopyRef,
  onStartDrag,
  onResetDrag,
}: {
  listW: number;
  sectionId: string;
  entries: SerializedEntry[];
  count: number;
  selected: Set<string>;
  allPicked: boolean;
  shortcutDefs: FieldDef[];
  draftId: string | undefined;
  dragging: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onTogglePick: (id: string) => void;
  onPick: (entry: SerializedEntry) => void;
  onCopyRef: (entry: { id: string; title: string }) => void;
  onStartDrag: (e: ReactMouseEvent) => void;
  onResetDrag: () => void;
}) {
  return (
    <>
      <div className="col" style={{ flex: `0 0 ${listW}px` }}>
        <div className="card">
          <div className="colhead">
            <label className="inline pickall" title="全选 / 取消全选（只影响导出与批量操作）">
              <input type="checkbox" checked={allPicked} onChange={onToggleAll} />
              <span>条目列表</span>
            </label>
            <span className="right muted">
              {selected.size ? `已选 ${selected.size} / ${count}` : count}
              {selected.size ? <button type="button" className="btn small ghost" onClick={onClear}>清空</button> : null}
            </span>
          </div>
          <div className="colbody">
            {entries.length ? entries.map((e) => (
              <div
                key={e.id}
                className={`row selectable ${e.id === draftId ? 'selected' : ''}`}
                onClick={() => onPick(e)}
              >
                <input
                  type="checkbox"
                  className="pick"
                  checked={selected.has(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={() => onTogglePick(e.id)}
                  title="选中后可只导出这一条"
                />
                <span className="name">{e.title || '（无名）'}</span>
                <span className="acts">
                  {shortcutDefs.map((def) => {
                    const c = shortcutCount(e.values[def.key]);
                    return (
                      <span key={def.key} className="tag" title={`${def.label}：${c.groups} 组 · ${c.items} 条`}>
                        {c.groups} 组 · {c.items} 条
                      </span>
                    );
                  })}
                  {e.missing.length ? <span className="tag">{e.completeness.ratio}%</span> : <span className="tag strong">已填满</span>}
                  <button
                    type="button"
                    className="row-copy"
                    title="复制条目定位（贴给 agent 即可修改）"
                    onClick={(ev) => { ev.stopPropagation(); onCopyRef(e); }}
                  >⧉</button>
                </span>
              </div>
            )) : <Empty>还没有条目。点右上角「新建条目」，或用 CLI：nx-sk entry add --section {sectionId} --set ...</Empty>}
          </div>
        </div>
      </div>

      <div
        className={`col-splitter${dragging ? ' active' : ''}`}
        title="拖动调整左右宽度（双击恢复默认）"
        onMouseDown={onStartDrag}
        onDoubleClick={onResetDrag}
      />
    </>
  );
}
