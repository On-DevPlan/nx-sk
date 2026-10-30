import { useMemo } from 'react';
import { Empty } from '../../web/frontend/components/ui.jsx';

/**
 * 数据库表格视图：一个栏目的**横向投影**。
 *
 * 与「条目列表」的分工：列表回答「有哪些条目」，表格回答「这些条目的某些字段各是什么」。
 * 列来自 `view.columns`（只存 key/width/hidden），标签与类型回查字段字典 —— 单一事实源。
 *
 * 三条边界（都是踩过的坑）：
 *   · 投影引用的字段被删 → 列**还在**，表头写「已删字段」（弱占位），格子里写「—」。
 *     不炸、也不静默消失：用户能看出这里曾经有一列（§19.4）。
 *   · **密文列在表格里一律打码**：表格是「一次看到很多行」的界面，明文密钥上屏的风险
 *     远大于便利；要读原文去详情表单（那里本来就有打码开关）。
 *   · 排序在这里做**只读投影**，不动数据：`view.sort` 是显示配置，不是写操作。
 */

function cellText(v, col, mask) {
  if (col.sensitive) return mask ? String(v ?? '') : '••••••';
  if (v === null || v === undefined || v === '') return '—';
  switch (col.type) {
    case 'bool':
      return v === true || v === 'true' ? '是' : v === false || v === 'false' ? '否' : String(v);
    case 'tags':
      return Array.isArray(v) ? v.join('、') : String(v);
    case 'file':
      return Array.isArray(v) ? (v.length ? `${v.length} 个附件` : '—') : String(v);
    case 'entrylist':
      return Array.isArray(v) ? (v.length ? `${v.length} 行` : '—') : String(v);
    case 'table':
      return `${(v.rows || []).length} 行 × ${(v.columns || []).length} 列`;
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function sortValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'object') return JSON.stringify(v);
  const n = Number(v);
  // 形如 "2026-10" / "2026-10-30" 的串按字符串比就是对的（ISO 前缀可比）
  return Number.isFinite(n) && String(v).trim() !== '' ? n : String(v);
}

export default function EntriesTable({ entries, columns, mask, sort, selected, onTogglePick, onPick, activeId }) {
  const rows = useMemo(() => {
    const list = [...(entries || [])];
    if (sort && sort.key) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        const x = sortValue(a.values ? a.values[sort.key] : undefined);
        const y = sortValue(b.values ? b.values[sort.key] : undefined);
        // 空值恒沉底：升序降序都一样，否则「排序后满屏空行在最上面」看着像丢数据
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y), 'zh-Hans-CN') * dir;
      });
    }
    return list;
  }, [entries, sort]);

  if (!entries || !entries.length) {
    return <Empty>还没有条目。点右上角「新建条目」，或用 CLI：nx-sk entry add --section …</Empty>;
  }

  return (
    <div className="dbtable-wrap">
      <table className="dbtable">
        <thead>
          <tr>
            <th className="pickcol" aria-label="选择" />
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width, minWidth: c.width } : { minWidth: 90 }}
                className={c.missing ? 'missing' : ''}
                title={c.missing
                  ? `字段 ${c.key} 已从字典里删掉；列还在，值显示为「—」`
                  : `${c.label}${c.sensitive ? '（密文列：表格里一律打码）' : ''}`}
              >
                {c.label}
                {c.sensitive ? <span className="hint">　密文</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr
              key={e.id}
              className={e.id === activeId ? 'on' : ''}
              onClick={() => onPick && onPick(e.id)}
            >
              <td className="pickcol">
                <input
                  type="checkbox"
                  checked={!!(selected && selected.has(e.id))}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={() => onTogglePick && onTogglePick(e.id)}
                  title="选中后可只导出这一条"
                />
              </td>
              {columns.map((c) => (
                <td key={c.key} className={c.missing ? 'missing' : ''}>
                  {c.missing ? '—' : cellText(e.values ? e.values[c.key] : undefined, c, mask)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
