// `file` 字段控件（**多值**）：值 = 附件 id 的列表，一个字段能挂多个附件
// （简历多版本、头像多张……）。
//
// **上传 / 选择就发生在这里**（「文件在栏目中链接」）；「附件」中心只负责统一展示与
// 库存管理，不在这里做指派，也不预定义任何槽位。
// 列表逐行显示：缩略图/扩展名徽标 + 名称（内联预览）+ 下载 + 复制物理路径 + 移除；
// 底部是添加入口（可**多选**上传、或从库里选一个追加）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { fileToDataUrl, listAttachments, refreshAttachments } from '../../api/files.ts';
import { Copyable } from '../ui.tsx';
import { useStore } from '../../store.tsx';
import type { ControlProps } from './types.ts';

/**
 * 字段值 → 附件 id 数组。
 * 一个 `file` 字段可挂**多个**附件：新写入统一存数组；历史形态有单值字符串、
 * 甚至旧版连写的 `"f_a,f_b"`（0.8.0 前 `--set` 不拆逗号）——统一拆分隔符归一。
 * 前端不能 import core，所以这里自带一份同口径的归一化。
 */
function toIds(value: any) {
  const raw = value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  const out: string[] = [];
  for (const x of raw) {
    for (const piece of String(x ?? '').split(/[,，、;；]+/)) {
      const id = piece.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

export function FileControl({ def, value, onChange }: ControlProps) {
  // store 目前还是 JSX（P5 才迁 TS），`createContext(null)` 让 TS 把它推成 never；
  // 这里显式放宽，行为与重构前完全一致。
  const { toast, guard, patchUi } = useStore() as any;
  const [data, setData] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  // 附件多的时候不把表单撑长：默认只露 5 行，窗口内上下滚动；需要看全时一键展开
  const [expanded, setExpanded] = useState(false);
  const uploadRef = useRef<any>(null);
  // 附件库选择器：默认收起，点开才搜索 / 挑选（表单是给人填的，不是给人翻附件库的）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  // dragenter/dragleave 在子元素间穿梭时会成对触发，用深度计数避免「还没离开就熄掉高亮」
  const dragDepth = useRef(0);
  const ids = toIds(value);
  const idsKey = ids.join(',');
  const max = Number(def.maxItems) || 0;
  const full = max > 0 && ids.length >= max;

  const load = useCallback(async (force = false) => {
    // 挂载时强制刷新：附件可能刚被 CLI / 另一个标签页导入，缓存里的旧表会让
    // 已关联的文件显示成「不存在」
    try { setData(await listAttachments(force)); } catch { /* 附件库读不到时仍可上传 */ }
  }, []);
  useEffect(() => { load(true); }, [load]);

  const all = useMemo(() => data?.files || [], [data]);
  const byId = (id: string) => all.find((f: any) => f.id === id) || null;
  // 本字段还没挂的附件
  const available = useMemo(
    () => all.filter((f: any) => !idsKey.split(',').includes(f.id)),
    [all, idsKey],
  );
  // **未引用优先**：附件中心刚导入、还没挂到任何条目的原件排在前面。
  // 理由：选附件时最常要的正是「刚传的那几个」；已被别处引用的往后排，
  // 仍然可选（同一个原件可以被多条条目共享）。
  const ordered = useMemo(() => {
    const free: any[] = [];
    const used: any[] = [];
    for (const f of available) (f.usedBy?.length ? used : free).push(f);
    return [...free, ...used];
  }, [available]);
  // 关键字搜索：名称 / 备注 / 标签
  const matched = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((f: any) => [f.name, f.note, ...(f.tags || [])]
      .join('\n').toLowerCase().includes(q));
  }, [ordered, pickQuery]);

  // Esc 关掉选择器
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onKey = (e: any) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);

  const upload = guard(async (fileList: any) => {
    const picked = [...(fileList || [])];
    if (!picked.length) return;
    if (full) { toast(`「${def.label}」最多 ${max} 个附件，先移除一个`, 'bad'); return; }
    const next = [...ids];
    let duplicated = 0;
    for (const file of picked) {
      const content = await fileToDataUrl(file);
      const r = await api('/api/files', { method: 'POST', body: { content, name: file.name } });
      if (next.includes(r.id)) { duplicated += 1; continue; }
      next.push(r.id);
    }
    onChange(next);
    const added = picked.length - duplicated;
    toast(duplicated
      ? `已上传并关联 ${added} 个；${duplicated} 个库里已有，直接引用`
      : `已上传并关联 ${picked.length} 个`);
    setData(await refreshAttachments());
  });

  const add = (id: string) => { if (id && !ids.includes(id)) onChange([...ids, id]); };
  const removeAt = (id: string) => onChange(ids.filter((x) => x !== id));

  // 拖拽文件进字段框 = 直接上传并追加（与「附件」中心同一套手感）
  const onDrop = guard(async (e: any) => {
    dragDepth.current = 0;
    setDragOver(false);
    await upload(e.dataTransfer?.files);
  });

  return (
    <div
      className={`file-picker ${dragOver ? 'drag' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
      onDrop={onDrop}
    >
      {ids.length ? (
        <div className={`file-picker-list${expanded ? ' expanded' : ''}`}>
          {ids.map((id) => {
            const rec = byId(id);
            if (!rec) {
              return (
                <div className="file-preview" key={id}>
                  <span className="hint bad grow">引用的附件已不存在（{id}）—— 重新上传，或移除。</span>
                  <button type="button" className="btn small ghost" onClick={() => removeAt(id)}>移除</button>
                </div>
              );
            }
            return (
              <div className="file-preview" key={id}>
                {rec.isImage
                  ? <img src={rec.url} alt={rec.name} />
                  : <span className="ext-badge" style={{ fontSize: 13, width: 40, textAlign: 'center' }}>{rec.ext ? rec.ext.slice(1).toUpperCase() : 'FILE'}</span>}
                <a className="file-preview-name grow" href={rec.url} target="_blank" rel="noreferrer" title={rec.displayPath}>{rec.name}</a>
                <a className="btn small ghost" href={rec.downloadUrl}>下载</a>
                <Copyable className="hint" text={rec.path} title="点击复制物理路径">路径</Copyable>
                <button type="button" className="btn small ghost" onClick={() => removeAt(id)}>移除</button>
              </div>
            );
          })}
        </div>
      ) : null}
      {!ids.length ? <span className="hint">还没有附件。</span> : null}
      {ids.length > 5 ? (
        <div className="file-pick-row">
          <span className="hint">共 {ids.length} 个附件{expanded ? '（已展开全部）' : '（窗口内上下滚动查看）'}</span>
          <button type="button" className="btn small ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起到 5 行' : '展开全部'}
          </button>
        </div>
      ) : null}
      <div className="file-pick-row">
        <button
          type="button"
          className="btn small"
          disabled={full || !available.length}
          onClick={() => setPickerOpen((v) => !v)}
          title="从附件库挑附件（可搜索；未引用的排在前面）"
        >
          从附件库选…
        </button>
        <button type="button" className="btn small" disabled={full} onClick={() => uploadRef.current?.click()}>上传文件</button>
        <button type="button" className="btn small ghost" onClick={() => { patchUi({ view: 'files' }); window.location.hash = '#/files'; }}>附件中心</button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
        />
      </div>
      {pickerOpen ? (
        <div className="file-pick-panel">
          <div className="file-pick-search">
            <input
              autoFocus
              value={pickQuery}
              placeholder="按名称 / 备注 / 标签搜索附件"
              onChange={(e) => setPickQuery(e.target.value)}
            />
            <span className="hint nowrap">{matched.length} / {available.length}</span>
            <button type="button" className="btn small ghost" onClick={() => setPickerOpen(false)}>关闭</button>
          </div>
          {matched.length ? (
            <div className="file-pick-list">
              {matched.map((f: any) => (
                <button type="button" key={f.id} className="file-pick-item" onClick={() => add(f.id)} title="点击追加到本字段">
                  {f.isImage
                    ? <img src={f.url} alt="" />
                    : <span className="ext-badge" style={{ fontSize: 12, width: 34, textAlign: 'center' }}>{f.ext ? f.ext.slice(1).toUpperCase() : 'FILE'}</span>}
                  <span className="file-pick-name grow nowrap">{f.name}</span>
                  <span className="hint nowrap">{f.usedBy?.length ? `已被 ${f.usedBy.length} 处引用` : '未引用'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="hint pad">没有匹配的附件。换个关键字，或先「上传文件」。</div>
          )}
          <div className="hint pad">未引用的排在前面；点一行即追加到本字段（可连续点多个）。</div>
        </div>
      ) : null}
      {full ? <span className="hint">已达上限（{max} 个）：先移除一个，或把字段的 maxItems 调大。</span> : null}
      {def.hint ? <span className="hint">{def.hint}</span> : null}
    </div>
  );
}
