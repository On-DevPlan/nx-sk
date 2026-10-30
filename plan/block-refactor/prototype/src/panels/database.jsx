/* 数据库面板 —— 一个栏目的**四种视图**（S2：视图 = 投影，数据同源）
 *
 * 视图 = 同一批数据的**不同投影**，切视图不换数据源：
 *   表格 → table（全部可投影列）　精简 → table（少几列，**仍是 table**）
 *   看板 → board（按 select 字段分组）　KV → kv（整栏目的键值读法）
 *
 * 视图是**面板身份的一部分**（config.viewId）→ 同一个栏目可以**同时开多个面板**（不同视图）。
 * 切视图 = 改这个面板的 config（FlexLayout 的 config 是属性，改它走 `Actions.updateNodeAttributes`）。
 *
 * 缺省视图由 `src/views.js` **推断**（不落盘）；栏目配了 `section.views` 就用配置的。
 * 投影降级：view 引用的字段被删 → 列仍在，渲染成「已删字段」弱占位。
 */

import { useMemo, useState } from 'react';
import { Actions } from 'flexlayout-react';
import { useApp } from '../appctx.jsx';
import { Chip, Panel } from '../ui.jsx';
import SectionTable from './sectionTable.jsx';
import BoardView from './boardView.jsx';
import KvView from './kvView.jsx';
import { resolveColumns, resolveView, sortRows } from '../views.js';

export default function DatabasePanel({ config, ctx }) {
  const { sections, navigate, masked } = useApp();
  const sec = sections[config?.section] || sections.demo;
  const [q, setQ] = useState('');

  const { view, views } = resolveView(sec, config?.viewId);
  const cols = useMemo(() => resolveColumns(sec, view), [sec, view]);

  // 搜索只影响**投影**，不改数据源（同一批数据的不同切法）
  const rows = useMemo(() => {
    const all = sortRows(sec.entries || [], view);
    if (!q.trim()) return all;
    const k = q.trim().toLowerCase();
    return all.filter((e) => String(e.title).toLowerCase().includes(k));
  }, [sec.entries, view, q]);

  const filtered = useMemo(() => ({ ...sec, entries: rows }), [sec, rows]);

  /** 切视图 = 改本面板的 config（config 是 tab 的属性） */
  const switchView = (viewId) => {
    if (!ctx?.model || !ctx?.tabId || viewId === config?.viewId) return;
    ctx.model.doAction(Actions.updateNodeAttributes(ctx.tabId, {
      config: { ...config, viewId },
    }));
  };

  const openDetail = (entry) => navigate(sec.id, entry.id);

  return (
    <Panel
      toolbar={
        <>
          <strong>{sec.title}</strong>
          <span className="muted">{rows.length} 条</span>
          <span className="grow" />
          {views.map((v) => (
            <Chip
              key={v.id}
              on={v.id === view.id}
              onClick={() => switchView(v.id)}
              title={`视图：${v.title}（${v.type}）`}
            >
              {v.title}
            </Chip>
          ))}
          <input
            id="entry-search"
            name="entry-search"
            type="search"
            placeholder="搜索条目…"
            value={q}
            style={{ width: 140 }}
            onChange={(e) => setQ(e.target.value)}
          />
        </>
      }
      footer={
        <>
          <span className="muted">
            {view.type === 'board'
              ? '拖卡片 = 改字段值（写操作）'
              : view.type === 'kv'
                ? '密文落盘，打码只是展示层'
                : '点行 → 在工作区新开详情面板'}
          </span>
          <span className="grow" />
          <span className="mono muted">
            view={view.id} · {view.type} · 数据源不变
          </span>
        </>
      }
    >
      {view.type === 'board' ? (
        <BoardView section={filtered} view={view} />
      ) : view.type === 'kv' ? (
        <KvView section={filtered} />
      ) : (
        <SectionTable section={filtered} cols={cols} masked={masked} onOpenEntry={openDetail} />
      )}
      {!rows.length ? <div className="muted" style={{ padding: '12px' }}>（无匹配条目）</div> : null}
    </Panel>
  );
}
