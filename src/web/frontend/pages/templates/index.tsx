import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { MoreMenu } from '../../components/menu/index.tsx';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { Empty, Modal, Tag } from '../../components/ui/index.tsx';
import { checkZipFile, fmtBytes, postZip } from '../../api/zip.ts';
import DictEditor from './dictEditor.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';
/** `/api/templates/tree` 里的一行条目。 */
interface TreeEntryRow {
  id: string;
  title: string;
  ratio: number;
}

/** `/api/templates/tree` 里的一节条目模板（含它的条目列表）。 */
interface TreeTemplateRow {
  id: string;
  title: string;
  description?: string;
  order?: number;
  template?: string | null;
  fields: number;
  entries: number;
  entryList: TreeEntryRow[];
  /** 搜索时临时展开（不写回展开态）。 */
  forcedOpen?: boolean;
}

/** `/api/templates/tree` 的响应（外部 JSON 边界）。 */
interface TreeData {
  count: number;
  totalEntries: number;
  templates: TreeTemplateRow[];
}

/** `/api/templates/presets` 的一行。 */
interface TemplateRow {
  id: string;
  label: string;
  fields: number;
}

/**
 * 字段的**读侧形状**：服务端在字典原样之外补了两个派生键——
 *   · `group`：它属于哪个组（组字段的 keys 决定，见 shared/fields/structure.ts）；
 *   · `keys`：组字段自己的成员清单。
 * 面板据此渲染分组与拖拽落点，不需要自己再推一遍结构。
 */
export type FieldRow = FieldDef & { group?: string; keys?: string[] };

/** `/api/templates/:id` 的条目模板全量（属性编辑器的数据源）。 */
export interface TemplateFull {
  id: string;
  title: string;
  description: string;
  order: number;
  titleLabel: string;
  titleField?: string | null;
  template?: string | null;
  groupList?: Array<{ id: string; title: string }>;
  fieldList?: FieldRow[];
}

interface CreateFormData {
  id: string;
  title: string;
  preset: string;
  description: string;
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
  template: { title: string; targetId: string; renamedFrom: string | null; fieldsToAdd: unknown[] };
  entries: { total: number; fresh: number };
  files: { new: number; reused: number; bytes: number };
  warnings: string[];
}

/** 零配置导入落地结果（只读条目模板 id/标题与新增条目数）。 */
interface GlobalApplyResult {
  template: { id: string; title: string };
  entries: { added: number };
}

interface ZipState { fileName: string; buffer: ArrayBuffer; preview: GlobalPreview }

// 选中项用带前缀的 key：条目模板与条目在同一个集合里，前缀就是它们的「类型」。
// 好处是「全选 / 反选 / 计数」只处理一个 Set，不必维护两份状态再想办法对齐。
const SK = (id: string) => `sec:${id}`;
const EK = (id: string) => `ent:${id}`;

/**
 * 条目模板管理：**一棵树**（条目模板 → 条目），不是一张平铺列表。
 *
 * 为什么改成树：条目模板一多，平铺列表就只剩「一堆看起来一样的行」——
 * 分不清哪些是条目模板哪些是条目、看不见条目模板里有什么、删除只能一条一条点。
 * 树把两件事同时解决：**层次**（条目模板 = 文件夹，条目 = 里面的文件）和**批量**
 * （勾选可以跨条目模板，删除一次走完）。
 *
 * 三条刻意的规则：
 *   1. **勾条目模板只选模板本身**。删除模板不删任何条目；条目要删就在树上单独勾。
 *   2. **勾条目不会顺带勾条目模板**。删掉全部条目 ≠ 删掉这个空模板，这是两件事。
 *   3. 两类选择可以同时存在：提交时先删除条目模板，再删选中的条目（含各自子树）。
 *   3. 搜索时**只展开命中的**，不改变原本的展开状态 —— 清空搜索就回到原样。
 */
export default function TemplatesView() {
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
  const [editing, setEditing] = useState<{ id: string; full: TemplateFull } | null>(null);
  // 零配置导入：不选条目模板，按包内结构新建；id 冲突自动加序号
  const [zip, setZip] = useState<ZipState | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  // 批量删除是低频破坏性操作：默认不摆勾选框，从「更多」显式进入批量模式
  const [batch, setBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  // 拖动排序：只有把手能起拖；拖到行的上半/下半 = 插到它前/后（Notion 同款落点线）
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; at: 'before' | 'after' } | null>(null);
  const canDrag = !q.trim() && !busy && !batch;
  // 展开态记在 ui（localStorage）里：条目模板多时「上次展开到哪」是跨会话有意义的选择
  const [open, setOpen] = useState<Record<string, boolean>>(
    () => (ui.treeOpen && typeof ui.treeOpen === 'object' ? ui.treeOpen as Record<string, boolean> : {}),
  );
  const zipInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [t, tpl] = await Promise.all([
        api<TreeData>('/api/templates/tree'),
        api<{ presets: TemplateRow[] }>('/api/templates/presets'),
      ]);
      setData(t);
      setTemplates(tpl.presets);
      setErr(null);
      // 选中项里清掉已经不存在的（别的标签页删过），否则「已选 3」里有两个是幽灵
      setSel((prev) => {
        if (!prev.size) return prev;
        const alive = new Set<string>();
        for (const s of t.templates) { alive.add(SK(s.id)); for (const e of s.entryList) alive.add(EK(e.id)); }
        const next = new Set([...prev].filter((k) => alive.has(k)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /** 搜索：条目模板命中就整棵留下；只有条目命中时只留命中的条目，并**临时**展开那一节。 */
  const view = useMemo<TreeTemplateRow[]>(() => {
    if (!data) return [];
    // 顺序以 order 为准（拖拽排序写回的就是它）；order 相同再按 id，保证刷新前后可复现
    const base = [...data.templates].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    const kw = q.trim().toLowerCase();
    if (!kw) return base;
    const out: TreeTemplateRow[] = [];
    for (const s of base) {
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
    for (const s of data?.templates || []) next[s.id] = v;
    setOpenMap(next);
  };

  const secState = (s: TreeTemplateRow) => ({ isSec: sel.has(SK(s.id)), total: s.entryList.length });

  /** 勾条目模板只选模板本身；条目要在树上单独勾，两类删除分开执行。 */
  const toggleSec = (s: TreeTemplateRow) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(SK(s.id))) next.delete(SK(s.id)); else next.add(SK(s.id));
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

  /** 删除计划：条目模板真正删除（条目落到空白模板），条目才真正删除；两者互不连带。 */
  const plan = useMemo(() => {
    const secs: TreeTemplateRow[] = [];
    const ents: Array<TreeEntryRow & { templateTitle?: string }> = [];
    for (const s of data?.templates || []) {
      if (sel.has(SK(s.id))) secs.push(s);
      for (const e of s.entryList) {
        if (sel.has(EK(e.id))) ents.push({ ...e, templateTitle: s.title });
      }
    }
    return { secs, ents, total: secs.length + ents.length };
  }, [data, sel]);

  const confirmRemove = async ({ secs = [], ents = [] }: {
    secs?: TreeTemplateRow[];
    ents?: Array<TreeEntryRow & { templateTitle?: string }>;
  }) => {
    const parts = [];
    if (secs.length) parts.push(`删除 ${secs.length} 个条目模板（条目不删，落到空白模板）`);
    if (ents.length) parts.push(`删除 ${ents.length} 条条目（含子树）`);
    const detail = [
      ...secs.map((s) => `删除条目模板：${s.title}（${s.id}）· ${s.entries} 条条目将落到空白模板`),
      ...ents.map((e) => `删除条目：${e.templateTitle ? `${e.templateTitle} › ` : ''}${e.title || '（无名）'}（${e.id}）`),
    ].join('\n');
    return dialog({
      message: `确认${parts.join('，')}？条目模板删掉只影响「以后用什么结构建条目」，已有条目的结构行与值原样保留；删除条目不可恢复——要留底先在「导出导入」页导一份。`,
      detail: detail.length > 1600 ? `${detail.slice(0, 1600)}\n…（共 ${secs.length + ents.length} 项）` : detail,
      danger: true,
      confirmText: '继续',
    });
  };

  const doRemove = async (secs: TreeTemplateRow[], ents: Array<TreeEntryRow & { templateTitle?: string }>) => {
    setBusy(true);
    try {
      if (secs.length) {
        await api('/api/templates/remove-many', { method: 'POST', body: { ids: secs.map((s) => s.id), force: true } });
      }
      if (ents.length) {
        await api('/api/entries/remove-many', { method: 'POST', body: { ids: ents.map((e) => e.id) } });
      }
      setSel(new Set());
      setBatch(false);
      const bits = [];
      if (secs.length) bits.push(`删除 ${secs.length} 个条目模板`);
      if (ents.length) bits.push(`删除 ${ents.length} 条条目`);
      toast(`已${bits.join(' + ')}`);
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

  const removeTemplateOne = guard(async (s: TreeTemplateRow) => {
    if (!(await confirmRemove({ secs: [s] }))) return;
    await doRemove([s], []);
  });

  const removeEntryOne = guard(async (s: TreeTemplateRow, e: TreeEntryRow) => {
    if (!(await confirmRemove({ ents: [{ ...e, templateTitle: s.title }] }))) return;
    await doRemove([], [{ ...e, templateTitle: s.title }]);
  });

  /** 重命名：只改标题，不动字段字典与条目；和「编辑」里的基本属性走同一条 PATCH。 */
  const renameTemplate = guard(async (s: TreeTemplateRow) => {
    const answer = await dialog({
      message: `条目模板「${s.title}」的新名称？`,
      input: { defaultValue: s.title, placeholder: '例如 项目档案' },
      confirmText: '保存',
    });
    if (answer === null || answer === undefined) return;
    const title = String(answer).trim();
    if (!title || title === s.title) return;
    await api(`/api/templates/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { title } });
    toast(`已重命名为「${title}」`);
    await load();
    await reload();
  });

  /** 拖动排序：把 from 插到 target 的上半/下半；整份顺序一次 POST，落盘后重拉。 */
  const commitReorder = guard(async (fromId: string, targetId: string, at: 'before' | 'after') => {
    if (fromId === targetId) return;
    const ordered = [...(data?.templates || [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
    const moving = ordered.find((x) => x.id === fromId);
    if (!moving) return;
    const rest = ordered.filter((x) => x.id !== fromId);
    const atIdx = rest.findIndex((x) => x.id === targetId);
    if (atIdx < 0) return;
    rest.splice(at === 'after' ? atIdx + 1 : atIdx, 0, moving);
    await api('/api/templates/reorder', { method: 'POST', body: { ids: rest.map((x) => x.id) } });
    await load();
    await reload();
  });

  const dropAt = (e: ReactDragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
  };

  const startDrag = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!canDrag) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    const row = e.currentTarget.closest('.tree-sec');
    if (row) e.dataTransfer.setDragImage(row as Element, 12, 12);
    setDragId(id);
    setDropMark(null);
  };

  const overRow = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const at = dropAt(e);
    setDropMark((prev) => (prev?.id === id && prev.at === at ? prev : { id, at }));
  };

  const dropOnRow = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    const at = dropMark?.id === id ? dropMark.at : dropAt(e);
    const from = dragId;
    setDragId(null);
    setDropMark(null);
    void commitReorder(from, id, at);
  };

  const endDrag = () => { setDragId(null); setDropMark(null); };

  /** 进条目模板 / 进条目：写地址栏 + 记选择（面板据此切视图）。 */
  const go = (sid: string, eid = '') => {
    window.location.hash = `#/${sid}`;
    patchUi({ view: sid, entry: eid });
  };

  const openDump = guard(async (s: TreeTemplateRow) => {
    const d = await api<unknown>(`/api/templates/${encodeURIComponent(s.id)}/dump`);
    setModal({ kind: 'dump', title: `${s.title}（${s.id}）的全部信息`, body: <pre className="block">{JSON.stringify(d, null, 2)}</pre> });
  });

  const openEdit = guard(async (s: TreeTemplateRow) => {
    const full = await api<TemplateFull>(`/api/templates/${encodeURIComponent(s.id)}`);
    setEditing({ id: s.id, full });
  });

  const create = guard(async (form: CreateFormData) => {
    const body: { id: string; title: string; preset?: string; description: string } = { id: form.id.trim(), title: form.title.trim() || form.id.trim(), preset: form.preset || undefined, description: form.description };
    await api('/api/templates', { method: 'POST', body });
    toast('条目模板已创建');
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
      toast(`已导入为新条目模板「${r.template.title}」（${r.entries.added} 条）`);
      await load();
      await reload();
      // 直接跳到新条目模板，省掉「导入完还得自己找」
      patchUi({ view: r.template.id, entry: '' });
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

  if (err) return <div className="pad stack"><div className="bad"><strong>读不到条目模板</strong></div><pre className="block">{err}</pre></div>;
  if (!data) return <div className="pad muted">加载中…</div>;

  // 属性编辑器整页接管（hooks 都已跑完，这里是合法提前返回）
  if (editing) {
    return (
      <DictEditor
        templateId={editing.id}
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
      className="template-wrap"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="toolbar rowgap pad">
        <strong>条目模板</strong>
        <span className="muted">{data.count} 个 · {data.totalEntries} 条条目</span>
        <span className="grow" />
        <input
          className="tree-search"
          placeholder="搜索条目模板 / 条目"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <MoreMenu
          label="更多条目模板操作"
          items={[
            { key: 'expand', label: '展开全部', onClick: () => allOpen(true) },
            { key: 'collapse', label: '收起全部', onClick: () => allOpen(false) },
            { key: 'reload', icon: 'reload', label: '刷新', onClick: () => load() },
            { key: 'import', icon: 'upload', label: '导入 ZIP', onClick: () => zipInput.current?.click() },
            'divider',
            { key: 'batch', label: batch ? '退出批量删除' : '批量删除…', danger: !batch, onClick: () => { setSel(new Set()); setBatch(!batch); } },
          ]}
        />
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
        <button className="btn small" onClick={() => setModal({ kind: 'create', form: { id: '', title: '', preset: templates[0]?.id || '', description: '' } })}>新建条目模板</button>
      </div>

      {batch ? (
        <div className="tree-batch">
          <label className="inline pickall">
            <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = someOn; }} onChange={toggleAll} />
            <span>全选{q ? '（当前结果）' : ''}</span>
          </label>
          <span className="hint">
            {plan.total
              ? `已选 ${plan.secs.length} 个条目模板（删除，条目不删）${plan.ents.length ? ` + ${plan.ents.length} 条条目（删除）` : ''}`
              : '勾条目模板 = 删除这个条目模板，已有条目落到空白模板、内容不动；勾条目 = 删除该条目及其子树。两类可以同时选'}
          </span>
          <span className="grow" />
          <button type="button" className="btn small ghost" onClick={() => { setSel(new Set()); setBatch(false); }}>退出</button>
          <button type="button" className="btn small danger" disabled={!plan.total || busy} onClick={removeSelected}>
            {busy ? '处理中…' : `删除选中${plan.total ? `（${plan.total}）` : ''}`}
          </button>
        </div>
      ) : null}

      <div className="tree">
        <div className="tree-head">
          <span className="tree-col-name">名称</span>
          <span className="tree-col-meta">结构</span>
          <span className="tree-col-acts">操作</span>
        </div>
        {view.length ? view.map((s) => (
          <TreeTemplate
            key={s.id}
            s={s}
            open={s.forcedOpen || !!open[s.id]}
            state={secState(s)}
            mark={dropMark?.id === s.id ? dropMark.at : null}
            dragging={dragId === s.id}
            canDrag={canDrag}
            batch={batch}
            onDragStart={(e) => startDrag(e, s.id)}
            onDragOver={(e) => overRow(e, s.id)}
            onDrop={(e) => dropOnRow(e, s.id)}
            onDragEnd={endDrag}
            onToggleOpen={() => toggleOpen(s.id)}
            onToggle={() => toggleSec(s)}
            onGo={() => go(s.id)}
            onRename={() => renameTemplate(s)}
            onEdit={() => openEdit(s)}
            onDump={() => openDump(s)}
            onRemove={() => removeTemplateOne(s)}
            isSel={(e) => sel.has(EK(e.id))}
            onToggleEntry={toggleEnt}
            onGoEntry={(e) => go(s.id, e.id)}
            onRemoveEntry={(e) => removeEntryOne(s, e)}
          />
        )) : (
          <div className="pad">
            <Empty>
              {q
                ? `没有匹配「${q}」的条目模板或条目。`
                : '还没有条目模板。点「新建条目模板」，用预置（求职 / 密钥 / 项目 / 实习 / 校内实践）起步，或建一个空条目模板自己定义字段。'}
            </Empty>
          </div>
        )}
      </div>

      <div className="pad hint">
        条目模板 = 一组初始化字段。树里一条 = 一个条目模板，展开是「用它初始化过的条目」（只作索引，不是目录）；
        删除条目模板不会删条目，已有条目落到空白模板。拖动左侧把手可调整条目模板顺序。条目的层级在左侧目录树里看。
      </div>

      {dragDepth > 0 ? <div className="drop-mask"><div>松开导入为新条目模板</div></div> : null}

      {zip ? (
        <Modal
          title={`导入为新条目模板 · ${zip.fileName}`}
          onClose={() => { if (!importing) setZip(null); }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setZip(null)} disabled={importing}>取消</button>
              <button className="btn" onClick={applyZip} disabled={importing}>{importing ? '导入中…' : '导入为新条目模板'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            return (
              <div className="stack">
                <div>
                  将新建条目模板：<strong>{p.template.title}</strong>
                  <span className="muted">（{p.template.targetId}）</span>
                  {p.template.renamedFrom ? <span className="bad">　id {p.template.renamedFrom} 已存在，已另存</span> : null}
                </div>
                <div className="hint">导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}</div>
                <div className="rowgap">
                  <Tag>条目 {p.entries.total}</Tag>
                  <Tag>字段 {p.template.fieldsToAdd.length}</Tag>
                  <Tag>附件 新增 {p.files.new} / 复用 {p.files.reused}（{fmtBytes(p.files.bytes)}）</Tag>
                </div>
                <div className="hint">条目模板结构、字段字典、附件都会一起建好，导入后可直接使用。</div>
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
                if (!/^[a-z][a-z0-9_-]{0,63}$/.test(modal.form.id.trim())) { toast('条目模板 id 必须是小写字母开头，仅含 a-z 0-9 _ -', 'bad'); return; }
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
  return '新建条目模板';
}

/**
 * 树里的一节：条目模板行 + （展开时）它的条目。
 *
 * 两类选择互不联动：条目模板勾上只代表「删除这个条目模板」，
 * 它下面的条目要删得单独勾。原生 checkbox，不再做半选。
 */
function TreeTemplate({
  s, open, state, mark, dragging, canDrag, batch, onDragStart, onDragOver, onDrop, onDragEnd,
  onToggleOpen, onToggle, onGo, onRename, onEdit, onDump, onRemove,
  isSel, onToggleEntry, onGoEntry, onRemoveEntry,
}: {
  s: TreeTemplateRow;
  open: boolean;
  state: { isSec: boolean; total: number };
  mark: 'before' | 'after' | null;
  dragging: boolean;
  canDrag: boolean;
  batch: boolean;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onToggleOpen: () => void;
  onToggle: () => void;
  onGo: () => void;
  onRename: () => void;
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
      <div
        className={`tree-row tree-sec${state.isSec ? ' on' : ''}${dragging ? ' dragging' : ''}${mark ? ` drop-${mark}` : ''}`}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <span
          className="tree-grip"
          draggable={canDrag}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="拖动调整条目模板顺序"
          aria-label="拖动调整条目模板顺序"
        />
        <button
          type="button"
          className="tree-chev"
          onClick={onToggleOpen}
          title={open ? '收起条目' : `展开条目（${s.entryList.length}）`}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'}
        </button>
        {batch ? (
          <input type="checkbox" className="tree-check" checked={state.isSec} onChange={onToggle}
            title="勾上 = 删除这个条目模板（已有条目落到空白模板，不删条目）" />
        ) : <span className="tree-check-slot" aria-hidden="true" />}
        <span className="tree-title">
          <button type="button" className="tree-link" onClick={onGo} title="进入这个条目模板">
            {s.title}
          </button>
          <span className="mono muted tree-id">{s.id}</span>
          {s.template && s.template !== s.id ? <Tag>{s.template}</Tag> : null}
          {s.description ? <span className="tree-desc muted nowrap">{s.description}</span> : null}
        </span>
        <span className="tree-meta">
          {s.fields} 字段 · {s.entries} 条目
        </span>
        <span className="tree-acts">
          <MoreMenu
            label={`更多操作：${s.title}`}
            items={[
              { key: 'rename', label: '改名', onClick: onRename },
              { key: 'edit', label: '编辑字段与结构', onClick: onEdit },
              { key: 'dump', icon: 'eye', label: '信息', onClick: onDump },
              'divider',
              { key: 'remove', icon: 'x', label: '删除条目模板', danger: true, onClick: onRemove },
            ]}
          />
        </span>
      </div>

      {open ? (
        <div className="tree-children">
          {s.entryList.length ? s.entryList.map((e) => (
            <div key={e.id} className={`tree-row tree-ent${isSel(e) ? ' on' : ''}`}>
              {batch ? (
                <input type="checkbox" className="tree-check" checked={isSel(e)}
                  onChange={() => onToggleEntry(e)} title="只选中这一条条目" />
              ) : <span className="tree-check-slot" aria-hidden="true" />}
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
          )) : <div className="tree-empty hint">这个条目模板还没有条目</div>}
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
          <div className="flabel"><span>条目模板 id</span><span className="fkey">小写字母开头，仅 a-z 0-9 _ -</span></div>
          <div className="fctrl"><input value={form.id} onChange={(e) => onChange({ id: e.target.value })} placeholder="例如 projects" /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>标题</span></div>
          <div className="fctrl"><input value={form.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="例如 项目档案" /></div>
        </div>
        <div className="field">
          <div className="flabel"><span>从预置起步</span></div>
          <div className="fctrl">
            <select value={form.preset} onChange={(e) => onChange({ preset: e.target.value })}>
              <option value="">（空条目模板，自定义字段）</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.label}（{t.fields} 字段）</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="field wide">
        <div className="flabel"><span>描述</span></div>
        <div className="fctrl"><input value={form.description} onChange={(e) => onChange({ description: e.target.value })} /></div>
      </div>
      <div className="rowgap">
        <button className="btn" onClick={onSubmit}>创建</button>
        <span className="hint">新建后排在末尾，回到列表拖动把手即可调顺序。同 id 已存在会直接报冲突，不会静默覆盖。</span>
      </div>
    </div>
  );
}

