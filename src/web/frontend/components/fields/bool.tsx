import type { ControlProps } from './types.ts';

export function BoolControl({ value, onChange }: ControlProps) {
  const checked = value === true || value === 'true' || value === '是';
  return (
    <label className="inline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="muted">{checked ? '是' : '否'}</span>
    </label>
  );
}
