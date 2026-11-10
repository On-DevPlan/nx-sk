// shortcut 字段控件：折叠条只报「几组/几条」，详细面板才铺开键位与说明。
//
// 面板的骨架来自参考实现（左侧分组目录 + 右侧快捷键表 + 底部键盘图），
// 但数据只认本项目的三层结构：组(group) → 条目(shortcut) → 按键(combo)。
// 编辑直接写回字段值（onChange），与服务端 `core/fields/behaviors/shortcut.ts` 的归一一致。
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { comboLabel, labelOfCode } from '../../../../shared/shortcut.ts';
import type { ShortcutGroup, ShortcutItem, ShortcutStroke } from '../../../../shared/fields/types.ts';
import { Peek } from '../peek.tsx';
import type { PeekMode } from '../peek.tsx';
import type { ControlProps } from './types.ts';
import { MAIN_ROWS, NAV_ROWS } from './shortcutKeys.ts';
import type { KeyCap } from './shortcutKeys.ts';

const MODIFIER_LABELS: Array<[keyof ShortcutModState, string, string]> = [
  ['ctrlKey', 'ControlLeft', 'Ctrl'],
  ['shiftKey', 'ShiftLeft', 'Shift'],
  ['altKey', 'AltLeft', 'Alt'],
  ['metaKey', 'MetaLeft', 'Meta'],
];

interface ShortcutModState {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

interface ShortcutDraft {
  groupId: string;
  /** null = 新增。 */
  itemId: string | null;
  combo: ShortcutStroke[];
  description: string;
  condition: string;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 前后端通用的值在到达面板时可能还没经过 coerce（本地乐观更新），这里只做**不抛错**的读。 */
function looseGroups(value: unknown): ShortcutGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((g) => g && typeof g === 'object')
    .map((g: any, gi: number) => ({
      id: String(g.id || `g${gi + 1}`),
      name: String(g.name || `组 ${gi + 1}`),
      shortcuts: (Array.isArray(g.shortcuts) ? g.shortcuts : [])
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any, si: number): ShortcutItem => ({
          id: String(s.id || `s${gi + 1}-${si + 1}`),
          combo: (Array.isArray(s.combo) ? s.combo : [])
            .filter((k: any) => k && typeof k === 'object' && k.code)
            .map((k: any): ShortcutStroke => ({
              code: String(k.code),
              label: String(k.label || labelOfCode(String(k.code))),
              ...(k.isModifier ? { isModifier: true } : {}),
            })),
          description: String(s.description || ''),
          ...(s.condition ? { condition: String(s.condition) } : {}),
          ...(Number.isFinite(s.createdAt) ? { createdAt: Number(s.createdAt) } : {}),
        })),
    }));
}

function modifiersOf(e: ShortcutModState): ShortcutStroke[] {
  return MODIFIER_LABELS
    .filter(([key]) => e[key])
    .map(([, code, label]) => ({ code, label, isModifier: true }));
}

function strokeOf(e: ReactKeyboardEvent<HTMLInputElement>): ShortcutStroke {
  const code = e.code || e.key;
  return { code, label: labelOfCode(code) || e.key };
}

export function ShortcutKeyboard({ active }: { active: Set<string> }) {
  const renderKey = (k: KeyCap, key: string) => {
    if (!k.code) return <span key={key} className="sckb-key sckb-ghost" style={{ flexGrow: k.w || 1 }} />;
    return (
      <span
        key={key}
        className={`sckb-key${active.has(k.code) ? ' on' : ''}`}
        style={{ flexGrow: k.w || 1 }}
        title={k.code}
      >
        {k.label}
      </span>
    );
  };
  return (
    <div className="sckb" aria-hidden>
      <div className="sckb-rows">
        {MAIN_ROWS.map((row, ri) => (
          <div className="sckb-row" key={`m${ri}`}>
            {row.map((k, ki) => renderKey(k, `m${ri}-${ki}`))}
          </div>
        ))}
      </div>
      <div className="sckb-nav">
        {NAV_ROWS.map((row, ri) => (
          <div className="sckb-row" key={`n${ri}`}>
            {row.map((k, ki) => renderKey(k, `n${ri}-${ki}`))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ShortcutPanelProps {
  label: string;
  groups: ShortcutGroup[];
  onChange: (value: ShortcutGroup[]) => void;
  mode: PeekMode;
  onMode: (mode: PeekMode) => void;
  onClose: () => void;
}

function ShortcutPanel({ label, groups, onChange, mode, onMode, onClose }: ShortcutPanelProps) {
  const [activeId, setActiveId] = useState(groups[0]?.id || '');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShortcutDraft | null>(null);
  const [pending, setPending] = useState<ShortcutStroke[]>([]);
  const [newGroup, setNewGroup] = useState('');
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const firstGroupRef = useRef<HTMLButtonElement>(null);
  const addGroupRef = useRef<HTMLInputElement>(null);

  const active = groups.find((g) => g.id === activeId) || groups[0] || null;
  const activeGroup = active;
  const hoverItem = activeGroup?.shortcuts.find((s) => s.id === hoverId) || null;

  // 分组被删/换位置后，选中项跟着落到第一个，避免面板空白。
  useEffect(() => {
    if (!activeGroup && groups.length) setActiveId(groups[0].id);
  }, [activeGroup, groups]);

  useEffect(() => {
    setNameDraft(activeGroup?.name || '');
    setDraft(null);
    setConfirmGroup(null);
    setHoverId(null);
  }, [activeGroup?.id, activeGroup?.name]);

  // 打开面板先把焦点放进目录（键盘用户不用先 Tab 穿过整个头部）。
  useEffect(() => {
    (firstGroupRef.current || addGroupRef.current)?.focus();
  }, []);

  const total = groups.reduce((n, g) => n + g.shortcuts.length, 0);
  const activeCombo = draft ? draft.combo : (hoverItem?.combo || []);
  const activeCodes = new Set(activeCombo.map((s) => s.code));

  function commitGroupRename() {
    if (!activeGroup) return;
    const name = nameDraft.trim();
    if (!name || name === activeGroup.name) { setNameDraft(activeGroup.name); return; }
    onChange(groups.map((g) => (g.id === activeGroup.id ? { ...g, name } : g)));
  }

  function addGroup() {
    const name = newGroup.trim();
    if (!name) return;
    const group: ShortcutGroup = { id: newId('g'), name, shortcuts: [] };
    onChange([...groups, group]);
    setActiveId(group.id);
    setNewGroup('');
    setDraft(null);
  }

  function removeGroup(id: string) {
    if (confirmGroup !== id) { setConfirmGroup(id); return; }
    const next = groups.filter((g) => g.id !== id);
    onChange(next);
    setActiveId(next[0]?.id || '');
    setConfirmGroup(null);
    setDraft(null);
  }

  function startNew() {
    if (!activeGroup) return;
    setDraft({ groupId: activeGroup.id, itemId: null, combo: [], description: '', condition: '' });
    setPending([]);
  }

  function startEdit(item: ShortcutItem) {
    if (!activeGroup) return;
    setDraft({
      groupId: activeGroup.id,
      itemId: item.id,
      combo: item.combo,
      description: item.description,
      condition: item.condition || '',
    });
    setPending([]);
  }

  function captureKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setDraft(null);
      setPending([]);
      return;
    }
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      setPending(modifiersOf(e));
      return;
    }
    setDraft((d) => (d ? { ...d, combo: [...modifiersOf(e), strokeOf(e)] } : d));
    setPending([]);
  }

  function saveDraft() {
    if (!draft || !activeGroup || !draft.combo.length || !draft.description.trim()) return;
    const item: ShortcutItem = {
      id: draft.itemId || newId('s'),
      combo: draft.combo,
      description: draft.description.trim(),
      ...(draft.condition.trim() ? { condition: draft.condition.trim() } : {}),
    };
    const next = groups.map((g) => {
      if (g.id !== draft.groupId) return g;
      return {
        ...g,
        shortcuts: draft.itemId
          ? g.shortcuts.map((s) => (s.id === draft.itemId ? item : s))
          : [...g.shortcuts, item],
      };
    });
    onChange(next);
    setDraft(null);
    setPending([]);
  }

  function removeItem(id: string) {
    if (!activeGroup) return;
    onChange(groups.map((g) => (
      g.id === activeGroup.id ? { ...g, shortcuts: g.shortcuts.filter((s) => s.id !== id) } : g
    )));
    if (draft?.itemId === id) setDraft(null);
  }

  const comboCell = (strokes: ShortcutStroke[]) => (
    <span className="shortcut-combo">
      {strokes.length
        ? strokes.map((s) => <kbd className="shortcut-kbd" key={s.code}>{s.label}</kbd>)
        : <span className="hint">未录入</span>}
    </span>
  );

  return (
    <Peek
      ariaLabel="快捷键面板"
      title={label || '快捷键'}
      subtitle={`${groups.length} 组 · ${total} 条`}
      meta={<span className="tag">{total} 条</span>}
      mode={mode}
      onMode={onMode}
      onClose={onClose}
      className="shortcut-panel"
    >
      <div className="shortcut-panel-body">
        <aside className="shortcut-groups-pane">
          <div className="shortcut-groups-list">
            {groups.map((g, i) => (
              <button
                key={g.id}
                ref={i === 0 ? firstGroupRef : undefined}
                type="button"
                className={`shortcut-group-item${g.id === activeGroup?.id ? ' sel' : ''}`}
                onClick={() => setActiveId(g.id)}
                aria-pressed={g.id === activeGroup?.id}
              >
                <span className="nowrap">{g.name}</span>
                <span className="grow" />
                <span className="tag">{g.shortcuts.length}</span>
              </button>
            ))}
            {!groups.length ? <div className="hint shortcut-empty">还没有分组</div> : null}
          </div>
          <div className="shortcut-group-add">
            <input
              ref={addGroupRef}
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup(); } }}
              placeholder="新分组名"
              aria-label="新分组名"
            />
            <button type="button" className="btn small" disabled={!newGroup.trim()} onClick={addGroup}>加组</button>
          </div>
        </aside>

        <section className="shortcut-main">
          {activeGroup ? (
            <>
              <div className="shortcut-main-head">
                <input
                  className="shortcut-group-name"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitGroupRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  aria-label="分组名"
                />
                <span className="tag">{activeGroup.shortcuts.length} 条</span>
                <span className="grow" />
                <button type="button" className="btn small" onClick={startNew}>新增</button>
                <button type="button" className="btn small ghost" onClick={() => removeGroup(activeGroup.id)}>
                  {confirmGroup === activeGroup.id ? '确认删除？' : '删除组'}
                </button>
              </div>

              <div className="shortcut-table-wrap">
                <table className="shortcut-table">
                  <thead>
                    <tr><th>按键</th><th>说明</th><th>条件</th><th className="shortcut-ops">操作</th></tr>
                  </thead>
                  <tbody>
                    {activeGroup.shortcuts.map((s) => (
                      <tr
                        key={s.id}
                        className={hoverId === s.id ? 'on' : ''}
                        onMouseEnter={() => setHoverId(s.id)}
                        onMouseLeave={() => setHoverId(null)}
                      >
                        <td>{comboCell(s.combo)}</td>
                        <td>{s.description}</td>
                        <td>{s.condition || <span className="hint">全局</span>}</td>
                        <td className="shortcut-ops">
                          <button type="button" className="btn small ghost" onClick={() => startEdit(s)}>编辑</button>
                          <button type="button" className="btn small ghost" onClick={() => removeItem(s.id)} aria-label={`删除 ${s.description}`}>删</button>
                        </td>
                      </tr>
                    ))}
                    {!activeGroup.shortcuts.length && !draft ? (
                      <tr><td colSpan={4}><span className="hint">这一组还没有快捷键，点右上「新增」开始录入。</span></td></tr>
                    ) : null}
                    {draft && draft.groupId === activeGroup.id ? (
                      <tr className="on">
                        <td>
                          <input
                            className="shortcut-capture"
                            readOnly
                            autoFocus
                            value={comboLabel(draft.combo) || pending.map((s) => s.label).join('+')}
                            placeholder="按下组合键…"
                            onKeyDown={captureKey}
                            aria-label="按下组合键"
                          />
                          {!draft.combo.length ? <span className="shortcut-error">先按组合键</span> : null}
                        </td>
                        <td>
                          <input
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                            placeholder="这条快捷键做什么"
                            aria-label="说明"
                          />
                          {draft.combo.length && !draft.description.trim()
                            ? <span className="shortcut-error">说明必填</span>
                            : null}
                        </td>
                        <td>
                          <input
                            value={draft.condition}
                            onChange={(e) => setDraft({ ...draft, condition: e.target.value })}
                            placeholder="条件（可空）"
                            aria-label="条件"
                          />
                        </td>
                        <td className="shortcut-ops">
                          <button
                            type="button"
                            className="btn small"
                            disabled={!draft.combo.length || !draft.description.trim()}
                            onClick={saveDraft}
                          >
                            保存
                          </button>
                          <button type="button" className="btn small ghost" onClick={() => setDraft(null)}>取消</button>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="shortcut-canvas">
                <div className="shortcut-canvas-title">
                  键位预览{activeCombo.length ? `　·　${comboLabel(activeCombo)}` : '　·　悬停一条快捷键，或录入时按键'}
                </div>
                <ShortcutKeyboard active={activeCodes} />
              </div>
            </>
          ) : (
            <div className="hint shortcut-empty">左侧还没有分组。先加一组，再录入快捷键。</div>
          )}
        </section>
      </div>
    </Peek>
  );
}

export function ShortcutControl({ def, value, onChange }: ControlProps) {
  const groups = looseGroups(value);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PeekMode>('fullpage');
  const total = groups.reduce((n, g) => n + g.shortcuts.length, 0);

  return (
    <div className="shortcut-field">
      <div className="shortcut-strip">
        <button type="button" className="shortcut-strip-main" onClick={() => setOpen(true)} aria-expanded={open} title="打开快捷键面板">
          <span className="source-caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="source-strip-label">{def.label || '快捷键'}</span>
          <span className="tag">{groups.length} 组</span>
          <span className="tag">{total} 条</span>
          {groups.length
            ? <span className="shortcut-groups">{groups.map((g) => `${g.name} × ${g.shortcuts.length}`).join('　·　')}</span>
            : <span className="hint">（空）</span>}
          <span className="grow" />
          <span className="hint">点「详细」看键位</span>
        </button>
        <button type="button" className="btn small" onClick={() => setOpen(true)}>详细</button>
      </div>
      {open ? (
        <ShortcutPanel
          label={def.label}
          groups={groups}
          onChange={onChange}
          mode={mode}
          onMode={setMode}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
