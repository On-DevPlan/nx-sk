// 原始资料袋（`type: 'source'`）的面板控件。
//
// 形态：**折叠条 → 右侧抽屉**。
//   - 折叠态只占一行（条目表单底部），标着「原始资料 · N 条」——它是个暂存区，
//     不该在日常填表时占地方；但也不能藏到找不着的地方（「整理」之前得看得见）。
//   - 抽屉里左边是清单（拖进来的一堆东西），右边是选中那条的正文 ——
//     master-detail 是这类「一堆待处理素材」唯一说得清的布局。
//
// 三条可访问性硬要求（来自 WCAG 2.2 AA，不是装饰）：
//   1. **拖拽不能是唯一入口**（Dragging Movements）：必须同时给「选择文件」按钮与
//      「粘贴文字」输入框，且全程键盘可达。
//   2. **焦点看得见**：抽屉里每个可点的东西都有 focus 环（模态内的焦点指示器是 High 级要求）。
//   3. **焦点不被遮住 / 关掉要还回来**：打开时聚焦清单，关掉时焦点回到折叠条。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { fileToDataUrl, listAttachments, mergeFiles } from '../api/files.js';
import { Copyable } from './ui.jsx';
import { MdView } from './mdView.jsx';
import { useStore } from '../store.jsx';

const KIND_LABEL = { text: '文字', file: '附件', url: '网址' };
const KIND_TAG = { text: '', file: 'bad', url: '' };

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一条资料的人读标题（没名字时按内容推断）。 */
function titleOf(item) {
  if (!item) return '';
  if (item.name) return item.name;
  if (item.kind === 'url') return item.url || '网址';
  if (item.kind === 'file') return '附件';
  const first = String(item.text || '').split('\n').find((l) => l.trim()) || '';
  return first.trim().slice(0, 40) || '一段文字';
}

/**
 * 抽屉本体。单独一个组件：它有自己的焦点生命周期（打开聚焦、关闭归还），
 * 混在字段控件里会让两件事互相干扰。
 */
function SourceDrawer({ items, onChange, onClose, title, sectionTitle }) {
  const { toast, guard } = useStore();
  const [selId, setSelId] = useState(items[0]?.id || null);
  const [dragOver, setDragOver] = useState(false);
  const [paste, setPaste] = useState('');
  const [files, setFiles] = useState({});
  const listRef = useRef(null);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);
  const triggerRef = useRef(null);

  const loadFiles = useCallback(async (force = false) => {
    try {
      const d = await listAttachments(force);
      const map = {};
      for (const f of d?.files || []) map[f.id] = f;
      setFiles(map);
    } catch { /* 附件库读不到：仍可粘贴文字 */ }
  }, []);
  useEffect(() => { loadFiles(true); }, [loadFiles]);

  // 打开时聚焦清单第一项：键盘用户一进来就知道自己在哪
  useEffect(() => {
    const first = listRef.current?.querySelector('button');
    first?.focus();
  }, []);

  const selected = useMemo(() => items.find((x) => x.id === selId) || items[0] || null, [items, selId]);
  // 冲突以新的为准、旧的留痕：当前版本与被取代的分开列。
  // 旧的默认收起——它们是证据（要能翻回去看），但不该挤在当前版本前面。
  const current = useMemo(() => items.filter((x) => !x.superseded), [items]);
  const olds = useMemo(() => items.filter((x) => x.superseded), [items]);
  const [showOld, setShowOld] = useState(false);

  const addItems = (next) => {
    onChange(next);
    if (next.length) setSelId(next[next.length - 1].id);
  };

  const upload = guard(async (fileList) => {
    const picked = [...(fileList || [])].filter(Boolean);
    if (!picked.length) return;
    const added = [];
    for (const file of picked) {
      try {
        const content = await fileToDataUrl(file);
        const r = await api('/api/files', { method: 'POST', body: { content, name: file.name } });
        added.push({
          id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          kind: 'file',
          name: r.name || file.name,
          fileId: r.id,
          addedAt: new Date().toISOString(),
        });
      } catch (e) {
        toast(`上传失败：${e.message || e}`, 'bad');
      }
    }
    if (added.length) {
      addItems([...items, ...added]);
      setFiles((prev) => mergeFiles(Object.values(prev).map((f) => ({ ...f })), added.map((a) => ({ id: a.fileId, name: a.name, url: '', isImage: false }))));
      loadFiles(true);
      toast(`已加入 ${added.length} 个文件`);
    }
  });

  const addText = () => {
    const text = paste.trim();
    if (!text) return;
    addItems([...items, {
      id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      kind: 'text',
      name: text.split('\n').find((l) => l.trim())?.trim().slice(0, 40) || '一段文字',
      text,
      addedAt: new Date().toISOString(),
    }]);
    setPaste('');
  };

  const removeSel = () => {
    if (!selected) return;
    const next = items.filter((x) => x.id !== selected.id);
    onChange(next);
    setSelId(next[0]?.id || null);
  };

  // 拖拽：dragenter/dragleave 在子元素间穿梭会成对触发，用深度计数避免高亮乱闪
  const onDrop = guard(async (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const list = [...(e.dataTransfer?.files || [])];
    if (list.length) await upload(list);
  });

  const fileRec = selected?.kind === 'file' ? files[selected.fileId] : null;

  return (
    <div
      className="mask source-mask"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <aside
        className="source-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="原始资料"
        ref={triggerRef}
      >
        <div className="source-drawer-head">
          <strong className="nowrap">原始资料</strong>
          <span className="muted nowrap">{sectionTitle ? `${sectionTitle} · ` : ''}{title || ''}</span>
          <span className="grow" />
          <span className="tag">{items.length} 条</span>
          <button type="button" className="btn small ghost" onClick={onClose}>关闭</button>
        </div>

        <div className="source-drawer-body">
          {/* 左：清单 + 入口 */}
          <div
            className={`source-list-pane${dragOver ? ' drag' : ''}`}
            onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
            onDrop={onDrop}
          >
            <div className="source-list-tools">
              <button type="button" className="btn small" onClick={() => fileRef.current?.click()}>＋ 选择文件</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const list = [...(e.target.files || [])];
                  e.target.value = '';
                  if (list.length) upload(list);
                }}
              />
              <span className="hint">或把文件拖到这一栏</span>
            </div>

            <div className="source-paste">
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addText(); }}
                placeholder="粘贴一段文字（Ctrl+Enter 加入）"
                rows={3}
              />
              <button type="button" className="btn small" onClick={addText} disabled={!paste.trim()}>加入</button>
            </div>

            <div className="source-items" ref={listRef}>
              {current.length ? current.map((it) => (
                <button
                  type="button"
                  key={it.id}
                  className={`source-item${selected?.id === it.id ? ' sel' : ''}`}
                  onClick={() => setSelId(it.id)}
                >
                  <span className={`tag ${KIND_TAG[it.kind] || ''}`}>{KIND_LABEL[it.kind] || it.kind}</span>
                  <span className="source-item-name">{titleOf(it)}</span>
                  {it.at ? <span className="source-item-time">{fmtTime(it.at)}</span> : null}
                </button>
              )) : (
                <div className="hint pad">袋子是空的。粘贴文字，或把文件拖进来。</div>
              )}

              {olds.length ? (
                <>
                  <button type="button" className="source-old-toggle" onClick={() => setShowOld((v) => !v)}>
                    {showOld ? '▾' : '▸'} 已被取代的 {olds.length} 条（留痕）
                  </button>
                  {showOld ? olds.map((it) => (
                    <button
                      type="button"
                      key={it.id}
                      className={`source-item old${selected?.id === it.id ? ' sel' : ''}`}
                      onClick={() => setSelId(it.id)}
                      title={`已被更新的取代${it.supersededBy ? `（${it.supersededBy}）` : ''}`}
                    >
                      <span className={`tag ${KIND_TAG[it.kind] || ''}`}>{KIND_LABEL[it.kind] || it.kind}</span>
                      <span className="source-item-name">{titleOf(it)}</span>
                      <span className="source-item-time">{fmtTime(it.at || it.addedAt)}</span>
                    </button>
                  )) : null}
                </>
              ) : null}
            </div>
          </div>

          {/* 中：选中那条的正文 */}
          <div className="source-view-pane">
            {!selected ? (
              <div className="hint pad">左边选一条看内容。</div>
            ) : (
              <>
                <div className="source-view-head">
                  <span className={`tag ${KIND_TAG[selected.kind] || ''}`}>{KIND_LABEL[selected.kind] || selected.kind}</span>
                  <strong className="grow">{titleOf(selected)}</strong>
                  {selected.superseded ? <span className="tag bad">已被取代</span> : null}
                  {selected.addedAt ? <span className="muted nowrap">{fmtTime(selected.at || selected.addedAt)}</span> : null}
                  {selected.kind === 'text' ? (
                    <Copyable className="tag" text={selected.text || ''} title="点击复制原文">复制</Copyable>
                  ) : null}
                  <button type="button" className="btn small ghost" onClick={removeSel}>移除</button>
                </div>

                <div className="source-view-body">
                  {selected.kind === 'text' ? (
                    <div className="md-preview reading">
                      <MdView text={selected.text || ''} />
                    </div>
                  ) : null}

                  {selected.kind === 'url' ? (
                    <div className="stack">
                      <a href={selected.url} target="_blank" rel="noreferrer" className="mono">{selected.url}</a>
                      <Copyable className="tag" text={selected.url} title="点击复制网址">复制</Copyable>
                    </div>
                  ) : null}

                  {selected.kind === 'file' ? (
                    fileRec ? (
                      <div className="stack">
                        {fileRec.isImage ? (
                          <img src={fileRec.url} alt={fileRec.name} className="source-preview-img" />
                        ) : (
                          <div className="block">{fileRec.name}</div>
                        )}
                        <div className="rowgap">
                          <a className="btn small ghost" href={fileRec.downloadUrl || fileRec.url} download>下载</a>
                          <Copyable className="tag" text={fileRec.path || ''} title="点击复制物理路径">路径</Copyable>
                        </div>
                      </div>
                    ) : (
                      <div className="hint bad">附件 {selected.fileId} 不在库里了（可能已在附件中心删除）。</div>
                    )
                  ) : null}

                  {selected.note ? <div className="hint">备注：{selected.note}</div> : null}
                  {selected.mapped?.length ? (
                    <div className="hint">已整理到字段：{selected.mapped.join('、')}</div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * 字段控件：折叠条 + 抽屉。
 *
 * 折叠条是这一屏唯一该出现的东西——日常填表不该被暂存区挤占；
 * 想整理时才点开抽屉（那里才有左清单与正文）。
 */
export function SourceFieldControl({ def, value, onChange }) {
  const items = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(false);
  const stripRef = useRef(null);

  // 关闭抽屉时把焦点还回折叠条（键盘用户的下一步还在原处）
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => stripRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // 摘要只显示**当前版本**（被取代的旧条不进摘要——它们是留痕，不是现状）
  const preview = items.filter((x) => !x.superseded).slice(0, 2).map(titleOf).join('　·　');
  const oldCount = items.filter((x) => x.superseded).length;

  return (
    <div className="source-field">
      <button
        type="button"
        ref={stripRef}
        className="source-strip"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        title="打开原始资料袋"
      >
        <span className="source-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="source-strip-label">{def.label || '原始资料'}</span>
        <span className="tag">{items.length}</span>
        {oldCount ? <span className="tag">旧 {oldCount}</span> : null}
        {preview ? <span className="source-strip-preview">{preview}</span> : <span className="hint">（空）</span>}
        <span className="grow" />
        <span className="hint">整理前先乱入这里</span>
      </button>

      {open ? (
        <SourceDrawer
          items={items}
          onChange={onChange}
          onClose={close}
          title={def.entryTitle}
          sectionTitle={def.sectionTitle}
        />
      ) : null}
    </div>
  );
}
