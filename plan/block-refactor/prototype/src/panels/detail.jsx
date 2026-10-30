/* 详细页 —— 属性区 + 块正文
 *
 * 属性区 = 字段字典（栏目定义）→ 这一条的值；块正文 = entry.body（递归块）。
 * 块正文用 dnd-kit 排序：拖动手柄改块顺序（真实实现走 `entry block move`，
 * 原型改内存数据，语义一致）。
 *
 * R13：容器块**真渲染**了（§十三 13.2）
 *   · `section` = 内嵌另一个栏目的数据库视图
 *     （与数据库面板共用 sectionTable.jsx → 同一份数据源，不是另画一张表）
 *   · `column`  = 列组：widths 与 children 平行，**拖列边框改 widths = 改布局**
 *     判别：widths 为空 → 叶子列（内容挂它下面）；非空 → 列组
 * 递归：容器块的 children 也是块，渲染与排序都递归下去。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApp } from '../appctx.jsx';
import { FieldValue, MiniTable, Panel, Secret, Tag } from '../ui.jsx';
import SectionTable from './sectionTable.jsx';
import FilePicker from '../components/filePicker.jsx';
import {
  appendBlock, convertBlock, findBlock, keepsText, moveBlock, moveBy,
  removeBlock as removeBlockFrom, replaceBlock, updateBlock,
} from '../blocks.js';
import { BLOCK_TYPES } from '../data.js';
import { syncBlocks } from '../api/protoApi.js';

export default function DetailPanel({ config }) {
  const { sections, masked, blocksOf, setBlocksOf, openPanel, setActiveEntryId, focusRequest } = useApp();
  const [menuFor, setMenuFor] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const entryId = config?.entryId;
  const blocks = blocksOf(entryId);
  const setBlocks = (next) => setBlocksOf(entryId, next);
  const syncedRef = useRef('');

  // R14：把「当前块内容」同步到服务端 —— 服务端是这批数据的 owner，
  // AI 的 baseHash 与冲突检测都拿服务端自己的副本算（设计 §十四 14.3）。
  // 真实实现里服务端直接读 store，路径不同、语义相同。
  useEffect(() => {
    const payload = JSON.stringify(blocks);
    if (payload === syncedRef.current) return;
    syncedRef.current = payload;
    syncBlocks(entryId, blocks, { title: config?.title || entryId }).catch(() => {});
  }, [entryId, blocks, config?.title]);

  // 当前打开的详情条目 = 块级 AI 的作用对象
  useEffect(() => {
    setActiveEntryId(entryId);
  }, [entryId, setActiveEntryId]);

  // R15：全局搜索命中某个块时 → 定位到它（滚动 + 灰底闪一下）
  // 提示走**应用级状态**（focusRequest，带 nonce），不进面板 config：
  //   · config 是面板身份的一部分，同一个条目不该因为带了定位提示就开出第二个面板
  //   · nonce 保证「同一个块再定位一次」也会重新触发（否则高亮已经褪了就不会再来一遍）
  const [focusId, setFocusId] = useState(null);
  const req = focusRequest;
  useEffect(() => {
    if (!req || req.entryId !== entryId || !req.blockId) return undefined;
    setFocusId(req.blockId);
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-block-id="${req.blockId}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    const t2 = setTimeout(() => setFocusId(null), 1800);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [req, entryId]);

  const found = useMemo(() => {
    for (const sec of Object.values(sections)) {
      const e = (sec.entries || []).find((x) => x.id === entryId);
      if (e) return { sec, entry: e };
    }
    return null;
  }, [sections, entryId]);

  if (!found) {
    return <Panel><div className="muted" style={{ padding: 12 }}>（条目不存在或已被删除）</div></Panel>;
  }

  const { sec, entry } = found;
  const groups = sec.groups.length ? sec.groups : [{ id: 'other', title: '字段' }];

  const addBlock = (parentId) =>
    setBlocks((b) => appendBlock(b, parentId, { id: `b${Date.now()}`, type: 'paragraph', text: '' }));

  const delBlock = (id) => setBlocks((b) => removeBlockFrom(b, id));

  const ctx = {
    depth: 0,
    entryId,
    masked,
    sections,
    openPanel: (entry) => openPanel('detail', { entryId: entry.id }, entry.title),
    setBlocks,
    menuFor,
    setMenuFor,
    onDelete: delBlock,
    onConvert: (blockId, type) => setBlocks((b) => {
      const cur = findBlock(b, blockId);
      return cur ? replaceBlock(b, blockId, convertBlock(cur, type)) : b;
    }),
    onMove: (blockId, delta, containerId) => setBlocks((b) => moveBy(b, containerId || null, blockId, delta)),
    focusId,
  };

  return (
    <Panel
      toolbar={
        <>
          <strong>{entry.title}</strong>
          <span className="muted">{sec.title} · 属性 {sec.fields.length} 项 · 正文 {blocks.length} 块</span>
          <span className="grow" />
          <button onClick={() => addBlock(null)}>＋ 加块</button>
        </>
      }
      footer={
        <>
          <span className="muted">属性区（字段字典的值）+ 块正文（块可嵌块）</span>
          <span className="grow" />
          <span className="mono muted">entry block add / move / remove</span>
        </>
      }
    >
      {/* 属性区 */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--soft-2)' }}>
        {groups.map((g) => {
          const fields = sec.fields.filter((f) => (f.group || 'other') === g.id);
          if (!fields.length) return null;
          return (
            <div key={g.id} style={{ marginBottom: 8 }}>
              <div className="muted" style={{ marginBottom: 2 }}>{g.title}</div>
              {fields.map((f) => (
                <div className="prop" key={f.key}>
                  <span className="k">{f.label}</span>
                  <span className="grow">
                    <FieldValue field={f} value={entry.values?.[f.key]} masked={masked} />
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* 块正文 */}
      <div style={{ padding: '10px 12px' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => {
            if (!e.over || e.active.id === e.over.id) return;
            const containerId = e.over.data.current?.containerId || null;
            setBlocks((b) => moveBlock(b, containerId, e.active.id, e.over.id));
          }}
        >
          <BlockList blocks={blocks} containerId={null} ctx={ctx} />
        </DndContext>
        <button style={{ marginTop: 6 }} onClick={() => addBlock(null)}>＋ 在尾部加块</button>
      </div>
    </Panel>
  );
}

/** 一层块列表（顶层，或某个容器的 children） */
function BlockList({ blocks, containerId, ctx }) {
  if (!blocks?.length) {
    return <div className="muted" style={{ padding: '2px 0 6px', fontSize: 11 }}>（空容器）</div>;
  }
  return (
    <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
      {blocks.map((b) => (
        <Block key={b.id} block={b} containerId={containerId} ctx={ctx} />
      ))}
    </SortableContext>
  );
}

/** 单个块：拖动手柄 + 内容 + 块菜单 */
function Block({ block, containerId, ctx }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    data: { containerId: containerId || '' },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: 'relative',
  };

  const menuOpen = ctx.menuFor === block.id;

  return (
    <div ref={setNodeRef} style={style} data-block-id={block.id}>
      <div
        style={{
          display: 'flex', gap: 6, alignItems: 'flex-start',
          background: ctx.focusId === block.id ? 'var(--soft)' : undefined,
          borderRadius: 4,
        }}
      >
        <span
          {...attributes}
          {...listeners}
          title="拖动改顺序"
          className="muted"
          style={{ cursor: 'grab', fontSize: 11, lineHeight: '20px', flexShrink: 0 }}
        >
          ⠿
        </span>
        <div className="grow blk">
          <BlockBody block={block} ctx={ctx} containerId={containerId} onSlash={() => ctx.setMenuFor(block.id)} />
        </div>
        <button
          style={{ height: 20, padding: '0 6px', flexShrink: 0 }}
          onClick={() => ctx.setMenuFor(menuOpen ? null : block.id)}
          title="块操作"
        >
          ⋯
        </button>
      </div>

      {menuOpen ? (
        <div className="drawer" style={{ position: 'static', display: 'inline-block', marginTop: 4, minWidth: 190 }}>
          <div className="hd">转成</div>
          {BLOCK_TYPES.map((t) => (
            <div
              key={t.type}
              className="it"
              style={t.type === block.type ? { background: 'var(--soft)' } : undefined}
              onClick={() => { ctx.onConvert(block.id, t.type); ctx.setMenuFor(null); }}
            >
              {t.label}
              {t.type === block.type ? <span className="muted" style={{ marginLeft: 'auto', fontSize: 10 }}>当前</span> : null}
              {!keepsText(t.type) ? <span className="muted" style={{ marginLeft: 'auto', fontSize: 10 }}>文本会丢</span> : null}
            </div>
          ))}
          <div className="sep" />
          <div className="it" onClick={() => { ctx.onMove(block.id, -1, containerId); ctx.setMenuFor(null); }}>上移</div>
          <div className="it" onClick={() => { ctx.onMove(block.id, 1, containerId); ctx.setMenuFor(null); }}>下移</div>
          <div className="sep" />
          <div className="it bad" onClick={() => { ctx.onDelete(block.id); ctx.setMenuFor(null); }}>删除块</div>
        </div>
      ) : null}
    </div>
  );
}

/** 附件块：**指派发生在块里**（附件中心只做库存展示，§十三 13.8）
 *  · 从附件库选… → 可搜索的选择面板（不是下拉框），未引用优先，点一行即追加
 *  · 上传文件 → 先进库再挂到本块（真实实现走 `file add`）
 *  · 逐行移除（×）
 *  块的值 = **附件 id 的列表**，不是文件名/路径。 */
function FileBlock({ block, ctx }) {
  const { library, assignFile, detachFile, uploadFiles } = useApp();
  const [picker, setPicker] = useState(false);
  const uploadRef = useRef(null);
  const items = (block.files || []).map((id) => ({ id, file: library?.find((f) => f.id === id) }));

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {items.map(({ id, file }) => (
          <span key={id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <Tag>{file ? `${file.name} · ${file.size}` : `未知附件 ${id}`}</Tag>
            <button
              title="从这个块移除（附件本身还在库里）"
              style={{ height: 18, padding: '0 5px' }}
              onClick={() => detachFile(ctx.entryId, block.id, id)}
            >
              ×
            </button>
          </span>
        ))}
        {!items.length ? <span className="muted">（还没有附件，从库里选或直接上传）</span> : null}
      </div>
      <div className="rowgap" style={{ marginTop: 4 }}>
        <button onClick={() => setPicker(true)}>从附件库选…</button>
        <button onClick={() => uploadRef.current?.click()}>上传文件</button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { uploadFiles(ctx.entryId, block.id, [...e.target.files]); e.target.value = ''; }}
        />
      </div>
      {picker ? (
        <FilePicker
          blockFiles={block.files}
          onClose={() => setPicker(false)}
          onPick={(f) => assignFile(ctx.entryId, block.id, f.id)}
        />
      ) : null}
    </div>
  );
}

/** markdown 块：轻量渲染（标题 / 列表 / 待办 / 行内代码）
 *  真实现用 react-markdown（主应用已有依赖）；原型只求形状对。 */
function MdBlock({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <div style={{ whiteSpace: 'pre-wrap' }}>
      {lines.map((line, i) => {
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) {
          return (
            <div key={i} style={{ fontWeight: 700, fontSize: h[1].length === 1 ? 14 : 13, marginTop: 4 }}>
              {h[2]}
            </div>
          );
        }
        const li = /^[-*]\s+(.*)$/.exec(line);
        if (li) {
          const todo = /^\[( |x)\]\s*(.*)$/.exec(li[1]);
          return (
            <div key={i} style={{ paddingLeft: 12 }}>
              {todo ? (
                <>
                  <span className="muted">{todo[1] === 'x' ? '[x]' : '[ ]'}</span> {todo[2]}
                </>
              ) : `· ${li[1]}`}
            </div>
          );
        }
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}

function BlockBody({ block, ctx, onSlash }) {
  const { masked } = ctx;

  switch (block.type) {
    case 'heading':
      return <div style={{ fontWeight: 700, fontSize: block.level === 2 ? 14 : 13, marginTop: 4 }}>{block.text}</div>;

    case 'table':
      return <MiniTable columns={block.columns} rows={block.rows} masked={masked} />;

    case 'file':
      return <FileBlock block={block} ctx={ctx} />;

    case 'md':
      return <MdBlock text={block.text} />;

    case 'entrylist':
      return <MiniTable columns={block.fields || []} rows={block.value || []} masked={masked} />;

    case 'secret':
      return (
        <div className="rowgap">
          <span className="muted">{block.label}</span>
          <Secret value={block.value} masked={masked} />
        </div>
      );

    // —— 容器块 R13 ——
    case 'section':
      return <SectionBlock block={block} ctx={ctx} />;

    case 'column':
      return (block.widths || []).length
        ? <ColumnGroup block={block} ctx={ctx} />
        : <ColumnLeaf block={block} ctx={ctx} />;

    default:
      return <EditableText block={block} ctx={ctx} onSlash={onSlash} />;
  }
}

/** 块内文字就地编辑（R14：为了能真的制造「块已被改过」的冲突）
 *  真实实现走 `entry update --set body[块id].text=…`；原型改内存数据，语义一致。 */
function EditableText({ block, ctx, onSlash }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.text || '');

  const commit = () => {
    setEditing(false);
    if (draft === (block.text || '')) return;
    ctx.setBlocks((b) => updateBlock(b, block.id, { text: draft }));
  };

  if (!editing) {
    const empty = !(block.text || '').length;
    return (
      <span
        onDoubleClick={() => { setDraft(block.text || ''); setEditing(true); }}
        title="双击编辑；空块里打 / 选类型"
        style={{ whiteSpace: 'pre-wrap', color: empty ? 'var(--mid)' : undefined }}
      >
        {empty ? '空段落 · 双击编辑，输入 / 选类型' : block.text}
      </span>
    );
  }
  return (
    <input
      type="text"
      autoFocus
      value={draft}
      placeholder="输入 / 选块类型，或直接写文字"
      style={{ width: '100%' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
        // 斜杠菜单：在**空的**块里打 '/' → 直接开块类型菜单（Notion 的习惯）
        if (e.key === '/' && draft === '') {
          e.preventDefault();
          setEditing(false);
          if (onSlash) onSlash();
        }
      }}
    />
  );
}

/** 内嵌另一个栏目的数据库视图（与数据库面板共用同一段渲染） */
function SectionBlock({ block, ctx }) {
  const sec = ctx.sections[block.sectionId];
  return (
    <div style={{ border: '1px solid var(--soft-2)', borderRadius: 6, padding: 6, margin: '4px 0' }}>
      <div className="rowgap" style={{ marginBottom: 4 }}>
        <Tag>内嵌栏目</Tag>
        <strong>{sec?.title || block.sectionId}</strong>
        <span className="muted">{sec?.entries?.length || 0} 条</span>
      </div>
      {sec ? (
        <SectionTable
          section={sec}
          masked={ctx.masked}
          dense
          onOpenEntry={(e) => ctx.openPanel(e)}
        />
      ) : (
        <div className="muted">（栏目 {block.sectionId} 不存在）</div>
      )}
    </div>
  );
}

/** 列组：子列并排，列宽由 widths 决定，拖列边框改 widths */
function ColumnGroup({ block, ctx }) {
  const groupRef = useRef(null);
  const widths = block.widths || [];
  const leaves = block.children || [];

  const setWidths = (next) => ctx.setBlocks((b) => updateBlock(b, block.id, { widths: next }));

  const onDividerDown = (i) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const host = groupRef.current;
    const total = host ? host.getBoundingClientRect().width : 0;
    if (!total) return;
    const startX = e.clientX;
    const base = [...widths];
    const move = (ev) => {
      const dPct = ((ev.clientX - startX) / total) * 100;
      const left = Math.max(12, Math.min(88, base[i - 1] - dPct));
      const right = 100 - left;
      setWidths(base.map((w, k) => (k === i - 1 ? left : k === i ? right : w)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={groupRef} style={{ display: 'flex', alignItems: 'stretch', margin: '4px 0' }}>
      {leaves.map((leaf, i) => (
        <Fragment key={leaf.id}>
          {i > 0 ? (
            <div
              onMouseDown={onDividerDown(i)}
              title="拖动改列宽"
              style={{ width: 5, cursor: 'col-resize', flexShrink: 0, background: 'var(--soft-2)' }}
            />
          ) : null}
          <div style={{ width: `${widths[i] ?? 100 / leaves.length}%`, minWidth: 0, padding: '0 5px' }}>
            <BlockList blocks={leaf.children || []} containerId={leaf.id} ctx={{ ...ctx, depth: (ctx.depth || 0) + 1 }} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** 叶子列：内容竖排（它的 children 属于它自己这个容器） */
function ColumnLeaf({ block, ctx }) {
  return <BlockList blocks={block.children || []} containerId={block.id} ctx={ctx} />;
}
