// 统一的「导出 / 导入」面板：按栏目（ZIP，可口令加密）与整库备份（.nxskbak）并排成一个 tab。
//
// 与栏目页里那套是**同一套包格式**：全局包只是外层容器（bundle.json + sections/<id>.zip），
// 每个栏目仍走单栏目导出/导入，所以结构、附件、冲突策略的表现完全一致。
//
// 选择语义：
//   sel[sectionId] === true      → 整个栏目（含以后新增的条目）
//   sel[sectionId] === Set(ids)  → 只选这些条目
//   不存在                        → 不导出
//
// 口令加密是**可选的**：留空 = 明文 ZIP（和 0.11.0 一样）；填了 = 整个包用 AES-256-GCM 加密，
// 导入时同一个入口先问口令再预览。加密只作用在最外层，所以「包里有哪些栏目」也一并藏住。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { checkZipFile, fmtBytes, isEncryptedZip, postZip } from '../api/zip.js';
import { useStore } from '../store.jsx';
import { Empty, Modal, Tag } from './ui.jsx';
import BackupPanel from '../../../modules/backup/view.jsx';

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

const EMPTY_SEL = {};

export default function TransferPanel() {
  const { toast, guard, reload } = useStore();
  const [tab, setTab] = useState('sections');
  const [sections, setSections] = useState([]);
  const [sel, setSel] = useState(EMPTY_SEL);
  const [active, setActive] = useState('');
  const [entries, setEntries] = useState({});
  const [withSecrets, setWithSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [busy, setBusy] = useState(false);
  const [zip, setZip] = useState(null);
  // 加密包先问口令：{ fileName, buffer }
  const [ask, setAsk] = useState(null);
  const [askPw, setAskPw] = useState('');
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

  // 默认激活第一个栏目：不选就永远看不到条目列表
  useEffect(() => {
    if (!active && sections.length) setActive(sections[0].id);
  }, [active, sections]);

  const loadEntries = useCallback(async (id) => {
    if (entries[id]) return;
    try {
      const d = await api(`/api/entries?section=${encodeURIComponent(id)}`);
      setEntries((prev) => ({ ...prev, [id]: d.entries }));
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [entries, toast]);

  // 条目是**纵向展开**在当前栏目下的：点一下 chips 换栏目，顺手把它的条目取回来
  useEffect(() => {
    if (active) loadEntries(active);
  }, [active, loadEntries]);

  const cur = sections.find((s) => s.id === active) || null;
  const curList = (active && entries[active]) || null;
  const curSel = active ? sel[active] : undefined;
  const whole = curSel === true;
  const curPicked = curSel === true
    ? (cur?.entries || 0)
    : (curSel instanceof Set ? curSel.size : 0);

  const toggleWhole = () => setSel((prev) => {
    const next = { ...prev };
    if (prev[active] !== undefined) delete next[active];
    else next[active] = true;
    return next;
  });

  const toggleEntry = (entryId) => setSel((prev) => {
    const list = curList || [];
    const set = prev[active] === true ? new Set(list.map((e) => e.id)) : new Set(prev[active] || []);
    if (set.has(entryId)) set.delete(entryId); else set.add(entryId);
    const next = { ...prev };
    if (!set.size) delete next[active]; else next[active] = set;
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
    if (!list.length) { toast('先选择要导出的栏目', 'bad'); return; }
    const pw = passphrase.trim();
    if (pw && pw !== passphrase2) { toast('两次输入的口令不一致', 'bad'); return; }
    setBusy(true);
    try {
      const blob = await postJsonZip('/api/bundle/export.zip', {
        selection: list,
        'no-secrets': !withSecrets,
        ...(pw ? { passphrase: pw } : {}),
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nx-sk-bundle-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      // 立刻 remove 会让 Chromium 把下载判成取消；留给它一拍
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      setPassphrase(''); setPassphrase2('');
      toast(`已开始下载：${list.length} 个栏目${withSecrets ? '（含凭据）' : '（凭据已打码）'}${pw ? ' · 已加密' : ''}`);
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  const openZip = (fileName, buffer, pass) => {
    setBusy(true);
    const qs = new URLSearchParams({ 'dry-run': '1' });
    if (pass) qs.set('passphrase', pass);
    return postZip(`/api/bundle/import.zip?${qs}`, buffer, fileName)
      .then((preview) => {
        setZip({ fileName, buffer, preview, passphrase: pass || '' });
        setConflict('skip');
      })
      .finally(() => setBusy(false));
  };

  const handleZip = guard(async (file) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      toast(`读不到文件：${e.message}`, 'bad');
      return;
    }
    // 加密包：先问口令，别把「缺口令」当成「包坏了」报出来
    if (isEncryptedZip(buffer)) {
      setAsk({ fileName: file.name, buffer });
      setAskPw('');
      return;
    }
    try {
      await openZip(file.name, buffer, '');
    } catch (e) {
      toast(e.message || String(e), 'bad');
    }
  });

  const submitAsk = guard(async () => {
    if (!ask) return;
    const pw = askPw.trim();
    if (!pw) { toast('请输入口令', 'bad'); return; }
    try {
      await openZip(ask.fileName, ask.buffer, pw);
      setAsk(null);
      setAskPw('');
    } catch (e) {
      toast(e.message || String(e), 'bad');
    }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setBusy(true);
    try {
      const qs = new URLSearchParams({ 'on-conflict': conflict });
      if (zip.passphrase) qs.set('passphrase', zip.passphrase);
      const r = await postZip(`/api/bundle/import.zip?${qs}`, zip.buffer, zip.fileName);
      setZip(null);
      toast(`导入完成：${r.totals.sections} 个栏目，新增 ${r.totals.added} / 另存 ${r.totals.copied} / 覆盖 ${r.totals.overwritten} / 跳过 ${r.totals.skipped}`);
      // 条目缓存与展开状态一起清掉：导入可能给栏目新增条目，
      // 留着旧缓存会让「展开」里看不到刚导入的那条。
      setEntries({});
      setOpen({});
      setSel({});
      await load();
      await reload();
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="transfer-panel">
      <div className="card">
        <div className="colhead">
          导出 / 导入
          <span className="right">
            <span className="muted hint">
              {pickedSections ? `已选 ${pickedSections} 栏目 · ${pickedEntries} 条目` : '未选择'}
            </span>
            <span className="tabs">
              <button type="button" className={`tab${tab === 'sections' ? ' on' : ''}`} onClick={() => setTab('sections')}>按栏目</button>
              <button type="button" className={`tab${tab === 'backup' ? ' on' : ''}`} onClick={() => setTab('backup')}>整库备份</button>
            </span>
          </span>
        </div>

        {tab === 'backup' ? (
          <div className="pad hint">整库加密备份（含设置与附件台账），与按栏目导出是同一个「倒出去 / 倒回来」的目的：一个按需取部分，一个整份带走。</div>
        ) : (
          <div className="pad stack">
            <div className="rowgap">
              <button className="btn small ghost" onClick={selectAll}>全选</button>
              <button className="btn small ghost" onClick={clearAll} disabled={!pickedSections}>清空</button>
              <span className="grow" />
              <button className="btn small" onClick={exportZip} disabled={busy || !pickedSections}>
                {busy ? '处理中…' : '导出 ZIP'}
              </button>
            </div>

            {/* 栏目横向排：一眼看完有哪些、选了几个 */}
            <div className="sec-strip">
              {sections.map((s) => {
                const st = sel[s.id];
                const n = st === true ? (s.entries || 0) : (st instanceof Set ? st.size : 0);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`sec-chip${active === s.id ? ' on' : ''}${n ? ' picked' : ''}`}
                    onClick={() => setActive(s.id)}
                    title={s.description || s.id}
                  >
                    <span className="chip-name">{s.title}</span>
                    <span className="chip-meta">{n ? `${n}/${s.entries}` : `${s.entries} 条`}</span>
                  </button>
                );
              })}
              {!sections.length ? <Empty>还没有栏目</Empty> : null}
            </div>

            {/* 条目纵向展开：勾选即精确导出 */}
            {cur ? (
              <div className="entry-panel">
                <div className="entry-head">
                  <label className="inline pickall" title="勾上 = 整个栏目（含以后新增的条目）">
                    <input type="checkbox" checked={whole} onChange={toggleWhole} />
                    <span>整个栏目（{cur.entries} 条）</span>
                  </label>
                  <span className="grow" />
                  <span className="hint">已选 {curPicked} / {cur.entries}</span>
                </div>
                <div className="entry-list">
                  {!curList ? <span className="hint">正在加载条目…</span> : (curList.length ? curList.map((e) => (
                    <label key={e.id} className="entry-row">
                      <input
                        type="checkbox"
                        checked={whole || (curSel instanceof Set && curSel.has(e.id))}
                        onChange={() => toggleEntry(e.id)}
                      />
                      <span className="name">{e.title || '（无名）'}</span>
                      <span className="hint">{e.completeness ? `${e.completeness.ratio}%` : ''}</span>
                    </label>
                  )) : <span className="hint">这个栏目还没有条目</span>)}
                </div>
              </div>
            ) : null}

            {/* 导出选项：凭据 + 口令（口令只影响这个包，不影响数据本身） */}
            <div className="export-opts">
              <div className="opt-group">
                <span className="opt-label">凭据</span>
                <label className={`pill${withSecrets ? '' : ' on'}`}>
                  <input type="radio" name="secrets" checked={!withSecrets} onChange={() => setWithSecrets(false)} />
                  打码
                </label>
                <label className={`pill${withSecrets ? ' on' : ''}`}>
                  <input type="radio" name="secrets" checked={withSecrets} onChange={() => setWithSecrets(true)} />
                  含明文
                </label>
              </div>
              <div className="opt-group">
                <span className="opt-label">口令</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className="pw"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="留空 = 明文包"
                />
                {passphrase ? (
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="pw"
                    value={passphrase2}
                    onChange={(e) => setPassphrase2(e.target.value)}
                    placeholder="再输一次"
                  />
                ) : null}
                <span className="hint">填了 = 下载的包整体加密，导入时需同一口令；忘了打不开</span>
              </div>
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
              <span className="hint">或点击选择文件 · 明文包与加密包都认 · 先预览会变成什么，再决定是否应用</span>
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
        )}
      </div>

      {tab === 'backup' ? <BackupPanel /> : null}

      {ask ? (
        <Modal
          title={`这个包已加密 · ${ask.fileName}`}
          onClose={() => { if (!busy) { setAsk(null); setAskPw(''); } }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setAsk(null)} disabled={busy}>取消</button>
              <button className="btn" onClick={submitAsk} disabled={busy || !askPw.trim()}>
                {busy ? '解密中…' : '打开预览'}
              </button>
            </>
          )}
        >
          <div className="stack">
            <div className="hint">导出时给这个包设了口令。输入同一口令才能预览与导入——口令不在文件里，错了只能重试。</div>
            <input
              type="password"
              autoComplete="off"
              className="pw"
              value={askPw}
              onChange={(e) => setAskPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAsk(); }}
              placeholder="导出时设置的口令"
            />
          </div>
        </Modal>
      ) : null}

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
                <div className="hint">
                  导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}
                  {p.encrypted ? '　·　已解密（口令已验证）' : ''}
                </div>
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
                      <span className="hint">
                        条目 {s.entries.total}（新增 {s.entries.fresh}）· 冲突 {s.entries.conflicts.length} · 补字段 {s.fieldsToAdd.length}
                      </span>
                    </div>
                  ))}
                </div>

                {/* 冲突明细：哪条撞了哪条、按什么规则、另存会变成什么 */}
                {t.conflicts ? (
                  <div className="stack">
                    <div className="flabel"><span>冲突明细</span><span className="fkey">撞 = 本地已有同 id 或同标题的条目</span></div>
                    <div className="conflict-list">
                      {p.sections.map((s) => s.entries.conflicts.map((c) => (
                        <div key={`${s.id}-${c.id}`} className="conflict-row">
                          <span className="sec">{s.title}</span>
                          <span className="title">{c.title}</span>
                          <span className="hint">
                            {c.reason === 'id' ? `同 id 撞上「${c.existingTitle}」` : `同标题撞上「${c.existingTitle}」`}
                          </span>
                          {conflict === 'copy' ? <span className="hint ok">→ {c.copyTitle}</span> : null}
                        </div>
                      )))}
                    </div>
                    <div className="flabel"><span>冲突怎么处理</span></div>
                    <label className="inline"><input type="radio" checked={conflict === 'skip'} onChange={() => setConflict('skip')} /> 跳过（保留现有）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'copy'} onChange={() => setConflict('copy')} /> 另存为新条目（标题加「导入」）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'overwrite'} onChange={() => setConflict('overwrite')} /> 覆盖现有条目的字段</label>
                  </div>
                ) : null}

                {p.warnings.slice(0, 8).map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}
    </div>
  );
}
