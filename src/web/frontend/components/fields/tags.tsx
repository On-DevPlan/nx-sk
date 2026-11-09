import type { ControlProps } from './types.ts';

export function TagsControl({ def, value, onChange }: ControlProps) {
  const text = Array.isArray(value) ? value.join('、') : String(value);
  return (
    <input
      value={text}
      placeholder={def.maxItems ? `多个用「、」分隔，最多 ${def.maxItems} 个` : '多个用「、」分隔'}
      onChange={(e) => onChange(e.target.value.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean))}
    />
  );
}
