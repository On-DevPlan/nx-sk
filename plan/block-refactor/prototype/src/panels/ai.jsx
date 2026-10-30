/* 块级 AI —— pending 真落目录 + 冲突检测（§十四）
 *
 * 红线：pending **不落进 store.json**（可能含明文密钥），
 * 落在独立运行态目录 `<home>/pending/`（一个 pending 一个文件，0700/0600）；
 * 删目录即清空；不进导出包。
 * AI 永不直接改数据：每条 pending 都必须「应用」才写。
 *
 * R14：这层不再是内存里的假动作——
 *   · suggest → 服务端写 pending 文件（baseHash 由服务端算）
 *   · list   → 真从磁盘目录读
 *   · apply  → 服务端拿自己的副本算哈希：≠ baseHash → CONFLICT，**不覆盖**
 *   · reject → 删文件
 *   · 隔离自检 → 真去 grep store.json / 导出包（还查 pending 独有的结构字段）
 */

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../appctx.jsx';
import { Panel, Tag } from '../ui.jsx';
import { applyPending, isolationCheck, listPending, rejectPending, suggestPending, syncBlocks } from '../api/protoApi.js';

const SEG_STYLE = {
  keep: {},
  del: { background: '#fdecea', color: 'var(--danger)', textDecoration: 'line-through' },
  add: { background: '#e8f3ea', color: '#1c5c2e', textDecoration: 'none' },
};

/** 模拟 AI：把第一个段落块改写一下 + 提一个新块 */
function simulate(prompt, blocks) {
  const target = blocks.find((b) => b.type === 'paragraph' && b.text);
  if (!target) return { diffs: [], newBlocks: [] };
  const text = String(target.text);
  const cut = Math.max(4, Math.floor(text.length * 0.6));
  const keep = text.slice(0, cut);
  const drop = text.slice(cut);
  const add = `（按「${prompt}」重写：下周约三家公司做模拟面试。）`;
  return {
    diffs: [{
      blockId: target.id,
      segments: [
        { t: keep, op: 'keep' },
        { t: drop, op: 'del' },
        { t: add, op: 'add' },
      ],
      finalText: keep + add,
    }],
    newBlocks: [{
      id: `b_ai_${Date.now().toString(36)}`,
      type: 'paragraph',
      text: `AI 新增：${prompt}`,
    }],
  };
}

export default function AiPanel() {
  const { activeEntryId, blocksOf, setBlocksOf, sections } = useApp();
  const [prompt, setPrompt] = useState('');
  const [pendings, setPendings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null); // { status, pendingId, message }
  const [isolation, setIsolation] = useState(null);
  const [dir, setDir] = useState('');

  // 作用对象**显式选**（对应 CLI 的 `entry ai suggest <ref>`），默认取当前打开的详情条目
  const allEntries = [];
  for (const sec of Object.values(sections)) {
    for (const e of sec.entries || []) allEntries.push({ id: e.id, title: e.title, section: sec.title });
  }
  const [targetId, setTargetId] = useState(null);
  const effectiveId = targetId || activeEntryId;
  const blocks = blocksOf(effectiveId);
  const entryTitle = allEntries.find((e) => e.id === effectiveId)?.title || null;

  const refresh = useCallback(async () => {
    const r = await listPending();
    setPendings(r.pendings || []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const suggest = async () => {
    if (!effectiveId || !prompt.trim()) return;
    setBusy(true);
    // 先把这批块同步给服务端再 suggest——baseHash 由服务端按**自己的副本**算，
    // 客户端的副本落后一步就会把 baseHash 算成 null（实测踩到）。
    await syncBlocks(effectiveId, blocks, { title: entryTitle || effectiveId }).catch(() => {});
    const plan = simulate(prompt.trim(), blocks);
    const r = await suggestPending({
      entryId: effectiveId,
      entryTitle: entryTitle || effectiveId,
      diffs: plan.diffs,
      newBlocks: plan.newBlocks,
      removedIds: [],
    });
    setBusy(false);
    if (r.ok) {
      setLast({ status: r.body.status, pendingId: r.body.pendingId, message: `已落盘：${r.body.file}` });
      setDir(r.body.dir || '');
      await refresh();
    } else {
      setLast({ status: 'error', message: JSON.stringify(r.body) });
    }
  };

  const apply = async (p, force) => {
    setBusy(true);
    const r = await applyPending(p.id, { force });
    setBusy(false);
    if (r.status === 200 && r.body.status === 'ok') {
      if (effectiveId && r.body.blocks) setBlocksOf(effectiveId, r.body.blocks);
      setLast({ status: 'ok', pendingId: p.id, message: '已应用（写 store）' });
    } else if (r.status === 409) {
      // **冲突：不覆盖** —— 明确告诉用户哪些块变了，让用户决定
      setLast({
        status: 'conflict',
        pendingId: p.id,
        message: `冲突：${r.body.conflicts.map((c) => c.blockId).join('、')} 已被改过，未覆盖`,
        conflicts: r.body.conflicts,
      });
    } else {
      setLast({ status: 'error', message: JSON.stringify(r.body) });
    }
    await refresh();
  };

  const reject = async (p) => {
    await rejectPending(p.id);
    setLast({ status: 'rejected', pendingId: p.id, message: '已拒绝（pending 文件已删）' });
    await refresh();
  };

  const check = async () => {
    const probe = pendings[0]?.id || 'pending-marker';
    const r = await isolationCheck(probe);
    setIsolation(r.body);
  };

  return (
    <Panel
      toolbar={
        <>
          <strong>块级 AI</strong>
          <span className="muted">pending {pendings.length} 处</span>
          <span className="grow" />
          <button onClick={check} title="真去 grep store.json 与导出包">隔离自检</button>
          <button onClick={() => pendings.forEach((p) => reject(p))} disabled={!pendings.length}>拒绝全部</button>
          <button className="primary" onClick={() => pendings.forEach((p) => apply(p, false))} disabled={!pendings.length}>应用全部</button>
        </>
      }
      footer={
        <>
          <span className="muted">
            pending 落 {dir || '<home>/pending/'}：不进 store.json、不进导出包
          </span>
          <span className="grow" />
          <span className="mono muted">entry ai suggest / apply / reject</span>
        </>
      }
    >
      {/* AI Bar：空格唤起 */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--soft-2)' }}>
        <div className="rowgap" style={{ marginBottom: 6 }}>
          <span className="muted">作用对象</span>
          <select
            value={effectiveId || ''}
            onChange={(e) => setTargetId(e.target.value)}
            style={{ height: 22, font: 'inherit' }}
          >
            {allEntries.map((e) => (
              <option key={e.id} value={e.id}>{e.title}（{e.section}）</option>
            ))}
          </select>
          <span className="muted">块 {blocks.length} 个</span>
        </div>
        <div className="rowgap">
          <input
            id="ai-prompt"
            name="ai-prompt"
            type="text"
            value={prompt}
            placeholder="对当前条目正文提一条修改指令…（空格唤起 AI Bar）"
            style={{ flex: 1, minWidth: 200 }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') suggest(); }}
          />
          <button className="primary" onClick={suggest} disabled={busy || !effectiveId || !prompt.trim()}>
            生成建议
          </button>
        </div>
      </div>

      {last ? (
        <div
          style={{
            padding: '6px 12px', borderBottom: '1px solid var(--soft-2)',
            color: last.status === 'conflict' ? 'var(--danger)' : undefined,
          }}
        >
          <b>{last.status}</b> · {last.message}
          {last.conflicts?.length ? (
            <div className="mono muted" style={{ fontSize: 11 }}>
              {last.conflicts.map((c) => `${c.blockId}: base=${c.expected} now=${c.actual}`).join(' | ')}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ padding: '10px 12px' }}>
        {pendings.map((p) => (
          <div key={p.id} style={{ marginBottom: 10, border: '1px solid var(--soft-2)', borderRadius: 8, padding: 8 }}>
            <div className="rowgap" style={{ marginBottom: 6 }}>
              <Tag>pending</Tag>
              <span className="mono muted">{p.id}</span>
              <span className="muted">{p.entryTitle}</span>
              <span className="grow" />
              <button style={{ height: 20 }} onClick={() => reject(p)}>拒绝</button>
              <button style={{ height: 20 }} onClick={() => apply(p, false)}>应用</button>
              <button style={{ height: 20 }} title="块已被改过也强推" onClick={() => apply(p, true)}>强推</button>
            </div>

            {(p.diffs || []).map((d) => (
              <div key={d.blockId} style={{ marginBottom: 4 }}>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {d.blockId} · baseHash {String(d.baseHash).slice(0, 8)}
                </div>
                <div>
                  {(d.segments || []).map((sg, i) => (
                    <span key={i} style={SEG_STYLE[sg.op]}>{sg.t}</span>
                  ))}
                </div>
              </div>
            ))}

            {(p.newBlocks || []).map((nb) => (
              <div key={nb.id} style={{ background: '#f2f8f3', borderLeft: '2px solid #1c5c2e', paddingLeft: 8 }}>
                <span className="tag">新增</span> {nb.text}
              </div>
            ))}

            {(p.removedIds || []).map((rid) => (
              <div key={rid} style={{ opacity: 0.55, textDecoration: 'line-through' }}>{rid}（删除）</div>
            ))}
          </div>
        ))}

        {!pendings.length ? (
          <div className="muted">没有待处理的 pending（应用或拒绝后即清空）。</div>
        ) : null}

        {isolation ? (
          <div style={{ border: '1px solid var(--soft-2)', borderRadius: 8, padding: 8, marginTop: 8 }}>
            <div className="rowgap" style={{ marginBottom: 4 }}>
              <Tag>隔离自检</Tag>
              <span className="mono muted">{isolation.pendingDir}</span>
              <span className="grow" />
              <span>{isolation.ok ? '通过' : '不通过'}</span>
            </div>
            {isolation.checks.map((c) => (
              <div key={c.what} style={{ fontSize: 11 }}>
                {c.pass ? '通过' : '不通过'} · {c.what}
                {c.detail?.length ? `（泄漏字段：${c.detail.join(', ')}）` : ''}
              </div>
            ))}
            <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
              pending 文件：{(isolation.pendingFileList || []).join(', ') || '（无）'}
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
