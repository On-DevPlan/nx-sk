import type { ControlProps } from './types.ts';

export function SelectControl({ def, value, onChange }: ControlProps) {
  const options = def.options || [];
  const isCustom = value !== '' && !options.includes(value);
  return (
    <select value={isCustom ? '__custom' : String(value)} onChange={(e) => onChange(e.target.value === '__custom' ? '' : e.target.value)}>
      <option value="">（未填写）</option>
      {options.map((o: string) => <option key={o} value={o}>{o}</option>)}
      {isCustom ? <option value="__custom">{String(value)}（当前值，不在候选里）</option> : null}
    </select>
  );
}
