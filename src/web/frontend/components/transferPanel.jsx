// 「加密导出 / 解密导入」—— 一个面板，一次心智：选什么 → 设口令 → 倒出去 / 倒回来。
//
// **没有「按栏目 / 整库」两个模式**：栏目的全选就是整库导出。预设按钮「整库」只是
// 「把所有栏目勾上」的快捷方式，产物与逐栏勾选完全一致——同一个包格式、同一套导入逻辑，
// 不存在第二条链路。（整库加密备份 .nxskbak 在「设置」里，那是带设置与附件台账的快照，
// 用途不同：一个是取数据，一个是留后路。）
//
// 与栏目页里那套是**同一套包格式**：全局包只是外层容器（bundle.json + sections/<id>.zip），
// 每个栏目仍走单栏目导出/导入，所以结构、附件、冲突策略的表现完全一致。
//
// 选择语义：
//   sel[sectionId] === true      → 整个栏目（含以后新增的条目）
//   sel[sectionId] === Set(ids)  → 只选这些条目
//   不存在                        → 不导出
//
// 包里**恒为明文**，保护靠口令：填了 = 整个包 AES-256-GCM 加密（导入时同一个入口先问口令），
// 留空 = 明文 ZIP。加密只作用在最外层，所以「包里有哪些栏目」也一并藏住。
//
// 交互口径（UI 指引）：
//   - chips 是原生 <button>，选中态走 aria-pressed，展开态走 aria-expanded，键盘可聚焦；
//   - 悬浮展开只是**增强**（省一次点击），点击/聚焦立即可用——不能只靠 hover；
//   - chips 一律换行，长标题省略号 + title 兜底，不裁切、不挤成一行；
//   - 主操作（口令 + 导出）放在卡片头部，条目再多也不用滚动去找按钮。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { checkZipFile, fmtBytes, isEncryptedZip, postZip } from '../api/zip.js';
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

// 指针移到 chip 上多久才展开它的条目：太短会「路过就跳」，太长又嫌迟钝。
const OPEN_DELAY = 90;

export default function TransferPanel() {
  const { toast, guard, reload } = useStore();
  const [sections, setSections] = useState([]);
  const [sel, setSel] = useState({});
  const [active, setActive] = useState('');
  const [entries, setEntries] = useState({});
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [busy, setBusy] = useState(false);
  const [zip, setZip] = useState(null);
  const [ask, setAsk] = useState(null); // 加密包先问口令：{ fileName, buffer }
  const [askPw, setAskPw] = useState('');
  const [conflict, setConflict] = useState('skip');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const openTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/sections');
      setSections(d.sections);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  // 默认激活第一个栏目：不选就永远看不到条目
  useEffect(() => {
    if (!active && sections.length) setActive(sections[0].id);
  }, [active, sections]);

  const loadEntries = useCallback(async (id) => {
    if (!id || entries[id]) return;
    try {
      const d = await api(`/api/entries?section=${encodeURIComponent(id)}`);
      setEntries((prev) => ({ ...prev, [id]: d.entries }));
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [entries, toast]);
  useEffect(() => { loadEntries(active); }, [active, loadEntries]);

  // ── 悬浮自动展开 ────────────────────────────────────────────
  // 指针移到 chip 上，延迟一会儿就把它栏目的条目展开在下面；离开时只取消**还没触发**的
  // 切换（指针只是路过不该跟着跳）。展开区常驻，没有「收起」态，也就没有闪缩动画。
  const cancelOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  useEffect(() => cancelOpen, []);

  const hoverChip = (id) => {
    if (id === active) return;
    cancelOpen();
    openTimer.current = setTimeout(() => setActive(id), OPEN_DELAY);
  };
  const activate = (id) => { cancelOpen(); setActive(id); };

  const cur = sections.find((s) => s.id === active) || null;
  const curList = (active && entries[active]) || null;
  const curSel = active ? sel[active] : undefined;
  const whole = curSel === true;
  const curPicked = curSel === true ? (cur?.entries || 0) : (curSel instanceof Set ? curSel.size : 0);

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

  // 「整库」= 所有栏目全选。它不是另一种导出模式，就是全选——产物与逐栏勾选同一个格式。
  const selectAll = () => setSel(Object.fromEntries(sections.map((s) => [s.id, true])));
  const clearAll = () => setSel({});

  const pickedSections = Object.keys(sel).length;
  const pickedEntries = Object.entries(sel).reduce((n, [id, v]) => (
    n + (v === true ? (sections.find((s) => s.id === id)?.entries || 0) : v.size)
  ), 0);
  const isWholeLib = sections.length > 0 && pickedSections === sections.length;

  const exportZip = guard(async () => {
    const list = Object.entries(sel).map(([id, v]) => (v === true ? { id } : { id, entries: [...v] }));
    if (!list.length) { toast('先选择要导出的栏目', 'bad'); return; }
    const pw = passphrase.trim();
    if (pw && pw !== passphrase2) { toast('两次输入的口令不一致', 'bad'); return; }
    setBusy(true);
    try {
      const blob = await postJsonZip('/api/bundle/export.zip', {
        selection: list,
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
      toast(`已开始下载：${list.length} 个栏目${pw ? ' · 已加密' : ' · 未设口令（明文包）'}`);
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
      setEntries({});
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
    <div className="card tp">
      <div className="colhead tp-head">
        加密导出 / 解密导入
        <span className="right tp-headacts">
          <span className="hint">
            {pickedSections
              ? `${isWholeLib ? '整库' : `已选 ${pickedSections} / ${sections.length} 栏目`} · ${pickedEntries} 条目`
              : '未选择'}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className="pw"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="口令（留空 = 明文包）"
            aria-label="导出口令"
          />
          {passphrase ? (
            <input
              type="password"
              autoComplete="new-password"
              className="pw"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              placeholder="再输一次"
              aria-label="确认导出口令"
            />
          ) : null}
          <button type="button" className="btn small" onClick={exportZip} disabled={busy || !pickedSections}>
            {busy ? '处理中…' : '导出 ZIP'}
          </button>
        </span>
      </div>

      <div className="tp-grid">
        {/* ── 左：选什么 ─────────────────────────────────────── */}
        <section className="tp-col" aria-label="选择要导出的内容">
          <div className="tp-colhead">
            <span className="tp-step">1</span>选择内容
            <span className="grow" />
            <button type="button" className="btn small ghost" onClick={selectAll} disabled={!sections.length || isWholeLib}>
              整库
            </button>
            <button type="button" className="btn small ghost" onClick={clearAll} disabled={!pickedSections}>清空</button>
          </div>

          {/* 栏目横向排：一眼看完有哪些、各选了几个。指针移上去自动展开该栏目的条目 */}
          <div className="sec-strip" onMouseLeave={cancelOpen}>
            {sections.map((s) => {
              const st = sel[s.id];
              const n = st === true ? (s.entries || 0) : (st instanceof Set ? st.size : 0);
              // 选中态与条目数**无关**：空栏目被整库选中时也是选中。
              // 用 `!!n` 会让 0 条目的栏目显示成未选，读屏用户随之得到错误状态。
              const selected = st === true || st instanceof Set;
              const on = active === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`sec-chip${on ? ' on' : ''}${n ? ' picked' : ''}`}
                  onClick={() => activate(s.id)}
                  onMouseEnter={() => hoverChip(s.id)}
                  onFocus={() => activate(s.id)}
                  aria-pressed={selected}
                  aria-expanded={on}
                  title={`${s.title}（${s.entries} 条）${s.description ? ` — ${s.description}` : ''}`}
                >
                  <span className="chip-name">{s.title}</span>
                  <span className="chip-meta">{n ? `${n}/${s.entries}` : `${s.entries} 条`}</span>
                </button>
              );
            })}
            {!sections.length ? <Empty>还没有栏目</Empty> : null}
          </div>

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

          <p className="hint tp-tip">
            填了口令 = 整包 AES-256-GCM 加密，导入时要同一个口令；口令不在文件里，忘了打不开。
            「整库」就是所有栏目全选，与逐栏勾选是同一个包。
          </p>
        </section>

        {/* ── 右：倒回来 ─────────────────────────────────────── */}
        <section className="tp-col" aria-label="解密导入">
          <div className="tp-colhead"><span className="tp-step">2</span>解密导入</div>
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
            <span className="hint">或点击选择文件 · 明文包与加密包都认</span>
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
          <div className="tp-note">
            <div className="hint">导入前先预览，不写盘：</div>
            <ul className="tp-list">
              <li>哪些栏目会新建、补哪些字段</li>
              <li>条目逐条列冲突（同 id / 同标题），可选跳过 / 另存 / 覆盖</li>
              <li>附件按 sha256 去重，本机已有就复用</li>
            </ul>
          </div>
        </section>
      </div>

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
                  导出时间 {p.exportedAt || '未知'}
                  {p.encrypted ? '　·　已解密（口令已验证）' : '　·　明文包（未设口令）'}
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
