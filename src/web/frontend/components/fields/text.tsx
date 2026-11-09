// 单行文本。也是**未知/脏类型**的运行时兜底（与重构前 fieldEditor 的最后一条
// `return <input type="text">` 完全一致）；兜底不删，但漏实现仍会被 Record 在编译期拦住。
import type { ControlProps } from './types.ts';

export function TextControl({ value, onChange }: ControlProps) {
  return <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}
