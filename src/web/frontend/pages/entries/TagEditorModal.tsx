// 标签编辑：条目 tags 与模板默认 tags 共用这一张表单。
//
// 输入用逗号/中文逗号/空白分隔；保存时统一 trim、去空、去重，
// 与 CLI 的 tag 归一化口径保持一致。API 调用留给容器，组件只收标签数组。
import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui/index.tsx';

export function parseTagInput(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];
}

export default function TagEditorModal({
  open,
  title,
  hint,
  initialTags,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  hint: string;
  initialTags: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (tags: string[]) => void;
}) {
  const [text, setText] = useState('');
  const initialKey = initialTags.join('\u0000');

  useEffect(() => {
    if (open) setText(initialTags.join(', '));
    // initialTags 每次渲染都是新数组；用内容 key 判断是否真的变了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKey]);

  if (!open) return null;
  const tags = parseTagInput(text);

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={() => onSubmit(tags)} disabled={busy}>
            {busy ? '保存中…' : '保存标签'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <div className="hint">{hint}</div>
        <div className="field wide">
          <div className="flabel"><span>标签</span><span className="fkey">逗号或空格分隔，可留空清空</span></div>
          <div className="fctrl">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="例如 求职, 内推, 成都"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(tags); }}
            />
          </div>
        </div>
        <div className="tag-row" aria-label="标签预览">
          {tags.length ? tags.map((t) => <span key={t} className="tag chip-tag">#{t}</span>) : <span className="hint">还没有标签</span>}
        </div>
      </div>
    </Modal>
  );
}
