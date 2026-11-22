// 条目模板属性编辑器（整页，替代旧弹窗）：基本属性 + 分组/字段字典。
//
// 两块「基础设施」直接复用条目正文那套（见 components/blockBoard.tsx 的手感约定）：
//   - **拖拽逻辑**：useListDrag 同款 HTML5 DnD + 插入线。分组面板整行是把手，
//     拖面板 = 调分组顺序（一次 PATCH 整份 groups）；字段行只有行首把手可拖，
//     拖到某行上半/下半 = 插到它前/后，**拖进别的分组 = 挪过去**（一次 PATCH 整份 fields）。
//   - **块逻辑**：一个分组 = 一块面板，一个字段 = 面板里的一个块；
//     字段的「所属分组」不再用下拉框表达，而是由它所在的面板表达。
//
// 保存模型与旧弹窗一致：一次改动一次 PATCH + 立刻回读（后端逐条校验，出错知道是哪一步）。
// 排序走 `groups` / `fields` 的**整份替换**语义（后端早已支持），不需要新的 API。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { Tag } from '../../components/ui/index.tsx';
import { reorderAt, useListDrag } from '../../components/listDrag/index.tsx';
import type { FieldType, SubFieldDef, TableColumnDef } from '../../../../shared/fields/types.ts';
import type { FieldRow, TemplateFull } from './index.tsx';
import { blurOnEnter, FieldBlock } from './fieldBlock.tsx';

/** 列编辑行（entrylist 的字段列 / table 的表格列，面板侧用字符串维护 options）。 */
interface ColRow {
  key: string;
  label: string;
  type?: string;
  formula?: string;
  options?: string;
  unit?: string;
  sensitive?: boolean;
}

/** 「新增字段」提交的形状（字段字典的写入侧）。 */
interface NewFieldDef {
  key: string;
  label: string;
  type: string;
  group?: string;
  fields?: SubFieldDef[];
  columns?: TableColumnDef[];
}

interface EditFormData {
  title: string;
  description: string;
  order: string;
  titleLabel: string;
  titleField: string;
}

export interface DictEditorProps {
  templateId: string;
  /** 打开时父级已 GET 回来的全量；编辑器内部每次 PATCH 后自行回读。 */
  initial: TemplateFull;
  types: FieldType[];
  labels: Record<string, string>;
  builtin: { group?: string; field?: string };
  onClose: () => void;
  /** 结构/属性变了：父级刷新条目模板树与 boot（计数、侧栏树都要跟上）。 */
  onChanged: () => void;
}

// entrylist 的默认列：最常见的就是「链接 / 账号 / 密码」这组，选中类型即预填，
// 一次点「加入字典」就能用；列可增删改，「密文」列落盘加密。
const ENTRYLIST_DEFAULT_COLS: ColRow[] = [
  { key: 'name', label: '名称' },
  { key: 'url', label: '链接' },
  { key: 'user', label: '账号' },
  { key: 'pass', label: '密码', sensitive: true },
];

// table 的默认列：一列文字 + 一列勾选 + 两列数字 + 一列算出来的金额。
// 预填成「能立刻看出它比 entrylist 多什么」的样子——勾选框、数字列、计算列各来一个。
const TABLE_DEFAULT_COLS: ColRow[] = [
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

const colKind = (c: ColRow) => (c.type === 'formula-num' || c.type === 'formula-text' ? c.type : (c.type || 'text'));

// 清单类字段（entrylist / table）：列是字段自己的结构，所以已有字段**不提供就地换成这两种类型**
// ——换过去等于换一个字段。要建就在「新增字段」里连列一起建。

/** 落点：插到某行前/后（key=该行），或面板空白区（key=null，追加到该组末尾）。 */
interface FieldDrop { group: string; key: string | null; after: boolean }

const formOf = (f: TemplateFull): EditFormData => ({
  title: f.title,
  description: f.description,
  order: String(f.order),
  titleLabel: f.titleLabel,
  titleField: f.titleField || '',
});

export default function DictEditor({ templateId, initial, types, labels, builtin, onClose, onChanged }: DictEditorProps) {
  const { toast, guard, dialog } = useStore();
  const [full, setFull] = useState<TemplateFull>(initial);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<EditFormData>(() => formOf(initial));
  // 稳定引用：doDrop 的 useCallback 依赖它们，每次渲染新建数组会让回调形同虚设
  const fields = useMemo(() => full.fieldList || [], [full]);
  // 分组面板 = 字典里的一条组字段 + 紧跟它的成员（fieldList 已按 keys 顺序排好）。
  // 面板顺序就是顶层组字段在字典里的顺序——**没有第二份分组清单**，所以「拖分组」
  // 走的是和「拖字段」同一条写路径（PATCH fields），不再有 `PATCH groups` 那条旧路。
  const panels = useMemo(() => groupPanelsOf(fields), [fields]);
  // 没有任何组接管的字段（手改 store 的脏数据）：单独一区，拖进分组即可。
  // 组字段自己**不算**孤儿——它就是分组本身，旧算法把它判成孤儿才多出一个假面板。
  const loose = useMemo(() => fields.filter((f) => f.type !== 'group' && !f.group), [fields]);

  // 服务端回读后（改名成功 / 被拒绝）以服务端为准，本地草稿不留在旧值上
  useEffect(() => { setForm(formOf(full)); }, [full]);

  /** 一次改动一次 PATCH + 立刻回读；出错由调用处的 guard 统一 toast。 */
  const applyPatch = useCallback(async (body: Record<string, unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await api(`/api/templates/${encodeURIComponent(templateId)}`, { method: 'PATCH', body });
      const fresh = await api<TemplateFull>(`/api/templates/${encodeURIComponent(templateId)}`);
      setFull(fresh);
      if (okMsg) toast(okMsg);
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [templateId, toast, onChanged]);
  const patch = guard(applyPatch);

  // —— 基本属性 ——
  const basicDirty = form.title !== full.title
    || form.description !== full.description
    || Number(form.order) !== full.order
    || form.titleLabel !== full.titleLabel
    || form.titleField !== (full.titleField || '');
  const saveBasic = guard(async () => {
    await applyPatch({
      title: form.title,
      description: form.description,
      order: Number(form.order) || 50,
      titleLabel: form.titleLabel,
      titleField: form.titleField,
    });
    toast('条目模板已更新');
  });

  const syncFields = guard(async () => {
    const r = await api<{ upToDate?: boolean; changedFields?: string[]; addedGroups?: string[]; addedFields?: string[] }>(`/api/templates/${encodeURIComponent(templateId)}/sync`, { method: 'POST' });
    if (r.upToDate) {
      toast(r.changedFields?.length
        ? `已是最新（无需补字段）；另有 ${r.changedFields.length} 个字段的模板定义改过，本条目模板保留原值`
        : '已是最新，条目模板里没有需要补的字段');
      return;
    }
    const bits = [
      r.addedGroups?.length ? `分组 ${r.addedGroups.join('、')}` : '',
      r.addedFields?.length ? `字段 ${r.addedFields.join('、')}` : '',
    ].filter(Boolean).join('；');
    const drift = r.changedFields?.length ? `；${r.changedFields.length} 个预置字段已改（保留原值）` : '';
    toast(`已按预置补齐：${bits || '无变化'}${drift}`);
    const fresh = await api<TemplateFull>(`/api/templates/${encodeURIComponent(templateId)}`);
    setFull(fresh);
    onChanged();
  });

  // —— 分组顺序：整行是把手；落定一次 PATCH 整份 fields（组字段在字典里的位置就是面板顺序）——
  const groupDrag = useListDrag((from, insertAt) => {
    const next = reorderAt(panels, from, insertAt);
    if (!next || next === panels) return;
    const flat = [...next.flatMap((p) => [p.def, ...p.rows]), ...loose];
    // 只比较 key 签名：原地放回不写库
    if (flat.every((r, i) => r.key === fields[i]?.key)) return;
    void patch({ fields: flat });
  });

  // —— 字段拖拽：跨面板的落点自己记（useListDrag 是单列表的，这里要「拖进别的组」）——
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<FieldDrop | null>(null);
  const endField = useCallback(() => { setDragKey(null); setDrop(null); }, []);
  const startField = useCallback((e: ReactDragEvent<HTMLElement>, key: string) => {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', key); } catch { /* 个别环境不给 setData */ }
    setDragKey(key);
  }, []);
  const rowOver = useCallback((e: ReactDragEvent<HTMLElement>, f: FieldRow) => {
    if (!dragKey || dragKey === f.key) return;
    e.preventDefault();
    e.stopPropagation(); // 别让冒泡把面板空白区的落点盖上来
    const r = e.currentTarget.getBoundingClientRect();
    const after = e.clientY - r.top > r.height / 2;
    // 落点分组 = **被拖到的那一行**所在的分组（孤儿区的行用它自己的 group，挪不出区）
    const g = f.group || 'other';
    const t: FieldDrop = { group: g, key: f.key, after };
    setDrop((prev) => (prev && prev.group === t.group && prev.key === t.key && prev.after === t.after ? prev : t));
  }, [dragKey]);
  const bodyOver = useCallback((e: ReactDragEvent<HTMLElement>, gid: string) => {
    if (!dragKey) return;
    if ((e.target as HTMLElement).closest('.drow')) return; // 行自己处理过了
    e.preventDefault();
    const t: FieldDrop = { group: gid, key: null, after: false };
    setDrop((prev) => (prev && prev.group === t.group && prev.key === null ? prev : t));
  }, [dragKey]);
  const doDrop = useCallback(() => {
    if (!dragKey || !drop) { endField(); return; }
    const moved = fields.find((f) => f.key === dragKey);
    const t = drop;
    endField();
    if (!moved) return;
    const rest = fields.filter((f) => f.key !== moved.key);
    let idx: number;
    if (t.key) {
      const ti = rest.findIndex((f) => f.key === t.key);
      if (ti < 0) return;
      idx = t.after ? ti + 1 : ti;
    } else {
      // 面板空白区：接到该组最后一个字段后面
      let li = -1;
      rest.forEach((f, i) => { if ((f.group || 'other') === t.group) li = i; });
      idx = li + 1;
    }
    const next = [...rest];
    next.splice(idx, 0, { ...moved, group: t.group });
    // 只比较「顺序 + 归属」签名：原地放回不写库
    const sig = (a: FieldRow[]) => a.map((f) => `${f.key}@${f.group || 'other'}`).join('|');
    if (sig(next) === sig(fields)) return;
    void patch({ fields: next });
  }, [dragKey, drop, fields, endField, patch]);
  const rowCls = (f: FieldRow) => `drow${dragKey === f.key ? ' dragging' : ''}${
    dragKey && drop && drop.key === f.key ? (drop.after ? ' drop-after' : ' drop-before') : ''}`;
  const bodyCls = (gid: string) => `dgrp-body${dragKey && drop && drop.key === null && drop.group === gid ? ' drop-into' : ''}`;

  // —— 字段/分组结构操作（与旧弹窗同一套 PATCH 语义）——
  const setField = (key: string, p: Record<string, unknown>) => { void patch({ 'set-field': { key, ...p } }); };
  const setFill = (key: string, policy: string) => { void patch({ fill: { [key]: policy } }); };
  const removeField = guard(async (key: string) => {
    const ok = await dialog({ message: `从字段字典里删掉「${key}」？已填的值会留在条目里（只是不再显示/校验）。`, danger: true, confirmText: '删除字段' });
    if (!ok) return;
    await applyPatch({ 'remove-field': key }, `已删字段 ${key}`);
  });
  const renameGroup = (id: string, title: string, newId?: string) => {
    const body: { id: string; title: string; newId?: string } = { id, title };
    if (newId && newId !== id) body.newId = newId;
    void patch({ 'rename-group': body }, `分组已改名为「${title}」`);
  };
  const removeGroup = (id: string) => { void patch({ 'remove-group': id }, `已删除分组 ${id}`); };

  // —— 新增分组 / 新增字段 ——
  const [ng, setNg] = useState({ id: '', title: '' });
  const addGroup = guard(async () => {
    const id = ng.id.trim();
    if (!id) { toast('填一下分组 id（小写字母开头，如 contact）', 'bad'); return; }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) { toast('分组 id 必须是小写字母开头，仅含 a-z 0-9 _ -', 'bad'); return; }
    await applyPatch({ 'add-group': { id, title: ng.title.trim() || id } }, `已新增分组 ${id}`);
    setNg({ id: '', title: '' });
  });

  const [nf, setNf] = useState<{ key: string; label: string; type: string; group: string; cols?: ColRow[] | null }>({ key: '', label: '', type: 'text', group: '' });
  const defaultCols: ColRow[] = nf.type === 'entrylist' ? ENTRYLIST_DEFAULT_COLS : (nf.type === 'table' ? TABLE_DEFAULT_COLS : []);
  const cols = (nf.type === 'entrylist' || nf.type === 'table') ? (nf.cols || defaultCols) : null;
  const cur = () => cols || [];
  const setCol = (i: number, p: Partial<ColRow>) => setNf((m) => ({ ...m, cols: (m.cols || defaultCols).map((c, idx) => (idx === i ? { ...c, ...p } : c)) }));
  const addCol = () => setNf((m) => ({ ...m, cols: [...(m.cols || defaultCols), { key: '', label: '', type: 'text' }] }));
  const removeCol = (i: number) => setNf((m) => ({ ...m, cols: (m.cols || defaultCols).filter((_, idx) => idx !== i) }));

  const buildDef = (): { def?: NewFieldDef; error?: string } => {
    const def: NewFieldDef = { key: nf.key.trim(), label: nf.label.trim() || nf.key.trim(), type: nf.type };
    if (nf.group) def.group = nf.group;
    if (nf.type === 'entrylist') {
      const sub = cur().map((c) => {
        const out: SubFieldDef = { key: c.key.trim(), label: c.label.trim() || c.key.trim() };
        if (c.sensitive) out.sensitive = true;
        return out;
      }).filter((c) => c.key);
      if (!sub.length) return { error: '结构清单至少要有一列（填列 key）' };
      def.fields = sub;
    }
    if (nf.type === 'table') {
      const columns: TableColumnDef[] = [];
      for (const c of cur()) {
        const key = String(c.key || '').trim();
        if (!key) continue;
        const kind = colKind(c);
        const col: TableColumnDef = { key, label: String(c.label || '').trim() || key };
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
  const addField = guard(async () => {
    const { def, error } = buildDef();
    if (error) { toast(error, 'bad'); return; }
    await applyPatch({ 'add-field': def! }, `已新增字段 ${def!.key}`);
    setNf({ key: '', label: '', type: 'text', group: nf.group, cols: null });
  });

  return (
    <div className="dict">
      <div className="dict-head">
        <button type="button" className="btn small ghost" onClick={onClose}>← 返回条目模板</button>
        <strong>条目模板属性</strong>
        <Tag>{templateId}</Tag>
        <span className="muted">{panels.length} 分组 · {fields.filter((f) => f.type !== 'group').length} 字段</span>
        <span className="grow" />
        {busy ? <span className="muted">保存中…</span> : null}
      </div>

      {/* 基本属性：Notion 式行式（名称+说明在左、控件在右），保存走旧 PATCH 语义 */}
      <div className="dict-card">
        <div className="dict-card-title">基本属性</div>
        <div className="set-row">
          <div className="set-k"><span className="name">标题</span><span className="desc">侧栏与面包屑显示的名字</span></div>
          <div className="set-v"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        </div>
        <div className="set-row">
          <div className="set-k"><span className="name">描述</span><span className="desc">工具条上的那句说明，可空</span></div>
          <div className="set-v"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        </div>
        <div className="set-row">
          <div className="set-k"><span className="name">排序</span><span className="desc">越小越靠前</span></div>
          <div className="set-v"><input type="number" style={{ width: 90 }} value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })} /></div>
        </div>
        <div className="set-row">
          <div className="set-k"><span className="name">条目名字段</span><span className="desc">列表里显示哪个字段</span></div>
          <div className="set-v">
            <select value={form.titleField} onChange={(e) => setForm({ ...form, titleField: e.target.value })}>
              <option value="">（用条目 title）</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}（{f.key}）</option>)}
            </select>
          </div>
        </div>
        <div className="set-row">
          <div className="set-k"><span className="name">名称标签</span><span className="desc">新建条目时问什么</span></div>
          <div className="set-v"><input style={{ width: 180 }} value={form.titleLabel} onChange={(e) => setForm({ ...form, titleLabel: e.target.value })} /></div>
        </div>
        <div className="rowgap" style={{ padding: '8px 12px' }}>
          <button type="button" className="btn" onClick={saveBasic} disabled={!basicDirty}>保存条目模板属性{basicDirty ? '（有改动）' : ''}</button>
          {full.template ? (
            <button type="button" className="btn ghost" onClick={syncFields} title={`按预置「${full.template}」补齐新增的分组与字段（只增不改不删）`}>同步预置字段</button>
          ) : null}
          <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
        </div>
        {full.template ? (
          <div className="hint" style={{ padding: '0 12px 10px' }}>
            本条目模板由预置「{full.template}」创建。预置后来新增的字段<b>不会自动</b>出现在这里，
            点「同步预置字段」补齐（例如求职预置新增的「附件资料」组 / 简历、头像等 file 字段）。
          </div>
        ) : null}
      </div>

      <div className="dbar">
        拖分组标题行调整分组顺序 · 拖字段行首（cursor 变抓手处）换序，拖进别的分组就是挪过去 · 每次改动即时保存
      </div>

      {/* 分组面板：一块 = 一个分组；块里的行 = 字段（组字段后面紧跟它的成员） */}
      {panels.map((p, gi) => {
        const isBuiltin = !!builtin.group && p.id === builtin.group;
        const list = p.rows;
        return (
          <div
            key={p.id}
            className={`dgrp${groupDrag.draggingIndex === gi ? ' dragging' : ''}${groupDrag.dropClass(gi)}`}
            {...groupDrag.itemProps(gi)}
          >
            <header
              className="dgrp-head"
              title="按住这一行拖动：调整分组顺序"
              draggable
              onDragStart={(e: ReactDragEvent<HTMLElement>) => {
                if ((e.target as HTMLElement).closest('input,button,select')) { e.preventDefault(); return; }
                groupDrag.dragStartProps(gi).onDragStart(e);
              }}
              onDragEnd={groupDrag.dragStartProps(gi).onDragEnd}
            >
              <GroupHeadInputs g={p} builtin={isBuiltin} onRename={renameGroup} />
              <span className="panel-count">{list.length} 字段</span>
              {isBuiltin ? <span className="hint">内置分组：每个条目模板自带，删了下回读又会补回来</span> : null}
              <span className="right dgrp-acts">
                <button
                  type="button"
                  className="btn small ghost danger-ghost"
                  disabled={isBuiltin || list.length > 0}
                  onClick={() => removeGroup(p.id)}
                  title={list.length ? `这组里还有 ${list.length} 个字段：先把它们拖到别的分组或删掉` : '删除这个分组（必须是空的）'}
                >
                  删除分组
                </button>
              </span>
            </header>
            <div className={bodyCls(p.id)} onDragOver={(e) => bodyOver(e, p.id)} onDrop={(e) => { e.preventDefault(); doDrop(); }}>
              {list.length ? list.map((f) => (
                <FieldBlock
                  key={f.key}
                  f={f}
                  types={types}
                  labels={labels}
                  locked={!!builtin.field && f.key === builtin.field}
                  cls={rowCls(f)}
                  onRowOver={(e) => rowOver(e, f)}
                  onDropRow={doDrop}
                  onStart={(e) => startField(e, f.key)}
                  onEnd={endField}
                  onSet={(pat) => setField(f.key, pat)}
                  onFill={(pol) => setFill(f.key, pol)}
                  onRemove={() => removeField(f.key)}
                />
              )) : <div className="dgrp-empty hint">这组还没有字段：把字段拖进来，或在下方「新增字段」里选它。</div>}
            </div>
          </div>
        );
      })}
      {!panels.length ? <div className="hint pad">还没有分组：字段会全部堆在内置「原始资料」袋里。先建一个。</div> : null}

      {/* 未归组（手改数据兜底）：只出不进——拖回上面的分组即可 */}
      {loose.length ? (
        <div className="dgrp orphans">
          <header className="dgrp-head">
            <span className="panel-title nowrap">未归组</span>
            <span className="panel-count">{loose.length}</span>
          </header>
          <div className="dgrp-body">
            {loose.map((f) => (
              <FieldBlock
                key={f.key}
                f={f}
                types={types}
                labels={labels}
                locked={false}
                cls={rowCls(f)}
                onRowOver={(e) => rowOver(e, f)}
                onDropRow={doDrop}
                onStart={(e) => startField(e, f.key)}
                onEnd={endField}
                onSet={(pat) => setField(f.key, pat)}
                onFill={(pol) => setFill(f.key, pol)}
                onRemove={() => removeField(f.key)}
              />
            ))}
            <div className="dgrp-empty hint">这些字段不属于任何分组（多半是手改数据留下的）。拖进某个分组即可。</div>
          </div>
        </div>
      ) : null}

      <div className="dict-card">
        <div className="dict-card-title">
          新增分组
          <span className="hint" style={{ fontWeight: 400, marginLeft: 8 }}>建在末尾（内置「原始资料」之前），拖标题行挪到想要的位置</span>
        </div>
        <div className="rowgap" style={{ padding: '8px 12px 12px' }}>
          <input
            style={{ width: 170 }}
            placeholder="分组 id（小写字母开头）"
            value={ng.id}
            onChange={(e) => setNg({ ...ng, id: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
          />
          <input
            style={{ width: 170 }}
            placeholder="分组名（如 联系信息）"
            value={ng.title}
            onChange={(e) => setNg({ ...ng, title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
          />
          <button type="button" className="btn small" onClick={addGroup}>＋ 添加分组</button>
        </div>
      </div>

      <div className="dict-card">
        <div className="dict-card-title">
          新增字段
          <span className="hint" style={{ fontWeight: 400, marginLeft: 8 }}>标签 / 类型 / 分组 / 提示 / 必填策略都能改；key 只读（值按 key 存）</span>
        </div>
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
            {panels.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
          {nf.type === 'entrylist' || nf.type === 'table' ? (
            <div className="stack" style={{ gap: 4, width: '100%' }}>
              <div className="hint">
                {nf.type === 'table'
                  ? '表格列：一列一种类型（勾选 / 下拉 / 数字 / 日期…）。「计算」列写 JS 表达式，可用同行的列 key 或中文列名（如 qty * price），也可用 rows / sum / countTrue 统计整表。'
                  : '清单列（每行一列，变长行共用）。key 英文字母开头；勾「密文」的列以密文落盘、--mask 打码。'}
              </div>
              {(cols || []).map((c, i) => (
                <ColumnRow key={i} col={c} table={nf.type === 'table'} onChange={(p) => setCol(i, p)} onRemove={() => removeCol(i)} />
              ))}
              <div>
                <button type="button" className="btn small ghost" onClick={addCol}>＋ 添加列</button>
              </div>
            </div>
          ) : null}
          <button className="btn small" onClick={addField}>加入字典</button>
          <span className="hint">加完立刻生效：CLI 与面板都能填它。</span>
        </div>
      </div>
    </div>
  );
}

/** 一个分组面板：组字段本身 + 紧跟它的成员（含嵌套组与普通字段，顺序即 keys 顺序）。 */
interface GroupPanel { id: string; title: string; def: FieldRow; rows: FieldRow[] }

/**
 * 字段字典 → 分组面板清单。
 *
 * `fieldList` 的读出口（modules/templates/common.ts 的 fieldListOf（后端））已经把「组字段 +
 * 按 keys 顺序的成员」摊平成一条线，所以这里只需按**顶层组字段**切段：
 * 每一段 = 一个面板；段外的普通字段 = 「未归组」（手改数据才可能出现）。
 * 组字段自己绝不能被当成孤儿——它就是分组本身（旧算法在这一步多造出一个假面板）。
 */
function groupPanelsOf(fields: FieldRow[]): GroupPanel[] {
  const out: GroupPanel[] = [];
  let cur: GroupPanel | null = null;
  for (const f of fields) {
    if (f.type === 'group' && !f.group) {
      cur = { id: f.key, title: f.label || f.key, def: f, rows: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.rows.push(f);
  }
  return out;
}

/** 分组头的两个输入（id / 名字）：本地草稿、失焦才提交——与旧 GroupRow 一致。 */
function GroupHeadInputs({ g, builtin, onRename }: {
  g: { id: string; title: string };
  builtin: boolean;
  onRename: (id: string, title: string, newId?: string) => void;
}) {
  const [id, setId] = useState(g.id);
  const [title, setTitle] = useState(g.title);
  useEffect(() => { setId(g.id); setTitle(g.title); }, [g.id, g.title]);
  const commit = () => {
    const nid = id.trim();
    const ntitle = title.trim();
    if (!nid || !ntitle) { setId(g.id); setTitle(g.title); return; } // 空值不提交：等于没改
    if (nid === g.id && ntitle === g.title) return;
    onRename(g.id, ntitle, nid);
  };
  return (
    <>
      <input
        className="dgrp-id"
        style={{ width: 120 }}
        value={id}
        disabled={builtin}
        onChange={(e) => setId(e.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        title="分组 id（小写字母开头；改 id 时组里字段的引用会跟着改）"
      />
      <input
        className="dgrp-title"
        style={{ width: 160 }}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        title="分组名：条目表单里的小标题"
      />
    </>
  );
}


/**
 * 一列的定义行（entrylist 与 table 共用）。
 *
 * 两个字段类型的列看起来像，但 table 的列多三件事：**类型**、**选项**、**公式**。
 * 合成一个组件而不是各写一份，是为了让「加列」的手感在两种字段上完全一样——
 * 用户不必先记住自己正在编辑哪一种清单。
 */
function ColumnRow({ col, table, onChange, onRemove }: {
  col: ColRow;
  table: boolean;
  onChange: (patch: Partial<ColRow>) => void;
  onRemove: () => void;
}) {
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

