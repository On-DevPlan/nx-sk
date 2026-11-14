import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../../api/client.ts';
import { checkZipFile, isNeedPassphraseError, postZip } from '../../api/zip.ts';
import { useStore, REFRESH_EVENT } from '../../store.tsx';
import { CliHints } from '../../components/ui.tsx';
import type { BoardGroup } from '../../components/blockBoard.tsx';
import { reconcileLayout, sameLayout } from '../../../../shared/blockLayout.ts';
import type { BlockLayout } from '../../../../shared/blockLayout.ts';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import { copyText, entryRefText } from '../../entryRef.ts';
import type { ViewProps } from '../../registry.ts';
import KvTable from './kvTable.tsx';
import EntryListColumn from './EntryListColumn.tsx';
import EntryDetailColumn from './EntryDetailColumn.tsx';
import SectionToolbar from './SectionToolbar.tsx';
import ImportModals from './ImportModals.tsx';
import AddFieldModal from './AddFieldModal.tsx';
import FieldModals from './FieldModals.tsx';
import { norm, syncEntryHash } from './viewTypes.ts';
import type { ApplySectionResult, AskState, Conflict, Draft, ImportPreview, ModalState, SectionDump, ZipState } from './viewTypes.ts';

/**
 * 栏目详情视图。按栏目的形状分两种布局：
 *
 * - `kv: true`（密钥那种）→ 交给 [[kvTable]]，**一行一个键值对**。没有条目列表、
 *   没有字段表单、没有完整性——密钥就是一张表。
 * - 其余栏目 → 模板建议的分组表单（求职那种需要中文标签/候选值/未填清单的场景）。
 *
 * 字段与分组全部来自后端，所以新增字段不需要改前端。
 */
export default function SectionView({ sectionId: rawId, listHidden = false, sidebarCollapsed = false }: ViewProps) {
  const sectionId = rawId || '';
  const { ui, patchUi, toast, guard, dialog, reload, boot } = useStore();
  const [data, setData] = useState<SectionDump | null>(null);
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
  // 任务 #24：块头「⋯」菜单的两个弹窗——查看（只读详情）/ 编辑（改本条的显示名与描述）
  const [fieldView, setFieldView] = useState<{ def: FieldDef } | null>(null);
  const [fieldEdit, setFieldEdit] = useState<{ def: FieldDef } | null>(null);
  // 任务 #27：字段变化历史（单字段）+ 条目变化时间线（全字段）
  const [fieldHistory, setFieldHistory] = useState<{ def: FieldDef } | null>(null);
  const [entryHistoryOpen, setEntryHistoryOpen] = useState(false);
  // 栏目 ZIP：zip = { fileName, buffer, preview }（buffer 用于确认时再 POST 一次，服务端不存状态）
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

  // ui.entry 可能在挂载之后才变（侧栏「＋」新建条目后立刻选中它，而 sectionId 没变、
  // 本组件不重挂）。load 的 deps 刻意不含 ui.entry（否则每次选条目都重拉 dump），
  // 所以用 ref 取最新值——否则 load 闭包里读到的还是挂载时的旧 ui.entry，
  // 重拉后会「兜底选中 entries[0]」，把刚建好的条目踢走。
  const entryRef = useRef(ui.entry);
  entryRef.current = ui.entry;

  const load = useCallback(async (keepId?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<SectionDump>(`/api/sections/${encodeURIComponent(sectionId)}/dump${mask ? '?mask=1' : ''}`);
      setData(d);
      const wanted = keepId || entryRef.current;
      const hit = d.entries.find((e) => e.id === wanted) || d.entries[0] || null;
      setDraft(hit ? { id: hit.id, title: hit.title, values: { ...hit.values } } : null);
      if (hit && hit.id !== entryRef.current) patchUi({ entry: hit.id });
    } catch (e) {
      setErr((e as Error).message);
      setData(null);
      setDraft(null);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, mask]);

  useEffect(() => { load(); }, [load]);
  // 任务 #30：顶栏「刷新数据」是唯一刷新入口——它只重拉 bootstrap，
  // 本条目的 dump 由这里订阅同一个事件重拉，两个旧按钮合并成一个。
  useEffect(() => {
    const onRefresh = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, [load]);
  // 侧栏条目树点击：外部（App 侧栏）把 ui.entry 换成**同栏目**的另一条时，跟随切换选中。
  // 数据不用重拉（dump 里本来就有全部条目）；目标条目不在本栏目时不动（load 的兜底逻辑管它）。
  const entryWanted = ui.entry;
  useEffect(() => {
    if (!entryWanted || !data) return;
    if (draft?.id === entryWanted) return;
    const hit = data.entries.find((e) => e.id === entryWanted);
    if (hit) setDraft({ id: hit.id, title: hit.title, values: { ...hit.values } });
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
    // 没有行数据（旧数据/兜底）才回退栏目字典。
    const defs = current?.entryFields?.length ? current.entryFields : data.fields;
    return data.groups.map((g) => ({ ...g, fields: defs.filter((f) => f.group === g.id) })).filter((g) => g.fields.length);
  }, [data, current]);

  // —— 正文版式（块布局）——
  // 版式是**显示关系**，存在 section.layout 里（与字段字典分开），所以有两条保存链：
  // 拖块 / 改宽高 / 换面板顺序只写版式（防抖自动存），填字段仍然走「N 处改动 → 保存」。
  // 这样拖一下版式不会把没填完的值一起提交，反过来改字段也不会打乱版式。
  const [board, setBoard] = useState<BlockLayout | null>(null);
  const boardTouched = useRef(false);
  const boardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { boardTouched.current = false; setBoard(null); }, [sectionId]);
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
      await api(`/api/sections/${encodeURIComponent(sectionId)}`, { method: 'PATCH', body: { layout: next } });
      toast('版式已保存');
    }), 700);
  };

  const patchField = (key: string, value: unknown) => setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));

  // 脏值判定的字段集合 = **本条目的结构行**（含条目内自建的扩展字段），
  // 不是栏目字典。任务 #25 的真根因：只遍历 data.fields 时，扩展字段的改动
  // 永远不进 dirty → 保存按钮不出现、值也存不下去（debug 引用因此看着「不更新」）。
  const dirty = useMemo(() => {
    if (!draft || !current) return { set: {} as Record<string, unknown>, titleChanged: false, count: 0 };
    const set: Record<string, unknown> = {};
    const defs = current.entryFields?.length ? current.entryFields : (data?.fields || []);
    for (const f of defs) {
      if (norm(current.values[f.key]) !== norm(draft.values[f.key])) set[f.key] = draft.values[f.key];
    }
    return { set, titleChanged: draft.title !== current.title, count: Object.keys(set).length + (draft.title !== current.title ? 1 : 0) };
  }, [draft, current, data]);

  const save = guard(async () => {
    if (!draft || !current) return;
    if (!dirty.count) { toast('没有改动'); return; }
    const body: { set: Record<string, unknown>; title?: string } = { set: dirty.set };
    if (dirty.titleChanged) body.title = draft.title;
    await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
    toast(`已保存 ${dirty.count} 处改动`);
    await load(draft.id);
    await reload();
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
  }, [autoSave, dirty.count, dirty.set, dirty.titleChanged]);
  useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current); }, []);

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

  // 任务 #20：条目级字段移除。模板字段=脱离（值保留、可恢复，字典与他条不受影响）；
  // 扩展字段=硬删（值一并删，不可恢复）——两种语义两种确认文案，danger 只给不可恢复那条。
  const removeField = guard(async (key: string, def: FieldDef) => {
    if (!draft) return;
    const isExtension = def.template === false;
    const label = def.label || key;
    const ok = await dialog({
      message: isExtension
        ? `删除扩展字段「${label}」？值会一并删除，不可恢复`
        : `从本条目移除「${label}」？（不影响栏目模板与其他条目）`,
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

  const addEntry = guard(async () => {
    const label = data?.section.titleLabel || '名称';
    const answer = await dialog({ message: `新建「${data?.section.title}」条目，${label}是？`, input: { placeholder: `例如 ${data?.section.titleField || '名称'}` } });
    if (!answer) return;
    const name = String(answer);
    const body: { section: string; title: string; set?: Record<string, string> } = { section: sectionId, title: name };
    if (data?.section.titleField) body.set = { [data.section.titleField]: name };
    const created = await api<{ id: string; title: string }>('/api/entries', { method: 'POST', body });
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

  // 面包屑点击复制：把「栏目›条目」定位（含 id 与 CLI 命令）贴进剪贴板，
  // 粘给任意 agent 即可精确定位这条条目去做修改
  const copyEntryRef = guard(async (entry: { id: string; title: string } | null) => {
    if (!entry || !data) return;
    const text = entryRefText(data.section, entry);
    // copyText 内部：优先剪贴板 API，被拒时退回 textarea+execCommand——两条 toast
    // 文案与抽出前逐字一致（API 直路带「贴给 agent 即可」，退回路径不带）。
    const direct = await copyText(text);
    toast(direct
      ? `已复制条目定位：${data.section.title} › ${entry.title}（贴给 agent 即可）`
      : `已复制条目定位：${data.section.title} › ${entry.title}`);
  });

  // 加密包先问口令（与全局面板同一套交互）：别把「缺口令」报成「包坏了」
  const openZip = async (fileName: string, buffer: ArrayBuffer, passphrase: string): Promise<boolean> => {
    setImporting(true);
    try {
      const qs = new URLSearchParams({ 'dry-run': '1' });
      if (passphrase) qs.set('passphrase', passphrase);
      const preview = await postZip<ImportPreview>(
        `/api/sections/${encodeURIComponent(sectionId)}/import.zip?${qs}`, buffer, fileName,
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
      const r = await postZip<ApplySectionResult>(
        `/api/sections/${encodeURIComponent(sectionId)}/import.zip?${qs}`,
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
      <SectionToolbar
        section={data.section}
        count={data.count}
        mask={mask}
        onToggleMask={() => patchUi({ mask: !mask })}
        onAddEntry={addEntry}
        showAdd={sidebarCollapsed}
      />

      <div className="cols" ref={colsRef}>
        {/* #14：侧栏树里已经有这个栏目的条目时，列表列与它的拖拽线一起隐藏——
            条目导航交给侧栏树，正文只留编辑器。收起侧栏（或侧栏还没加载出条目）
            列表照旧出现：它是收起态下唯一的条目导航。 */}
        {listHidden ? null : (
          <EntryListColumn
            listW={listW}
            sectionId={data.section.id}
            entries={data.entries}
            count={data.count}
            shortcutDefs={shortcutDefs}
            draftId={draft?.id}
            dragging={draggingCol}
            onPick={(e) => {
              patchUi({ entry: e.id });
              syncEntryHash(sectionId, e.id);
              setDraft({ id: e.id, title: e.title, values: { ...e.values } });
            }}
            onCopyRef={copyEntryRef}
            onStartDrag={startColDrag}
            onResetDrag={resetColDrag}
          />
        )}

        <EntryDetailColumn
          data={data}
          draft={draft}
          current={current}
          dirtyCount={dirty.count}
          skippedExcluded={skippedExcluded}
          sectionId={sectionId}
          groups={groups}
          boardView={boardView}
          fieldActions={fieldActions}
          onSave={save}
          onCopyRef={copyEntryRef}
          onDraftTitle={(title) => setDraft((d) => (d ? { ...d, title } : d))}
          onAddField={() => setAf({ key: '', label: '', type: 'text', group: groups[0]?.id || '', value: '' })}
          onRestoreField={restoreField}
          onBoard={applyBoard}
          onPatchField={patchField}
          onDiscard={() => { if (draft) load(draft.id); }}
          onRemoveEntry={removeEntry}
          onOpenHistory={() => setEntryHistoryOpen(true)}
        />
      </div>

      <CliHints module="entries" />

      {dragDepth > 0 ? (
        <div className="drop-mask"><div>松开导入栏目 ZIP</div></div>
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
        sectionTitle={data.section.title}
        onCloseView={() => setFieldView(null)}
        onCloseEdit={() => setFieldEdit(null)}
        onCloseHistory={() => setFieldHistory(null)}
        onCloseEntryHistory={() => setEntryHistoryOpen(false)}
        onSaved={async () => { if (draft) { await load(draft.id); await reload(); } }}
      />

      <AddFieldModal
        af={af}
        afBusy={afBusy}
        sectionTitle={data.section.title}
        groups={groups}
        fieldTypes={boot?.fieldTypes}
        fieldTypeLabels={boot?.fieldTypeLabels}
        onChange={setAf}
        onClose={() => { if (!afBusy) setAf(null); }}
        onCancel={() => setAf(null)}
        onSubmit={submitAddField}
      />
    </div>
  );
}
