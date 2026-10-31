// 块级 AI 的评审条（S4）：**AI 的提议在这里被审，不在这里被生成**。
//
// 一条 pending 的生命周期是：CLI/agent 产出提议（`entry ai suggest --from`）→ 面板上看到 diff
// → 人点「应用」才写 store，点「拒绝」就删掉文件。所以这个组件的职责只有两件：
//   1. 把 pending 渲染成「改了什么」（红删绿增、新增淡绿、删除置灰）；
//   2. 把「应用 / 强制应用 / 拒绝」接到三条 action 上。
//
// 有几件事刻意**不**做：
//   · 不在面板里调大模型。nx-sk 是本地优先的；模型由调用方（agent）产出提议，
//     面板只负责审。这样 agent 走 CLI 与人在面板上审的是同一条 pending。
//   · 不展示 pending 的最终正文（`blocks`）：那一份带明文密钥。接口也刻意不返回它。
//   · 不做「自动应用」。冲突（块在提议之后被改过）必须显式点「覆盖」。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store.jsx';

const OP_CLASS = { same: 'ai-same', del: 'ai-del', ins: 'ai-ins' };

function whenLabel(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 一条提议：改动预览 + 决策按钮。 */
function PendingCard({ item, busy, onApply, onReject, conflicts }) {
  const scope = item.scopeBlockId ? ` · 只动 ${item.scopeBlockId}` : '';
  const multi = item.diffs.length > 1;
  return (
    <div className="ai-card">
      <div className="ai-card-head">
        <span className="ai-prompt">{item.prompt || '（无指令）'}</span>
        <span className="muted">{whenLabel(item.createdAt)}{scope}</span>
        <span className="grow" />
        <span className="muted">改 {item.diffs.length} · 新增 {item.newBlocks.length} · 删 {item.removedIds.length}</span>
      </div>

      {item.diffs.map((d) => (
        <div className="ai-diff" key={d.blockId}>
          <div className="ai-diff-head">
            <span className="mono muted">{d.blockId}</span>
            <span className="muted">{d.type}</span>
            <span className="grow" />
            {multi ? (
              <button
                type="button"
                className="btn small ghost"
                disabled={busy}
                onClick={() => onApply(item, { block: d.blockId })}
                title="只应用这一块的改动"
              >
                应用这块
              </button>
            ) : null}
          </div>
          <div className="ai-diff-body">
            {d.secret ? (
              <span className="muted">密文块已变更（明文只在 pending 文件里，不经面板）</span>
            ) : d.structural ? (
              <span className="muted">结构化块被整体替换（表格 / 附件 / 内嵌视图）</span>
            ) : (
              (d.segments || []).map((s, i) => (
                // 差异片段没有稳定 key（同一段文字会重复），用下标 + op 足够
                <span key={`${s.op}-${i}`} className={OP_CLASS[s.op] || 'ai-same'}>{s.text}</span>
              ))
            )}
          </div>
        </div>
      ))}

      {item.newBlocks.map((b) => (
        <div className="ai-new" key={b.id}>
          <span className="ai-new-tag">新增 {b.label}</span>
          <span>{b.text || <span className="muted">（无文本）</span>}</span>
        </div>
      ))}

      {item.removedIds.map((id) => (
        <div className="ai-removed" key={id}>
          <span className="mono">{id}</span>
          <span className="muted">　将被删除（连同子树）</span>
        </div>
      ))}

      {conflicts && conflicts.length ? (
        <div className="ai-warn">
          块已被改过，不能直接覆盖：<span className="mono">{conflicts.join(', ')}</span>
          <button type="button" className="btn small" disabled={busy} onClick={() => onApply(item, { force: true })}>
            仍要覆盖
          </button>
          <span className="muted">（覆盖会用提议内容替换你刚才的改动）</span>
        </div>
      ) : null}

      <div className="ai-card-foot">
        <button type="button" className="btn small" disabled={busy} onClick={() => onApply(item, {})}>
          {busy ? '处理中…' : '应用全部'}
        </button>
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => onReject(item)}>
          拒绝
        </button>
        <span className="muted">{item.id}</span>
      </div>
    </div>
  );
}

export default function AiBar({ entryId, onApplied }) {
  const { toast, guard } = useStore();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [conflicts, setConflicts] = useState({}); // pendingId → 冲突块 id

  const load = useCallback(async () => {
    if (!entryId) { setItems([]); return; }
    try {
      const d = await api(`/api/entries/${encodeURIComponent(entryId)}/ai`);
      const list = d.pendings || [];
      setItems(list);
      // 有新提议就自动展开：让人一眼看见「有东西等着你决定」
      if (list.length) setOpen(true);
    } catch {
      setItems([]); // 读不到就当没有：这条永远不该挡住正文
    }
  }, [entryId]);

  useEffect(() => { load(); }, [load]);

  const apply = guard(async (item, opts = {}) => {
    setBusyId(item.id);
    try {
      const body = { ...(opts.force ? { force: true } : {}), ...(opts.block ? { block: opts.block } : {}) };
      const d = await api(`/api/ai/${encodeURIComponent(item.id)}/apply`, { method: 'POST', body });
      if (d.status === 'conflict') {
        setConflicts((cur) => ({ ...cur, [item.id]: d.conflictIds || [] }));
        toast(`没应用：块已被改过（${(d.conflictIds || []).join(', ')}）`, 'bad');
        return;
      }
      setConflicts((cur) => { const next = { ...cur }; delete next[item.id]; return next; });
      toast(opts.block ? '已应用这一块的改动' : `已应用：改 ${d.changed} · 新增 ${d.added} · 删 ${d.removed}`);
      await load();
      if (onApplied) onApplied();
    } finally {
      setBusyId('');
    }
  });

  const reject = guard(async (item) => {
    setBusyId(item.id);
    try {
      await api(`/api/ai/${encodeURIComponent(item.id)}/reject`, { method: 'POST' });
      toast('已拒绝这条提议（数据未改）');
      await load();
    } finally {
      setBusyId('');
    }
  });

  if (!entryId || !items.length) return null;

  return (
    <div className="aibar">
      <div className="aibar-head">
        <strong>AI 提议</strong>
        <span className="muted">{items.length} 条待审 · 未写入，应用才生效</span>
        <span className="grow" />
        <button type="button" className="btn small ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open ? (
        <div className="aibar-body">
          {items.map((item) => (
            <PendingCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              conflicts={conflicts[item.id]}
              onApply={apply}
              onReject={reject}
            />
          ))}
          <div className="hint">
            提议由 CLI 或 agent 产出（`nx-sk entry ai suggest &lt;条目&gt; --prompt "…" --from @proposal.json`），
            面板只负责审。pending 是运行态：不进 store、不进导出包，删 <span className="mono">~/nx-sk/pending/</span> 即清空。
          </div>
        </div>
      ) : null}
    </div>
  );
}
