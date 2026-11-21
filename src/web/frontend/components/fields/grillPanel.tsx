// grill 面板正文：一页「AI 提问 → 用户逐条回答 → 确认回写」。
//
// 面板刻意长这样：
//   - 原话只读放最上面，用户知道自己在确认什么；
//   - 每题都有「回答区 + 备注/理由」两层输入，否定不是靠删问题表达；
//   - 底部 sticky 动作条只留两个动作：保存进度 / 确认并回写；
//   - 任何修改都会把已确认状态退回 pending——ack 不能嘴上说说了事。
import { useState } from 'react';
import { GRILL_KIND_LABELS, answerText, grillProgress, isGrillAnswered } from '../../../../shared/grill.ts';
import type { GrillAnswer, GrillDoc, GrillQuestion } from '../../../../shared/fields/types.ts';
import { Peek } from '../peek.tsx';
import type { PeekMode } from '../peek.tsx';

function pending(doc: GrillDoc): GrillDoc {
  return { ...doc, ack: { status: 'pending' } };
}

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function OptionMark({ on }: { on: boolean }) {
  return <span className={`grill-option-mark${on ? ' on' : ''}`} aria-hidden>{on ? '√' : ''}</span>;
}

function AnswerArea({ q, onChange }: { q: GrillQuestion; onChange: (v: GrillAnswer) => void }) {
  if (q.kind === 'text') {
    return (
      <textarea
        className="grill-input"
        rows={3}
        value={typeof q.answer === 'string' ? q.answer : ''}
        placeholder={q.placeholder || '写下你的回答…'}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (q.kind === 'confirm') {
    return (
      <div className="grill-yesno">
        <button
          type="button"
          className={`grill-option${q.answer === true ? ' on' : ''}`}
          aria-pressed={q.answer === true}
          onClick={() => onChange(q.answer === true ? null : true)}
        >
          <OptionMark on={q.answer === true} />是，按这个理解
        </button>
        <button
          type="button"
          className={`grill-option${q.answer === false ? ' on' : ''}`}
          aria-pressed={q.answer === false}
          onClick={() => onChange(q.answer === false ? null : false)}
        >
          <OptionMark on={q.answer === false} />否，需要改
        </button>
      </div>
    );
  }
  const multi = q.kind === 'multi';
  const selected = multi
    ? (Array.isArray(q.answer) ? q.answer : [])
    : (typeof q.answer === 'string' && q.answer ? [q.answer] : []);
  return (
    <div className="grill-options">
      {q.options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`grill-option${on ? ' on' : ''}`}
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            onClick={() => {
              if (!multi) { onChange(on ? null : o.value); return; }
              onChange(on ? selected.filter((x) => x !== o.value) : [...selected, o.value]);
            }}
          >
            <OptionMark on={on} />
            <span className="grill-option-text">
              <span>{o.label}{o.recommended ? <span className="tag strong grill-rec">建议</span> : null}</span>
              {o.detail ? <small>{o.detail}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function QuestionCard({ q, index, onChange, onNote }: {
  q: GrillQuestion;
  index: number;
  onChange: (v: GrillAnswer) => void;
  onNote: (v: string) => void;
}) {
  const answered = isGrillAnswered(q);
  return (
    <article className={`grill-q${answered ? ' done' : ''}`} data-grill-q={q.id}>
      <header className="grill-q-head">
        <span className="grill-q-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="grill-q-title">
          <h3>{q.title}</h3>
          <div className="rowgap grill-q-tags">
            <span className="tag">{GRILL_KIND_LABELS[q.kind]}</span>
            {q.required ? <span className="tag">必答</span> : <span className="tag">可选</span>}
            {answered ? <span className="grill-ok">已回答</span> : null}
            {q.kind !== 'text' && q.kind !== 'confirm' && q.options.length ? (
              <button type="button" className="grill-clear" onClick={() => onChange(null)} disabled={!answered}>清除</button>
            ) : null}
          </div>
        </div>
      </header>
      {q.detail ? <p className="grill-q-detail">{q.detail}</p> : null}
      <div className="grill-answer">
        <div className="grill-label">你的回答</div>
        <AnswerArea q={q} onChange={onChange} />
      </div>
      <label className="grill-note">
        <span className="grill-label">备注 / 理由 <em>可写否定原因，agent 会一起读</em></span>
        <textarea
          rows={2}
          value={q.note}
          placeholder="为什么这样选？有什么不能接受的？"
          onChange={(e) => onNote(e.target.value)}
        />
      </label>
    </article>
  );
}

interface GrillPanelProps {
  label: string;
  templateTitle?: string;
  entryTitle?: string;
  doc: GrillDoc;
  onDoc: (doc: GrillDoc) => void;
  onCommit: (key: string, value: unknown) => Promise<boolean | undefined>;
  defKey: string;
  mode: PeekMode;
  onMode: (mode: PeekMode) => void;
  onClose: () => void;
  newTabHref?: string;
}

export default function GrillPanel({
  label, templateTitle, entryTitle, doc, onDoc, onCommit, defKey, mode, onMode, onClose, newTabHref,
}: GrillPanelProps) {
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const p = grillProgress(doc);
  const acked = doc.ack.status === 'acknowledged';

  const updateQ = (id: string, patch: Partial<GrillQuestion>) => {
    onDoc(pending({
      ...doc,
      questions: doc.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)),
    }));
  };

  const save = async (next: GrillDoc, close: boolean) => {
    setSaving(true);
    setFlash(null);
    try {
      const ok = await onCommit(defKey, next);
      if (ok) {
        if (close) onClose();
        else setFlash('已回写，继续改也可以；再次确认会把状态重新标为已确认。');
      } else {
        setFlash('回写失败：条目没有保存成功，答案还在草稿里，请重试或复制 JSON。');
      }
    } finally {
      setSaving(false);
    }
  };

  const saveProgress = () => { void save(doc, true); };

  const acknowledge = () => {
    if (!p.all) return;
    const next: GrillDoc = {
      ...doc,
      ack: {
        status: 'acknowledged',
        at: new Date().toISOString(),
        by: 'web',
        answered: p.answered,
        total: p.total,
      },
    };
    onDoc(next);
    void save(next, true);
  };

  return (
    <Peek
      ariaLabel={`${label || '对齐确认'}面板`}
      title={doc.title || label || '对齐确认'}
      subtitle={[templateTitle, entryTitle].filter(Boolean).join(' · ') || 'Grill & Ack'}
      meta={(
        <span className="rowgap">
          <span className={`tag${acked ? ' strong' : ''}`}>{acked ? '已确认' : `待确认 ${p.answered}/${p.total}`}</span>
          {p.optional ? <span className="tag">{p.optional} 题可选</span> : null}
        </span>
      )}
      mode={mode}
      onMode={onMode}
      onClose={onClose}
      className="grill-panel"
      newTabHref={newTabHref}
      persistKey="grill"
      defaultMode="fullpage"
    >
      <div className="grill-body">
        <div className="grill-page">
          <header className="grill-hero">
            <div className="grill-kicker">GRILL &amp; ACK · 需要你逐条对齐</div>
            <p className="grill-intro">{doc.intro || 'AI 把需要确认的假设写成了问题。逐条选，不同意的写清理由；全部必答后才算确认。'}</p>
            {doc.prompt ? (
              <div className="grill-quote">
                <span className="grill-label">这份对齐单在回应你的原话</span>
                <blockquote>{doc.prompt}</blockquote>
              </div>
            ) : null}
            <div className="grill-progress" aria-hidden>
              <span style={{ width: `${p.total ? Math.min(100, (p.answered / p.total) * 100) : 100}%` }} />
            </div>
            <div className="grill-progress-caption">
              <span>必答 {p.answered}/{p.total}{p.all ? ' · 已答完' : ` · 还差 ${p.total - p.answered} 题`}</span>
              {acked ? <span className="grill-acked">已确认 · {when(doc.ack.at)}</span> : <span className="hint">确认后 agent 会读这份 JSON 继续</span>}
            </div>
          </header>

          {acked ? (
            <div className="grill-banner ok">这份对齐单已确认。再改任何一格会自动退回「待确认」，需要重新点确认。</div>
          ) : null}
          {flash ? <div className={`grill-banner${flash.startsWith('回写失败') ? ' bad' : ''}`}>{flash}</div> : null}

          <div className="grill-questions">
            {doc.questions.map((q, i) => (
              <QuestionCard
                key={q.id}
                q={q}
                index={i}
                onChange={(v) => updateQ(q.id, { answer: v })}
                onNote={(v) => updateQ(q.id, { note: v })}
              />
            ))}
          </div>

          {!doc.questions.length ? (
            <div className="grill-empty">
              <strong>AI 还没写问题。</strong>
              <span>让 agent 往这个字段写入 <code>{`{"schema":"nx-sk/grill@1","questions":[...]}`}</code>，再打开这里。</span>
            </div>
          ) : null}

          <label className="grill-free">
            <span className="grill-label">还有没问到的？<em>会原样回给 agent</em></span>
            <textarea
              rows={4}
              value={doc.freeform}
              placeholder="补充范围、验收证据、你不想做什么……"
              onChange={(e) => onDoc(pending({ ...doc, freeform: e.target.value }))}
            />
          </label>

          <div className="grill-answer-preview">
            <span className="grill-label">确认内容预览</span>
            {doc.questions.filter((q) => q.required).map((q) => (
              <div key={q.id} className="grill-preview-row">
                <span>{q.title}</span>
                <strong>{answerText(q) || '（未答）'}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="grill-actions">
          <div className="grill-actions-info">
            <strong>{p.answered}/{p.total}</strong>
            <span>{p.all ? '必答已完成' : `还有 ${p.total - p.answered} 题必答`}</span>
          </div>
          <span className="grow" />
          <button type="button" className="btn small ghost" onClick={saveProgress} disabled={saving}>保存进度</button>
          <button
            type="button"
            className="btn small grill-confirm"
            onClick={acknowledge}
            disabled={!p.all || saving}
            title={p.all ? '把答案和确认状态一起写回条目 JSON' : '必答问题全部回答后才能确认'}
          >
            {saving ? '回写中…' : acked ? '重新确认并回写' : '确认并回写'}
          </button>
        </div>
      </div>
    </Peek>
  );
}
