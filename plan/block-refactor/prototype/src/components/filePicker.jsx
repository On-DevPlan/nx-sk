/* 附件选择器 —— **选择面板，不是下拉框**（40-files.md 的规矩）
 *
 *   · 可搜索：按名称 / 标签过滤（库里几十个附件时下拉框根本没法挑）
 *   · 未引用优先：没有引用的原件排前面；已引用的排后面并标「已被 N 处引用」——**仍然可选**
 *     （同一原件可被多条条目共享，「已被 N 处引用」说的不是「不能选」）
 *   · 点一行即**追加**到本块，可以连点多个；已挂上的从列表里消失（它已经在这个块里了）
 */

import { useMemo, useState } from 'react';
import { useApp } from '../appctx.jsx';

export default function FilePicker({ blockFiles, onPick, onClose }) {
  const { library, fileRefs } = useApp();
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const assigned = new Set(blockFiles || []);
    const k = q.trim().toLowerCase();
    return (library || [])
      .filter((f) => !assigned.has(f.id))
      .filter((f) => !k || f.name.toLowerCase().includes(k) || (f.tags || []).some((t) => t.toLowerCase().includes(k)))
      .map((f) => ({ ...f, refs: fileRefs?.get(f.id) || 0 }))
      .sort((a, b) => (a.refs - b.refs) || a.name.localeCompare(b.name));
  }, [library, blockFiles, q, fileRefs]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ minWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>从附件库选…</h3>
        <input
          id="file-picker-search"
          name="file-picker-search"
          type="search"
          autoFocus
          placeholder="按名称 / 标签过滤…"
          style={{ width: '100%', marginBottom: 8 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--soft-2)', borderRadius: 6 }}>
          {list.map((f) => (
            <div
              key={f.id}
              onClick={() => onPick(f)}
              style={{
                display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px',
                borderBottom: '1px solid var(--soft)', cursor: 'pointer',
              }}
            >
              <span className="nowrap grow">{f.name}</span>
              <span className="muted" style={{ fontSize: 11 }}>{f.size}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {f.refs ? `已被 ${f.refs} 处引用` : '未引用'}
              </span>
            </div>
          ))}
          {!list.length ? <div className="muted" style={{ padding: 10 }}>（没有可追加的附件）</div> : null}
        </div>
        <div className="muted" style={{ fontSize: 11, margin: '8px 0' }}>
          点一行即追加到本块，可以连点多个；同一个原件可被多个块共享。
        </div>
        <div className="acts">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
