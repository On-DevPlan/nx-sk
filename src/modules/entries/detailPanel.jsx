/* 条目详情面板 —— 工作区里**独立**的一块（可拖到任意分栏 / 弹出浮窗 / 单独关掉）
 *
 * 详情从视图里搬出来过两次：S2 是「列表视图的右栏」，S3 后是「表格视图的右栏」，
 * 现在是独立面板——视图只管投影（表格 / 精简 / 看板），详情是面板级的：
 * 点一行开一块，拖到右边、拖成浮窗都行，不用被表格挤成一条竖缝。
 *
 * 面板显示哪条条目 = **它的 config**（{ section, entry }）：表格点行时由
 * workspace.openEntryPanel 换 config + 选中它；深链第二段同理。
 * 面板自己只管把这一条的数据读出来、编辑、保存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Actions } from 'flexlayout-react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Tag } from '../../web/frontend/components/ui.jsx';
import { FieldGroup } from '../../web/frontend/components/fieldEditor.jsx';
import BlockPanel from './blockPanel.jsx';
import { entryRefText, norm } from '../../web/frontend/entryRef.js';

export default function EntryDetailPanel({ sectionId, entryId, tabId, model }) {
  const { ui, patchUi, toast, guard, dialog, reload } = useStore();
  const mask = !!ui.mask;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [quick, setQuick] = useState('');

  /** 页签名跟着条目走：标题改了页签也要改，否则两个页签同名分不清谁是谁。 */
  const renameSelf = useCallback((title) => {
    if (!title || !tabId || !model) return;
    model.visitNodes((node) => {
      if (node.getType() !== 'tab') return;
      if (node.getId() !== tabId) return;
      if (node.getName() !== title) model.doAction(Actions.renameTab(tabId, title));
    });
  }, [model, tabId]);

  const load = useCallback(async (keepId) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api(`/api/sections/${encodeURIComponent(sectionId)}/dump${mask ? '?mask=1' : ''}`);
      setData(d);
      const wanted = keepId || entryId;
      const hit = d.entries.find((e) => e.id === wanted) || null;
      setDraft(hit ? { id: hit.id, title: hit.title, values: { ...hit.values } } : null);
      if (hit) renameSelf(hit.title || hit.id);
    } catch (e) {
      setErr(e.message);
      setData(null);
      setDraft(null);
    } finally {
      setBusy(false);
    }
  }, [sectionId, entryId, mask, renameSelf]);

  useEffect(() => { load(); }, [load]);

  // 别的面板改了这条数据（看板拖卡改了分组、表格里的操作）→ 这里跟着重拉。
  // 有未保存改动时不打断：改到一半被数据刷新冲掉，比晚点看到新值更糟。
  useEffect(() => {
    if (!ui.rev || !draft?.id) return;
    if (dirtyRef.current > 0) return;
    load(draft.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.rev]);

  // 换条目（表格里点了另一行 / 深链指了另一条）：**有未保存改动时不换**——
  // 静默丢掉编辑比「点了没反应」更糟；把 config 退回去，面板继续显示原来那条。
  const dirtyRef = useRef(0);
  const current = useMemo(() => data?.entries.find((e) => e.id === draft?.id) || null, [data, draft]);
  const dirty = useMemo(() => {
    if (!draft || !current) return { set: {}, titleChanged: false, count: 0 };
    const set = {};
    for (const f of data.fields) {
      if (norm(current.values[f.key]) !== norm(draft.values[f.key])) set[f.key] = draft.values[f.key];
    }
    return { set, titleChanged: draft.title !== current.title, count: Object.keys(set).length + (draft.title !== current.title ? 1 : 0) };
  }, [draft, current, data]);
  dirtyRef.current = dirty.count;

  useEffect(() => {
    if (!data || !entryId) return;
    if (draft?.id === entryId) return;
    if (dirtyRef.current > 0) {
      toast('当前条目还有未保存的改动：先保存或放弃，再切到别的条目', 'bad');
      // 把 config 退回当前这条（外部已经改了 config，不退回去就会出现「面板显示 A、config 写 B」）
      if (model && tabId) model.doAction(Actions.updateNodeAttributes(tabId, { config: { section: sectionId, entry: draft?.id } }));
      return;
    }
    load(entryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, data]);

  const groups = useMemo(() => {
    if (!data) return [];
    return data.groups.map((g) => ({ ...g, fields: data.fields.filter((f) => f.group === g.id) })).filter((g) => g.fields.length);
  }, [data]);

  // 「已标不填」只对**真的空着**的可选字段有意义：填了值的可选字段不属于跳过，
  // 否则一份填满的资料会被显示成「另有 N 项已标不填」，自相矛盾。
  const skippedExcluded = useMemo(
    () => (current?.excluded || []).filter((m) => norm(current.values?.[m.key]) === ''),
    [current],
  );

  const patchField = (key, value) => setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));

  /** 改完数据后叫醒别的面板（表格 / 看板的行）重拉：面板之间不共享状态，只共享「数据变了」。 */
  const bumpRev = () => patchUi({ rev: (Number(ui.rev) || 0) + 1 });

  const save = guard(async () => {
    if (!draft || !current) return;
    if (!dirty.count) { toast('没有改动'); return; }
    const body = { set: dirty.set };
    if (dirty.titleChanged) body.title = draft.title;
    await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
    toast(`已保存 ${dirty.count} 处改动`);
    await load(draft.id);
    bumpRev();
    await reload();
  });

  // 「直接存 kv」的入口：敲一行 字段=值 回车即写入，字典里没有的键会自动登记
  const quickAdd = guard(async () => {
    if (!draft) { toast('先在表格里选一条条目', 'bad'); return; }
    const i = quick.indexOf('=');
    if (i <= 0) { toast('用 字段=值 的格式，例如 微信=zhangsan', 'bad'); return; }
    const k = quick.slice(0, i).trim();
    const v = quick.slice(i + 1);
    const r = await api(`/api/entries/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body: { set: { [k]: v } } });
    setQuick('');
    toast(`已写入 ${k}${r.newFields?.length ? '（新字段已登记）' : ''}`);
    await load(draft.id);
    bumpRev();
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
    bumpRev();
    await reload();
  });

  // 面包屑点击复制：把「栏目›条目」定位（含 id 与 CLI 命令）贴进剪贴板，
  // 粘给任意 agent 即可精确定位这条条目去做修改
  const copyEntryRef = guard(async (entry) => {
    if (!entry || !data) return;
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

  // 改到一半关标签页 = 改动全丢。浏览器只允许弹一句「确定要离开吗」，
  // 拦不住也改不了文案，但至少别让未保存的改动无声消失。
  useEffect(() => {
    if (!dirty.count) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty.count]);

  if (err) {
    return (
      <div className="pad stack">
        <div className="bad"><strong>条目读不到</strong></div>
        <pre className="block">{err}</pre>
      </div>
    );
  }
  if (!data) return <div className="pad muted">{busy ? '加载中…' : '暂无数据'}</div>;
  if (!entryId || !draft) {
    return (
      <div className="pad stack">
        <Empty>这个面板还没选中条目。在表格里点一行，或用深链 `#/栏目/条目`。</Empty>
      </div>
    );
  }

  return (
    <div className="detail-pane">
      <div className="card">
        {/* 顶栏固定在面板顶部：长表单滚到一半也能看见「保存」——
            否则改完一个字段要翻到表单最底点保存，翻页越多越容易漏保存。 */}
        <div className="colhead sticky-head">
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
          {dirty.count ? (
            <>
              <span className="hint nowrap">{dirty.count} 处改动未保存</span>
              <button type="button" className="btn small" onClick={save} title="保存当前条目的改动">保存</button>
            </>
          ) : null}
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
          <FieldGroup key={g.id} title={g.title} fields={g.fields} draft={draft.values} onPatch={patchField} sectionTitle={data.section.title} entryTitle={current?.title || draft.title} />
        ))}

        {/* 正文区（entry.body）：属性区在上、块正文在下，同一条数据同一个编辑面。
            body 是可选键——老条目没有正文，这里就是一句空态 + 一个「加块」。 */}
        <BlockPanel key={draft.id} entryId={draft.id} mask={mask} />

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

      <CliHints module="entries" />
    </div>
  );
}
