import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { CliHints, Empty, Modal, Tag } from '../../components/ui.tsx';
import { checkZipFile, fmtBytes, postZip } from '../../api/zip.ts';
import DictEditor from './dictEditor.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';

/** `/api/sections/tree` 里的一行条目。 */
interface TreeEntryRow {
  id: string;
  title: string;
  ratio: number;
}

/** `/api/sections/tree` 里的一节栏目（含它的条目列表）。 */
interface TreeSectionRow {
  id: string;
  title: string;
  description?: string;
  kv?: boolean;
  template?: string | null;
  fields: number;
  entries: number;
  entryList: TreeEntryRow[];
  /** 搜索时临时展开（不写回展开态）。 */
  forcedOpen?: boolean;
}

/** `/api/sections/tree` 的响应（外部 JSON 边界）。 */
interface TreeData {
  count: number;
  totalEntries: number;
  sections: TreeSectionRow[];
}

/** `/api/sections/templates` 的一行。 */
interface TemplateRow {
  id: string;
  label: string;
  fields: number;
}

/** `/api/sections/:id` 的栏目全量（属性编辑器的数据源）。 */
export interface SectionFull {
  id: string;
  title: string;
  description: string;
  order: number;
  titleLabel: string;
  titleField?: string | null;
  template?: string | null;
  kv?: boolean;
  groupList?: Array<{ id: string; title: string }>;
  fieldList?: FieldDef[];
}

interface CreateFormData {
  id: string;
  title: string;
  template: string;
  description: string;
  order: string;
}

type ModalState =
  | { kind: 'dump'; title: string; body: ReactNode }
  | { kind: 'create'; form: CreateFormData };

/** 零配置导入预览（`/api/import.zip?dry-run=1`）。 */
interface GlobalPreview {
  status: string;
  exportedAt?: string;
  encrypted: boolean;
  withSecrets: boolean;
  section: { title: string; targetId: string; renamedFrom: string | null; fieldsToAdd: unknown[] };
  entries: { total: number; fresh: number };
  files: { new: number; reused: number; bytes: number };
  warnings: string[];
}

/** 零配置导入落地结果（只读栏目 id/标题与新增条目数）。 */
interface GlobalApplyResult {
  section: { id: string; title: string };
  entries: { added: number };
}

interface ZipState { fileName: string; buffer: ArrayBuffer; preview: GlobalPreview }

// 选中项用带前缀的 key：栏目与条目在同一个集合里，前缀就是它们的「类型」。
// 好处是「全选 / 反选 / 计数」只处理一个 Set，不必维护两份状态再想办法对齐。
const SK = (id: string) => `sec:${id}`;
const EK = (id: string) => `ent:${id}`;

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
  const [data, setData] = useState<TreeData | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  // #15：属性编辑从弹窗升级为整页编辑器（块式分组 + 拖拽排序）
  const [editing, setEditing] = useState<{ id: string; full: SectionFull } | null>(null);
  // 零配置导入：不选栏目，按包内结构新建；id 冲突自动加序号
  const [zip, setZip] = useState<ZipState | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  // 展开态记在 ui（localStorage）里：栏目多时「上次展开到哪」是跨会话有意义的选择
  const [open, setOpen] = useState<Record<string, boolean>>(
    () => (ui.treeOpen && typeof ui.treeOpen === 'object' ? ui.treeOpen as Record<string, boolean> : {}),
  );
  const zipInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [t, tpl] = await Promise.all([
        api<TreeData>('/api/sections/tree'),
        api<{ templates: TemplateRow[] }>('/api/sections/templates'),
      ]);
      setData(t);
      setTemplates(tpl.templates);
      setErr(null);
      // 选中项里清掉已经不存在的（别的标签页删过），否则「已选 3」里有两个是幽灵
      setSel((prev) => {
        if (!prev.size) return prev;
        const alive = new Set<string>();
        for (const s of t.sections) { alive.add(SK(s.id)); for (const e of s.entryList) alive.add(EK(e.id)); }
        const next = new Set([...prev].filter((k) => alive.has(k)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 搜索：栏目命中就整棵留下；只有条目命中时只留命中的条目，并**临时**展开那一节。 */
  const view = useMemo<TreeSectionRow[]>(() => {
    if (!data) return [];
    const kw = q.trim().toLowerCase();
    if (!kw) return data.sections;
    const out: TreeSectionRow[] = [];
    for (const s of data.sections) {
      const secHit = [s.id, s.title, s.description || ''].join(' ').toLowerCase().includes(kw);
      const hits = s.entryList.filter((e) => String(e.title || '').toLowerCase().includes(kw));
      if (!secHit && !hits.length) continue;
      out.push(secHit ? s : { ...s, entryList: hits, forcedOpen: true });
    }
    return out;
  }, [data, q]);

  const setOpenMap = (next: Record<string, boolean>) => { setOpen(next); patchUi({ treeOpen: next }); };
  const toggleOpen = (id: string) => setOpenMap({ ...open, [id]: !open[id] });
  const allOpen = (v: boolean) => {
    const next: Record<string, boolean> = {};
    for (const s of data?.sections || []) next[s.id] = v;
    setOpenMap(next);
  };

  const secState = (s: TreeSectionRow) => {
    const isSec = sel.has(SK(s.id));
    const picked = s.entryList.filter((e) => sel.has(EK(e.id))).length;
    return { isSec, picked, total: s.entryList.length, full: isSec && picked === s.entryList.length };
  };

  /** 勾栏目 = 连条目一起；反勾 = 一起清掉。 */
  const toggleSec = (s: TreeSectionRow) => setSel((prev) => {
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

  const toggleEnt = (e: TreeEntryRow) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(EK(e.id))) next.delete(EK(e.id)); else next.add(EK(e.id));
    return next;
  });

  const visibleKeys = useMemo(() => {
    const keys: string[] = [];
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
    const secs: TreeSectionRow[] = [];
    const ents: Array<TreeEntryRow & { sectionTitle?: string }> = [];
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

  const confirmRemove = async ({ secs = [], ents = [] }: {
    secs?: TreeSectionRow[];
    ents?: Array<TreeEntryRow & { sectionTitle?: string }>;
  }) => {
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

  const doRemove = async (secs: TreeSectionRow[], ents: Array<TreeEntryRow & { sectionTitle?: string }>) => {
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

  const removeSectionOne = guard(async (s: TreeSectionRow) => {
    if (!(await confirmRemove({ secs: [s] }))) return;
    await doRemove([s], []);
  });

  const removeEntryOne = guard(async (s: TreeSectionRow, e: TreeEntryRow) => {
    if (!(await confirmRemove({ ents: [{ ...e, sectionTitle: s.title }] }))) return;
    await doRemove([], [{ ...e, sectionTitle: s.title }]);
  });

  /** 进栏目 / 进条目：写地址栏 + 记选择（面板据此切视图）。 */
  const go = (sid: string, eid = '') => {
    window.location.hash = `#/${sid}`;
    patchUi({ view: sid, entry: eid });
  };

  const openDump = guard(async (s: TreeSectionRow) => {
    const d = await api<unknown>(`/api/sections/${encodeURIComponent(s.id)}/dump`);
    setModal({ kind: 'dump', title: `${s.title}（${s.id}）的全部信息`, body: <pre className="block">{JSON.stringify(d, null, 2)}</pre> });
  });

  const openEdit = guard(async (s: TreeSectionRow) => {
    const full = await api<SectionFull>(`/api/sections/${encodeURIComponent(s.id)}`);
    setEditing({ id: s.id, full });
  });

  const create = guard(async (form: CreateFormData) => {
    const body: { id: string; title: string; template?: string; description: string; order: number } = { id: form.id.trim(), title: form.title.trim() || form.id.trim(), template: form.template || undefined, description: form.description, order: Number(form.order) || 50 };
    await api('/api/sections', { method: 'POST', body });
    toast('栏目已创建');
    setModal(null);
    await load();
    await reload();
  });

  const handleZip = guard(async (file: File) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const preview = await postZip<GlobalPreview>('/api/import.zip?dry-run=1', buffer, file.name);
      setZip({ fileName: file.name, buffer, preview });
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setImporting(true);
    try {
      const r = await postZip<GlobalApplyResult>('/api/import.zip', zip.buffer, zip.fileName);
      setZip(null);
      toast(`已导入为新栏目「${r.section.title}」（${r.entries.added} 条）`);
      await load();
      await reload();
      // 直接跳到新栏目，省掉「导入完还得自己找」
      patchUi({ view: r.section.id, entry: '' });
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

  const hasFiles = (e: ReactDragEvent<HTMLElement>) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>) => { if (!hasFiles(e)) return; e.preventDefault(); setDragDepth((d) => d + 1); };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => { if (hasFiles(e)) e.preventDefault(); };
  const onDragLeave = () => setDragDepth((d) => Math.max(0, d - 1));
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragDepth(0);
    const f = [...(e.dataTransfer?.files || [])][0];
    if (f) handleZip(f);
  };

  if (err) return <div className="pad stack"><div className="bad"><strong>读不到栏目</strong></div><pre className="block">{err}</pre></div>;
  if (!data) return <div className="pad muted">加载中…</div>;

  // 属性编辑器整页接管（hooks 都已跑完，这里是合法提前返回）
  if (editing) {
    return (
      <DictEditor
        sectionId={editing.id}
        initial={editing.full}
        types={types}
        labels={labels}
        builtin={boot?.builtin || {}}
        onClose={() => setEditing(null)}
        onChanged={() => { void load(); void reload(); }}
      />
    );
  }

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
              onChange={(f) => setModal((m) => (m && m.kind === 'create' ? { ...m, form: { ...m.form, ...f } } : m))}
              onSubmit={() => {
                if (!/^[a-z][a-z0-9_-]{0,63}$/.test(modal.form.id.trim())) { toast('栏目 id 必须是小写字母开头，仅含 a-z 0-9 _ -', 'bad'); return; }
                create(modal.form);
              }}
            />
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

function modalTitle(m: ModalState) {
  if (m.kind === 'dump') return m.title;
  return '新建栏目';
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
}: {
  s: TreeSectionRow;
  open: boolean;
  state: { isSec: boolean; picked: number; total: number; full: boolean };
  onToggleOpen: () => void;
  onToggle: () => void;
  onGo: () => void;
  onEdit: () => void;
  onDump: () => void;
  onRemove: () => void;
  isSel: (e: TreeEntryRow) => boolean;
  onToggleEntry: (e: TreeEntryRow) => void;
  onGoEntry: (e: TreeEntryRow) => void;
  onRemoveEntry: (e: TreeEntryRow) => void;
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

function CreateForm({ templates, form, onChange, onSubmit }: {
  templates: TemplateRow[];
  form: CreateFormData;
  onChange: (patch: Partial<CreateFormData>) => void;
  onSubmit: () => void;
}) {
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
