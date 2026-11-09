import type { ControlProps } from './types.ts';

export function MonthControl({ value, onChange }: ControlProps) {
  return <input type="month" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}
