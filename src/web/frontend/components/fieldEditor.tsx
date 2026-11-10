// 字段编辑器：按字段字典的 type 决定控件。
// 字典来自后端（section.fields），所以**面板能填的字段与 CLI 能填的字段天然一致**。
//
// 控件的分派收在 `./fields/index.ts` 的 `FIELD_CONTROLS: Record<FieldType, Control>`：
// 每种类型一个 `.tsx`，漏实现由 `tsc -b` 拦住；运行时对历史脏类型兜底到单行文本。
import type { ReactNode } from 'react';
import { controlOf } from './fields/index.ts';
import type { FieldDef } from '../../../shared/fields/types.ts';
import type { ControlProps } from './fields/types.ts';

export function FieldControl({ def, value, onChange, disabled, ctx }: ControlProps) {
  const type = def.type || 'text';
  const v = value === null || value === undefined ? '' : value;
  const Control = controlOf(type);
  return <Control def={def} value={v} onChange={onChange} disabled={disabled} ctx={ctx} />;
}

export interface FieldGroupProps {
  title?: ReactNode;
  fields: FieldDef[];
  draft: Record<string, unknown>;
  onPatch: (key: string, value: any) => void;
  sectionTitle?: string;
  entryTitle?: string;
}

/** 一整组字段（同一 group）的矩阵。 */
export function FieldGroup({ title, fields, draft, onPatch, sectionTitle, entryTitle }: FieldGroupProps) {
  return (
    <>
      <div className="group-title">{title}</div>
      <div className="pad">
        <div className="grid">
          {fields.map((def) => (
            <div key={def.key} className={`field ${['textarea', 'file', 'md', 'entrylist', 'table', 'source', 'shortcut'].includes(def.type) ? 'wide' : ''}`}>
              <div className="flabel">
                <span>{def.label}</span>
                {def.sensitive ? <span className="tag bad">密文</span> : null}
                {/* 填写策略来自后端字段字典；不计入完整度，所以标签用中性色而不是红色——
                    用户是**主动**跳过它，不是出错。 */}
                {def.fill && def.fill !== 'normal' ? <span className="tag">{def.fillLabel || def.fill}</span> : null}
                <span className="fkey">{def.key}</span>
              </div>
              <div className="fctrl">
                <FieldControl
                  def={def}
                  value={draft[def.key]}
                  onChange={(v) => onPatch(def.key, v)}
                  ctx={{ sectionTitle, entryTitle }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
