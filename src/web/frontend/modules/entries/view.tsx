import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../../api/client.ts';
import { checkZipFile, isNeedPassphraseError, postZip } from '../../api/zip.ts';
import { useStore, REFRESH_EVENT } from '../../store.tsx';
import type { BoardGroup } from '../../components/blockBoard.tsx';
import { reconcileLayout, sameLayout } from '../../../../shared/blockLayout.ts';
import type { BlockLayout } from '../../../../shared/blockLayout.ts';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import { copyText, entryRefText } from '../../entryRef.ts';
import type { ViewProps } from '../../registry.ts';
import EntryListColumn from './EntryListColumn.tsx';
import EntryDetailColumn from './EntryDetailColumn.tsx';
import TemplateToolbar from './TemplateToolbar.tsx';
import ImportModals from './ImportModals.tsx';
import AddFieldModal from './AddFieldModal.tsx';
import SaveAsTemplateModal from './SaveAsTemplateModal.tsx';
import type { SaveAsTemplateForm } from './SaveAsTemplateModal.tsx';
import TagEditorModal from './TagEditorModal.tsx';
import { TEMPLATE_ID_RE } from './SaveAsTemplateModal.tsx';
import FieldModals from './FieldModals.tsx';
import { norm, syncEntryHash } from './viewTypes.ts';
import type { ApplyTemplateResult, AskState, Conflict, Draft, ImportPreview, ModalState, TemplateDump, ZipState } from './viewTypes.ts';

/**
 * 条目模板详情视图：模板建议的分组表单（求职那种需要中文标签/候选值/未填清单的场景）。
 * 密钥也走这里——它只是普通模板 + 一个 keys 结构清单字段，不再是特例。
 *
 * 字段与分组全部来自后端，所以新增字段不需要改前端。
 */
export default function TemplateView({ templateId: rawId, listHidden = false, sidebarCollapsed = false, onCreateEntry }: ViewProps) {
  const templateId = rawId || '';
  const { ui, patchUi, toast, guard, dialog, reload, boot } = useStore();
  const [data, setData] = useState<TemplateDump | null>(null);
  // 条目列表里 shortcut 字段只报数量（#5 原文：字段显示只需要分组数量）。
  const shortcutDefs = data ? data.fields.filter((f) => f.type === 'shortcut') : [];
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  // #19 验收反馈：「字段=值 快填」旁路撤除——条目内加字段只留「＋ 添加字段」正门。
  // （CLI/agent 的 --set 未知键自动登记通路不受影响，退役的只是这块 UI。）
  const [af, setAf] = useState<{ key: string; label: string; type: string; group: string; value: string } | null>(null);
  const [afBusy, setAfBusy] = useState(false);
  // 任务 #48：把当前条目结构另存为条目模板（只抄结构、不抄值）
  const [saveTpl, setSaveTpl] = useState<SaveAsTemplateForm | null>(null);
  const [saveTplBusy, setSaveTplBusy] = useState(false);
  // 标签编辑：条目 tags 与模板默认 tags 共用一张表单，直接 PATCH，不重拉 dump。
  const [tagEdit, setTagEdit] = useState<{ scope: 'entry' | 'template'; tags: string[] } | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  // 任务 #24：块头「⋯」菜单的两个弹窗——查看（只读详情）/ 编辑（改本条的显示名与描述）
  const [fieldView, setFieldView] = useState<{ def: FieldDef } | null>(null);
  const [fieldEdit, setFieldEdit] = useState<{ def: FieldDef } | null>(null);
  // 任务 #27：字段变化历史（单字段）+ 条目变化时间线（全字段）
  const [fieldHistory, setFieldHistory] = useState<{ def: FieldDef } | null>(null);
  const [entryHistoryOpen, setEntryHistoryOpen] = useState(false);
  // 条目模板 ZIP：zip = { fileName, buffer, preview }（buffer 用于确认时再 POST 一次，服务端不存状态）
  const [zip, setZip] = useState<ZipState | null>(null);
  // 加密包先问口令：ask = { fileName, buffer }
  const [ask, setAsk] = useState<AskState | null>(null);
  const [askPw, setAskPw] = useState('');
  const [conflict, setConflict] = useState<Conflict>('skip');
  const [importing, setImporting] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const mask = !!ui.mask;

  // —— 左右栏拖宽：条目列表 ↔ 内容 ——
  // 宽度持久化在 ui.listW（patchUi 对新键照存）。拖动过程只改**本地** state，
  // 松手才落盘——否则每次 mousemove 都会经 context 重渲染整个表单树。
  const colsRef = useRef<HTMLDivElement>(null);
  const listWRef = useRef(Number(ui.listW) || 300);
  const [listW, setListW] = useState(listWRef.current);
  const [draggingCol, setDraggingCol] = useState(false);
  const startColDrag = (e: ReactMouseEvent) => { e.preventDefault(); setDraggingCol(true); };
  useEffect(() => {
    if (!draggingCol) return undefined;
    const move = (ev: MouseEvent) => {
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

  // ui.entry 可能在挂载之后才变（侧栏「＋」新建条目后立刻选中它，而 templateId 没变、
  // 本组件不重挂）。load 的 deps 刻意不含 ui.entry（否则每次选条目都重拉 dump），
  // 所以用 ref 取最新值——否则 load 闭包里读到的还是挂载时的旧 ui.entry，
  // 重拉后会「兜底选中 entries[0]」，把刚建好的条目踢走。
  const entryRef = useRef(ui.entry);
  entryRef.current = ui.entry;

  const load = useCallback(async (keepId?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<TemplateDump>(`/api/templates/${encodeURIComponent(templateId)}/dump${mask ? '?mask=1' : ''}`);
      // 0.43：条目是唯一内容节点，条目模板 dump 里不一定有它（folder / 无条目模板条目）。
      // 目标条目不在 dump 里时，按 id 单读一条，把它自己的字段结构带进来。
      const wanted0 = keepId || entryRef.current;
      if (wanted0 && !d.entries.some((e) => e.id === wanted0)) {
        const one = await api<TemplateDump['entries'][number] & {
          fields?: FieldDef[];
          groups?: Array<{ id: string; title: string }>;
        }>(`/api/entries/${encodeURIComponent(wanted0)}${mask ? '?mask=1' : ''}`);
        d.entries = [one];
        if (one.fields?.length) d.fields = one.fields;
        if (one.groups?.length) d.groups = one.groups;
      }
      setData(d);
      const wanted = keepId || entryRef.current;
      const hit = d.entries.find((e) => e.id === wanted) || d.entries[0] || null;
      setDraft(hit ? { id: hit.id, title: hit.title, desc: hit.desc || '', values: { ...hit.values } } : null);
      if (hit && hit.id !== entryRef.current) patchUi({ entry: hit.id });
    } catch (e) {
      setErr((e as Error).message);
      setData(null);
      setDraft(null);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, mask]);

  useEffect(() => { load(); }, [load]);
  // 任务 #30：顶栏「刷新数据」是唯一刷新入口——它只重拉 bootstrap，
  // 本条目的 dump 由这里订阅同一个事件重拉，两个旧按钮合并成一个。
  useEffect(() => {
    const onRefresh = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, [load]);
  // 侧栏条目树点击：外部（App 侧栏）把 ui.entry 换成**同条目模板**的另一条时，跟随切换选中。
  // 数据不用重拉（dump 里本来就有全部条目）；目标条目不在本条目模板时不动（load 的兜底逻辑管它）。
  const entryWanted = ui.entry;
  useEffect(() => {
    if (!entryWanted || !data) return;
    if (draft?.id === entryWanted) return;
    const hit = data.entries.find((e) => e.id === entryWanted);
    if (hit) setDraft({ id: hit.id, title: hit.title, desc: hit.desc || '', values: { ...hit.values } });
  }, [entryWanted, data, draft?.id]);
  // #18：侧栏点了「字段」结果 → 进本条目后把对应块滚进视口并短暂高亮。
  // ui.focus 由 App 的 onOpenEntry 写入；消费一次立刻清空（切条目/重进不该再闪）。
  const focusKey = String(ui.focus || '');
  useEffect(() => {
    if (!focusKey || !draft) return undefined;
    const timer = setTimeout(() => {
      const attr = focusKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const el = document.querySelector(`[data-block="${attr}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('blk-focus');
        setTimeout(() => el.classList.remove('blk-focus'), 1600);
      }
      patchUi({ focus: '' });
    }, 160);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, draft?.id]);
  const current = useMemo(() => data?.entries.find((e) => e.id === draft?.id) || null, [data, draft]);
  // 「已标不填」只对**真的空着**的可选字段有意义：填了值的可选字段不属于跳过，
  // 否则一份填满的资料会被显示成「另有 N 项已标不填」，自相矛盾。
  const skippedExcluded = useMemo(
    () => (current?.excluded || []).filter((m) => norm(current?.values?.[m.key]) === ''),
    [current],
  );

  const groups = useMemo<BoardGroup[]>(() => {
    if (!data) return [];
    // v3：块渲染跟随**条目自身的字段行**（含条目内添加的扩展字段）；
    // 没有行数据（旧数据/兜底）才回退条目模板字典。
    const rawDefs = current?.entryFields?.length ? current.entryFields : data.fields;
    // 0.43 无条目模板 / folder 条目没有组字段：给一个「内容」根组，别把字段全过滤掉。
    const defs = data.groups.length
      ? rawDefs
      : rawDefs.map((f) => ({ ...f, group: 'root' }));
    const groupsView = data.groups.length ? data.groups : (defs.length ? [{ id: 'root', title: '内容' }] : []);
    return groupsView
      .map((g) => ({ ...g, fields: defs.filter((f) => (f as { group?: string }).group === g.id) }))
      .filter((g) => g.fields.length);
  }, [data, current]);

  // —— 正文版式（块布局）——
  // 版式是**显示关系**，存在 template.layout 里（与字段字典分开），所以有两条保存链：
  // 拖块 / 改宽高 / 换面板顺序只写版式（防抖自动存），填字段仍然走「N 处改动 → 保存」。
  // 这样拖一下版式不会把没填完的值一起提交，反过来改字段也不会打乱版式。
  const [board, setBoard] = useState<BlockLayout | null>(null);
  const boardTouched = useRef(false);
  const boardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { boardTouched.current = false; setBoard(null); }, [templateId]);
  // 服务端读回来的版式已经按当前字段对齐过；只有当用户还没动过版式时才跟着刷新
  // （否则「保存字段」触发的重读会把刚拖好的版式弹回去）
  useEffect(() => { if (!boardTouched.current && data?.layout) setBoard(data.layout); }, [data]);
  useEffect(() => () => { if (boardTimer.current) clearTimeout(boardTimer.current); }, []);
  const boardView = useMemo(() => reconcileLayout(board || data?.layout, groups), [board, data, groups]);
  const applyBoard = (next: BlockLayout) => {
    if (sameLayout(next, boardView)) return;
    boardTouched.current = true;
    setBoard(next);
    if (boardTimer.current) clearTimeout(boardTimer.current);
    boardTimer.current = setTimeout(guard(async () => {
      boardTimer.current = null;
      await api(`/api/templates/${encodeURIComponent(templateId)}`, { method: 'PATCH', body: { layout: next } });
      toast('版式已保存');
    }), 700);
  };

  const patchField = (key: string, value: unknown) => setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));

  // 脏值判定的字段集合 = **本条目的结构行**（含条目内自建的扩展字段），
  // 不是条目模板字典。任务 #25 的真根因：只遍历 data.fields 时，扩展字段的改动
  // 永远不进 dirty → 保存按钮不出现、值也存不下去（debug 引用因此看着「不更新」）。
  const dirty = useMemo(() => {
    if (!draft || !current) return { set: {} as Record<string, unknown>, titleChanged: false, descChanged: false, count: 0 };
    const set: Record<string, unknown> = {};
    const defs = current.entryFields?.length ? current.entryFields : (data?.fields || []);
    for (const f of defs) {
      if (norm(current.values[f.key]) !== norm(draft.values[f.key])) set[f.key] = draft.values[f.key];
    }
    const titleChanged = draft.title !== current.title;
    // desc 是条目自身属性（不是字段），所以单独算一处改动。
    const descChanged = draft.desc !== (current.desc || '');
    return { set, titleChanged, descChanged, count: Object.keys(set).length + (titleChanged ? 1 : 0) + (descChanged ? 1 : 0) };
  }, [draft, current, data]);

  const save = guard(async () => {
    if (!draft || !current) return;
    if (!dirty.count) { toast('没有改动'); return; }
    const body: { set: Record<string, unknown>; title?: string; desc?: string } = { set: dirty.set };
    if (dirty.titleChanged) body.title = draft.title;
    if (dirty.descChanged) body.desc = draft.desc;
    await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
    toast(`已保存 ${dirty.count} 处改动`);
    await load(draft.id);
    await reload();
  });

  // 标签是独立元数据，不进字段 dirty；直接 PATCH 后只改本地 data.tags，
  // 不重拉 dump——否则会把用户尚未保存的字段草稿一起冲掉。
  const saveTags = guard(async (tags: string[]) => {
    if (!tagEdit) return;
    setTagBusy(true);
    try {
      if (tagEdit.scope === 'entry') {
        if (!current) return;
        await api(`/api/entries/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: { tags } });
        setData((d) => (d ? { ...d, entries: d.entries.map((e) => (e.id === current.id ? { ...e, tags } : e)) } : d));
        toast('条目标签已保存');
      } else {
        await api(`/api/templates/${encodeURIComponent(templateId)}`, { method: 'PATCH', body: { tags } });
        setData((d) => (d ? { ...d, template: { ...d.template, tags } } : d));
        toast('模板默认标签已保存，只影响以后从该模板新建的条目');
      }
      setTagEdit(null);
      await reload();
    } finally {
      setTagBusy(false);
    }
  });

  const openSaveAsTemplate = () => {
    const entry = current || draft;
    if (!entry) return;
    if (dirty.count) {
      toast('先保存当前改动，再存为条目模板（未保存的字段不会进模板）', 'bad');
      return;
    }
    const raw = `tpl_${entry.id.replace(/^e_/, '')}`;
    const base = raw.slice(0, 55);
    let id = base;
    let suffix = 2;
    while (boot?.templates.some((t) => t.id === id)) id = `${base}_${suffix++}`.slice(0, 64);
    setSaveTpl({
      entryId: entry.id,
      id,
      title: entry.title || '未命名模板',
      description: `从条目「${entry.title || entry.id}」保存的条目模板`,
    });
  };

  const saveAsTemplate = guard(async () => {
    if (!saveTpl || saveTplBusy) return;
    const id = saveTpl.id.trim();
    if (!TEMPLATE_ID_RE.test(id)) {
      toast('条目模板 id 必须是小写字母开头，仅含 a-z 0-9 _ -', 'bad');
      return;
    }
    setSaveTplBusy(true);
    try {
      const r = await api<{ template: { id: string; title: string } }>(
        `/api/entries/${encodeURIComponent(saveTpl.entryId)}/save-as-template`,
        { method: 'POST', body: { id, title: saveTpl.title.trim() || id, description: saveTpl.description.trim() } },
      );
      toast(`已保存为条目模板：${r.template.title}（${r.template.id}）`);
      setSaveTpl(null);
      await reload();
    } finally {
      setSaveTplBusy(false);
    }
  });

  // 任务 #26：偏好「编辑后自动保存」。复用上面同一条保存链（PATCH + 重读），
  // 停手 800ms 触发；偏好关闭时这段完全不参与，行为与之前的手动保存一致。
  // save 每渲染都是新函数，用 ref 取最新一版，避免把它写进依赖导致计时器被无谓重置。
  const autoSave = boot?.settings?.autoSaveFields === true;
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveRef = useRef(save);
  useEffect(() => { autoSaveRef.current = save; });
  useEffect(() => {
    if (!autoSave || !dirty.count) return undefined;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      void autoSaveRef.current();
    }, 800);
    return () => {
      if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    };
  }, [autoSave, dirty.count, dirty.set, dirty.titleChanged, dirty.descChanged]);
  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);

  /**
   * 字段级回写：grill 的「确认并回写」走这里。
   *
   * 不能只 `onChange` 然后调 `save()`：同一个事件里 state 还没提交，save 会读到旧草稿，
   * 新答案刚好漏掉。这里把 override 合并进整份 dirty set 再 PATCH，既保住别的未保存字段，
   * 又保证这次答案真的落库；成功后重新 load，面板拿到的就是服务端回读值。
   */
  const commitField = guard(async (key: string, value: unknown) => {
    if (!draft || !current) return false;
    const nextValues = { ...draft.values, [key]: value };
    const defs = current.entryFields?.length ? current.entryFields : (data?.fields || []);
    const set: Record<string, unknown> = {};
    for (const f of defs) {
      if (norm(current.values[f.key]) !== norm(nextValues[f.key])) set[f.key] = nextValues[f.key];
    }
    const titleChanged = draft.title !== current.title;
    const descChanged = draft.desc !== (current.desc || '');
    const count = Object.keys(set).length + (titleChanged ? 1 : 0) + (descChanged ? 1 : 0);
    if (!count) { toast('没有改动'); return true; }
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    const body: { set: Record<string, unknown>; title?: string; desc?: string } = { set };
    if (titleChanged) body.title = draft.title;
    if (descChanged) body.desc = draft.desc;
    await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
    toast(`已回写 ${count} 处改动`);
    await load(draft.id);
    await reload();
    return true;
  });

  // 改到一半关标签页 = 改动全丢。浏览器只允许弹一句「确定要离开吗」，
  // 拦不住也改不了文案，但至少别让未保存的改动无声消失。
  useEffect(() => {
    if (!dirty.count) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty.count]);

  // v3：条目内添加扩展字段（显式类型/分组）——POST 到 entry.add-field 路由。
  const submitAddField = guard(async () => {
    if (!af || !draft) return;
    const key = af.key.trim();
    if (!key) { toast('填一下字段 key（英文字母开头）', 'bad'); return; }
    setAfBusy(true);
    try {
      await api(`/api/entries/${encodeURIComponent(draft.id)}/fields`, {
        method: 'POST',
        body: {
          key,
          label: af.label.trim() || undefined,
          type: af.type || 'text',
          group: af.group || undefined,
          value: af.value === '' ? undefined : af.value,
        },
      });
      toast(`已添加扩展字段 ${af.label.trim() || key}`);
      setAf(null);
      await load(draft.id);
      await reload();
    } finally {
      setAfBusy(false);
    }
  });

  // 任务 #20：条目级字段移除。条目模板字段=脱离（值保留、可恢复，字典与他条不受影响）；
  // 扩展字段=硬删（值一并删，不可恢复）——两种语义两种确认文案，danger 只给不可恢复那条。
  const removeField = guard(async (key: string, def: FieldDef) => {
    if (!draft) return;
    const isExtension = def.template === false;
    const label = def.label || key;
    const ok = await dialog({
      message: isExtension
        ? `删除扩展字段「${label}」？值会一并删除，不可恢复`
        : `从本条目移除「${label}」？（不影响条目模板定义与其他条目）`,
      danger: isExtension,
      confirmText: isExtension ? '删除字段' : '移除',
    });
    if (!ok) return;
    await api(`/api/entries/${encodeURIComponent(draft.id)}/fields/${encodeURIComponent(key)}`, { method: 'DELETE' });
    toast(isExtension ? `已删除扩展字段「${label}」` : `已从本条目移除「${label}」`);
    await load(draft.id);
    await reload();
  });

  // 任务 #24：块头「⋯」三件事。查看/编辑只是开弹窗（不发请求）；删除沿用 removeField 的确认与语义。
  // 任务 #27：多了「变化历史」——同样只开弹窗，恢复动作在弹窗里走 REST。
  const fieldActions = {
    view: (_key: string, def: FieldDef) => setFieldView({ def }),
    history: (_key: string, def: FieldDef) => setFieldHistory({ def }),
    edit: (_key: string, def: FieldDef) => setFieldEdit({ def }),
    remove: (key: string, def: FieldDef) => { void removeField(key, def); },
  };

  const restoreField = guard(async (key: string, label: string) => {
    if (!draft) return;
    await api(`/api/entries/${encodeURIComponent(draft.id)}/fields/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      body: { restore: true },
    });
    toast(`已恢复「${label}」到本条目`);
    await load(draft.id);
    await reload();
  });

  // 任务 #49：条目页的「新建条目」不再自己问名字，统一交给 App 的创建弹窗。
  // 当前条目模板只作为弹窗里的默认选项，用户仍可改选其他模板或空白条目。
  const addEntry = () => onCreateEntry?.(templateId);

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
    patchUi({ entry: '' });
    syncEntryHash(templateId, '');
    await load('');
    await reload();
  });

  // 面包屑点击复制：把条目定位（id + CLI 命令）贴进剪贴板，
  // 粘给任意 agent 即可精确定位这条条目去做修改；条目模板不参与定位。
  const copyEntryRef = guard(async (entry: { id: string; title: string } | null) => {
    if (!entry || !data) return;
    const text = entryRefText(entry);
    // copyText 内部：优先剪贴板 API，被拒时退回 textarea+execCommand——两条 toast
    // 文案都只带条目标题，避免把「模板›条目」重新写回成层级关系。
    const direct = await copyText(text);
    toast(direct
      ? `已复制条目定位：${entry.title}（贴给 agent 即可）`
      : `已复制条目定位：${entry.title}`);
  });

  // 加密包先问口令（与全局面板同一套交互）：别把「缺口令」报成「包坏了」
  const openZip = async (fileName: string, buffer: ArrayBuffer, passphrase: string): Promise<boolean> => {
    setImporting(true);
    try {
      const qs = new URLSearchParams({ 'dry-run': '1' });
      if (passphrase) qs.set('passphrase', passphrase);
      const preview = await postZip<ImportPreview>(
        `/api/templates/${encodeURIComponent(templateId)}/import.zip?${qs}`, buffer, fileName,
      );
      setZip({ fileName, buffer, preview, passphrase: passphrase || '' });
      setConflict('skip');
      return true;
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
      return false;
    } finally {
      setImporting(false);
    }
  };

  const handleZip = guard(async (file: File) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      toast(`读不到文件：${(e as Error).message}`, 'bad');
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
      toast((e as Error).message || String(e), 'bad');
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
      const r = await postZip<ApplyTemplateResult>(
        `/api/templates/${encodeURIComponent(templateId)}/import.zip?${qs}`,
        zip.buffer, zip.fileName,
      );
      setZip(null);
      toast(`导入完成：新增 ${r.entries.added}，另存 ${r.entries.copied}，覆盖 ${r.entries.overwritten}，跳过 ${r.entries.skipped}`);
      await load();
      await reload();
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    } finally {
      setImporting(false);
    }
  });

  // 拖拽用深度计数：dragenter/dragleave 在子元素间穿梭会成对触发，
  // 只按布尔值会在「还没离开就熄掉」和「离开后不熄」之间抖。
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

  if (err) {
    return (
      <div className="pad stack">
        <div className="bad"><strong>条目模板读不到</strong></div>
        <pre className="block">{err}</pre>
        <div className="hint">如果这个条目模板刚被删掉，切到「条目模板」tab 看看现有条目模板。</div>
      </div>
    );
  }
  if (!data) return <div className="pad muted">{busy ? '加载中…' : '暂无数据'}</div>;

  // 模板所有形状统一走普通条目列表 + 字段表单（密钥也是普通字段）。

  return (
    <div
      className="template-wrap"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TemplateToolbar
        template={data.template}
        count={data.count}
        mask={mask}
        onToggleMask={() => patchUi({ mask: !mask })}
        onEditTags={() => setTagEdit({ scope: 'template', tags: data.template.tags })}
        onAddEntry={addEntry}
        showAdd={sidebarCollapsed}
      />

      <div className="cols" ref={colsRef}>
        {/* #14：侧栏树里已经有这个条目模板的条目时，列表列与它的拖拽线一起隐藏——
            条目导航交给侧栏树，正文只留编辑器。收起侧栏（或侧栏还没加载出条目）
            列表照旧出现：它是收起态下唯一的条目导航。 */}
        {listHidden ? null : (
          <EntryListColumn
            listW={listW}
            entries={data.entries}
            count={data.count}
            shortcutDefs={shortcutDefs}
            draftId={draft?.id}
            dragging={draggingCol}
            onPick={(e) => {
              patchUi({ entry: e.id });
              syncEntryHash(templateId, e.id);
              setDraft({ id: e.id, title: e.title, desc: e.desc || '', values: { ...e.values } });
            }}
            onCopyRef={copyEntryRef}
            onStartDrag={startColDrag}
            onResetDrag={resetColDrag}
            onAdd={addEntry}
          />
        )}

        <EntryDetailColumn
          data={data}
          draft={draft}
          current={current}
          dirtyCount={dirty.count}
          skippedExcluded={skippedExcluded}
          templateId={templateId}
          groups={groups}
          boardView={boardView}
          fieldActions={fieldActions}
          onSave={save}
          onCopyRef={copyEntryRef}
          onSaveAsTemplate={openSaveAsTemplate}
          onDraftTitle={(title) => setDraft((d) => (d ? { ...d, title } : d))}
          onDraftDesc={(desc) => setDraft((d) => (d ? { ...d, desc } : d))}
          onEditTags={() => setTagEdit({ scope: 'entry', tags: current?.tags || [] })}
          onAddField={() => setAf({ key: '', label: '', type: 'text', group: groups[0]?.id || '', value: '' })}
          onRestoreField={restoreField}
          onBoard={applyBoard}
          onPatchField={patchField}
          onCommitField={commitField}
          onDiscard={() => { if (draft) load(draft.id); }}
          onRemoveEntry={removeEntry}
          onOpenHistory={() => setEntryHistoryOpen(true)}
        />
      </div>

      {dragDepth > 0 ? (
        <div className="drop-mask"><div>松开导入条目模板 ZIP</div></div>
      ) : null}

      <ImportModals
        ask={ask}
        askPw={askPw}
        importing={importing}
        onAskPw={setAskPw}
        onAskClose={() => { if (!importing) { setAsk(null); setAskPw(''); } }}
        onAskCancel={() => setAsk(null)}
        onSubmitAsk={submitAsk}
        zip={zip}
        conflict={conflict}
        onConflict={setConflict}
        onZipClose={() => { if (!importing) setZip(null); }}
        onZipCancel={() => setZip(null)}
        onApplyZip={applyZip}
        modal={modal}
        onModalClose={() => setModal(null)}
      />

      <FieldModals
        fieldView={fieldView}
        fieldEdit={fieldEdit}
        fieldHistory={fieldHistory}
        entryHistoryOpen={entryHistoryOpen}
        draft={draft}
        current={current}
        templateTitle={data.template.title}
        onCloseView={() => setFieldView(null)}
        onCloseEdit={() => setFieldEdit(null)}
        onCloseHistory={() => setFieldHistory(null)}
        onCloseEntryHistory={() => setEntryHistoryOpen(false)}
        onSaved={async () => { if (draft) { await load(draft.id); await reload(); } }}
      />

      <AddFieldModal
        af={af}
        afBusy={afBusy}
        templateTitle={data.template.title}
        groups={groups}
        fieldTypes={boot?.fieldTypes}
        fieldTypeLabels={boot?.fieldTypeLabels}
        onChange={setAf}
        onClose={() => { if (!afBusy) setAf(null); }}
        onCancel={() => setAf(null)}
        onSubmit={submitAddField}
      />

      <SaveAsTemplateModal
        form={saveTpl}
        busy={saveTplBusy}
        onChange={setSaveTpl}
        onClose={() => { if (!saveTplBusy) setSaveTpl(null); }}
        onSubmit={saveAsTemplate}
      />

      <TagEditorModal
        open={!!tagEdit}
        title={tagEdit?.scope === 'template' ? '编辑模板默认标签' : '编辑条目标签'}
        hint={tagEdit?.scope === 'template'
          ? '模板默认标签只影响以后从该模板新建的条目；已建条目的标签不会自动改。'
          : '标签是条目元数据，保存后立即生效，不会影响未保存的字段草稿。'}
        initialTags={tagEdit?.tags || []}
        busy={tagBusy}
        onClose={() => { if (!tagBusy) setTagEdit(null); }}
        onSubmit={saveTags}
      />
    </div>
  );
}

