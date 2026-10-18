// 统一的「全局导出 / 导入」面板：栏目树 + 条目多选 + 拖入 ZIP + 应用前预览。
//
// 与栏目页里那套是**同一套包格式**：全局包只是外层容器（bundle.json + sections/<id>.zip），
// 每个栏目仍走单栏目导出/导入，所以结构、附件、冲突策略的表现完全一致。
//
// 选择语义：
//   sel[sectionId] === true      → 整个栏目（含以后新增的条目）
//   sel[sectionId] === Set(ids)  → 只选这些条目
//   不存在                        → 不导出
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { checkZipFile, fmtBytes, postZip } from '../api/zip.js';
import { useStore } from '../store.jsx';
import { Empty, Modal, Tag } from './ui.jsx';

async function postJsonZip(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export default function TransferPanel() {
  const { toast, guard, reload } = useStore();
  const [sections, setSections] = useState([]);
  const [sel, setSel] = useState({});
  const [open, setOpen] = useState({});
  const [entries, setEntries] = useState({});
  const [withSecrets, setWithSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zip, setZip] = useState(null);
  const [conflict, setConflict] = useState('skip');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/sections');
      setSections(d.sections);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const loadEntries = useCallback(async (id) => {
    if (entries[id]) return;
    try {
      const d = await api(`/api/entries?section=${encodeURIComponent(id)}`);
      setEntries((prev) => ({ ...prev, [id]: d.entries }));
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [entries, toast]);

  const toggleOpen = (id) => {
    const next = !open[id];
    setOpen((prev) => ({ ...prev, [id]: next }));
    if (next) loadEntries(id);
  };

  const toggleSection = (id) => setSel((prev) => {
    const next = { ...prev };
    if (next[id] !== undefined) delete next[id];
    else next[id] = true;
    return next;
  });

  const toggleEntry = (secId, entryId) => setSel((prev) => {
    const list = entries[secId] || [];
    const cur = prev[secId];
    const set = cur === true ? new Set(list.map((e) => e.id)) : new Set(cur || []);
    if (set.has(entryId)) set.delete(entryId); else set.add(entryId);
    const next = { ...prev };
    if (!set.size) delete next[secId]; else next[secId] = set;
    return next;
  });

  const selectAll = () => setSel(Object.fromEntries(sections.map((s) => [s.id, true])));
  const clearAll = () => setSel({});

  const pickedSections = Object.keys(sel).length;
  const pickedEntries = Object.entries(sel).reduce((n, [id, v]) => (
    n + (v === true ? (sections.find((s) => s.id === id)?.entries || 0) : v.size)
  ), 0);

  const exportZip = guard(async () => {
    const list = Object.entries(sel).map(([id, v]) => (v === true ? { id } : { id, entries: [...v] }));
    if (!list.length) { toast('先勾选要导出的栏目或条目', 'bad'); return; }
    setBusy(true);
    try {
      const blob = await postJsonZip('/api/bundle/export.zip', { selection: list, 'no-secrets': !withSecrets });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nx-sk-bundle-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast(`已开始下载：${list.length} 个栏目${withSecrets ? '（含凭据）' : '（凭据已打码）'}`);
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  const handleZip = guard(async (file) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const preview = await postZip('/api/bundle/import.zip?dry-run=1', buffer, file.name);
      setZip({ fileName: file.name, buffer, preview });
      setConflict('skip');
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setBusy(true);
    try {
      const r = await postZip(`/api/bundle/import.zip?on-conflict=${encodeURIComponent(conflict)}`, zip.buffer, zip.fileName);
      setZip(null);
      toast(`导入完成：${r.totals.sections} 个栏目，新增 ${r.totals.added} / 另存 ${r.totals.copied} / 覆盖 ${r.totals.overwritten} / 跳过 ${r.totals.skipped}`);
      // 条目缓存与展开状态一起清掉：导入可能给栏目新增条目，
      // 留着旧缓存会让「展开」里看不到刚导入的那条。
      setEntries({});
      setOpen({});
      await load();
      await reload();
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="card transfer-panel">
      <div className="colhead">
        全局导出 / 导入
        <span className="right muted">
          {pickedSections ? `已选 ${pickedSections} 栏目 · ${pickedEntries} 条目` : '未选择'}
        </span>
      </div>

      <div className="pad stack">
        <div className="rowgap">
          <button className="btn small ghost" onClick={selectAll}>全选</button>
          <button className="btn small ghost" onClick={clearAll} disabled={!pickedSections}>清空</button>
          <label className="inline hint">
            <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
            <span className={withSecrets ? 'bad' : ''}>{withSecrets ? '包含凭据明文（注意存放）' : '凭据打码'}</span>
          </label>
          <span className="grow" />
          <button className="btn small" onClick={exportZip} disabled={busy || !pickedSections}>
            {busy ? '处理中…' : '导出选中的 ZIP'}
          </button>
        </div>

        <div className="tree">
          {sections.length ? sections.map((s) => {
            const state = sel[s.id];
            const checked = state !== undefined;
            const list = entries[s.id];
            return (
              <div key={s.id} className="tree-sec">
                <div className="tree-row">
                  <input type="checkbox" checked={checked} onChange={() => toggleSection(s.id)} title="选中整个栏目" />
                  <button type="button" className="btn small ghost" onClick={() => toggleOpen(s.id)}>
                    {open[s.id] ? '收起' : '展开'}
                  </button>
                  <span className="name">{s.title}</span>
                  <span className="mono muted">{s.id}</span>
                  <Tag>{s.entries} 条</Tag>
                  {state instanceof Set ? <span className="hint">已选 {state.size} 条</span> : null}
                </div>
                {open[s.id] ? (
                  <div className="tree-items">
                    {!list ? <span className="hint">加载条目…</span> : (list.length ? list.map((e) => (
                      <label key={e.id} className="tree-item">
                        <input
                          type="checkbox"
                          checked={state === true || (state instanceof Set && state.has(e.id))}
                          onChange={() => toggleEntry(s.id, e.id)}
                        />
                        <span className="name">{e.title || '（无名）'}</span>
                        <span className="hint">{e.completeness ? `${e.completeness.ratio}%` : ''}</span>
                      </label>
                    )) : <span className="hint">（该栏目还没有条目）</span>)}
                  </div>
                ) : null}
              </div>
            );
          }) : <Empty>还没有栏目</Empty>}
        </div>

        <div
          className={`drop-box${dragOver ? ' over' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = [...(e.dataTransfer?.files || [])][0];
            handleZip(f);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }}
        >
          <strong>把导出的 ZIP 拖到这里</strong>
          <span className="hint">或点击选择文件 · 先预览会变成什么，再决定是否应用</span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = [...(e.target.files || [])][0];
            e.target.value = '';
            handleZip(f);
          }}
        />
      </div>

      {zip ? (
        <Modal
          title={`导入预览 · ${zip.fileName}`}
          onClose={() => { if (!busy) setZip(null); }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setZip(null)} disabled={busy}>取消</button>
              <button className="btn" onClick={applyZip} disabled={busy}>{busy ? '导入中…' : '确认导入'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            const t = p.totals;
            return (
              <div className="stack">
                <div className="hint">导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}</div>
                <div className="rowgap">
                  <Tag>栏目 {t.sections}{t.newSections ? `（新建 ${t.newSections}）` : ''}</Tag>
                  <Tag>条目 {t.entries}</Tag>
                  <Tag>新增 {t.fresh}</Tag>
                  {t.conflicts ? <span className="tag bad">冲突 {t.conflicts}</span> : null}
                  <Tag>附件 新增 {t.filesNew} / 复用 {t.filesReused}（{fmtBytes(t.bytes)}）</Tag>
                </div>

                <div className="block">
                  {p.sections.map((s) => (
                    <div key={s.id} className="transfer-sec-row">
                      <strong>{s.title}</strong>
                      <span className="mono muted">{s.id}</span>
                      {s.willCreate ? <span className="tag">新建</span> : null}
                      <span className="hint">条目 {s.entries.total} · 冲突 {s.entries.conflicts.length} · 补字段 {s.fieldsToAdd.length}</span>
                    </div>
                  ))}
                </div>

                {t.conflicts ? (
                  <div className="stack">
                    <div className="flabel"><span>冲突怎么处理</span></div>
                    <label className="inline"><input type="radio" checked={conflict === 'skip'} onChange={() => setConflict('skip')} /> 跳过（保留现有）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'copy'} onChange={() => setConflict('copy')} /> 另存为新条目（标题加「导入」）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'overwrite'} onChange={() => setConflict('overwrite')} /> 覆盖现有条目的字段</label>
                  </div>
                ) : null}

                {p.warnings.slice(0, 6).map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}
    </div>
  );
}
