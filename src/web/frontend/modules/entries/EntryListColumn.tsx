import type { MouseEvent as ReactMouseEvent } from 'react';
import { Empty } from '../../components/ui.tsx';
import { shortcutCount } from '../../components/fields/shortcut.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';

/**
 * 左栏条目列表（含拖宽分隔条）。纯展示：选中态与回调全部由容器传入，
 * 这里不持有任何 state/hook，DOM 与 className 与拆分前逐字一致。
 * 导出走「导入导出」页，这里不再有勾选列。
 */
export default function EntryListColumn({
  listW,
  entries,
  count,
  shortcutDefs,
  draftId,
  dragging,
  onPick,
  onCopyRef,
  onStartDrag,
  onResetDrag,
  onAdd,
}: {
  listW: number;
  entries: SerializedEntry[];
  count: number;
  shortcutDefs: FieldDef[];
  draftId: string | undefined;
  dragging: boolean;
  onPick: (entry: SerializedEntry) => void;
  onCopyRef: (entry: { id: string; title: string }) => void;
  onStartDrag: (e: ReactMouseEvent) => void;
  onResetDrag: () => void;
  /** 空列表时也要有个显眼的「新建条目」入口（#43）。 */
  onAdd: () => void;
}) {
  return (
    <>
      <div className="col entry-list-col" style={{ flex: `0 0 ${listW}px` }}>
        <div className="card">
          <div className="colhead">
            <span className="pickall">条目列表</span>
            <span className="grow" />
            <span className="right muted">{count}</span>
            <button type="button" className="btn small ghost" onClick={onAdd} title="新建条目">＋ 新建</button>
          </div>
          <div className="colbody">
            {entries.length ? entries.map((e) => (
              <div
                key={e.id}
                className={`row selectable ${e.id === draftId ? 'selected' : ''}`}
                onClick={() => onPick(e)}
              >
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
            )) : <Empty>还没有条目。点上方「＋ 新建」创建第一条。</Empty>}
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

