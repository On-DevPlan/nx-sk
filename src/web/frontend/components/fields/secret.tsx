import type { ControlProps } from './types.ts';

export function SecretControl({ value, onChange, disabled }: ControlProps) {
  return (
    <input
      type="text"
      value={String(value)}
      placeholder="密文落盘；原样保留占位则视为不修改"
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
