import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { fileToDataUrl, refreshAttachments } from '../../web/frontend/api/files.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Copyable, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const refText = (u) => `${u.sectionTitle} / ${u.entryTitle || '（无名）'} / ${u.fieldLabel}`;

// 附件库可能上千个文件：一次渲染全部卡片会把所有图片拉进内存（OOM）。
// 面板每页 24 个；CLI 不传 limit，仍是全量。
const PAGE_SIZE = 24;

/**
 * 附件工作台：统一**展示与库存管理**（上传 / 本机路径导入、预览、下载、编辑、还原、删除）。
 *
 * 组织方式**完全由栏目驱动**——按「哪些栏目在引用附件」筛选，不预定义任何分类或槽位。
 * 真正的「上传并挂到某条条目」发生在本栏目条目的 `file` 字段里；这里只是所有原件的总览。
 */
export default function FilesView() {
  const { toast, guard, dialog, reload } = useStore();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState(''); // '' 全部 | 'none' 未引用 | <栏目 id>
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [page, setPage] = useState(0);
  const [modal, setModal] = useState(null);
  const pickerRef = useRef(null);
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter) params.set('section', filter);
      if (q) params.set('q', q);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const qs = params.toString();
      const d = await api(`/api/files${qs ? `?${qs}` : ''}`);
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(e.message);
      setData(null);
    }
  }, [filter, q, page]);

  // 换筛选/搜索时回到第一页，否则会停在一个不存在的页码上
  useEffect(() => { setPage(0); }, [filter, q]);
  // 删到当前页空了：退回最后一页，而不是显示「还没有附件」
  useEffect(() => {
    if (data?.page && page > 0 && data.files.length === 0 && data.page.total > 0) {
      setPage(Math.max(0, Math.ceil(data.page.total / PAGE_SIZE) - 1));
    }
  }, [data, page]);

  useEffect(() => { load(); }, [load]);

  const uploadFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
      try {
        const content = await fileToDataUrl(file);
        await api('/api/files', { method: 'POST', body: { content, name: file.name } });
        ok += 1;
      } catch (e) {
        toast(`${file.name} 上传失败：${e.message}`, 'bad');
      }
    }
    if (ok) toast(`已导入 ${ok} 个附件（到栏目条目里选它即可链接）`);
    await refreshAttachments();
    await load();
    await reload();
  }, [load, reload, toast]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const openPathImport = guard(async () => {
    setModal({ kind: 'path', form: { path: '', copy: false } });
  });

  const submitPathImport = guard(async (form) => {
    if (!form.path.trim()) { toast('请填本机文件的绝对路径', 'bad'); return; }
    const r = await api('/api/files', { method: 'POST', body: { path: form.path.trim(), copy: form.copy } });
    setModal(null);
    toast(r.duplicated ? '库中已有相同文件' : (r.moved ? '已移动进附件库（可还原）' : '已复制进附件库'));
    await refreshAttachments();
    await load();
    await reload();
  });

  const openEdit = guard(async (file) => {
    setModal({
      kind: 'edit',
      id: file.id,
      form: { name: file.name, tags: file.tags.join('、'), note: file.note },
    });
  });

  const submitEdit = guard(async (id, form) => {
    await api(`/api/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        name: form.name,
        tags: form.tags.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean),
        note: form.note,
      },
    });
    setModal(null);
    toast('附件已更新');
    await refreshAttachments();
    await load();
  });

  const restore = guard(async (file) => {
    const answer = await dialog({
      message: `把「${file.name}」还原到哪？`,
      detail: file.sourceDisplay
        ? `默认移回原始位置并撤销台账：${file.sourceDisplay}`
        : '该附件没有原始位置记录，请在下一步填写目标目录。',
      input: file.sourceDisplay ? undefined : { placeholder: '目标目录绝对路径，例如 D:\\资料' },
      confirmText: '移回并撤销台账',
      cancelText: '取消',
    });
    if (answer === null) return;
    const body = {};
    if (answer && typeof answer === 'string') body.to = answer.trim();
    const r = await api(`/api/files/${encodeURIComponent(file.id)}/restore`, { method: 'POST', body });
    toast(`已还原到 ${r.displayPath}`);
    await refreshAttachments();
    await load();
    await reload();
  });

  const exportCopy = guard(async (file) => {
    const to = await dialog({
      message: `导出「${file.name}」的副本到哪个目录？库中原件保留。`,
      input: { placeholder: '目标目录绝对路径，例如 D:\\资料' },
      confirmText: '导出副本',
    });
    if (!to) return;
    const r = await api(`/api/files/${encodeURIComponent(file.id)}/restore`, {
      method: 'POST',
      body: { to: String(to).trim(), copy: true },
    });
    toast(`已导出到 ${r.displayPath}`);
  });

  const remove = guard(async (file) => {
    const ok = await dialog({
      message: `删除附件「${file.name}」？物理原件会一起删除，删除前自动留台账快照。`,
      detail: '想保留原件、只撤销台账，请改用「还原」。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await api(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
    toast('已删除');
    await refreshAttachments();
    await load();
    await reload();
  });

  if (err) {
    return <div className="pad stack"><div className="bad"><strong>附件库读不到</strong></div><pre className="block">{err}</pre></div>;
  }
  if (!data) return <div className="pad muted">加载中…</div>;

  const sections = data.sections || [];

  return (
    <div
      className={`files-page ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); }
      }}
      onDrop={onDrop}
    >
      <div className="toolbar rowgap pad">
        <strong>附件</strong>
        <span className="muted">{data.total} 个 · {fmtBytes(data.totalBytes)}</span>
        <span className="hint" title="被栏目条目的 file 字段引用的附件数">被引用 {data.total - data.unlinked}/{data.total}</span>
        <Copyable className="hint" text={data.rootRaw} title="点击复制附件库目录">{data.root}</Copyable>
        <span className="grow" />
        <input
          style={{ width: 180 }}
          placeholder="搜索名称 / 备注 / 标签 / 引用它的条目"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn small ghost" onClick={load}>刷新</button>
        <button className="btn small ghost" onClick={openPathImport}>本机路径导入</button>
        <button className="btn small" onClick={() => pickerRef.current?.click()}>上传文件</button>
        <input
          ref={pickerRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {/* 筛选按**栏目**驱动：栏目有 file 字段就会出现一个筛选片，不预定义任何分类 */}
      <div className="rowgap pad file-filters">
        <button className={`tab small ${!filter ? 'active' : ''}`} onClick={() => setFilter('')}>
          全部<span className="count">{data.total}</span>
        </button>
        {sections.map((s) => (
          <button
            key={s.id}
            className={`tab small ${filter === s.id ? 'active' : ''}`}
            onClick={() => setFilter(s.id)}
            title={`被「${s.title}」栏目引用的附件`}
          >
            {s.title}<span className="count">{s.count}</span>
          </button>
        ))}
        <button className={`tab small ${filter === 'none' ? 'active' : ''}`} onClick={() => setFilter('none')}>
          未引用<span className="count">{data.unlinked}</span>
        </button>
      </div>

      {dragOver ? <div className="drop-hint">松开鼠标，文件直接导入附件库</div> : null}

      {data.files.length ? (
        <div className="file-grid pad">
          {data.files.map((file) => (
            <div key={file.id} className="file-card">
              <a className="file-thumb" href={file.url} target="_blank" rel="noreferrer" title="在浏览器中预览">
                {file.isImage
                  ? <img src={file.url} alt={file.name} loading="lazy" />
                  : <span className="ext-badge">{file.ext ? file.ext.slice(1).toUpperCase() : 'FILE'}</span>}
              </a>
              <div className="file-meta">
                <a className="file-name" href={file.url} target="_blank" rel="noreferrer" title={file.name}>{file.name}</a>
                <div className="rowgap" style={{ gap: 4 }}>
                  <span className="hint">{fmtBytes(file.bytes)}</span>
                  {file.mode === 'move' ? <Tag>移动导入</Tag> : null}
                </div>
                {file.usedBy?.length
                  ? <div className="hint" title="条目的 file 字段引用了本附件">被引用：{file.usedBy.map(refText).join('、')}</div>
                  : <div className="hint">未被任何条目引用（到栏目条目里选它即可链接）</div>}
              </div>
              <div className="file-acts">
                <a className="btn small ghost" href={file.downloadUrl}>下载</a>
                <button className="btn small ghost" onClick={() => exportCopy(file)}>导出副本</button>
                <button className="btn small ghost" onClick={() => restore(file)}>还原</button>
                <button className="btn small ghost" onClick={() => openEdit(file)}>编辑</button>
                <button className="btn small ghost danger-ghost" onClick={() => remove(file)}>删除</button>
                <span className="grow" />
                <Copyable className="hint" text={file.path} title="点击复制物理路径">路径</Copyable>
                <Copyable className="hint" text={file.url} title="点击复制链接">链接</Copyable>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="pad">
          <Empty>还没有附件。把文件拖到这里、点「上传文件」，或用「本机路径导入」把原件移动进库；随后到栏目的条目里选它。</Empty>
          <div className="hint pad">CLI：nx-sk file add --path "D:\简历\张三-简历.pdf"（默认移动；--copy 仅复制）</div>
        </div>
      )}

      {data.page && data.page.total > PAGE_SIZE ? (
        <div className="rowgap pad">
          <button className="btn small ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
          <span className="hint">
            第 {page + 1} / {Math.ceil(data.page.total / PAGE_SIZE)} 页 · 共 {data.page.total} 个（每页 {PAGE_SIZE}）
          </span>
          <button className="btn small ghost" disabled={!data.page.hasMore} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      ) : null}

      <CliHints module="files" />

      {modal ? (
        <Modal title={modal.kind === 'edit' ? '编辑附件' : '从本机路径导入'} onClose={() => setModal(null)}>
          {modal.kind === 'path' ? (
            <PathImportForm
              form={modal.form}
              onChange={(f) => setModal((m) => ({ ...m, form: { ...m.form, ...f } }))}
              onSubmit={() => submitPathImport(modal.form)}
            />
          ) : (
            <EditForm
              form={modal.form}
              onChange={(f) => setModal((m) => ({ ...m, form: { ...m.form, ...f } }))}
              onSubmit={() => submitEdit(modal.id, modal.form)}
            />
          )}
        </Modal>
      ) : null}
    </div>
  );
}

function PathImportForm({ form, onChange, onSubmit }) {
  return (
    <div className="stack">
      <div className="field wide">
        <div className="flabel"><span>本机文件的绝对路径</span></div>
        <div className="fctrl">
          <input
            value={form.path}
            placeholder='例如 D:\简历\张三-简历.pdf'
            onChange={(e) => onChange({ path: e.target.value })}
          />
        </div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>导入方式</span></div>
        <div className="fctrl">
          <label className="inline">
            <input
              type="checkbox"
              checked={form.copy}
              onChange={(e) => onChange({ copy: e.target.checked })}
            />
            <span className="hint">仅复制、保留原件（默认把原件移动进库，可用「还原」撤销）</span>
          </label>
        </div>
      </div>
      <div className="rowgap">
        <button className="btn" onClick={onSubmit}>导入</button>
      </div>
    </div>
  );
}

function EditForm({ form, onChange, onSubmit }) {
  return (
    <div className="stack">
      <div className="field wide">
        <div className="flabel"><span>文件名</span></div>
        <div className="fctrl"><input value={form.name} onChange={(e) => onChange({ name: e.target.value })} /></div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>标签</span><span className="fkey">多个用「、」分隔</span></div>
        <div className="fctrl"><input value={form.tags} onChange={(e) => onChange({ tags: e.target.value })} /></div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>备注</span></div>
        <div className="fctrl"><textarea rows={2} value={form.note} onChange={(e) => onChange({ note: e.target.value })} /></div>
      </div>
      <div className="rowgap">
        <button className="btn" onClick={onSubmit}>保存</button>
        <span className="hint">改文件名时，物理原件会随之移动。要链接到条目，请在栏目条目的 file 字段里选本附件。</span>
      </div>
    </div>
  );
}
