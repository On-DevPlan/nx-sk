/* 全局搜索 —— 顶栏搜索框 + 结果面板
 *
 * 跨栏目搜**条目名 / 字段值 / 块正文**（搜的语义见 src/search.js 与设计 §十七）。
 * 命中直接开详情面板；块命中还会**定位到那个块**（滚动 + 灰底闪一下）。
 *
 * 密文不参与搜索（见 search.js 的安全边界）——搜索框不是泄露口。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../appctx.jsx';
import { dedupeHits, searchAll } from '../search.js';

const KIND_LABEL = { section: '栏目', title: '条目名', field: '字段', block: '正文' };

/** 命中词高亮：单色系（灰底 + 加粗），不引新颜色 */
function Highlighted({ snippet }) {
  if (!snippet) return null;
  const before = snippet.text.slice(0, snippet.matchStart);
  const mid = snippet.text.slice(snippet.matchStart, snippet.matchEnd);
  const after = snippet.text.slice(snippet.matchEnd);
  return (
    <span>
      {before}
      <span style={{ background: 'var(--soft-2)', fontWeight: 600 }}>{mid}</span>
      {after}
    </span>
  );
}

export default function GlobalSearch() {
  const { sections, blocksOf, navigate, requestFocus } = useApp();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  // 拿整份块树（不是只有当前打开那条的）——搜索要跨条目
  const blocksByEntry = useMemo(() => {
    const m = {};
    for (const sec of Object.values(sections || {})) {
      for (const e of sec.entries || []) m[e.id] = blocksOf(e.id);
    }
    return m;
  }, [sections, blocksOf]);

  // 防抖：每键都全量扫会卡
  useEffect(() => {
    if (!q.trim()) { setHits([]); return undefined; }
    const t = setTimeout(() => {
      setHits(dedupeHits(searchAll(sections, blocksByEntry, q)));
      setCursor(0);
      setOpen(true);
    }, 120);
    return () => clearTimeout(t);
  }, [q, sections, blocksByEntry]);

  // 点外面就收起
  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const open_ = (hit) => {
    // 栏目名命中 → 开这个栏目的数据库面板；其余命中 → 开条目详情
    // （**一律写深链**：地址栏 = 当前打开的面板）
    if (hit.kind === 'section') {
      navigate(hit.sectionId);
    } else {
      navigate(hit.sectionId, hit.entryId);
      // 块命中 → 定位到那个块（条目命中就不定位）
      if (hit.blockId) requestFocus(hit.entryId, hit.blockId);
    }
    setOpen(false);
    setQ('');
    setHits([]);
  };

  const onKeyDown = (e) => {
    if (!open || !hits.length) {
      if (e.key === 'Escape') { setOpen(false); setQ(''); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); open_(hits[cursor]); }
    if (e.key === 'Escape') { setOpen(false); setQ(''); }
  };

  // 光标移动时把选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="1"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        id="global-search"
        name="global-search"
        type="search"
        value={q}
        placeholder="全局搜索：条目 / 字段 / 正文…"
        style={{ width: 230 }}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => { if (hits.length) setOpen(true); }}
        onKeyDown={onKeyDown}
        aria-label="全局搜索"
      />
      {open && hits.length ? (
        <div
          ref={listRef}
          className="drawer"
          style={{ position: 'absolute', right: 0, top: 36, width: 380, maxHeight: 360, overflow: 'auto', padding: 2 }}
        >
          {hits.map((h, i) => (
            <div
              key={`${h.entryId}:${h.kind}:${h.blockId || h.fieldLabel || ''}`}
              className="it"
              data-active={i === cursor ? '1' : '0'}
              style={{
                display: 'block',
                background: i === cursor ? 'var(--soft)' : undefined,
                padding: '5px 8px',
              }}
              onMouseEnter={() => setCursor(i)}
              onClick={() => open_(h)}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="tag">{KIND_LABEL[h.kind]}</span>
                <strong className="nowrap">{h.title}</strong>
                <span className="muted">{h.sectionTitle}</span>
                {h.fieldLabel ? <span className="muted">· {h.fieldLabel}</span> : null}
              </div>
              <div className="muted nowrap" style={{ fontSize: 11, marginTop: 2 }}>
                <Highlighted snippet={h.snippet} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {open && q.trim() && !hits.length ? (
        <div className="drawer" style={{ position: 'absolute', right: 0, top: 36, width: 220 }}>
          <div className="it muted">没有命中（密文不参与搜索）</div>
        </div>
      ) : null}
    </div>
  );
}
