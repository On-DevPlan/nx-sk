import type { ControlProps } from './types.ts';

export function DateControl({ value, onChange }: ControlProps) {
  return <input type="date" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}
