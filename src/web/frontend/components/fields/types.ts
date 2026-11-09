// 字段控件的**统一契约**。
//
// `def` / `value` 刻意是宽松类型：字段字典来自后端 JSON，历史数据与导入包可能带
// 各种形状，控件的职责是「照单渲染」，类型收窄在控件内部按需做。
// 真正的穷举约束在 `FIELD_CONTROLS: Record<FieldType, Control>`（见 ./index.ts）：
// 加一种字段类型而没写控件，`tsc -b` 会报缺少属性。
import type { ReactNode } from 'react';

export interface ControlProps {
  def: any;
  value: any;
  onChange: (value: any) => void;
  /** 只有 secret 控件使用（与重构前一致：其余控件忽略它）。 */
  disabled?: boolean;
  /** 表格外的一层上下文（sectionTitle / entryTitle），只有 source 控件用到。 */
  ctx?: Record<string, unknown>;
}

export type Control = (props: ControlProps) => ReactNode;
