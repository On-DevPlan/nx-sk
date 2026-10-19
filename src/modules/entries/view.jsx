import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { checkZipFile, fmtBytes, isNeedPassphraseError, postZip } from '../../web/frontend/api/zip.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';
import { FieldGroup } from '../../web/frontend/components/fieldEditor.jsx';
import KvTable from './kvTable.jsx';

// 脏值比较用：对象/数组（tags、entrylist 的行）必须走 JSON 序列化——
// String(obj) 恒为 '[object Object]'，会把「没改」误判成「每处都改了」
const norm = (x) => (x === null || x === undefined ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)));

// 条目定位文本（面包屑点击复制用）：人读的路径 + agent 可直接执行的 CLI。
// id 与标题都带——标题可能重名/被改，id 是唯一事实；命令里用 id 定位最稳。
function entryRefText(section, entry) {
  return [
    `nx-sk 条目 · 栏目「${section.title}」(${section.id}) › 条目「${entry.title}」(${entry.id})`,
    `读: nx-sk entry get --section ${section.id} ${entry.id}`,
    `改: nx-sk entry update --section ${section.id} ${entry.id} --set 字段=值`,
  ].join('\n');
}


/**
 * 栏目详情视图。按栏目的形状分两种布局：
 *
 * - `kv: true`（密钥那种）→ 交给 [[kvTable]]，**一行一个键值对**。没有条目列表、
 *   没有字段表单、没有完整性——密钥就是一张表。
 * - 其余栏目 → 模板建议的分组表单（求职那种需要中文标签/候选值/未填清单的场景）。
 *
 * 字段与分组全部来自后端，所以新增字段不需要改前端。
 */
export default function SectionView({ sectionId }) {
  const { ui, patchUi, toast, guard, dialog, reload } = useStore();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [modal, setModal] = useState(null);
  const [quick, setQuick] = useState('');
  // 栏目 ZIP：zip = { fileName, buffer, preview }（buffer 用于确认时再 POST 一次，服务端不存状态）
  const [zip, setZip] = useState(null);
  // 加密包先问口令：ask = { fileName, buffer }
  const [ask, setAsk] = useState(null);
  const [askPw, setAskPw] = useState('');
  const [conflict, setConflict] = useState('skip');
  const [importing, setImporting] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  // 精确导出：选中的条目 id；空集合 = 导出全部（菜单文案会跟着变）
  const [selected, setSelected] = useState(() => new Set());
  const zipInput = useRef(null);
  const moreRef = useRef(null);
  const mask = !!ui.mask;

  // —— 左右栏拖宽：条目列表 ↔ 内容 ——
  // 宽度持久化在 ui.listW（patchUi 对新键照存）。拖动过程只改**本地** state，
  // 松手才落盘——否则每次 mousemove 都会经 context 重渲染整个表单树。
  const colsRef = useRef(null);
  const listWRef = useRef(Number(ui.listW) || 300);
  const [listW, setListW] = useState(listWRef.current);
  const [draggingCol, setDraggingCol] = useState(false);
  const startColDrag = (e) => { e.preventDefault(); setDraggingCol(true); };
  useEffect(() => {
    if (!draggingCol) return undefined;
    const move = (ev) => {
      const rect = colsRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = Math.round(Math.min(560, Math.max(240, ev.clientX - rect.left)));
      listWRef.current = w;
      setListW(w);
    };
    const up = () => setDraggingCol(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('col-resizing');
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      if (listWRef.current !== (Number(ui.listW) || 300)) patchUi({ listW: listWRef.current });
    };
    // ui.listW 只在拖动开始/结束之间有意义；patchUi 稳定，不会造成重复订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingCol]);
  const resetColDrag = () => {
    listWRef.current = 300;
    setListW(300);
    patchUi({ listW: 300 });
  };

  const load = useCallback(async (keepId) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api(`/api/sections/${encodeURIComponent(sectionId)}/dump${mask ? '?mask=1' : ''}`);
      setData(d);
      const wanted = keepId || ui.entry;
      const hit = d.entries.find((e) => e.id === wanted) || d.entries[0] || null;
      setDraft(hit ? { id: hit.id, title: hit.title, values: { ...hit.values } } : null);
      if (hit && hit.id !== ui.entry) patchUi({ entry: hit.id });
    } catch (e) {
      setErr(e.message);
      setData(null);
      setDraft(null);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, mask]);

  useEffect(() => { load(); }, [load]);
  // 切栏目、或条目被删掉后，选择里不能留下不存在的 id（导出会因为「找不到条目」整包失败）
  useEffect(() => { setSelected(new Set()); }, [sectionId]);
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set((data?.entries || []).map((e) => e.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const current = useMemo(() => data?.entries.find((e) => e.id === draft?.id) || null, [data, draft]);
  // 「已标不填」只对**真的空着**的可选字段有意义：填了值的可选字段不属于跳过，
  // 否则一份填满的资料会被显示成「另有 N 项已标不填」，自相矛盾。
  const skippedExcluded = useMemo(
    () => (current?.excluded || []).filter((m) => norm(current.values?.[m.key]) === ''),
    [current],
  );
  const allIds = useMemo(() => (data?.entries || []).map((e) => e.id), [data]);
  const allPicked = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const togglePick = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(allIds));

  const groups = useMemo(() => {
    if (!data) return [];
    return data.groups.map((g) => ({ ...g, fields: data.fields.filter((f) => f.group === g.id) })).filter((g) => g.fields.length);
  }, [data]);

  const patchField = (key, value) => setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));

  const dirty = useMemo(() => {
    if (!draft || !current) return { set: {}, titleChanged: false, count: 0 };
    const set = {};
    for (const f of data.fields) {
      if (norm(current.values[f.key]) !== norm(draft.values[f.key])) set[f.key] = draft.values[f.key];
    }
    return { set, titleChanged: draft.title !== current.title, count: Object.keys(set).length + (draft.title !== current.title ? 1 : 0) };
  }, [draft, current, data]);

  const save = guard(async () => {
    if (!draft || !current) return;
    if (!dirty.count) { toast('没有改动'); return; }
    const body = { set: dirty.set };
    if (dirty.titleChanged) body.title = draft.title;
    await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
    toast(`已保存 ${dirty.count} 处改动`);
    await load(draft.id);
    await reload();
  });

  // 「直接存 kv」的入口：敲一行 字段=值 回车即写入，字典里没有的键会自动登记
  const quickAdd = guard(async () => {
    if (!draft) { toast('先新建一条条目', 'bad'); return; }
    const i = quick.indexOf('=');
    if (i <= 0) { toast('用 字段=值 的格式，例如 微信=zhangsan', 'bad'); return; }
    const k = quick.slice(0, i).trim();
    const v = quick.slice(i + 1);
    const r = await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: { set: { [k]: v } } });
    setQuick('');
    toast(`已写入 ${k}${r.newFields?.length ? '（新字段已登记）' : ''}`);
    await load(draft.id);
    await reload();
  });

  const addEntry = guard(async () => {
    const label = data?.section.titleLabel || '名称';
    const name = await dialog({ message: `新建「${data?.section.title}」条目，${label}是？`, input: { placeholder: `例如 ${data?.section.titleField || '名称'}` } });
    if (!name) return;
    const body = { section: sectionId, title: name };
    if (data?.section.titleField) body.set = { [data.section.titleField]: name };
    const created = await api('/api/entries', { method: 'POST', body });
    toast(`已新建：${created.title}`);
    await load(created.id);
    await reload();
  });

  const removeEntry = guard(async () => {
    if (!current) return;
    const ok = await dialog({
      message: `删除条目「${current.title}」？删除不可恢复（没有自动快照）——需要留底就先在「导出导入」页导一份。`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await api(`/api/entries/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    toast('已删除');
    await load('');
    await reload();
  });

  const closeMore = () => { if (moreRef.current) moreRef.current.open = false; };

  // 面包屑点击复制：把「栏目›条目」定位（含 id 与 CLI 命令）贴进剪贴板，
  // 粘给任意 agent 即可精确定位这条条目去做修改
  const copyEntryRef = guard(async (entry) => {
    if (!entry) return;
    const text = entryRefText(data.section, entry);
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制条目定位：${data.section.title} › ${entry.title}（贴给 agent 即可）`);
    } catch {
      // 剪贴板被拒（非安全上下文/权限）时退回选中文本方案
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(`已复制条目定位：${data.section.title} › ${entry.title}`);
    }
  });

  /** 浏览器下载：让 <a download> 去接，前端不碰 zip 内容；含凭据与否由菜单项决定。 */
  const exportZip = (withSecrets) => {
    closeMore();
    const q = new URLSearchParams();
    if (!withSecrets) q.set('no-secrets', '1');
    if (selected.size) q.set('entries', [...selected].join(','));
    const qs = q.toString();
    const a = document.createElement('a');
    a.href = `/api/sections/${encodeURIComponent(sectionId)}/export.zip${qs ? `?${qs}` : ''}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    // 立刻 remove 会让 Chromium 把下载判成取消；留给它一拍
    setTimeout(() => a.remove(), 1000);
    toast(withSecrets ? '开始下载（含凭据，请妥善保管）' : '开始下载（凭据已打码）');
  };

  // 加密包先问口令（与全局面板同一套交互）：别把「缺口令」报成「包坏了」
  const openZip = async (fileName, buffer, passphrase) => {
    setImporting(true);
    try {
      const qs = new URLSearchParams({ 'dry-run': '1' });
      if (passphrase) qs.set('passphrase', passphrase);
      const preview = await postZip(
        `/api/sections/${encodeURIComponent(sectionId)}/import.zip?${qs}`, buffer, fileName,
      );
      setZip({ fileName, buffer, preview, passphrase: passphrase || '' });
      setConflict('skip');
      return true;
    } catch (e) {
      toast(e.message || String(e), 'bad');
      return false;
    } finally {
      setImporting(false);
    }
  };

  const handleZip = guard(async (file) => {
    closeMore();
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
    // 加密包由服务端识别（外层 ZIP 里有 payload.enc）：先按明文试，它说缺口令再问
    try {
      await openZip(file.name, buffer, '');
    } catch (e) {
      if (isNeedPassphraseError(e)) {
        setAsk({ fileName: file.name, buffer });
        setAskPw('');
        return;
      }
      toast(e.message || String(e), 'bad');
    }
  });

  const submitAsk = guard(async () => {
    if (!ask) return;
    const pw = askPw.trim();
    if (!pw) { toast('请输入口令', 'bad'); return; }
    const ok = await openZip(ask.fileName, ask.buffer, pw);
    if (ok) { setAsk(null); setAskPw(''); }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setImporting(true);
    try {
      const qs = new URLSearchParams({ 'on-conflict': conflict });
      if (zip.passphrase) qs.set('passphrase', zip.passphrase);
      const r = await postZip(
        `/api/sections/${encodeURIComponent(sectionId)}/import.zip?${qs}`,
        zip.buffer, zip.fileName,
      );
      setZip(null);
      toast(`导入完成：新增 ${r.entries.added}，另存 ${r.entries.copied}，覆盖 ${r.entries.overwritten}，跳过 ${r.entries.skipped}`);
      await load();
      await reload();
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

  // 拖拽用深度计数：dragenter/dragleave 在子元素间穿梭会成对触发，
  // 只按布尔值会在「还没离开就熄掉」和「离开后不熄」之间抖。
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); setDragDepth((d) => d + 1); };
  const onDragOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const onDragLeave = () => setDragDepth((d) => Math.max(0, d - 1));
  const onDrop = (e) => {
    e.preventDefault();
    setDragDepth(0);
    const f = [...(e.dataTransfer?.files || [])][0];
    if (f) handleZip(f);
  };

  if (err) {
    return (
      <div className="pad stack">
        <div className="bad"><strong>栏目读不到</strong></div>
        <pre className="block">{err}</pre>
        <div className="hint">如果这个栏目刚被删掉，切到「栏目」tab 看看现有栏目。</div>
      </div>
    );
  }
  if (!data) return <div className="pad muted">{busy ? '加载中…' : '暂无数据'}</div>;

  // KV 栏目单独一套界面（宿主的 hooks 都已经跑完，这里是合法提前返回）
  if (data.section.kv) return <KvTable sectionId={sectionId} sectionTitle={data.section.title} />;

  return (
    <div
      className="section-wrap"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="toolbar rowgap pad">
        <strong>{data.section.title}</strong>
        <Tag>{data.section.id}</Tag>
        <span className="muted">{data.count} 条 / {data.section.fields} 字段</span>
        {data.section.description ? <span className="desc muted nowrap grow">{data.section.description}</span> : <span className="grow" />}
        <label className="inline hint">
          <input type="checkbox" checked={mask} onChange={() => patchUi({ mask: !mask })} />
          打码显示（投屏/截图时用）
        </label>
        <button className="btn small ghost" onClick={() => load()}>刷新</button>
        <details className="more" ref={moreRef}>
          <summary className="btn small ghost">更多</summary>
          <div className="more-menu">
            <button type="button" onClick={() => exportZip(true)}>
              {selected.size ? `导出选中 ${selected.size} 条（含凭据）` : '导出 ZIP（含凭据）'}
            </button>
            <button type="button" onClick={() => exportZip(false)}>
              {selected.size ? `导出选中 ${selected.size} 条（打码）` : '导出 ZIP（打码）'}
            </button>
            <button type="button" onClick={() => { closeMore(); zipInput.current?.click(); }}>导入 ZIP…</button>
          </div>
        </details>
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            // FileList 是活的：先拷成数组再清 value
            const f = [...(e.target.files || [])][0];
            e.target.value = '';
            handleZip(f);
          }}
        />
        <button className="btn small" onClick={addEntry}>新建条目</button>
      </div>

      <div className="cols" ref={colsRef}>
        <div className="col" style={{ flex: `0 0 ${listW}px` }}>
          <div className="card">
            <div className="colhead">
              <label className="inline pickall" title="全选 / 取消全选（只影响导出与批量操作）">
                <input type="checkbox" checked={allPicked} onChange={toggleAll} />
                <span>条目列表</span>
              </label>
              <span className="right muted">
                {selected.size ? `已选 ${selected.size} / ${data.count}` : data.count}
                {selected.size ? <button type="button" className="btn small ghost" onClick={() => setSelected(new Set())}>清空</button> : null}
              </span>
            </div>
            <div className="colbody">
              {data.entries.length ? data.entries.map((e) => (
                <div
                  key={e.id}
                  className={`row selectable ${e.id === draft?.id ? 'selected' : ''}`}
                  onClick={() => { patchUi({ entry: e.id }); setDraft({ id: e.id, title: e.title, values: { ...e.values } }); }}
                >
                  <input
                    type="checkbox"
                    className="pick"
                    checked={selected.has(e.id)}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={() => togglePick(e.id)}
                    title="选中后可只导出这一条"
                  />
                  <span className="name">{e.title || '（无名）'}</span>
                  <span className="acts">
                    {e.missing.length ? <span className="tag">{e.completeness.ratio}%</span> : <span className="tag strong">已填满</span>}
                    <button
                      type="button"
                      className="row-copy"
                      title="复制条目定位（贴给 agent 即可修改）"
                      onClick={(ev) => { ev.stopPropagation(); copyEntryRef(e); }}
                    >⧉</button>
                  </span>
                </div>
              )) : <Empty>还没有条目。点右上角「新建条目」，或用 CLI：nx-sk entry add --section {data.section.id} --set ...</Empty>}
            </div>
          </div>
        </div>

        <div
          className={`col-splitter${draggingCol ? ' active' : ''}`}
          title="拖动调整左右宽度（双击恢复默认）"
          onMouseDown={startColDrag}
          onDoubleClick={resetColDrag}
        />

        <div className="col">
          {!draft ? (
            <div className="card"><Empty>左边选一条，或新建一条</Empty></div>
          ) : (
            <div className="card">
              <div className="colhead">
                <span
                  className="crumb grow nowrap"
                  title="点击复制条目定位（栏目›条目 + id + CLI 命令，贴给 agent 即可修改）"
                  onClick={() => copyEntryRef(current || draft)}
                >
                  <span className="crumb-sec">{data.section.title}</span>
                  <span className="crumb-sep">›</span>
                  <span className="crumb-ent">{current?.title || draft.title}</span>
                  <span className="crumb-copy" aria-hidden>⧉</span>
                </span>
                <span className="muted mono">{draft.id}</span>
                {current ? <Tag kind={current.missing.length ? '' : 'strong'}>完整度 {current.completeness.ratio}%</Tag> : null}
              </div>

              <div className="field wide pad" style={{ borderBottom: '1px solid var(--soft-2)' }}>
                <div className="flabel">
                  <span>{data.section.titleLabel || '名称'}</span>
                  <span className="bad">改动后必须保存</span>
                </div>
                <div className="fctrl">
                  <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
                </div>
              </div>

              <div className="rowgap" style={{ padding: '6px 14px', borderBottom: '1px solid var(--soft-2)' }}>
                <input
                  className="grow"
                  style={{ minWidth: 220 }}
                  placeholder="直接加字段：字段=值　（回车写入；没见过的键会自动登记）"
                  value={quick}
                  onChange={(e) => setQuick(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') quickAdd(); }}
                />
                <button className="btn small" onClick={quickAdd} disabled={!quick.includes('=')}>写入</button>
              </div>

              {groups.map((g) => (
                <FieldGroup key={g.id} title={g.title} fields={g.fields} draft={draft.values} onPatch={patchField} />
              ))}

              <div className="rowgap pad">
                <button className="btn" onClick={save} disabled={!dirty.count}>保存{dirty.count ? `（${dirty.count} 处改动）` : ''}</button>
                <button className="btn ghost" onClick={() => load(draft.id)} disabled={!dirty.count}>放弃改动</button>
                <button className="btn ghost" onClick={removeEntry}>删除条目</button>
                {current?.missing.length ? (
                  <span className="hint">模板建议里还有 {current.missing.length} 项没填（不影响使用）：{current.missing.slice(0, 5).map((m) => m.label).join('、')}{current.missing.length > 5 ? '…' : ''}</span>
                ) : null}
                {skippedExcluded.length ? (
                  <span className="hint">另有 {skippedExcluded.length} 项已标不填、不计入完整度：{skippedExcluded.slice(0, 6).map((m) => m.label).join('、')}{skippedExcluded.length > 6 ? '…' : ''}</span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <CliHints module="entries" />

      {dragDepth > 0 ? (
        <div className="drop-mask"><div>松开导入栏目 ZIP</div></div>
      ) : null}

      {ask ? (
        <Modal
          title={`这个包已加密 · ${ask.fileName}`}
          onClose={() => { if (!importing) { setAsk(null); setAskPw(''); } }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setAsk(null)} disabled={importing}>取消</button>
              <button className="btn" onClick={submitAsk} disabled={importing || !askPw.trim()}>
                {importing ? '解密中…' : '打开预览'}
              </button>
            </>
          )}
        >
          <div className="stack">
            <div className="hint">导出时给这个包设了口令。输入同一口令才能预览与导入——口令不在文件里，错了只能重试。</div>
            <input
              type="password"
              autoComplete="off"
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
          onClose={() => { if (!importing) setZip(null); }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setZip(null)} disabled={importing}>取消</button>
              <button className="btn" onClick={applyZip} disabled={importing}>{importing ? '导入中…' : '确认导入'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            return (
              <div className="stack">
                <div>
                  来源：<strong>{p.section.source.title}</strong><span className="muted">（{p.section.source.id}）</span>
                  {' → '}目标：<strong>{p.section.title}</strong><span className="muted">（{p.section.targetId}）</span>
                  {p.section.willCreate ? <span className="bad">　将新建栏目</span> : null}
                </div>
                <div className="hint">
                  导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}
                  {p.encrypted ? '　·　已解密（口令已验证）' : ''}
                </div>
                <div className="rowgap">
                  <Tag>条目 {p.entries.total}</Tag>
                  <Tag>将新增 {p.entries.fresh}</Tag>
                  {p.entries.conflicts.length ? <span className="tag bad">冲突 {p.entries.conflicts.length}</span> : null}
                  <Tag>附件 新增 {p.files.new} / 复用 {p.files.reused}（{fmtBytes(p.files.bytes)}）</Tag>
                </div>
                {p.section.fieldsToAdd.length ? (
                  <div className="hint">将补 {p.section.fieldsToAdd.length} 个字段：{p.section.fieldsToAdd.map((f) => f.label).join('、')}</div>
                ) : null}
                {p.entries.conflicts.length ? (
                  <div className="block">
                    <div className="flabel"><span>冲突明细</span><span className="fkey">撞 = 本地已有同 id 或同标题的条目</span></div>
                    <div className="conflict-list">
                      {p.entries.conflicts.map((c) => (
                        <div key={`${c.id}-${c.existingId}`} className="conflict-row">
                          <span className="title">{c.title}</span>
                          <span className="hint">
                            {c.reason === 'id' ? `同 id 撞上「${c.existingTitle}」` : `同标题撞上「${c.existingTitle}」`}
                          </span>
                          {conflict === 'copy' ? <span className="hint ok">→ {c.copyTitle}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {p.entries.conflicts.length ? (
                  <div className="stack">
                    <div className="flabel"><span>冲突怎么处理</span></div>
                    <label className="inline"><input type="radio" checked={conflict === 'skip'} onChange={() => setConflict('skip')} /> 跳过（保留现有）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'copy'} onChange={() => setConflict('copy')} /> 另存为新条目（标题加「导入」）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'overwrite'} onChange={() => setConflict('overwrite')} /> 覆盖现有条目的字段</label>
                  </div>
                ) : null}
                {p.warnings.map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}

      {modal ? (
        <Modal title={modal.title} onClose={() => setModal(null)}>
          {modal.body}
        </Modal>
      ) : null}
    </div>
  );
}
