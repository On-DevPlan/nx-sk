import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';

const TYPES = ['text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags', 'secret', 'file'];

export default function SectionsView() {
  const { reload, toast, guard, dialog } = useStore();
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null);

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
      toast('已是最新，模板里没有需要补的字段');
      return;
    }
    const bits = [
      r.addedGroups?.length ? `分组 ${r.addedGroups.join('、')}` : '',
      r.addedFields?.length ? `字段 ${r.addedFields.join('、')}` : '',
    ].filter(Boolean).join('；');
    toast(`已按模板补齐：${bits || '无变化'}`);
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

  if (err) return <div className="pad stack"><div className="bad"><strong>读不到栏目</strong></div><pre className="block">{err}</pre></div>;
  if (!data) return <div className="pad muted">加载中…</div>;

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>栏目</strong>
        <span className="muted">共 {data.count} 个 · 条目 {data.totalEntries} 条</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={load}>刷新</button>
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
          )) : <Empty>还没有栏目。点「新建栏目」，用内置模板（求职 / 密钥）起步。</Empty>}
        </div>
      </div>

      <div className="pad hint">
        栏目 = 一组同构条目 + 一份字段字典。字典是数据，所以这里加一个字段，CLI 与面板立刻就都能填它。
      </div>

      <CliHints module="sections" />

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
    </>
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

function EditForm({ modal, onChange, onSave, onSync, onAddField, onRemoveField, onClose }) {
  const [nf, setNf] = useState({ key: '', label: '', type: 'text', group: '' });
  const full = modal.full;
  const groups = full?.groupList || [];
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
                  <span className="desc">{f.hint || ''}</span>
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
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select style={{ width: 150 }} value={nf.group} onChange={(e) => setNf({ ...nf, group: e.target.value })}>
            <option value="">（首个分组）</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
          <button
            className="btn small"
            onClick={() => {
              const def = { key: nf.key.trim(), label: nf.label.trim() || nf.key.trim(), type: nf.type };
              if (nf.group) def.group = nf.group;
              onAddField(def);
              setNf({ key: '', label: '', type: 'text', group: nf.group });
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
