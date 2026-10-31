// 条目详细页的**正文区**（`entry.body`，v4）。
//
// 属性区（字段字典的值）在上，正文区在下：同一屏、同一条数据、一个编辑面
// （设计 §十二 12.2「不新增第二个编辑入口」）。
//
// 这里只做三件事，其余都交给下家：
//   1. 读写：`GET/POST/PATCH/DELETE /api/entries/:ref/blocks…` —— 与 CLI 同一组 action；
//   2. 编排：加块 / 转类型 / 上移下移 / 删除 / 递归渲染容器块的 children；
//   3. 去抖：表格、清单、附件这类「改一格发一次」的编辑器，按 blockId 合并 500ms 再落盘
//      （不合并的话，敲一行字会在 store.json 上打十几次原子写）。
//
// 块渲染本身在 `src/web/frontend/blocks/registry.jsx`（type → Editor），
// 校验与归一在 `src/shared/blocks.js`（CLI 与面板共用一份）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { blockEditor, blockLabel, keepsText, LEAF_BLOCK_TYPES } from '../../web/frontend/blocks/registry.jsx';
import { CONTAINER_VIEWS } from '../../web/frontend/blocks/registry.jsx';
import { findContainer, updateBlock } from '../../shared/blocks.js';
import BlockDnd, { SortableBlk } from '../../web/frontend/components/blockDnd.jsx';
import AiBar from '../../web/frontend/components/aiBar.jsx';

/** 去抖窗口：足够把一次连续输入/拖拽合成一次写，又短到刷新后立刻能看到。 */
const FLUSH_MS = 500;

export default function BlockPanel({ entryId, mask }) {
  const { toast, guard, dialog, boot } = useStore();
  const [body, setBody] = useState(null); // null = 还没加载（与「正文为空」区分）
  const [err, setErr] = useState(null);
  const pending = useRef(new Map()); // blockId → 待落盘的 patch
  const timers = useRef(new Map());
  const bodyRef = useRef([]);
  bodyRef.current = body || [];
  const sections = boot?.sections || [];

  const load = useCallback(async () => {
    if (!entryId) return;
    setErr(null);
    try {
      const d = await api(`/api/entries/${encodeURIComponent(entryId)}/blocks${mask ? '?mask=1' : ''}`);
      setBody(d.blocks || []);
    } catch (e) {
      setErr(e.message || String(e));
      setBody([]);
    }
  }, [entryId, mask]);

  useEffect(() => { load(); }, [load]);
  // 切条目时把没落盘的改动丢掉：它们属于上一条，合并到新条目上就是串数据
  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    pending.current.clear();
  }, [entryId]);

  const flush = useCallback(async (blockId) => {
    const patch = pending.current.get(blockId);
    pending.current.delete(blockId);
    if (!patch) return;
    try {
      await api(`/api/entries/${encodeURIComponent(entryId)}/blocks/${encodeURIComponent(blockId)}`, {
        method: 'PATCH', body: { data: patch },
      });
    } catch (e) {
      // 落盘失败 → 回到服务端真值：留着本地那份「看起来改了其实没改」才是骗人
      toast(e.message || String(e), 'bad');
      await load();
    }
  }, [entryId, load, toast]);

  /** 本地先改（输入框是受控的），再合并落盘。 */
  const patchBlock = useCallback((blockId, patch) => {
    setBody((cur) => updateBlock(cur || [], blockId, patch));
    pending.current.set(blockId, { ...(pending.current.get(blockId) || {}), ...patch });
    clearTimeout(timers.current.get(blockId));
    timers.current.set(blockId, setTimeout(() => flush(blockId), FLUSH_MS));
  }, [flush]);

  const addBlock = guard(async (type, afterId) => {
    await api(`/api/entries/${encodeURIComponent(entryId)}/blocks`, {
      method: 'POST', body: { type, ...(afterId ? { after: afterId } : {}) },
    });
    await load();
    toast(`已加一块：${blockLabel(type)}`);
  });

  /**
   * 转类型 = `entry.block.update` 一份新形状的块（**没有 convert action**）。
   * 服务端在 type 变化时做**整块替换**，所以这里只要给出新形状即可；
   * 文本型之间转移保留原文，转成结构型必然丢文本 —— 菜单里已标注。
   */
  const convertBlock = guard(async (block, type) => {
    const data = { type };
    if (keepsText(type)) data.text = block.text || '';
    await api(`/api/entries/${encodeURIComponent(entryId)}/blocks/${encodeURIComponent(block.id)}`, {
      method: 'PATCH', body: { data },
    });
    await load();
    toast(`已转成${blockLabel(type)}${keepsText(type) ? '' : '（文本已丢）'}`);
  });

  const moveBlock = guard(async (block, delta) => {
    const container = findContainer(bodyRef.current, block.id);
    const siblings = container ? (container.children || []) : bodyRef.current;
    const i = siblings.findIndex((b) => b.id === block.id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= siblings.length) return;
    await api(`/api/entries/${encodeURIComponent(entryId)}/blocks/${encodeURIComponent(block.id)}/move`, {
      method: 'POST', body: { to },
    });
    await load();
  });

  // 拖拽排序的落点（只支持顶层块，见 blockDnd.jsx 的说明）
  const moveBlockTo = guard(async (from, to) => {
    const block = bodyRef.current[from];
    if (!block) return;
    await api(`/api/entries/${encodeURIComponent(entryId)}/blocks/${encodeURIComponent(block.id)}/move`, {
      method: 'POST', body: { to },
    });
    await load();
  });

  const removeBlock = guard(async (block) => {
    const ok = await dialog({
      message: `删除这个「${blockLabel(block.type)}」块？块删除属条目内编辑，删除不可撤销——要留底就先在「导出导入」页导一份。`,
      danger: true, confirmText: '删除',
    });
    if (!ok) return;
    await api(`/api/entries/${encodeURIComponent(entryId)}/blocks/${encodeURIComponent(block.id)}`, { method: 'DELETE' });
    await load();
    toast('已删除这个块');
  });

  const closeMenu = (ev) => {
    const d = ev.currentTarget.closest('details');
    if (d) d.open = false;
  };

  const renderBlock = (block, dragHandle) => {
    const Editor = blockEditor(block.type);
    const label = blockLabel(block.type);
    const isColumn = block.type === 'column';
    const isColumnGroup = isColumn && (block.widths || []).length > 0;
    const ContainerView = CONTAINER_VIEWS[block.type];

    return (
      <div className="blk" key={block.id} data-block-id={block.id}>
        <div className="blk-head">
          {dragHandle ? <span {...dragHandle}>⠿</span> : null}
          <span className="blk-type">{label}</span>
          <span className="blk-id mono" title={block.id}>{block.id}</span>
          <span className="grow" />
          {isColumn ? <span className="hint">{isColumnGroup ? `列组 · 宽 ${(block.widths || []).join('/')}` : '叶子列'}</span> : null}
          <details className="more">
            <summary className="btn small ghost" title="块操作（转类型 / 移动 / 删除）">⋯</summary>
            <div className="more-menu">
              <div className="hint" style={{ padding: '4px 10px' }}>转成</div>
              {LEAF_BLOCK_TYPES.map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={(ev) => { closeMenu(ev); if (t !== block.type) convertBlock(block, t); }}
                  disabled={t === block.type}
                  title={t === block.type ? '当前类型' : (keepsText(t) ? '保留原文' : '文本会丢')}
                >
                  {blockLabel(t)}
                  {t === block.type ? <span className="muted">　当前</span> : (keepsText(t) ? null : <span className="bad">　文本会丢</span>)}
                </button>
              ))}
              <div className="hint" style={{ padding: '4px 10px', borderTop: '1px solid var(--soft-2)' }}>位置</div>
              <button type="button" onClick={(ev) => { closeMenu(ev); moveBlock(block, -1); }}>上移</button>
              <button type="button" onClick={(ev) => { closeMenu(ev); moveBlock(block, 1); }}>下移</button>
              <button type="button" className="bad" onClick={(ev) => { closeMenu(ev); removeBlock(block); }}>删除块</button>
            </div>
          </details>
        </div>

        <div className="blk-body">
          {Editor ? <Editor block={block} mask={mask} sections={sections} onChange={(p) => patchBlock(block.id, p)} /> : null}
          {ContainerView ? <ContainerView block={block} sections={sections} /> : null}
          {isColumn ? (
            (block.children || []).length ? (
              <div className="blk-nested">{(block.children || []).map((c) => renderBlock(c))}</div>
            ) : (
              <div className="hint">
                空列。S1 的 `entry block add` 只能「追加到尾部 / 某块之后」，还进不了空容器——
                用 CLI 一次写整棵子树：`nx-sk entry block add &lt;条目&gt; --type column --data @tree.json`
              </div>
            )
          ) : null}
          {!Editor && !ContainerView && !isColumn ? <div className="hint bad">未知块类型：{block.type}（面板还不认识，CLI 照常可读）</div> : null}
        </div>
      </div>
    );
  };

  if (!entryId) return null;

  return (
    <div className="blk-panel">
      <div className="blk-bar">
        <strong>正文</strong>
        <span className="muted">
          {body === null ? '加载中…' : `${body.length} 块`}
        </span>
        <span className="grow" />
        <details className="more">
          <summary className="btn small">＋ 加块</summary>
          <div className="more-menu">
            {LEAF_BLOCK_TYPES.map((t) => (
              <button type="button" key={t} onClick={(ev) => { closeMenu(ev); addBlock(t); }}>{blockLabel(t)}</button>
            ))}
          </div>
        </details>
      </div>

      {/* 待审的 AI 提议（S4）：有才显示，应用后回读正文 */}
      <AiBar entryId={entryId} onApplied={load} />

      {err ? <div className="pad hint bad">正文读不到：{err}</div> : null}
      {body === null && !err ? <div className="pad muted">加载正文…</div> : null}
      {body && !body.length ? (
        <div className="pad hint">还没有正文。点右上「＋ 加块」加一个；命令行等价于 `nx-sk entry block add {entryId} --type paragraph`。</div>
      ) : null}
      {body && body.length ? (
        <BlockDnd ids={body.map((b) => b.id)} onMove={moveBlockTo}>
          <div className="blk-list">
            {body.map((b) => (
              <SortableBlk key={b.id} id={b.id}>
                {(handle) => renderBlock(b, handle)}
              </SortableBlk>
            ))}
          </div>
        </BlockDnd>
      ) : null}
    </div>
  );
}
