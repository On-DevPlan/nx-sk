// ShortcutTable.tsx —— 当前选中分组的快捷键表格
// 与参考实现 shortcut-library/src/pages/ShortcutTable.tsx 的结构、交互、类名保持一致。
import { useEffect, useMemo, useState } from 'react';
import type { ShortcutGroup, ShortcutItem, ShortcutStroke } from '../../../../../shared/fields/types.ts';
import CapturePopover from './CapturePopover.tsx';
import { ComboDisplay } from './KeyChip.tsx';

interface Props {
  group: ShortcutGroup;
  query: string;
  onAddShortcut: (combo: ShortcutStroke[], description: string, condition?: string) => void;
  onUpdateShortcut: (shortcutId: string, patch: Partial<Pick<ShortcutItem, 'combo' | 'description' | 'condition'>>) => void;
  onDeleteShortcut: (shortcutId: string) => void;
  onCapture: (codes: Set<string>) => void;
  onHover?: (codes: Set<string> | null) => void;
  onShortcutHover?: (shortcut: ShortcutItem | null, rect: DOMRect | null) => void;
}

function comboKey(combo: ShortcutStroke[]): string {
  return combo.map((k) => k.code).join('+');
}

function comboLabel(combo: ShortcutStroke[]): string {
  return combo.map((k) => k.label).join(' + ');
}

export default function ShortcutTable({
  group,
  query,
  onAddShortcut,
  onUpdateShortcut,
  onDeleteShortcut,
  onCapture,
  onHover,
  onShortcutHover,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftDesc, setDraftDesc] = useState('');
  const [draftCondition, setDraftCondition] = useState('');
  // 删除二次确认：第一下 × 变 ?，再点同一行的 ? 才真删；切分组/失焦自动取消。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 条件筛选：'' 表示全部；选中某个 condition 值时只显示条件完全相同的行。
  const [condFilter, setCondFilter] = useState('');

  useEffect(() => {
    setConfirmDeleteId(null);
  }, [group.id]);

  // 当前分组内去重后的 condition 值（纯备注，可为空；非空才进选项）。
  const conditionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of group.shortcuts) if (s.condition) set.add(s.condition);
    return [...set].sort();
  }, [group.shortcuts]);

  useEffect(() => {
    setCondFilter((prev) => (prev && conditionOptions.includes(prev) ? prev : ''));
  }, [conditionOptions]);

  // 冲突判定：同一 group 内 combo 完全相同算冲突。
  const conflictMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of group.shortcuts) m.set(comboKey(s.combo), (m.get(comboKey(s.combo)) ?? 0) + 1);
    const conflicts = new Set<string>();
    for (const [k, c] of m) if (c > 1) conflicts.add(k);
    return conflicts;
  }, [group.shortcuts]);

  const q = query.trim().toLowerCase();
  const filtered = group.shortcuts.filter((s) => {
    if (condFilter && s.condition !== condFilter) return false;
    if (!q) return true;
    if (s.description.toLowerCase().includes(q)) return true;
    if (s.condition?.toLowerCase().includes(q)) return true;
    if (comboLabel(s.combo).toLowerCase().includes(q)) return true;
    return false;
  });

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setDraftDesc('');
    setDraftCondition('');
  }

  function commitAdd(combo: ShortcutStroke[], condition: string) {
    onAddShortcut(combo, draftDesc, condition);
    onCapture(new Set(combo.map((k) => k.code)));
    setAdding(false);
    setDraftDesc('');
    setDraftCondition('');
  }

  function commitEdit(id: string, combo: ShortcutStroke[], condition: string) {
    onUpdateShortcut(id, { combo, condition });
    onCapture(new Set(combo.map((k) => k.code)));
    setEditingId(null);
  }

  return (
    <section className="sl-sl-table">
      <header className="sl-sl-table__head">
        <div>
          <h2 className="sl-sl-table__title">{group.name}</h2>
          <span className="sl-sl-table__sub">{group.shortcuts.length} 条快捷键</span>
        </div>
        <div className="sl-sl-table__actions">
          {conditionOptions.length > 0 && (
            <select
              className="sl-sl-filter"
              value={condFilter}
              onChange={(e) => setCondFilter(e.target.value)}
              aria-label="按条件筛选"
            >
              <option value="">全部条件</option>
              {conditionOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
          <button
            className="sl-sl-btn sl-sl-btn--primary"
            onClick={startAdd}
            disabled={adding}
          >
            + 新增快捷键
          </button>
        </div>
      </header>

      {group.shortcuts.length === 0 && !adding ? (
        <div className="sl-sl-table__empty">
          还没有快捷键,点击右上角&ldquo;新增快捷键&rdquo;开始。
        </div>
      ) : (
        <div className="sl-sl-table__viewport">
          <table className="sl-sl-table__grid">
            <thead>
              <tr>
                <th className="sl-sl-table__col-combo">组合键</th>
                <th className="sl-sl-table__col-cond">条件</th>
                <th className="sl-sl-table__col-desc">说明</th>
                <th className="sl-sl-table__col-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const isEditing = editingId === s.id;
                const isConflict = conflictMap.has(comboKey(s.combo)) && !isEditing;
                if (isEditing) {
                  return (
                    <tr key={s.id} className="sl-sl-row sl-sl-row--editing">
                      <td colSpan={4}>
                        <CapturePopover
                          initial={s.combo}
                          initialCondition={s.condition ?? ''}
                          onConfirm={(c, cond) => commitEdit(s.id, c, cond)}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr
                    key={s.id}
                    className={`sl-sl-row ${isConflict ? 'sl-sl-row--conflict' : ''}`}
                    title={isConflict ? '同组内已有相同组合' : undefined}
                    onMouseEnter={(e) => {
                      onHover?.(new Set(s.combo.map((k) => k.code)));
                      if (onShortcutHover) {
                        onShortcutHover(s, (e.currentTarget as HTMLElement).getBoundingClientRect());
                      }
                    }}
                    onMouseLeave={() => {
                      onHover?.(null);
                      onShortcutHover?.(null, null);
                    }}
                  >
                    <td className="sl-sl-table__col-combo">
                      <ComboDisplay combo={s.combo} />
                      {isConflict && <span className="sl-sl-table__conflict-tag">冲突</span>}
                    </td>
                    <td className="sl-sl-table__col-cond">
                      {s.condition || <span className="sl-sl-empty">—</span>}
                    </td>
                    <td className="sl-sl-table__col-desc">
                      {s.description || <span className="sl-sl-empty">未填写</span>}
                    </td>
                    <td className="sl-sl-table__col-act">
                      <button
                        className="sl-sl-icon-btn"
                        onClick={() => {
                          setAdding(false);
                          setEditingId(s.id);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className={`sl-sl-icon-btn sl-sl-icon-btn--danger${confirmDeleteId === s.id ? ' is-confirming' : ''}`}
                        title={confirmDeleteId === s.id ? '再点一次确认删除' : '删除'}
                        onClick={() => {
                          if (confirmDeleteId === s.id) {
                            onDeleteShortcut(s.id);
                            setConfirmDeleteId(null);
                          } else {
                            setConfirmDeleteId(s.id);
                          }
                        }}
                        onBlur={() => {
                          if (confirmDeleteId === s.id) setConfirmDeleteId(null);
                        }}
                      >
                        {confirmDeleteId === s.id ? '?' : '×'}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {adding && (
                <tr className="sl-sl-row sl-sl-row--adding">
                  <td colSpan={4}>
                    <div className="sl-sl-add-row">
                      <input
                        className="sl-sl-input sl-sl-input--desc"
                        placeholder="说明,例如 打开目录"
                        value={draftDesc}
                        onChange={(e) => setDraftDesc(e.target.value)}
                        autoFocus
                      />
                      <input
                        className="sl-sl-input sl-sl-input--cond"
                        placeholder="条件(可选),例如 选中数字时"
                        value={draftCondition}
                        onChange={(e) => setDraftCondition(e.target.value)}
                      />
                      <CapturePopover
                        initialCondition={draftCondition}
                        onConfirm={commitAdd}
                        onCancel={() => {
                          setAdding(false);
                          setDraftDesc('');
                          setDraftCondition('');
                        }}
                      />
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {filtered.length === 0 && group.shortcuts.length > 0 && (
            <div className="sl-sl-table__empty">
              {condFilter
                ? `没有条件为“${condFilter}”${q ? ` 且匹配“${query}”` : ''} 的快捷键`
                : `没有匹配“${query}”的快捷键`}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

