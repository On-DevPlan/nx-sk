import type { ControlProps } from './types.ts';

export function NumberControl({ value, onChange }: ControlProps) {
  return <input type="number" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}
