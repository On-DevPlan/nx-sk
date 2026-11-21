// 条目 → 条目模板：把这条条目当前的字段结构存成新模板。
//
// 只抄结构、不抄值；表单默认值由容器给（id 冲突时容器先生成唯一后缀），
// 真正的 API 调用留给容器，组件只负责把三个字段收齐。
import { Modal } from '../../components/ui/index.tsx';

export interface SaveAsTemplateForm {
  entryId: string;
  id: string;
  title: string;
  description: string;
}

/** 条目模板 id 的允许形状（与 template add / save-as-template 后端一致）。 */
export const TEMPLATE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export default function SaveAsTemplateModal({
  form,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  form: SaveAsTemplateForm | null;
  busy: boolean;
  onChange: (next: SaveAsTemplateForm) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!form) return null;
  return (
    <Modal
      title="保存为条目模板"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={onSubmit} disabled={busy || !TEMPLATE_ID_RE.test(form.id.trim())}>
            {busy ? '保存中…' : '保存为模板'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <div className="hint">
          只抄这条条目<b>当前的字段结构</b>，不抄值；存完后的模板只用于以后新建条目初始化，
          不会回刷这条条目，也不影响已有条目。
        </div>
        <div className="grid">
          <div className="field">
            <div className="flabel"><span>条目模板 id</span><span className="fkey">小写字母开头，仅 a-z 0-9 _ -</span></div>
            <div className="fctrl">
              <input
                value={form.id}
                onChange={(e) => onChange({ ...form, id: e.target.value })}
                placeholder="例如 tpl_my_entry"
                autoFocus
              />
            </div>
          </div>
          <div className="field">
            <div className="flabel"><span>条目模板名</span><span className="fkey">显示在模板库里的名字</span></div>
            <div className="fctrl">
              <input
                value={form.title}
                onChange={(e) => onChange({ ...form, title: e.target.value })}
                placeholder="例如 我的求职模板"
              />
            </div>
          </div>
        </div>
        <div className="field wide">
          <div className="flabel"><span>说明</span><span className="fkey">选填</span></div>
          <div className="fctrl">
            <input
              value={form.description}
              onChange={(e) => onChange({ ...form, description: e.target.value })}
              placeholder="这组字段是做什么用的"
              onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
            />
          </div>
        </div>
        <div className="hint">
          基于条目 <span className="mono">{form.entryId}</span> 保存。未保存的字段改动不会进模板，先保存条目再存模板。
        </div>
      </div>
    </Modal>
  );
}
