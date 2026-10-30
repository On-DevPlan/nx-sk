// 块渲染注册表：`type → { label, keepsText, Editor }`。
//
// 分工（设计 §十二 12.1）：**渲染是前端的事 → web/frontend**；校验与归一在
// `src/shared/blocks.js`（CLI 与面板共用一份）；数据的读写是 `entry.block.*` 这组 action。
// 三个地方各管一件事，加一种块时只改这里的 `Editor` + shared 里的类型表。
//
// Editor 的签名统一为 `({ block, mask, onChange, sections })`：
//   · `onChange(patch)` 把 patch 合并进这个块并**落盘**（面板里按 blockId 去抖），
//     所以编辑器只管「改了什么」，不管「怎么存」——存是 action 的事（一条 action 双端）。
//   · `mask` = 打码态。**含密文的块（table / entrylist / secret）在打码态只读**：
//     把打码值当成新值写回去，等于把 `sk-p******alue` 存成真密钥（README 里记过的事故）。
//     文本块不含密文，打码态照常可编辑。
//
// 容器块（column / section）不在这里做「编辑」：column 的子块由面板递归渲染，
// section 只是内嵌栏目视图（表格渲染随 S3）。它们在本文件里只有展示用的 `View`。
import { useEffect, useRef, useState } from 'react';
import { BLOCK_LABELS, BLOCK_TYPES, keepsText } from '../../../shared/blocks.js';
import { listAttachments } from '../api/files.js';
import { EntryListFieldControl, FileFieldControl } from '../components/fieldEditor.jsx';
import { MdView } from '../components/mdView.jsx';
import { TableFieldControl } from '../components/tableField.jsx';

/** 逐字显示用：块正文里保留换行（模板字符串里的换行是内容，不是排版）。 */
const preWrap = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

/**
 * 文本型块（paragraph / heading / md）的就地编辑：
 * 双击进入 → Enter 提交（Shift+Enter 换行）→ Esc 取消；空块显示占位提示。
 *
 * 为什么不给「编辑」按钮：块是拿来连续写的，每块多一个按钮会让正文变成一列按钮。
 * 双击是 Notion / 备忘录一类的既有习惯，不用教。
 */
function TextBlock({ block, onChange, placeholder, rows = 2, className = '', md = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.text || '');
  const taRef = useRef(null);
  const files = useFileMap(md);

  useEffect(() => {
    if (!editing) return;
    const el = taRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== (block.text || '')) onChange({ text: draft });
  };
  const cancel = () => {
    setEditing(false);
    setDraft(block.text || '');
  };

  if (editing) {
    return (
      <textarea
        ref={taRef}
        className="blk-input"
        rows={rows}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
    );
  }

  const empty = !String(block.text || '').trim();
  if (empty) {
    return (
      <div
        className="blk-empty"
        role="button"
        tabIndex={0}
        title="双击编辑"
        onDoubleClick={() => { setDraft(block.text || ''); setEditing(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(block.text || ''); setEditing(true); } }}
      >
        {placeholder}
      </div>
    );
  }

  if (md) {
    return (
      <div
        className="blk-md"
        title="双击编辑"
        onDoubleClick={() => { setDraft(block.text); setEditing(true); }}
      >
        <MdView text={block.text || ''} byId={files} />
      </div>
    );
  }

  return (
    <div
      className={`blk-text ${className}`}
      style={preWrap}
      title="双击编辑"
      onDoubleClick={() => { setDraft(block.text); setEditing(true); }}
    >
      {block.text}
    </div>
  );
}

/**
 * 附件 id → 记录的 Map。块的 md 正文里贴的图是 `f_xxx`，没这张表就全渲染成
 * 「图片缺失」——图明明在库里，看起来却像坏了。只在 md 块里拉（其余块用不到）。
 */
function useFileMap(enabled) {
  const [byId, setById] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    listAttachments()
      .then((d) => { if (alive) setById(new Map((d?.files || []).map((f) => [f.id, f]))); })
      .catch(() => { if (alive) setById(new Map()); });
    return () => { alive = false; };
  }, [enabled]);
  return byId;
}

/** 打码态下不写回：含密文的块一律只读，并说清楚为什么（不然用户以为面板坏了）。 */
function MaskedNotice({ children }) {
  return (
    <div className="blk-readonly">
      {children}
      <div className="hint bad">打码态下只读：把打码值写回去会把星号存成真值。要看/改原文，先取消顶部的「打码显示」。</div>
    </div>
  );
}

function ParagraphBlock(props) {
  return <TextBlock {...props} placeholder="空段落 · 双击编辑" rows={2} />;
}

function HeadingBlock({ block, onChange }) {
  return (
    <div className="blk-heading">
      <select
        className="blk-level"
        value={block.level || 2}
        title="标题级别"
        onChange={(e) => onChange({ level: Number(e.target.value) })}
      >
        <option value={1}>H1</option>
        <option value={2}>H2</option>
        <option value={3}>H3</option>
      </select>
      <TextBlock block={block} onChange={onChange} placeholder="空标题 · 双击编辑" rows={1} className={`blk-h blk-h${block.level || 2}`} />
    </div>
  );
}

function MdBlock(props) {
  return <TextBlock {...props} placeholder="空图文块 · 双击编辑（支持 markdown、贴图、待办）" rows={4} md />;
}

/**
 * 表格块：**列与行都在块值里**（自描述文档，与 table 字段同一台机器）。
 * 直接复用字段侧的表格编辑器 —— 公式、统计行、列类型都跟着过来，不重写一套。
 * 密文列在打码态只读（`MaskedNotice` 的分支在下面）。
 */
function TableBlock({ block, mask, onChange }) {
  const editor = (
    <TableFieldControl
      def={{ type: 'table', label: BLOCK_LABELS.table }}
      value={{ columns: block.columns || [], rows: block.rows || [], totals: block.totals, summary: block.summary }}
      onChange={(v) => onChange({ columns: v.columns, rows: v.rows, totals: v.totals, summary: v.summary })}
    />
  );
  const hasSensitive = (block.columns || []).some((c) => c.sensitive);
  return mask && hasSensitive ? <MaskedNotice>{editor}</MaskedNotice> : editor;
}

/** 清单块：自带 `fields`（子列定义）——块没有栏目字典可查，不自带就渲染不出表头。 */
function EntryListBlock({ block, mask, onChange }) {
  const editor = (
    <EntryListFieldControl
      def={{ type: 'entrylist', label: BLOCK_LABELS.entrylist, fields: block.fields || [] }}
      value={block.value || []}
      onChange={(rows) => onChange({ value: rows })}
    />
  );
  const hasSensitive = (block.fields || []).some((f) => f.sensitive);
  return mask && hasSensitive ? <MaskedNotice>{editor}</MaskedNotice> : editor;
}

/** 附件块：值 = **附件 id 列表**；上传与选择就发生在这里（附件中心只做库存）。 */
function FileBlock({ block, onChange }) {
  return (
    <FileFieldControl
      def={{ type: 'file', label: BLOCK_LABELS.file }}
      value={block.files || []}
      onChange={(ids) => onChange({ files: ids })}
    />
  );
}

/**
 * 密钥块：值与 secret 字段**同一条加密路径**（AES-256-GCM 落盘）。
 * 留空 = 不改（不提交空值，免得把现有密钥清掉）；写入时才发一次 PATCH。
 */
function SecretBlock({ block, mask, onChange }) {
  const [label, setLabel] = useState(block.label || '密钥');
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(!mask);
  const readable = typeof block.value === 'string';
  const current = readable ? block.value : '';
  const broken = block.value != null && !readable;

  return (
    <div className="blk-secret">
      <div className="rowgap">
        <input
          className="blk-secret-label"
          value={label}
          placeholder="名称（例如 DB_PASSWORD）"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => { if (label !== (block.label || '')) onChange({ label }); }}
        />
        <span className="hint">当前值</span>
        <span className="mono grow nowrap" title={mask ? '打码态不显示原文' : ''}>
          {mask ? '（打码）' : (broken ? '（密文无法解开：本机缺密钥或换过密钥）' : (current || '（空）'))}
        </span>
        <button type="button" className="btn small ghost" onClick={() => setShow((v) => !v)}>
          {show ? '隐藏输入' : '显示输入'}
        </button>
      </div>
      {mask ? (
        <div className="hint bad">打码态下不写入：先取消打码，再填新值——否则星号会被存成新密钥。</div>
      ) : (
        <div className="rowgap">
          <input
            className="grow"
            type={show ? 'text' : 'password'}
            autoComplete="off"
            value={draft}
            placeholder="填新值（留空 = 不改）；写入后立即加密落盘"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn small"
            disabled={!draft}
            onClick={() => { onChange({ value: draft }); setDraft(''); }}
          >
            写入
          </button>
        </div>
      )}
    </div>
  );
}

/** 内嵌栏目：正文里放另一个栏目的数据库视图（表格渲染随 S3，这里先给身份与规模）。 */
function SectionBlockView({ block, sections }) {
  const sec = (sections || []).find((s) => s.id === block.sectionId);
  return (
    <div className="blk-section">
      <span className="tag">内嵌栏目</span>
      <strong>{sec ? sec.title : block.sectionId || '（未指定栏目）'}</strong>
      <span className="muted">{sec ? `${sec.entries} 条` : '栏目不存在'}</span>
      {block.viewId ? <span className="hint">视图 {block.viewId}</span> : null}
      <span className="hint grow">行内表格渲染随 S3（数据库视图）一起接</span>
    </div>
  );
}

const EDITORS = {
  paragraph: ParagraphBlock,
  heading: HeadingBlock,
  md: MdBlock,
  table: TableBlock,
  entrylist: EntryListBlock,
  file: FileBlock,
  secret: SecretBlock,
};

/** 统一取用：未知类型返回 null（调用方渲染「未知块类型」，不静默丢）。 */
export function blockEditor(type) {
  return EDITORS[type] || null;
}

export function blockLabel(type) {
  return BLOCK_LABELS[type] || type;
}

/** 面板上「加块 / 转类型」的可选项：**只列七种叶块**，容器块随 S3（见文件头）。 */
export const LEAF_BLOCK_TYPES = Object.keys(EDITORS);

/** 容器块的展示（column 的子块由面板递归，section 只是身份）。 */
export const CONTAINER_VIEWS = { section: SectionBlockView };

export { BLOCK_TYPES, keepsText };
