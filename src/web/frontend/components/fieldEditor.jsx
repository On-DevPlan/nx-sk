// 字段编辑器：按字段字典的 type 决定控件。
// 字典来自后端（section.fields），所以**面板能填的字段与 CLI 能填的字段天然一致**。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { fileToDataUrl, listAttachments, refreshAttachments } from '../api/files.js';
import { Copyable } from './ui.jsx';
import { useStore } from '../store.jsx';

/**
 * file 字段控件：值 = 附件 id。
 * **上传 / 选择就发生在这里**（栏目条目的字段里）——「文件在栏目中链接」；
 * 「附件」中心只负责统一展示与库存管理，不在这里做指派，也不预定义任何槽位。
 */
export function FileFieldControl({ def, value, onChange }) {
  const { toast, guard, patchUi } = useStore();
  const [data, setData] = useState(null);
  const uploadRef = useRef(null);
  const id = value || '';

  const load = useCallback(async () => {
    try { setData(await listAttachments()); } catch { /* 附件库读不到时仍可上传 */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const current = (data?.files || []).find((f) => f.id === id) || null;

  const upload = guard(async (fileList) => {
    const file = fileList?.[0];
    if (!file) return;
    const content = await fileToDataUrl(file);
    const r = await api('/api/files', { method: 'POST', body: { content, name: file.name } });
    onChange(r.id);
    toast(r.duplicated ? '库中已有相同文件，已直接引用' : '已上传并关联');
    setData(await refreshAttachments());
  });

  return (
    <div className="file-picker">
      {current ? (
        <div className="file-preview">
          {current.isImage
            ? <img src={current.url} alt={current.name} />
            : <span className="ext-badge" style={{ fontSize: 13, width: 40, textAlign: 'center' }}>{current.ext ? current.ext.slice(1).toUpperCase() : 'FILE'}</span>}
          <a className="file-preview-name grow" href={current.url} target="_blank" rel="noreferrer" title={current.displayPath}>{current.name}</a>
          <a className="btn small ghost" href={current.downloadUrl}>下载</a>
          <Copyable className="hint" text={current.path} title="点击复制物理路径">路径</Copyable>
          <button type="button" className="btn small ghost" onClick={() => onChange('')}>清除</button>
        </div>
      ) : null}
      <div className="file-pick-row">
        <select value={id} onChange={(e) => onChange(e.target.value)}>
          <option value="">（未选择：从附件库选一个）</option>
          {(data?.files || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button type="button" className="btn small" onClick={() => uploadRef.current?.click()}>上传文件</button>
        <button type="button" className="btn small ghost" onClick={() => patchUi({ view: 'files' })}>附件中心</button>
        <input
          ref={uploadRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
        />
      </div>
      {id && !current ? <span className="hint bad">引用的附件已不存在（{id}）—— 重新上传，或清除。</span> : null}
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
    return <textarea value={String(v)} onChange={(e) => onChange(e.target.value)} rows={3} />;
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
