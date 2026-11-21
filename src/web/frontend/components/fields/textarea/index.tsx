import { AutoTextarea } from '../autoTextarea/index.tsx';
import type { ControlProps } from '../types.ts';

export function TextareaControl({ value, onChange }: ControlProps) {
  return <AutoTextarea value={value} onChange={onChange} />;
}

