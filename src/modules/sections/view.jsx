import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';
import { checkZipFile, fmtBytes, postZip } from '../../web/frontend/api/zip.js';

export default function SectionsView() {
  const { reload, toast, guard, dialog, boot, patchUi } = useStore();
  // 字段类型是**后端定义的封闭枚举**（core/fields.FIELD_TYPES），面板不再自己抄一份：
  // 抄一份的后果是「后端加了一种类型，这里的下拉框永远看不到它」，而且没人会发现。
  const types = boot?.fieldTypes || [];
  // 类型的中文名（后端下发）：下拉框渲染成「图文（可贴图）（md）」，
  // 既看得懂，也不丢内部 id（排查时用得上）。
  const labels = boot?.fieldTypeLabels || {};
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null);
  // 零配置导入：不选栏目，按包内结构新建；id 冲突自动加序号
  const [zip, setZip] = useState(null);
  const [importing, setImporting] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const zipInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const [list, tpl] = await Promise.all([api('/api/sections'), api('/api/sections/templates')]);
      setData(list);
      setTemplates(tpl.templates);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDump = guard(async (s) => {
    const d = await api(`/api/sections/${encodeURIComponent(s.id)}/dump`);
    setModal({ kind: 'dump', title: `${s.title}（${s.id}）的全部信息`, body: <pre className="block">{JSON.stringify(d, null, 2)}</pre> });
  });

  const openEdit = guard(async (s) => {
    const full = await api(`/api/sections/${encodeURIComponent(s.id)}`);
    setModal({ kind: 'edit', id: s.id, form: {
      title: full.title,
      description: full.description,
      order: String(full.order),
      titleLabel: full.titleLabel,
      titleField: full.titleField || '',
    }, full });
  });

  const create = guard(async (form) => {
    const body = { id: form.id.trim(), title: form.title.trim() || form.id.trim(), template: form.template || undefined, description: form.description, order: Number(form.order) || 50 };
    await api('/api/sections', { method: 'POST', body });
    toast('栏目已创建');
    setModal(null);
    await load();
    await reload();
  });

  const saveEdit = guard(async (m) => {
    const body = {
      title: m.form.title,
      description: m.form.description,
      order: Number(m.form.order) || 50,
      titleLabel: m.form.titleLabel,
      titleField: m.form.titleField,
    };
    await api(`/api/sections/${encodeURIComponent(m.id)}`, { method: 'PATCH', body });
    toast('栏目已更新');
    const fresh = await api(`/api/sections/${encodeURIComponent(m.id)}`);
    setModal({ ...m, full: fresh });
    await load();
    await reload();
  });

  const addField = guard(async (m, def) => {
    await api(`/api/sections/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: { 'add-field': def } });
    toast(`已新增字段 ${def.key}`);
    const fresh = await api(`/api/sections/${encodeURIComponent(m.id)}`);
    setModal({ ...m, full: fresh });
    await load();
  });

  // 按模板补齐：模板新增的字段不会回溯到已建栏目，这里把缺口补上（只增不改不删）
  const syncFields = guard(async (m) => {
    const r = await api(`/api/sections/${encodeURIComponent(m.id)}/sync`, { method: 'POST' });
    if (r.upToDate) {
      toast(r.changedFields?.length
        ? `已是最新（无需补字段）；另有 ${r.changedFields.length} 个字段的模板定义改过，本栏目保留原值`
        : '已是最新，模板里没有需要补的字段');
      return;
    }
    const bits = [
      r.addedGroups?.length ? `分组 ${r.addedGroups.join('、')}` : '',
      r.addedFields?.length ? `字段 ${r.addedFields.join('、')}` : '',
    ].filter(Boolean).join('；');
    const drift = r.changedFields?.length ? `；${r.changedFields.length} 个字段模板已改（保留原值）` : '';
    toast(`已按模板补齐：${bits || '无变化'}${drift}`);
    const fresh = await api(`/api/sections/${encodeURIComponent(m.id)}`);
    setModal({ ...m, full: fresh });
    await load();
    await reload();
  });

  const removeField = guard(async (m, key) => {
    const ok = await dialog({ message: `从字段字典里删掉「${key}」？已填的值会留在条目里（只是不再显示/校验）。`, danger: true, confirmText: '删除字段' });
    if (!ok) return;
    await api(`/api/sections/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: { 'remove-field': key } });
    toast(`已删字段 ${key}`);
    const fresh = await api(`/api/sections/${encodeURIComponent(m.id)}`);
    setModal({ ...m, full: fresh });
    await load();
  });

  const removeSection = guard(async (s) => {
    const ok = await dialog({
      message: `删除栏目「${s.title}」，连带其中 ${s.entries} 条条目？删除前会自动留快照。`,
      danger: true,
      confirmText: '连带删除',
    });
    if (!ok) return;
    // 注意：DELETE 的参数走**请求体**，不是 query —— api.js 对写操作只合并 body
    await api(`/api/sections/${encodeURIComponent(s.id)}`, { method: 'DELETE', body: { force: true } });
    toast('栏目已删除');
    await load();
    await reload();
  });

  const handleZip = guard(async (file) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const preview = await postZip('/api/import.zip?dry-run=1', buffer, file.name);
      setZip({ fileName: file.name, buffer, preview });
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setImporting(true);
    try {
      const r = await postZip('/api/import.zip', zip.buffer, zip.fileName);
      setZip(null);
      toast(`已导入为新栏目「${r.section.title}」（${r.entries.added} 条）`);
      await load();
      await reload();
      // 直接跳到新栏目，省掉「导入完还得自己找」
      patchUi({ view: r.section.id, entry: '' });
    } catch (e) {
      toast(e.message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

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

  if (err) return <div className="pad stack"><div className="bad"><strong>读不到栏目</strong></div><pre className="block">{err}</pre></div>;
  if (!data) return <div className="pad muted">加载中…</div>;

  return (
    <div
      className="section-wrap"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="toolbar rowgap pad">
        <strong>栏目</strong>
        <span className="muted">共 {data.count} 个 · 条目 {data.totalEntries} 条</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={load}>刷新</button>
        <button className="btn small ghost" onClick={() => zipInput.current?.click()}>导入 ZIP</button>
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = [...(e.target.files || [])][0];
            e.target.value = '';
            handleZip(f);
          }}
        />
        <button className="btn small" onClick={() => setModal({ kind: 'create', form: { id: '', title: '', template: templates[0]?.id || '', description: '', order: '50' } })}>新建栏目</button>
      </div>

      <div className="card">
        <div className="colhead">全部栏目</div>
        <div className="colbody">
          {data.sections.length ? data.sections.map((s) => (
            <div key={s.id} className="row">
              <span className="name">{s.title}</span>
              <span className="mono muted">{s.id}</span>
              {s.template ? <Tag>{s.template}</Tag> : <Tag>自定义</Tag>}
              <span className="desc">{s.description}</span>
              <span className="acts">
                <span className="tag">{s.fields} 字段</span>
                <span className="tag">{s.entries} 条目</span>
                <button className="btn small ghost" onClick={() => openDump(s)}>全部信息</button>
                <button className="btn small ghost" onClick={() => openEdit(s)}>编辑</button>
                <button className="btn small ghost" onClick={() => removeSection(s)}>删除</button>
              </span>
            </div>
          )) : <Empty>还没有栏目。点「新建栏目」，用内置模板（求职 / 密钥 / 项目 / 实习 / 校内实践）起步，或建一个空栏目自己定义字段。</Empty>}
        </div>
      </div>

      <div className="pad hint">
        栏目 = 一组同构条目 + 一份字段字典。字典是数据，所以这里加一个字段，CLI 与面板立刻就都能填它。
      </div>

      <CliHints module="sections" />

      {dragDepth > 0 ? <div className="drop-mask"><div>松开导入为新栏目</div></div> : null}

      {zip ? (
        <Modal
          title={`导入为新栏目 · ${zip.fileName}`}
          onClose={() => { if (!importing) setZip(null); }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setZip(null)} disabled={importing}>取消</button>
              <button className="btn" onClick={applyZip} disabled={importing}>{importing ? '导入中…' : '导入为新栏目'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            return (
              <div className="stack">
                <div>
                  将新建栏目：<strong>{p.section.title}</strong>
                  <span className="muted">（{p.section.targetId}）</span>
                  {p.section.renamedFrom ? <span className="bad">　id {p.section.renamedFrom} 已存在，已另存</span> : null}
                </div>
                <div className="hint">导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}</div>
                <div className="rowgap">
                  <Tag>条目 {p.entries.total}</Tag>
                  <Tag>字段 {p.section.fieldsToAdd.length}</Tag>
                  <Tag>附件 新增 {p.files.new} / 复用 {p.files.reused}（{fmtBytes(p.files.bytes)}）</Tag>
                </div>
                <div className="hint">栏目结构、字段字典、附件都会一起建好，导入后可直接使用。</div>
                {p.warnings.map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}

      {modal ? (
        <Modal title={modalTitle(modal)} onClose={() => setModal(null)}>
          {modal.kind === 'dump' ? modal.body : null}
          {modal.kind === 'create' ? (
            <CreateForm
              templates={templates}
              form={modal.form}
              onChange={(f) => setModal((m) => ({ ...m, form: { ...m.form, ...f } }))}
              onSubmit={() => {
                if (!/^[a-z][a-z0-9_-]{0,63}$/.test(modal.form.id.trim())) { toast('栏目 id 必须是小写字母开头，仅含 a-z 0-9 _ -', 'bad'); return; }
                create(modal.form);
              }}
            />
          ) : null}
          {modal.kind === 'edit' ? (
            <EditForm
              modal={modal}
              types={types}
              labels={labels}
              onChange={(f) => setModal((m) => ({ ...m, form: { ...m.form, ...f } }))}
              onSave={() => saveEdit(modal)}
              onSync={() => syncFields(modal)}
              onAddField={(def) => addField(modal, def)}
              onRemoveField={(key) => removeField(modal, key)}
              onClose={() => setModal(null)}
            />
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

function modalTitle(m) {
  if (m.kind === 'dump') return m.title;
  if (m.kind === 'create') return '新建栏目';
  return `编辑栏目 ${m.id}`;
}

function CreateForm({ templates, form, onChange, onSubmit }) {
  return (
    <div className="stack">
      <div className="grid">
        <div className="field">
          <div className="flabel"><span>栏目 id</span><span className="fkey">小写字母开头，仅 a-z 0-9 _ -</span></div>
          <div className="fctrl"><input value={form.id} onChange={(e) => onChange({ id: e.target.value })} placeholder="例如 projects" /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>标题</span></div>
          <div className="fctrl"><input value={form.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="例如 项目档案" /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>从模板起步</span></div>
          <div className="fctrl">
            <select value={form.template} onChange={(e) => onChange({ template: e.target.value })}>
              <option value="">（空栏目，自定义字段）</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.label}（{t.fields} 字段）</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <div className="flabel"><span>排序</span><span className="fkey">越小越靠前</span></div>
          <div className="fctrl"><input type="number" value={form.order} onChange={(e) => onChange({ order: e.target.value })} /></div>
        </div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>描述</span></div>
        <div className="fctrl"><input value={form.description} onChange={(e) => onChange({ description: e.target.value })} /></div>
      </div>
      <div className="rowgap">
        <button className="btn" onClick={onSubmit}>创建</button>
        <span className="hint">同 id 已存在会直接报冲突，不会静默覆盖。</span>
      </div>
    </div>
  );
}

// entrylist 的默认列：最常见的就是「链接 / 账号 / 密码」这组，选中类型即预填，
// 一次点「加入字典」就能用；列可增删改，「密文」列落盘加密。
const ENTRYLIST_DEFAULT_COLS = [
  { key: 'name', label: '名称' },
  { key: 'url', label: '链接' },
  { key: 'user', label: '账号' },
  { key: 'pass', label: '密码', sensitive: true },
];

function EditForm({ modal, types, labels, onChange, onSave, onSync, onAddField, onRemoveField, onClose }) {
  const [nf, setNf] = useState({ key: '', label: '', type: 'text', group: '' });
  const full = modal.full;
  const groups = full?.groupList || [];
  // 列编辑只在 entrylist 时显示；cols 为 null 表示还没动过 → 用默认列
  const cols = nf.type === 'entrylist' ? (nf.cols || ENTRYLIST_DEFAULT_COLS) : null;
  const setCol = (i, patch) => setNf((m) => ({ ...m, cols: (m.cols || ENTRYLIST_DEFAULT_COLS).map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));
  const addCol = () => setNf((m) => ({ ...m, cols: [...(m.cols || ENTRYLIST_DEFAULT_COLS), { key: '', label: '' }] }));
  const removeCol = (i) => setNf((m) => ({ ...m, cols: (m.cols || ENTRYLIST_DEFAULT_COLS).filter((_, idx) => idx !== i) }));
  const buildDef = () => {
    const def = { key: nf.key.trim(), label: nf.label.trim() || nf.key.trim(), type: nf.type };
    if (nf.group) def.group = nf.group;
    if (nf.type === 'entrylist') {
      const fields = cols.map((c) => {
        const out = { key: c.key.trim(), label: c.label.trim() || c.key.trim() };
        if (c.sensitive) out.sensitive = true;
        return out;
      }).filter((c) => c.key);
      if (!fields.length) return { error: '结构清单至少要有一列（填列 key）' };
      def.fields = fields;
    }
    return { def };
  };
  return (
    <div className="stack">
      <div className="grid">
        <div className="field">
          <div className="flabel"><span>标题</span></div>
          <div className="fctrl"><input value={modal.form.title} onChange={(e) => onChange({ title: e.target.value })} /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>排序</span></div>
          <div className="fctrl"><input type="number" value={modal.form.order} onChange={(e) => onChange({ order: e.target.value })} /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>条目名字段</span><span className="fkey">列表里显示哪个字段</span></div>
          <div className="fctrl">
            <select value={modal.form.titleField} onChange={(e) => onChange({ titleField: e.target.value })}>
              <option value="">（用条目 title）</option>
              {(full?.fieldList || []).map((f) => <option key={f.key} value={f.key}>{f.label}（{f.key}）</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <div className="flabel"><span>名称标签</span><span className="fkey">新建条目时问什么</span></div>
          <div className="fctrl"><input value={modal.form.titleLabel} onChange={(e) => onChange({ titleLabel: e.target.value })} /></div>
        </div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>描述</span></div>
        <div className="fctrl"><input value={modal.form.description} onChange={(e) => onChange({ description: e.target.value })} /></div>
      </div>
      <div className="rowgap">
        <button className="btn" onClick={onSave}>保存栏目属性</button>
        {full?.template ? (
          <button className="btn ghost" onClick={onSync} title={`按模板「${full.template}」补齐新增的分组与字段（只增不改不删）`}>同步模板字段</button>
        ) : null}
        <button className="btn ghost" onClick={onClose}>关闭</button>
      </div>
      {full?.template ? (
        <div className="hint">
          本栏目由模板「{full.template}」创建。模板后来新增的字段<b>不会自动</b>出现在这里，
          点「同步模板字段」补齐（例如求职模板新增的「附件资料」组 / 简历、头像等 file 字段）。
        </div>
      ) : null}

      <div className="card" style={{ border: '1px solid var(--soft-2)', borderRadius: 4 }}>
        <div className="colhead">字段字典（{full?.fieldList?.length || 0}）</div>
        <div className="colbody">
          {groups.map((g) => (
            <div key={g.id}>
              <div className="group-title">{g.title}（{g.id}）</div>
              {(full.fieldList || []).filter((f) => f.group === g.id).map((f) => (
                <div key={f.key} className="row">
                  <span className="name">{f.label}</span>
                  <span className="mono muted">{f.key}</span>
                  <Tag>{f.type}</Tag>
                  {f.sensitive ? <Tag kind="bad">密文</Tag> : null}
                  <span className="desc">
                    {f.hint || ''}
                    {f.type === 'entrylist' && Array.isArray(f.fields) && f.fields.length
                      ? `${f.hint ? '　' : ''}列：${f.fields.map((s) => `${s.label}${s.sensitive ? '（密文）' : ''}`).join(' / ')}`
                      : ''}
                  </span>
                  <span className="acts"><button className="btn small ghost" onClick={() => onRemoveField(f.key)}>删除</button></span>
                </div>
              ))}
            </div>
          ))}
          {(full?.fieldList || []).filter((f) => !groups.some((g) => g.id === f.group)).map((f) => (
            <div key={f.key} className="row">
              <span className="name">{f.label}</span>
              <span className="mono muted">{f.key}</span>
              <Tag>{f.type}</Tag>
              <span className="desc">分组 {f.group}（不在 groups 列表里）</span>
              <span className="acts"><button className="btn small ghost" onClick={() => onRemoveField(f.key)}>删除</button></span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ border: '1px solid var(--soft-2)', borderRadius: 4 }}>
        <div className="colhead">新增字段</div>
        <div className="pad rowgap">
          <input style={{ width: 150 }} placeholder="key（英文字母开头）" value={nf.key} onChange={(e) => setNf({ ...nf, key: e.target.value })} />
          <input style={{ width: 150 }} placeholder="标签（中文名）" value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value })} />
          <select style={{ width: 110 }} value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>
            {types.map((t) => (
              <option key={t} value={t}>
                {labels[t] ? `${labels[t]}（${t}）` : t}
              </option>
            ))}
          </select>
          <select style={{ width: 150 }} value={nf.group} onChange={(e) => setNf({ ...nf, group: e.target.value })}>
            <option value="">（首个分组）</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
          {nf.type === 'entrylist' ? (
            <div className="stack" style={{ gap: 4 }}>
              <div className="hint">清单列（每行一列，变长行共用）。key 英文字母开头；勾「密文」的列以密文落盘、--mask 打码。</div>
              {cols.map((c, i) => (
                <div key={i} className="rowgap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input style={{ width: 150 }} placeholder="列 key（如 url）" value={c.key} onChange={(e) => setCol(i, { key: e.target.value })} />
                  <input style={{ width: 150 }} placeholder="列名（如 链接）" value={c.label} onChange={(e) => setCol(i, { label: e.target.value })} />
                  <label className="inline hint" title="这一列的值以 AES-256-GCM 密文落盘">
                    <input type="checkbox" checked={!!c.sensitive} onChange={(e) => setCol(i, { sensitive: e.target.checked })} /> 密文
                  </label>
                  <button type="button" className="btn small ghost" onClick={() => removeCol(i)}>×</button>
                </div>
              ))}
              <div>
                <button type="button" className="btn small ghost" onClick={addCol}>＋ 添加列</button>
              </div>
            </div>
          ) : null}
          <button
            className="btn small"
            onClick={() => {
              const { def, error } = buildDef();
              if (error) { toast(error, 'bad'); return; }
              onAddField(def);
              setNf({ key: '', label: '', type: 'text', group: nf.group, cols: null });
            }}
          >
            加入字典
          </button>
          <span className="hint">加完立刻生效：CLI 与面板都能填它。</span>
        </div>
      </div>
    </div>
  );
}
