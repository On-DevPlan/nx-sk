// 组字段（type='group'）在条目表单里的控件。
//
// 组**不是**一个可填的值：它只是把成员字段包在一起的小标题（`keys` 决定成员是谁）。
// 所以这里渲染成一行只读标题，而不是输入框——写成输入框等于让人以为填了能存下来。
//
// 面板读侧只关心 `label`：归属关系由后端推导后随字典下发（`group` / `keys` 两键），
// 控件本身不做任何结构推导。
import type { ControlProps } from './types.ts';

export function GroupControl({ def }: ControlProps) {
  const title = String(def?.label || def?.key || '');
  return (
    <div className="fld-group-title" data-key={String(def?.key || '')}>
      <span className="fld-group-title-text">{title}</span>
      <span className="fld-group-title-count">{Array.isArray(def?.keys) ? `${def.keys.length} 个字段` : ''}</span>
    </div>
  );
}

