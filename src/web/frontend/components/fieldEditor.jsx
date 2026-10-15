// 字段编辑器：按字段字典的 type 决定控件。
// 字典来自后端（section.fields），所以**面板能填的字段与 CLI 能填的字段天然一致**。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { fileToDataUrl, listAttachments, refreshAttachments } from '../api/files.js';
import { Copyable } from './ui.jsx';
import { useStore } from '../store.jsx';

/**
 * 自适应高度 textarea：所见即所得，填多少显示多少。
 * - 初始 `minRows` 行（避免空字段塌成一坨）；输入后按 scrollHeight 撑开
 * - `resize: none` + `overflow: hidden` 关掉浏览器默认的拖拽手柄与滚动条（自适应时两者会打架）
 * - reset 'auto' → 测 scrollHeight → 设回：删字时能正确回缩，而不是黏在上一次的高
 * - 用 useLayoutEffect 而非 useEffect，避免一帧的「旧高度 + 新内容」闪一下
 */
function AutoTextarea({ value, onChange, minRows = 2, placeholder, disabled, maxLength }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      rows={minRows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      style={{ resize: 'none', overflow: 'hidden', width: '100%' }}
    />
  );
}

/**
 * 字段值 → 附件 id 数组。
 * 一个 `file` 字段可挂**多个**附件：新写入统一存数组，历史数据里的单值是字符串
 * （读时按单元素处理）。前端不能 import core，所以这里自带一份同口径的归一化。
 */
function toIds(value) {
  const raw = value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  const out = [];
  for (const x of raw) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * file 字段控件（**多值**）：值 = 附件 id 的列表，一个字段能挂多个附件
 * （简历多版本、头像多张……）。
 *
 * **上传 / 选择就发生在这里**（「文件在栏目中链接」）；「附件」中心只负责统一展示与
 * 库存管理，不在这里做指派，也不预定义任何槽位。
 * 列表逐行显示：缩略图/扩展名徽标 + 名称（内联预览）+ 下载 + 复制物理路径 + 移除；
 * 底部是添加入口（可**多选**上传、或从库里选一个追加）。
 */
export function FileFieldControl({ def, value, onChange }) {
  const { toast, guard, patchUi } = useStore();
  const [data, setData] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const uploadRef = useRef(null);
  // dragenter/dragleave 在子元素间穿梭时会成对触发，用深度计数避免「还没离开就熄掉高亮」
  const dragDepth = useRef(0);
  const ids = toIds(value);
  const max = Number(def.maxItems) || 0;
  const full = max > 0 && ids.length >= max;

  const load = useCallback(async () => {
    try { setData(await listAttachments()); } catch { /* 附件库读不到时仍可上传 */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const all = data?.files || [];
  const byId = (id) => all.find((f) => f.id === id) || null;
  const available = all.filter((f) => !ids.includes(f.id));

  const upload = guard(async (fileList) => {
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

  const add = (id) => { if (id && !ids.includes(id)) onChange([...ids, id]); };
  const removeAt = (id) => onChange(ids.filter((x) => x !== id));

  // 拖拽文件进字段框 = 直接上传并追加（与「附件」中心同一套手感）
  const onDrop = guard(async (e) => {
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
      {!ids.length ? <span className="hint">还没有附件。</span> : null}
      <div className="file-pick-row">
        <select value="" disabled={full || !available.length} onChange={(e) => add(e.target.value)}>
          <option value="">{available.length ? '（从附件库选一个，选中即追加）' : '（库里没有可再选的附件）'}</option>
          {available.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button type="button" className="btn small" disabled={full} onClick={() => uploadRef.current?.click()}>上传文件</button>
        <button type="button" className="btn small ghost" onClick={() => patchUi({ view: 'files' })}>附件中心</button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
        />
      </div>
      {full ? <span className="hint">已达上限（{max} 个）：先移除一个，或把字段的 maxItems 调大。</span> : null}
      {def.hint ? <span className="hint">{def.hint}</span> : null}
    </div>
  );
}

export function FieldControl({ def, value, onChange, disabled }) {
  const type = def.type || 'text';
  const v = value === null || value === undefined ? '' : value;

  if (type === 'file') {
    return <FileFieldControl def={def} value={v} onChange={onChange} />;
  }

  if (type === 'bool') {
    const checked = v === true || v === 'true' || v === '是';
    return (
      <label className="inline">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="muted">{checked ? '是' : '否'}</span>
      </label>
    );
  }

  if (type === 'select') {
    const options = def.options || [];
    const isCustom = v !== '' && !options.includes(v);
    return (
      <select value={isCustom ? '__custom' : String(v)} onChange={(e) => onChange(e.target.value === '__custom' ? '' : e.target.value)}>
        <option value="">（未填写）</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {isCustom ? <option value="__custom">{String(v)}（当前值，不在候选里）</option> : null}
      </select>
    );
  }

  if (type === 'textarea') {
    return <AutoTextarea value={v} onChange={onChange} />;
  }

  if (type === 'tags') {
    const text = Array.isArray(v) ? v.join('、') : String(v);
    return (
      <input
        value={text}
        placeholder={def.maxItems ? `多个用「、」分隔，最多 ${def.maxItems} 个` : '多个用「、」分隔'}
        onChange={(e) => onChange(e.target.value.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean))}
      />
    );
  }

  const inputType = type === 'number' ? 'number' : (type === 'date' ? 'date' : (type === 'month' ? 'month' : 'text'));
  if (type === 'secret') {
    return (
      <input
        type="text"
        value={String(v)}
        placeholder="密文落盘；原样保留占位则视为不修改"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return <input type={inputType} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
}

/** 一整组字段（同一 group）的矩阵。 */
export function FieldGroup({ title, fields, draft, onPatch }) {
  return (
    <>
      <div className="group-title">{title}</div>
      <div className="pad">
        <div className="grid">
          {fields.map((def) => (
            <div key={def.key} className={`field ${def.type === 'textarea' || def.type === 'file' ? 'wide' : ''}`}>
              <div className="flabel">
                <span>{def.label}</span>
                {def.sensitive ? <span className="tag bad">密文</span> : null}
                {/* 填写策略来自后端字段字典；不计入完整度，所以标签用中性色而不是红色——
                    用户是**主动**跳过它，不是出错。 */}
                {def.fill && def.fill !== 'normal' ? <span className="tag">{def.fillLabel || def.fill}</span> : null}
                <span className="fkey">{def.key}</span>
              </div>
              <div className="fctrl">
                <FieldControl def={def} value={draft[def.key]} onChange={(v) => onPatch(def.key, v)} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
