import { Modal } from '../../components/ui.tsx';
import type { BoardGroup } from '../../components/blockBoard.tsx';
import type { FieldType } from '../../../../shared/fields/types.ts';

/** 「添加扩展字段」弹窗（条目内字段扩展正门）。纯展示，表单值由容器持有。 */
export default function AddFieldModal({
  af,
  afBusy,
  sectionTitle,
  groups,
  fieldTypes,
  fieldTypeLabels,
  onChange,
  onClose,
  onCancel,
  onSubmit,
}: {
  af: { key: string; label: string; type: string; group: string; value: string } | null;
  afBusy: boolean;
  sectionTitle: string;
  groups: BoardGroup[];
  fieldTypes: FieldType[] | undefined;
  fieldTypeLabels: Record<FieldType, string> | undefined;
  onChange: (next: { key: string; label: string; type: string; group: string; value: string }) => void;
  onClose: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      {af ? (
        <Modal
          title={`添加扩展字段 · ${sectionTitle}`}
          onClose={onClose}
          footer={(
            <>
              <button className="btn ghost" onClick={onCancel} disabled={afBusy}>取消</button>
              <button className="btn" onClick={onSubmit} disabled={afBusy || !af.key.trim()}>
                {afBusy ? '添加中…' : '添加'}
              </button>
            </>
          )}
        >
          <div className="stack">
            <div className="hint">字段只加在<b>这一条条目</b>上（写时复制，不动栏目模板）；凭据样的键（密码 / 令牌 / 密钥）落盘即密文。</div>
            <div className="grid">
              <div className="field">
                <div className="flabel"><span>key</span><span className="fkey">英文字母开头</span></div>
                <div className="fctrl"><input value={af.key} onChange={(e) => onChange({ ...af, key: e.target.value })} placeholder="例如 budget" /></div>
              </div>
              <div className="field">
                <div className="flabel"><span>标签</span><span className="fkey">缺省同 key</span></div>
                <div className="fctrl"><input value={af.label} onChange={(e) => onChange({ ...af, label: e.target.value })} placeholder="例如 预算" /></div>
              </div>
              <div className="field">
                <div className="flabel"><span>类型</span></div>
                <div className="fctrl">
                  <select value={af.type} onChange={(e) => onChange({ ...af, type: e.target.value })}>
                    {(fieldTypes || []).map((t) => (
                      <option key={t} value={t}>{fieldTypeLabels?.[t] ? `${fieldTypeLabels[t]}（${t}）` : t}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <div className="flabel"><span>分组</span><span className="fkey">块在页面里的位置</span></div>
                <div className="fctrl">
                  <select value={af.group} onChange={(e) => onChange({ ...af, group: e.target.value })}>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="field wide">
              <div className="flabel"><span>初值</span><span className="fkey">可留空，建完再填</span></div>
              <div className="fctrl">
                <input
                  value={af.value}
                  onChange={(e) => onChange({ ...af, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
                  placeholder="顺手给个值（选填）"
                />
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
