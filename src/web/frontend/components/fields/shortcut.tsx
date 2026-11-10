// shortcut 字段控件：折叠条只报「几组/几条」，详细面板才铺开键位与说明。
//
// 详细面板直接复用参考实现 `ve/packages/react-components/src/shortcut-library`
// 的结构、类名、交互与样式（见 ./shortcutLibrary/），数据只认本项目的三层结构：
// 组(group) → 条目(shortcut) → 按键(combo)。编辑直接写回字段值（onChange），
// 与服务端 `core/fields/behaviors/shortcut.ts` 的归一一致。
import { useState } from 'react';
import { labelOfCode } from '../../../../shared/shortcut.ts';
import type { ShortcutGroup, ShortcutItem, ShortcutStroke } from '../../../../shared/fields/types.ts';
import { Peek, peekDefault } from '../peek.tsx';
import type { PeekMode } from '../peek.tsx';
import type { ControlProps } from './types.ts';
import ShortcutLibrary from './shortcutLibrary/ShortcutLibrary.tsx';

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

/** 条目列表/折叠条只用数量：组数与总条数（#5「字段显示里只报分组数量」）。 */
export function shortcutCount(value: unknown): { groups: number; items: number } {
  const groups = looseGroups(value);
  return { groups: groups.length, items: groups.reduce((n, g) => n + g.shortcuts.length, 0) };
}

interface ShortcutPanelProps {
  label: string;
  groups: ShortcutGroup[];
  onChange: (value: ShortcutGroup[]) => void;
  mode: PeekMode;
  onMode: (mode: PeekMode) => void;
  onClose: () => void;
  newTabHref?: string;
}

function ShortcutPanel({ label, groups, onChange, mode, onMode, onClose, newTabHref }: ShortcutPanelProps) {
  const total = groups.reduce((n, g) => n + g.shortcuts.length, 0);
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
      newTabHref={newTabHref}
      persistKey="shortcut"
      defaultMode="fullpage"
    >
      <ShortcutLibrary groups={groups} onChange={onChange} />
    </Peek>
  );
}

export function ShortcutControl({ def, value, onChange, ctx }: ControlProps) {
  const groups = looseGroups(value);
  const [open, setOpen] = useState(false);
  // 「编辑默认视图」可改写默认形态；没存过就是 fullpage（#5 的原始要求）。
  const [mode, setMode] = useState<PeekMode>(() => peekDefault('shortcut', 'fullpage'));
  const total = groups.reduce((n, g) => n + g.shortcuts.length, 0);
  const sectionId = typeof ctx?.sectionId === 'string' ? ctx.sectionId : '';
  const entryId = typeof ctx?.entryId === 'string' ? ctx.entryId : '';
  const newTabHref = sectionId && entryId
    ? `#/${encodeURIComponent(sectionId)}?entry=${encodeURIComponent(entryId)}`
    : undefined;

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
          newTabHref={newTabHref}
        />
      ) : null}
    </div>
  );
}
