/* 面板通用零件 —— 所有面板共用同一套密度与零件，避免每屏各造一套
 *
 * 视觉纪律（§十二 12.6）：单色 + 唯一语义红；状态用标签不用色块；
 * 立体感只给可按/可填的元素；1px 浅底线分隔，不用投影撑容器。
 */

import { maskValue } from './data.js';
import { useApp } from './appctx.jsx';

export function Toolbar({ children }) {
  return <div className="toolbar">{children}</div>;
}

export function StatusBar({ children }) {
  return <div className="statusbar">{children}</div>;
}

export function Panel({ toolbar, children, footer, className }) {
  return (
    <div className={className || 'panel'} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {toolbar ? <Toolbar>{toolbar}</Toolbar> : null}
      <div className="grow" style={{ minHeight: 0, overflow: 'auto' }}>{children}</div>
      {footer ? <StatusBar>{footer}</StatusBar> : null}
    </div>
  );
}

/**
 * chips 是**可点击的东西** → 必须让键盘也能点到（B10）：
 * role=button + tabIndex=0 + Enter/Space 触发。裸 `<span onClick>` 鼠标能点、键盘到不了，
 * 屏幕阅读器也不念 —— 那是「看着像按钮、用起来不是」的假控件。
 */
export function Chip({ children, on, dim, onClick, title }) {
  const key = (e) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <span
      className={`chip${on ? ' on' : ''}${dim ? ' dim' : ''}`}
      onClick={onClick}
      onKeyDown={key}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={title}
    >
      {children}
    </span>
  );
}

export function Tag({ children }) {
  return <span className="tag">{children}</span>;
}

export function Prop({ k, children }) {
  return (
    <div className="prop">
      <span className="k">{k}</span>
      <span className="grow">{children}</span>
    </div>
  );
}

/** 密文展示：打码规则与 src/core/crypto.js maskValue 一致 */
export function Secret({ value, masked }) {
  if (!value) return <span className="muted">—</span>;
  return <span className="mono">{masked ? maskValue(value) : value}</span>;
}

/** 按字段类型渲染值（原型共用一份，database / detail / kv 都走它） */
export function FieldValue({ field, value, masked = true }) {
  const { library } = useApp();
  if (!field) return <span className="muted">—</span>;
  switch (field.type) {
    case 'bool':
      return <Tag>{value ? '是' : '否'}</Tag>;
    case 'select':
      return value ? <Tag>{value}</Tag> : <span className="muted">—</span>;
    case 'tags':
      return (value || []).length
        ? <span className="rowgap">{(value || []).map((t) => <Tag key={t}>{t}</Tag>)}</span>
        : <span className="muted">—</span>;
    case 'number':
      return value == null || value === '' ? <span className="muted">—</span> : <span className="num">{value}</span>;
    case 'secret':
      return <Secret value={value} masked={masked} />;
    case 'file': {
      // 值 = **附件 id 的列表**（不是文件名）→ 从库里解析出名字
      const ids = Array.isArray(value) ? value : [];
      const items = ids.map((id) => library?.find((f) => f.id === id)).filter(Boolean);
      return items.length
        ? <span className="rowgap">{items.map((f) => <Tag key={f.id}>{f.name}</Tag>)}</span>
        : <span className="muted">—</span>;
    }
    case 'entrylist':
      return <MiniTable
        columns={(field.fields || []).map((f) => ({ key: f.key, label: f.label, sensitive: f.sensitive }))}
        rows={value || []}
        masked={masked}
      />;
    case 'table':
      return <MiniTable columns={field.columns || []} rows={value || []} masked={masked} />;
    case 'md':
      return <span style={{ whiteSpace: 'pre-wrap' }}>{value || <span className="muted">—</span>}</span>;
    default:
      return value == null || value === '' ? <span className="muted">—</span> : <span>{value}</span>;
  }
}

/** 迷你表：表格块 / 结构清单块用；计算列标「算」 */
export function MiniTable({ columns, rows, masked }) {
  if (!columns?.length) return <span className="muted">（无列）</span>;
  const calc = new Set(columns.filter((c) => c.formula).map((c) => c.key));
  const head = (
    <thead>
      <tr>
        {columns.map((c) => (
          <th key={c.key}>
            {c.label}
            {calc.has(c.key) ? <span className="muted" title="计算列：读时现算，不落盘"> 算</span> : null}
          </th>
        ))}
      </tr>
    </thead>
  );
  return (
    <div className="mini-table">
      <div>
      <table>
        {head}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => {
                let v = r[c.key];
                if (c.formula) {
                  const [a, b] = c.formula.split('*').map((s) => s.trim());
                  v = Number(r[a]) * Number(r[b]);
                }
                if (c.sensitive) v = masked ? maskValue(v) : v;
                if (c.type === 'bool') v = v ? '是' : '否';
                return (
                  <td key={c.key} className={c.type === 'number' || c.formula ? 'num' : ''}>
                    {v == null || v === '' ? '—' : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** 危险操作二次确认：条目改归属必须过这里 */
export function ConfirmHost({ request, onResolve }) {
  if (!request) return null;
  return (
    <div className="modal-mask" onClick={() => onResolve(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{request.title}</h3>
        <p>{request.body}</p>
        <div className="acts">
          <button onClick={() => onResolve(false)}>取消</button>
          <button className="danger" onClick={() => onResolve(true)}>确认</button>
        </div>
      </div>
    </div>
  );
}
