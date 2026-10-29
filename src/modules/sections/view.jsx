import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';
import { checkZipFile, fmtBytes, postZip } from '../../web/frontend/api/zip.js';

// 选中项用带前缀的 key：栏目与条目在同一个集合里，前缀就是它们的「类型」。
// 好处是「全选 / 反选 / 计数」只处理一个 Set，不必维护两份状态再想办法对齐。
const SK = (id) => `sec:${id}`;
const EK = (id) => `ent:${id}`;

/**
 * 栏目管理：**一棵树**（栏目 → 条目），不是一张平铺列表。
 *
 * 为什么改成树：栏目一多，平铺列表就只剩「一堆看起来一样的行」——
 * 分不清哪些是栏目哪些是条目、看不见栏目里有什么、删除只能一条一条点。
 * 树把两件事同时解决：**层次**（栏目 = 文件夹，条目 = 里面的文件）和**批量**
 * （勾选可以跨栏目，删除一次走完）。
 *
 * 三条刻意的规则：
 *   1. **勾栏目 = 连它的条目一起勾**。删栏目本来就是删文件夹，条目必然跟着走；
 *      只勾栏目却让条目空着，会让人以为「条目会留下」。
 *   2. **勾条目不会顺带勾栏目**。删掉全部条目 ≠ 删掉这个空栏目，这是两件事。
 *   3. 搜索时**只展开命中的**，不改变原本的展开状态 —— 清空搜索就回到原样。
 */
export default function SectionsView() {
  const { reload, toast, guard, dialog, boot, patchUi, ui } = useStore();
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
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // 展开态记在 ui（localStorage）里：栏目多时「上次展开到哪」是跨会话有意义的选择
  const [open, setOpen] = useState(() => (ui.treeOpen && typeof ui.treeOpen === 'object' ? ui.treeOpen : {}));
  const zipInput = useRef(null);

  const load = useCallback(async () => {
    try {
      const [t, tpl] = await Promise.all([api('/api/sections/tree'), api('/api/sections/templates')]);
      setData(t);
      setTemplates(tpl.templates);
      setErr(null);
      // 选中项里清掉已经不存在的（别的标签页删过），否则「已选 3」里有两个是幽灵
      setSel((prev) => {
        if (!prev.size) return prev;
        const alive = new Set();
        for (const s of t.sections) { alive.add(SK(s.id)); for (const e of s.entryList) alive.add(EK(e.id)); }
        const next = new Set([...prev].filter((k) => alive.has(k)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 搜索：栏目命中就整棵留下；只有条目命中时只留命中的条目，并**临时**展开那一节。 */
  const view = useMemo(() => {
    if (!data) return [];
    const kw = q.trim().toLowerCase();
    if (!kw) return data.sections;
    const out = [];
    for (const s of data.sections) {
      const secHit = [s.id, s.title, s.description || ''].join(' ').toLowerCase().includes(kw);
      const hits = s.entryList.filter((e) => String(e.title || '').toLowerCase().includes(kw));
      if (!secHit && !hits.length) continue;
      out.push(secHit ? s : { ...s, entryList: hits, forcedOpen: true });
    }
    return out;
  }, [data, q]);

  const setOpenMap = (next) => { setOpen(next); patchUi({ treeOpen: next }); };
  const toggleOpen = (id) => setOpenMap({ ...open, [id]: !open[id] });
  const allOpen = (v) => {
    const next = {};
    for (const s of data?.sections || []) next[s.id] = v;
    setOpenMap(next);
  };

  const secState = (s) => {
    const isSec = sel.has(SK(s.id));
    const picked = s.entryList.filter((e) => sel.has(EK(e.id))).length;
    return { isSec, picked, total: s.entryList.length, full: isSec && picked === s.entryList.length };
  };

  /** 勾栏目 = 连条目一起；反勾 = 一起清掉。 */
  const toggleSec = (s) => setSel((prev) => {
    const next = new Set(prev);
    const on = next.has(SK(s.id)) && s.entryList.every((e) => next.has(EK(e.id)));
    if (on) {
      next.delete(SK(s.id));
      for (const e of s.entryList) next.delete(EK(e.id));
    } else {
      next.add(SK(s.id));
      for (const e of s.entryList) next.add(EK(e.id));
    }
    return next;
  });

  const toggleEnt = (e) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(EK(e.id))) next.delete(EK(e.id)); else next.add(EK(e.id));
    return next;
  });

  const visibleKeys = useMemo(() => {
    const keys = [];
    for (const s of view) { keys.push(SK(s.id)); for (const e of s.entryList) keys.push(EK(e.id)); }
    return keys;
  }, [view]);
  const allOn = visibleKeys.length > 0 && visibleKeys.every((k) => sel.has(k));
  const someOn = !allOn && visibleKeys.some((k) => sel.has(k));
  const toggleAll = () => setSel((prev) => {
    const next = new Set(prev);
    if (allOn) visibleKeys.forEach((k) => next.delete(k));
    else visibleKeys.forEach((k) => next.add(k));
    return next;
  });

  /** 删除计划：栏目优先——被选中栏目里的条目已经「跟着走」，不再重复计一遍。 */
  const plan = useMemo(() => {
    const secs = [];
    const ents = [];
    for (const s of data?.sections || []) {
      const isSec = sel.has(SK(s.id));
      if (isSec) secs.push(s);
      for (const e of s.entryList) {
        if (isSec) continue;
        if (sel.has(EK(e.id))) ents.push({ ...e, sectionTitle: s.title });
      }
    }
    return { secs, ents, carried: secs.reduce((n, s) => n + s.entryList.length, 0), total: secs.length + ents.length };
  }, [data, sel]);

  const confirmRemove = async ({ secs = [], ents = [] }) => {
    const carried = secs.reduce((n, s) => n + s.entryList.length, 0);
    const parts = [];
    if (secs.length) parts.push(`${secs.length} 个栏目${carried ? `（连带 ${carried} 条条目）` : ''}`);
    if (ents.length) parts.push(`${ents.length} 条条目`);
    const detail = [
      ...secs.map((s) => `${s.title}（${s.id}）${s.entryList.length ? ` · ${s.entryList.length} 条目` : ''}`),
      ...ents.map((e) => `${e.sectionTitle ? `${e.sectionTitle} › ` : ''}${e.title || '（无名）'}（${e.id}）`),
    ].join('\n');
    return dialog({
      message: `删除${parts.join(' 和 ')}？栏目等同文件夹：删栏目会连它的条目一起删。删除不可恢复——要留底先在「导出导入」页导一份。`,
      detail: detail.length > 1600 ? `${detail.slice(0, 1600)}\n…（共 ${secs.length + ents.length} 项）` : detail,
      danger: true,
      confirmText: '删除',
    });
  };

  const doRemove = async (secs, ents) => {
    setBusy(true);
    try {
      if (secs.length) {
        await api('/api/sections/remove-many', { method: 'POST', body: { ids: secs.map((s) => s.id), force: true } });
      }
      if (ents.length) {
        await api('/api/entries/remove-many', { method: 'POST', body: { ids: ents.map((e) => e.id) } });
      }
      setSel(new Set());
      const bits = [];
      if (secs.length) bits.push(`${secs.length} 个栏目`);
      if (ents.length) bits.push(`${ents.length} 条条目`);
      toast(`已删除 ${bits.join(' + ')}`);
      await load();
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = guard(async () => {
    if (!plan.total) return;
    if (!(await confirmRemove(plan))) return;
    await doRemove(plan.secs, plan.ents);
  });

  const removeSectionOne = guard(async (s) => {
    if (!(await confirmRemove({ secs: [s] }))) return;
    await doRemove([s], []);
  });

  const removeEntryOne = guard(async (s, e) => {
    if (!(await confirmRemove({ ents: [{ ...e, sectionTitle: s.title }] }))) return;
    await doRemove([], [{ ...e, sectionTitle: s.title }]);
  });

  /** 进栏目 / 进条目：写地址栏 + 记选择（面板据此切视图）。 */
  const go = (sid, eid = '') => {
    window.location.hash = `#/${sid}`;
    patchUi({ view: sid, entry: eid });
  };

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
        <span className="muted">{data.count} 个 · {data.totalEntries} 条条目</span>
        <span className="grow" />
        <input
          className="tree-search"
          placeholder="搜索栏目 / 条目"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn small ghost" onClick={() => allOpen(true)} title="展开全部栏目的条目">展开</button>
        <button className="btn small ghost" onClick={() => allOpen(false)} title="收起全部">收起</button>
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

      {/* 批量条：只在有用的时候说话——没勾东西时不摆一排灰按钮 */}
      <div className="tree-batch">
        <label className="inline pickall">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => { if (el) el.indeterminate = someOn; }}
            onChange={toggleAll}
          />
          <span>全选{q ? '（当前结果）' : ''}</span>
        </label>
        <span className="hint">
          {plan.total
            ? `已选 ${plan.secs.length} 个栏目${plan.carried ? `（连带 ${plan.carried} 条条目）` : ''}${plan.ents.length ? ` + ${plan.ents.length} 条条目` : ''}`
            : '勾栏目 = 连它的条目一起（删栏目等同删文件夹）；勾条目只删那一条'}
        </span>
        <span className="grow" />
        <button type="button" className="btn small danger" disabled={!plan.total || busy} onClick={removeSelected}>
          {busy ? '删除中…' : `删除选中${plan.total ? `（${plan.total}）` : ''}`}
        </button>
      </div>

      <div className="tree">
        <div className="tree-head">
          <span className="tree-col-name">名称</span>
          <span className="tree-col-meta">结构</span>
          <span className="tree-col-acts">操作</span>
        </div>
        {view.length ? view.map((s) => (
          <TreeSection
            key={s.id}
            s={s}
            open={s.forcedOpen || !!open[s.id]}
            state={secState(s)}
            onToggleOpen={() => toggleOpen(s.id)}
            onToggle={() => toggleSec(s)}
            onGo={() => go(s.id)}
            onEdit={() => openEdit(s)}
            onDump={() => openDump(s)}
            onRemove={() => removeSectionOne(s)}
            isSel={(e) => sel.has(EK(e.id))}
            onToggleEntry={toggleEnt}
            onGoEntry={(e) => go(s.id, e.id)}
            onRemoveEntry={(e) => removeEntryOne(s, e)}
          />
        )) : (
          <div className="pad">
            <Empty>
              {q
                ? `没有匹配「${q}」的栏目或条目。`
                : '还没有栏目。点「新建栏目」，用内置模板（求职 / 密钥 / 项目 / 实习 / 校内实践）起步，或建一个空栏目自己定义字段。'}
            </Empty>
          </div>
        )}
      </div>

      <div className="pad hint">
        栏目 = 一组同构条目 + 一份字段字典。树里一条 = 一个栏目（文件夹），展开是它的条目；
        勾选可以跨栏目，一次删完。删栏目会连带它的条目——要留底先在「导出导入」页导一份。
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
              toast={toast}
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

/**
 * 树里的一节：栏目行 + （展开时）它的条目。
 *
 * 三态勾选：栏目自己勾上 = 实心；只勾了其中几条 = 半选（`indeterminate`）。
 * 半选用原生 `indeterminate` 而不是自己画一个方块：表单控件的手感是系统给的，
 * 自己画的那个在键盘与读屏里都不会按「复选框」工作。
 */
function TreeSection({
  s, open, state, onToggleOpen, onToggle, onGo, onEdit, onDump, onRemove,
  isSel, onToggleEntry, onGoEntry, onRemoveEntry,
}) {
  return (
    <>
      <div className={`tree-row tree-sec${state.isSec ? ' on' : ''}`}>
        <button
          type="button"
          className="tree-chev"
          onClick={onToggleOpen}
          title={open ? '收起条目' : `展开条目（${s.entryList.length}）`}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
        <input
          type="checkbox"
          className="tree-check"
          checked={state.isSec}
          ref={(el) => { if (el) el.indeterminate = !state.isSec && state.picked > 0; }}
          onChange={onToggle}
          title="勾上 = 连同它的条目一起选中"
        />
        <span className="tree-title">
          <button type="button" className="tree-link" onClick={onGo} title="进入这个栏目">
            {s.title}
          </button>
          <span className="mono muted tree-id">{s.id}</span>
          {s.kv ? <Tag>KV</Tag> : null}
          {s.template ? <Tag>{s.template}</Tag> : null}
          {s.description ? <span className="tree-desc muted nowrap">{s.description}</span> : null}
        </span>
        <span className="tree-meta">
          {s.fields} 字段 · {s.entries} 条目
        </span>
        <span className="tree-acts">
          <button type="button" className="btn small ghost" onClick={onEdit}>编辑</button>
          <button type="button" className="btn small ghost" onClick={onDump}>信息</button>
          <button type="button" className="btn small ghost danger-ghost" onClick={onRemove}>删除</button>
        </span>
      </div>

      {open ? (
        <div className="tree-children">
          {s.entryList.length ? s.entryList.map((e) => (
            <div key={e.id} className={`tree-row tree-ent${isSel(e) ? ' on' : ''}`}>
              <input
                type="checkbox"
                className="tree-check"
                checked={isSel(e)}
                onChange={() => onToggleEntry(e)}
                title="只选中这一条条目"
              />
              <span className="tree-title">
                <button type="button" className="tree-link" onClick={() => onGoEntry(e)} title="打开这条条目">
                  {e.title || '（无名）'}
                </button>
                <span className="mono muted tree-id">{e.id}</span>
              </span>
              <span className="tree-meta">
                <span className={`tag${e.ratio >= 100 ? ' strong' : ''}`}>{e.ratio}%</span>
              </span>
              <span className="tree-acts">
                <button type="button" className="tf-mini" title="删除这条条目" onClick={() => onRemoveEntry(e)}>×</button>
              </span>
            </div>
          )) : <div className="tree-empty hint">这个栏目还没有条目</div>}
        </div>
      ) : null}
    </>
  );
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

// table 的默认列：一列文字 + 一列勾选 + 两列数字 + 一列算出来的金额。
// 预填成「能立刻看出它比 entrylist 多什么」的样子——勾选框、数字列、计算列各来一个。
const TABLE_DEFAULT_COLS = [
  { key: 'item', label: '项目', type: 'text' },
  { key: 'done', label: '已办', type: 'bool' },
  { key: 'qty', label: '数量', type: 'number' },
  { key: 'price', label: '单价', type: 'number' },
  { key: 'amount', label: '金额', type: 'formula-num', formula: 'qty * price' },
];

// 类型下拉里的「计算列」是伪类型：落盘时拆成 type + formula
const COL_TYPES = [
  ['text', '文本'], ['number', '数字'], ['bool', '勾选（是/否）'], ['select', '下拉框'],
  ['date', '日期'], ['month', '月份'], ['textarea', '长文本'], ['tags', '多值'],
  ['formula-num', '计算（数字）'], ['formula-text', '计算（文本）'],
];

const colKind = (c) => (c.type === 'formula-num' || c.type === 'formula-text' ? c.type : (c.type || 'text'));

function EditForm({ modal, types, labels, onChange, onSave, onSync, onAddField, onRemoveField, onClose, toast }) {
  const [nf, setNf] = useState({ key: '', label: '', type: 'text', group: '' });
  const full = modal.full;
  const groups = full?.groupList || [];
  // 列编辑只在清单类字段出现；cols 为 null 表示还没动过 → 用该类型的默认列
  const defaultCols = nf.type === 'entrylist' ? ENTRYLIST_DEFAULT_COLS : (nf.type === 'table' ? TABLE_DEFAULT_COLS : []);
  const cols = (nf.type === 'entrylist' || nf.type === 'table') ? (nf.cols || defaultCols) : null;
  const cur = () => cols || [];
  const setCol = (i, patch) => setNf((m) => ({ ...m, cols: (m.cols || defaultCols).map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));
  const addCol = () => setNf((m) => ({ ...m, cols: [...(m.cols || defaultCols), { key: '', label: '', type: 'text' }] }));
  const removeCol = (i) => setNf((m) => ({ ...m, cols: (m.cols || defaultCols).filter((_, idx) => idx !== i) }));

  const buildDef = () => {
    const def = { key: nf.key.trim(), label: nf.label.trim() || nf.key.trim(), type: nf.type };
    if (nf.group) def.group = nf.group;
    if (nf.type === 'entrylist') {
      const fields = cur().map((c) => {
        const out = { key: c.key.trim(), label: c.label.trim() || c.key.trim() };
        if (c.sensitive) out.sensitive = true;
        return out;
      }).filter((c) => c.key);
      if (!fields.length) return { error: '结构清单至少要有一列（填列 key）' };
      def.fields = fields;
    }
    if (nf.type === 'table') {
      const columns = [];
      for (const c of cur()) {
        const key = String(c.key || '').trim();
        if (!key) continue;
        const kind = colKind(c);
        const col = { key, label: String(c.label || '').trim() || key };
        if (kind === 'formula-num' || kind === 'formula-text') {
          const formula = String(c.formula || '').trim();
          if (!formula) return { error: `列「${col.label}」选了计算，但没写公式（例如 qty * price）` };
          col.type = kind === 'formula-text' ? 'text' : 'number';
          col.formula = formula;
        } else {
          col.type = kind;
          if (kind === 'select') {
            const opts = String(c.options || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
            if (!opts.length) return { error: `列「${col.label}」是下拉框，要填选项（逗号分隔）` };
            col.options = opts;
          }
          if (c.sensitive) col.sensitive = true;
        }
        if (String(c.unit || '').trim()) col.unit = String(c.unit).trim();
        columns.push(col);
      }
      if (!columns.length) return { error: '表格至少要有一列（填列 key）' };
      def.columns = columns;
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
                    {f.type === 'table' && Array.isArray(f.columns) && f.columns.length
                      ? `${f.hint ? '　' : ''}列：${f.columns.map((s) => `${s.label}${s.formula ? '（算）' : ''}`).join(' / ')}`
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
          {nf.type === 'entrylist' || nf.type === 'table' ? (
            <div className="stack" style={{ gap: 4, width: '100%' }}>
              <div className="hint">
                {nf.type === 'table'
                  ? '表格列：一列一种类型（勾选 / 下拉 / 数字 / 日期…）。「计算」列写 JS 表达式，可用同行的列 key 或中文列名（如 qty * price），也可用 rows / sum / countTrue 统计整表。'
                  : '清单列（每行一列，变长行共用）。key 英文字母开头；勾「密文」的列以密文落盘、--mask 打码。'}
              </div>
              {cols.map((c, i) => (
                <ColumnRow
                  key={i}
                  col={c}
                  table={nf.type === 'table'}
                  onChange={(p) => setCol(i, p)}
                  onRemove={() => removeCol(i)}
                />
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

/**
 * 一列的定义行（entrylist 与 table 共用）。
 *
 * 两个字段类型的列看起来像，但 table 的列多三件事：**类型**、**选项**、**公式**。
 * 合成一个组件而不是各写一份，是为了让「加列」的手感在两种字段上完全一样——
 * 用户不必先记住自己正在编辑哪一种清单。
 */
function ColumnRow({ col, table, onChange, onRemove }) {
  const kind = colKind(col);
  const isFormula = kind === 'formula-num' || kind === 'formula-text';
  return (
    <div className="stack" style={{ gap: 3, paddingBottom: 4, borderBottom: '1px dashed var(--soft-2)' }}>
      <div className="rowgap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input style={{ width: 120 }} placeholder="列 key（如 qty）" value={col.key} onChange={(e) => onChange({ key: e.target.value })} />
        <input style={{ width: 120 }} placeholder="列名（如 数量）" value={col.label} onChange={(e) => onChange({ label: e.target.value })} />
        {table ? (
          <select style={{ width: 132 }} value={kind} onChange={(e) => onChange({ type: e.target.value })}>
            {COL_TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        ) : null}
        {table && !isFormula ? (
          <input style={{ width: 70 }} placeholder="单位" value={col.unit || ''} onChange={(e) => onChange({ unit: e.target.value })} />
        ) : null}
        {!isFormula ? (
          <label className="inline hint" title="这一列的值以 AES-256-GCM 密文落盘">
            <input type="checkbox" checked={!!col.sensitive} onChange={(e) => onChange({ sensitive: e.target.checked })} /> 密文
          </label>
        ) : null}
        <button type="button" className="btn small ghost" onClick={onRemove}>×</button>
      </div>
      {isFormula ? (
        <input
          placeholder="公式：qty * price　（可用列 key、中文列名、row、rows、sum / countTrue / round…）"
          value={col.formula || ''}
          onChange={(e) => onChange({ formula: e.target.value })}
        />
      ) : null}
      {table && kind === 'select' ? (
        <input
          placeholder="选项，逗号分隔，例如：未开始，进行中，已完成"
          value={col.options || ''}
          onChange={(e) => onChange({ options: e.target.value })}
        />
      ) : null}
    </div>
  );
}
