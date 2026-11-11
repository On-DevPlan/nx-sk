// debug（资源引用）字段控件的**阶段 A 占位实现**：只读列出 locator。
// 阶段 B（任务 #18 B2/B3）替换为：引用格子 + 悬浮预览 + 「＋ 引用资源」选择面板。
import type { ControlProps } from './types.ts';

export function DebugControl({ value }: ControlProps) {
  const refs = Array.isArray((value as { refs?: unknown } | null)?.refs)
    ? ((value as { refs: string[] }).refs)
    : [];
  if (!refs.length) return <span className="hint">还没有引用。用 CLI 写入：nx-sk entry update … --set 字段='["nx-sk://…"]'</span>;
  return (
    <div className="dbg-refs mono">
      {refs.map((r) => <div key={r}>{r}</div>)}
    </div>
  );
}
