/* 栏目表格投影 —— 数据库面板与「内嵌栏目」容器块**共用同一份**
 *
 * 这是 S2「视图 = 投影，数据同源」的结构保证：
 * 同一段渲染代码，同一个 sections 数据源，只是外层容器不同。
 * 内嵌块不是「另画一张表」，它就是数据库面板的投影。
 *
 * 列是**解析后的投影**（{ key, label, field, missing }）——
 * 字段被删时列仍在，只是渲染成「已删字段」弱占位（设计 §八 8.2 的「投影降级」）。
 */

import { useMemo } from 'react';
import { FieldValue } from '../ui.jsx';

/** 缺省列（没给 cols 时用）：与 src/views.js 的 projectableFields 同一口径 */
export function defaultColumns(section) {
  return (section?.fields || [])
    .filter((f) => f.key !== 'source')
    .map((f) => ({ key: f.key, label: f.label, field: f, missing: false }));
}

/**
 * @param {object} section  栏目定义
 * @param {Array}  [cols]   解析后的投影列；不给就用缺省前 4 个
 * @param {(entry)=>void} [onOpenEntry] 点行回调
 */
export default function SectionTable({ section, cols, masked, onOpenEntry, dense }) {
  const columns = useMemo(() => cols || defaultColumns(section), [cols, section]);
  const rows = section.entries || [];

  return (
    <div className="mini-table">
      <div>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.missing ? 'muted' : undefined} title={c.missing ? '这个字段已被删除（投影降级：列还在，占位）' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr
                key={e.id}
                onClick={onOpenEntry ? () => onOpenEntry(e) : undefined}
                style={{ cursor: onOpenEntry ? 'pointer' : undefined }}
              >
                {columns.map((c) => (
                  <td key={c.key} style={dense ? { height: 22, padding: '0 8px' } : undefined}>
                    {c.missing
                      ? <span className="muted">—</span>
                      : <FieldValue field={c.field} value={e.values?.[c.key]} masked={masked} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length ? <div className="muted" style={{ padding: '6px 8px' }}>（空栏目）</div> : null}
    </div>
  );
}
