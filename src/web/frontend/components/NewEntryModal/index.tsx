// 新建条目的统一入口：模板选择 + 名称 + 父级上下文。
//
// 0.43 之后模板只用于创建时初始化字段结构；新建子条目默认空白，
// 不应该因为父条目用了某个模板就自动继承。这个弹窗把选择显式摆出来。
import { Modal } from '../ui/index.tsx';
import type { BootTemplate } from '../../../../shared/model.ts';
import { BLANK_TEMPLATE_ID } from '../../../../shared/tree.ts';

export interface NewEntryForm {
  /** null = 根目录；否则是父条目 id。父级只决定目录位置，不决定模板。 */
  parent: string | null;
  /** 模板 id；`__blank__` = 空白条目。 */
  template: string;
  /** 条目名称（也会写进模板的 titleField，如果有）。 */
  title: string;
}

export default function NewEntryModal({
  form,
  parentTitle,
  templates,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  form: NewEntryForm | null;
  parentTitle?: string;
  templates: BootTemplate[];
  busy: boolean;
  onChange: (next: NewEntryForm) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!form) return null;

  const sorted = [...templates].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const blank = sorted.find((t) => t.blank || t.id === BLANK_TEMPLATE_ID);
  const choices = sorted.filter((t) => !t.blank && t.id !== BLANK_TEMPLATE_ID);
  const selected = form.template === BLANK_TEMPLATE_ID ? blank : sorted.find((t) => t.id === form.template);
  const isBlank = form.template === BLANK_TEMPLATE_ID;
  const titleLabel = isBlank ? '名称' : (selected?.titleLabel || '名称');
  const titlePlaceholder = selected?.titleLabel ? `例如 ${selected.titleLabel}` : '例如 我的条目';
  const trimmed = form.title.trim();

  return (
    <Modal
      title="新建条目"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={onSubmit} disabled={busy || !trimmed}>
            {busy ? '创建中…' : '创建条目'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <div className="hint">
          {parentTitle
            ? <>建在「<b>{parentTitle}</b>」下：父条目只决定目录位置，子条目默认空白。</>
            : '建在根目录。默认空白条目；需要字段结构时，在下面选一个条目模板。'}
        </div>
        <div className="grid">
          <div className="field">
            <div className="flabel"><span>条目模板</span><span className="fkey">只初始化字段</span></div>
            <div className="fctrl">
              <select
                value={form.template}
                onChange={(e) => onChange({ ...form, template: e.target.value })}
                disabled={busy}
              >
                <option value={BLANK_TEMPLATE_ID}>空白条目（不初始化字段）</option>
                {choices.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}（{t.fields} 字段 · {t.id}）
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <div className="flabel"><span>{titleLabel}</span><span className="fkey">条目名称</span></div>
            <div className="fctrl">
              <input
                value={form.title}
                onChange={(e) => onChange({ ...form, title: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
                placeholder={titlePlaceholder}
                autoFocus
                disabled={busy}
              />
            </div>
          </div>
        </div>
        <div className="hint">
          {isBlank
            ? '空白条目不会带入任何字段，建完可以在条目里按需添加。'
            : selected
              ? <>「<b>{selected.title}</b>」会深拷贝 {selected.fields} 个字段作为初始结构{selected.description ? `；${selected.description}` : ''}。创建后条目独立演化，改模板不会回刷它。</>
              : '选中的条目模板已不在当前列表里，请重新选择。'}
        </div>
      </div>
    </Modal>
  );
}
