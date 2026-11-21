// grill 字段的入口：页面上只露一个很小的状态按钮，真正的表单在三态子页面里。
//
// 为什么不做成一整块大表单：条目页是「一眼扫过」的台账，对齐单属于低频但深度的动作；
// 入口只报「待确认 x/y / 已确认」，点开才进入 Peek（侧边 / 居中 / 整页，默认整页）。
import { useEffect, useRef, useState } from 'react';
import { grillProgress, parseGrill } from '../../../../shared/grill.ts';
import type { GrillDoc } from '../../../../shared/fields/types.ts';
import { peekDefault } from '../peek.tsx';
import type { PeekMode } from '../peek.tsx';
import type { ControlProps } from './types.ts';
import GrillPanel from './grillPanel.tsx';

function safeDoc(value: unknown): GrillDoc {
  try {
    return parseGrill(value);
  } catch {
    return parseGrill(null);
  }
}

export function GrillControl({ def, value, onChange, ctx }: ControlProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PeekMode>(() => peekDefault('grill', 'fullpage'));
  const [doc, setDoc] = useState<GrillDoc>(() => safeDoc(value));
  const lastValue = useRef<unknown>(value);

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setDoc(safeDoc(value));
  }, [value]);

  const emit = (next: GrillDoc) => {
    lastValue.current = next;
    setDoc(next);
    onChange(next);
  };

  const commitField = typeof ctx?.onCommitField === 'function'
    ? ctx.onCommitField as (key: string, value: unknown) => Promise<boolean | undefined>
    : undefined;
  const commit = async (key: string, next: unknown): Promise<boolean | undefined> => {
    if (!commitField) return false;
    return commitField(key, next);
  };

  const templateId = typeof ctx?.templateId === 'string' ? ctx.templateId : '';
  const entryId = typeof ctx?.entryId === 'string' ? ctx.entryId : '';
  const newTabHref = templateId && entryId
    ? `#/${encodeURIComponent(templateId)}?entry=${encodeURIComponent(entryId)}`
    : undefined;
  const p = grillProgress(doc);
  const acked = doc.ack.status === 'acknowledged';
  const empty = !doc.questions.length && !doc.title && !doc.intro && !doc.prompt;

  return (
    <div className="grill-field">
      <button
        type="button"
        className={`grill-chip${acked ? ' acked' : ''}`}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        title={`打开「${def.label || doc.title || '对齐确认'}」：${acked ? '已确认' : `待确认 ${p.answered}/${p.total}`}`}
      >
        <span className="grill-pulse" aria-hidden />
        <span className="grill-chip-title">{def.label || doc.title || '对齐确认'}</span>
        <span className="grill-chip-count">{empty ? '空' : `${p.answered}/${p.total}`}</span>
        <span className="grill-chip-state">{acked ? '已确认' : p.all ? '待确认' : '未答完'}</span>
      </button>
      {open ? (
        <GrillPanel
          label={def.label || doc.title || '对齐确认'}
          templateTitle={typeof ctx?.templateTitle === 'string' ? ctx.templateTitle : undefined}
          entryTitle={typeof ctx?.entryTitle === 'string' ? ctx.entryTitle : undefined}
          doc={doc}
          onDoc={emit}
          onCommit={commit}
          defKey={def.key}
          mode={mode}
          onMode={setMode}
          onClose={() => setOpen(false)}
          newTabHref={newTabHref}
        />
      ) : null}
    </div>
  );
}
