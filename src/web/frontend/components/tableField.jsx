import { useEffect, useMemo, useRef, useState } from 'react';
import { TABLE_CELL_TYPES, computeTable, columnToDef, formatCellValue } from '../../../shared/table.js';
import { useStore } from '../store.jsx';
import { reorderAt, useListDrag } from './listDrag.jsx';

/**
 * 表格字段（`type: 'table'`）的编辑界面。
 *
 * **这张表是自描述的**：列、行、公式、统计配置全部存在条目数据里（不在栏目字典里）。
 * 所以这里除了填格子，还能直接**加列 / 改列类型 / 改公式** —— 改完就是这条数据的一部分，
 * 不会影响同栏目下的其它条目。字段定义里的 columns 只是「新建时的初始列」。
 *
 * 四个刻意的取舍：
 *   1. **计算列不落盘、也不可编辑**。它由公式从同行的值算出来；把结果存下来，
 *      下次改了一个数字而忘记重算，就会出现「存下来的合计和现在的数据对不上」。
 *   2. **合计就摆在表尾**，不是另一个面板。看数的人不该先点一个按钮才知道总数。
 *   3. **回车往下走**（最后一格回车就新起一行），Alt+↑/↓ 改上下行的同一个格子 ——
 *      录一张表时手不用离开键盘，这是「像表格」和「像一堆输入框」的分界。
 *   4. 每行都是**独立 grid**（与 entrylist 同一手法）：列宽只由列定义决定，
 *      内容再长也不会把某一行撑歪。
 *   5. **行与列都能拖**：行把手在行尾的操作区，列直接拖表头（列设置里也有把手）。
 *      排序是最常见的编辑动作之一，一排 ↑↓ 按钮既占地方又说不清「会插到哪」，
 *      拖拽 + 一条插入线是唯一能表达「插在这里」的交互（↑↓ 保留，hover 才出现）。
 */

// 行尾操作区：把手 14 + 三个 16 的小键 + 间距。它是「操作列」，不是内容列，
// 所以宽度写死 —— 列多了是内容区横向滚动，不该把这一列压扁。
const GUTTER = 78;

const alignOf = (col) => col.align || (col.type === 'number' ? 'right' : (col.type === 'bool' ? 'center' : 'left'));

const TOTAL_OPTIONS = [
  ['', '按类型（数字求和 / 勾选计是）'],
  ['none', '不统计'],
  ['sum', '求和'],
  ['avg', '平均'],
  ['count', '计数（非空）'],
  ['countTrue', '计数（是）'],
  ['countFalse', '计数（否）'],
  ['min', '最小'],
  ['max', '最大'],
  ['distinct', '去重计数'],
  ['median', '中位数'],
];

function cellText(col, v) {
  if (v === null || v === undefined) return '';
  if (col.type === 'tags') return Array.isArray(v) ? v.join('、') : String(v);
  return String(v);
}

/** 一格输入控件。计算列不在这里 —— 它渲染成只读文本。 */
function CellInput({ col, value, mask, cellRef, onPatch, onEnter, onArrow }) {
  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); return; }
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); onArrow(1); return; }
    if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); onArrow(-1); }
  };
  const common = { 'data-cell': cellRef, className: 'tf-input', onKeyDown };

  if (col.type === 'bool') {
    const checked = value === true || value === 'true' || value === '是' || value === 1 || value === '1';
    return (
      <label className="tf-bool" title={checked ? '是（点击改成否）' : '否（点击改成是）'}>
        <input {...common} type="checkbox" checked={checked} onChange={(e) => onPatch(e.target.checked)} />
      </label>
    );
  }

  if (col.type === 'select') {
    const v = value === null || value === undefined ? '' : String(value);
    const opts = col.options || [];
    const custom = v !== '' && !opts.includes(v);
    return (
      <select {...common} className="tf-input tf-select" value={v} onChange={(e) => onPatch(e.target.value)}>
        <option value="">（未选）</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        {custom ? <option value={v}>{v}（不在候选里）</option> : null}
      </select>
    );
  }

  if (col.type === 'number') {
    return (
      <input
        {...common}
        type="number"
        step="any"
        className="tf-input num"
        value={cellText(col, value)}
        onChange={(e) => onPatch(e.target.value)}
      />
    );
  }

  if (col.type === 'date' || col.type === 'month') {
    return <input {...common} type={col.type} className="tf-input" value={cellText(col, value)} onChange={(e) => onPatch(e.target.value)} />;
  }

  return (
    <input
      {...common}
      type={col.sensitive && mask ? 'password' : 'text'}
      autoComplete="off"
      className="tf-input"
      value={cellText(col, value)}
      title={cellText(col, value)}
      onChange={(e) => onPatch(e.target.value)}
    />
  );
}

export function TableFieldControl({ def, value, onChange }) {
  const { ui } = useStore();
  const mask = !!ui.mask;
  const [colsOpen, setColsOpen] = useState(false);
  const rootRef = useRef(null);
  // 回车新起一行时焦点要先送进新行，而新行在这一帧还没挂载 —— 记下目标，渲染完再对焦。
  const [pending, setPending] = useState('');

  const table = useMemo(() => computeTable(def, value), [def, value]);
  const cols = table.columns;
  const rows = useMemo(() => table.rows.map((r) => r.raw), [table]);

  /** 一次改动 = 一份**完整的**表格文档（列、行都在里面），而不是只回写行。 */
  const commit = (patch = {}) => {
    const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    onChange({
      ...base,
      v: 1,
      columns: patch.columns || table.columns.map((c) => columnToDef(c)),
      rows: patch.rows || rows,
    });
  };
  /** 表尾统计的总开关。开 = 去掉这个键（回到「按类型自动」），关 = 显式写 false。 */
  const setSummary = (on) => {
    const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const next = { ...base, v: 1, columns: cols.map((c) => columnToDef(c)), rows };
    if (on) {
      delete next.summary;
      // 显式的空 totals 也是「不要表尾」，一起清掉，否则勾了也不会出现
      if (Array.isArray(next.totals) && !next.totals.length) delete next.totals;
    } else next.summary = false;
    onChange(next);
  };

  useEffect(() => {
    if (!pending) return;
    const el = rootRef.current?.querySelector(`[data-cell="${pending}"]`);
    if (el) {
      el.focus();
      if (el.select && el.type !== 'checkbox') el.select();
    }
    setPending('');
  }, [pending, rows.length]);

  const grid = `${cols.map((c) => (c.width ? `${c.width}px` : 'minmax(84px, 1fr)')).join(' ')} ${GUTTER}px`;
  // 行宽的下限：列多了就把容器撑开、横向滚动，而不是把每列压到看不见。
  // 所有行都挂在这一个宽度上，列的左右边界才对得齐（每行是独立 grid）。
  const minWidth = cols.reduce((sum, c) => sum + (c.width || 84), 0) + GUTTER;

  const setCell = (i, key, v) => commit({ rows: rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)) });
  /** 新增行时按列的 `default` 预填：没有默认值的列留空（不写 null，空着就是空着）。 */
  const seedRow = () => {
    const seed = {};
    for (const c of cols) {
      if (c.computed) continue;
      if (c.default !== undefined && c.default !== null) seed[c.key] = c.default;
    }
    return seed;
  };
  const addRow = () => { commit({ rows: [...rows, seedRow()] }); return rows.length; };
  const moveRow = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    commit({ rows: next });
  };
  const removeRow = (i) => commit({ rows: rows.filter((_, idx) => idx !== i) });
  // 拖拽排序：落点给的是**插入位**，行 / 列各自一份（互不干扰：一边在拖时另一边不接管 dragover）
  // 拖回原位时 reorderAt 返回**同一个数组**——这时不 commit，否则条目会被标成「有改动」而其实没动。
  const rowDrag = useListDrag((from, insertAt) => {
    const next = reorderAt(rows, from, insertAt);
    if (next !== rows) commit({ rows: next });
  }, { axis: 'y' });
  const colDrag = useListDrag((from, insertAt) => {
    const next = reorderAt(cols.map(columnToDef), from, insertAt);
    if (next !== cols) commit({ columns: next });
  }, { axis: 'x' });

  const patchColumn = (i, patch) => {
    const oldKey = cols[i].key;
    // 把 key 删空不算一次修改：空 key 的列在归一阶段就会被丢掉，看起来像「清空输入框，
    // 整列连数据一起消失了」。忽略空输入，等用户敲出新的 key 再改名。
    const nextKey = patch.key === undefined ? oldKey : String(patch.key).trim();
    if (patch.key !== undefined && !nextKey) return;
    const next = cols.map((c) => columnToDef(c));
    next[i] = { ...next[i], ...patch, ...(patch.key !== undefined ? { key: nextKey } : {}) };
    // 改列 key 要**连值一起搬**：只改定义的话，那些格子会变成「没有列的数据」，
    // 保存时被挡下来（看起来像「改个名字数据就没了」）。
    let nextRows = rows;
    if (nextKey !== oldKey) {
      nextRows = rows.map((r) => {
        if (!(oldKey in r)) return r;
        const copy = { ...r };
        copy[nextKey] = copy[oldKey];
        delete copy[oldKey];
        return copy;
      });
    }
    commit({ columns: next, rows: nextRows });
  };
  const moveColumn = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const next = cols.map((c) => columnToDef(c));
    [next[i], next[j]] = [next[j], next[i]];
    commit({ columns: next });
  };
  /** 删列要连值一起删：只删定义会让那些格子变成「没有列的数据」，写入时被挡下来。 */
  const removeColumn = (i) => {
    const gone = cols[i];
    const next = cols.filter((_, idx) => idx !== i).map((c) => columnToDef(c));
    const nextRows = rows.map((r) => {
      const copy = { ...r };
      delete copy[gone.key];
      return copy;
    });
    commit({ columns: next, rows: nextRows });
  };
  const addColumn = () => {
    let n = cols.length + 1;
    while (cols.some((c) => c.key === `col${n}`)) n += 1;
    commit({ columns: [...cols.map((c) => columnToDef(c)), { key: `col${n}`, label: `列${n}`, type: 'text' }] });
    setColsOpen(true);
  };

  const focusCell = (i, key) => {
    const el = rootRef.current?.querySelector(`[data-cell="${i}:${key}"]`);
    if (el) {
      el.focus();
      if (el.select && el.type !== 'checkbox' && el.type !== 'select') el.select();
    }
  };
  /** 回车：下一行同一列；已经是最后一行就新起一行，焦点落在新格子上。 */
  const enterFrom = (i, col) => {
    if (i + 1 < rows.length) { focusCell(i + 1, col.key); return; }
    addRow();
    setPending(`${i + 1}:${col.key}`);
  };
  /** Alt+↑/↓：同列上下移动。 */
  const arrowFrom = (i, col, dir) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    focusCell(j, col.key);
  };

  const summaryOn = table.summary !== false;

  return (
    <div className="tablefield" ref={rootRef}>
      {cols.length ? (
        <div className="tf-scroll">
          <div className="tf-body" style={{ minWidth }}>
            {/* 表头：整格可拖（里面没有输入框，不会跟文本选择打架）—— 拖表头就是搬这一列 */}
            <div className="tf-row tf-head" style={{ gridTemplateColumns: grid }}>
              {cols.map((c, idx) => (
                <div
                  key={c.key}
                  className={`tf-th ${alignOf(c)}${colDrag.dropClass(idx)}`}
                  title={(c.hint || (c.computed ? `计算列：${c.formula}` : '拖动表头可调整列顺序')) || undefined}
                  {...colDrag.dragStartProps(idx)}
                  {...colDrag.itemProps(idx)}
                >
                  <span className="tf-th-label">{c.label}</span>
                  {c.computed ? <span className="tf-badge" title={`计算列：${c.formula}`}>算</span> : null}
                  {c.sensitive ? <span className="tf-badge bad">密</span> : null}
                  {c.unit ? <span className="tf-unit">{c.unit}</span> : null}
                </div>
              ))}
              <div className="tf-th tf-th-acts" />
            </div>

            {/* 数据行 */}
            {table.rows.map((row, i) => (
              <div
                key={i}
                className={`tf-row${rowDrag.draggingIndex === i ? ' dragging' : ''}${rowDrag.dropClass(i)}`}
                style={{ gridTemplateColumns: grid }}
                {...rowDrag.itemProps(i)}
              >
                {cols.map((c) => {
                  const err = row.errors[c.key];
                  if (c.computed) {
                    const text = err ? '#错误' : formatCellValue(c, row.values[c.key]);
                    return (
                      <div key={c.key} className={`tf-td tf-calc ${alignOf(c)}`} title={err || `= ${c.formula}`}>
                        <span className={err ? 'tf-err' : ''}>{err ? '#错误' : text || '—'}</span>
                      </div>
                    );
                  }
                  return (
                    <div key={c.key} className={`tf-td ${alignOf(c)}${err ? ' has-err' : ''}`} title={err || ''}>
                      <CellInput
                        col={c}
                        value={row.raw?.[c.key]}
                        mask={mask}
                        cellRef={`${i}:${c.key}`}
                        onPatch={(v) => setCell(i, c.key, v)}
                        onEnter={() => enterFrom(i, c)}
                        onArrow={(d) => arrowFrom(i, c, d)}
                      />
                    </div>
                  );
                })}
                <div className="tf-td tf-acts">
                  <span {...rowDrag.handleProps(i)}>⠿</span>
                  <button type="button" className="tf-mini" title="上移这一行" disabled={i === 0} onClick={() => moveRow(i, -1)}>↑</button>
                  <button type="button" className="tf-mini" title="下移这一行" disabled={i === rows.length - 1} onClick={() => moveRow(i, 1)}>↓</button>
                  <button type="button" className="tf-mini" title="删除这一行" onClick={() => removeRow(i)}>×</button>
                </div>
              </div>
            ))}

            {/* 统计行：合计就摆在表尾，不用点开任何东西 */}
            {table.totals.map((t, ti) => (
              <div key={`t${ti}`} className="tf-row tf-total" style={{ gridTemplateColumns: grid }}>
                {cols.map((c, idx) => {
                  const err = t.errors[c.key];
                  const txt = err ? '#错误' : (t.texts[c.key] ?? '');
                  if (idx === 0) {
                    return (
                      <div key={c.key} className={`tf-td ${alignOf(c)}`} title={err || ''}>
                        <span className="tf-sum-label">{t.label}</span>
                        {txt ? <span className="tf-sum-val">{txt}</span> : null}
                        {!txt && t.text ? <span className="tf-sum-val">{t.text}</span> : null}
                      </div>
                    );
                  }
                  return (
                    <div key={c.key} className={`tf-td ${alignOf(c)}`} title={err || ''}>
                      <span className={err ? 'tf-err' : 'tf-sum-val'}>{txt}</span>
                    </div>
                  );
                })}
                <div className="tf-td tf-acts" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="tf-empty hint">这张表还没有列。先「添加列」，或一次把整份数据写进来（CLI 的 columns + rows）。</div>
      )}

      <div className="tf-bar">
        <button type="button" className="btn small" onClick={addRow} disabled={!cols.length}>＋ 添加行</button>
        <button type="button" className="btn small ghost" onClick={addColumn}>＋ 添加列</button>
        <button type="button" className={`btn small ghost${colsOpen ? ' on' : ''}`} onClick={() => setColsOpen((v) => !v)}>
          {colsOpen ? '收起列设置' : '列设置'}
        </button>
        <label className="inline hint" title="表尾显示一行统计（数字求和、勾选计是，也可逐列指定）">
          <input type="checkbox" checked={summaryOn} onChange={(e) => setSummary(e.target.checked)} />
          统计行
        </label>
        <span className="grow" />
        <span className="hint">
          {rows.length ? `${rows.length} 行 · ${cols.length} 列` : '还没有行'}
          {table.errorCount ? <span className="bad">　·　{table.errorCount} 处公式错误</span> : null}
        </span>
      </div>

      {colsOpen ? (
        <div className="tf-cols">
          <div className="hint">
            列定义跟着**这条数据**走（不写进栏目字典），所以这里加列只影响这一条。
            计算列写 JS 表达式：可用同行的列 key 或中文列名，也可用 rows / col("列名") / sum / countTrue。
            排序用拖：**拖表头**搬列，拖行尾的 ⠿ 搬行（松手前会有一条插入线告诉你落在哪）。
          </div>
          {cols.map((c, i) => (
            <div key={c.key} className={`tf-colrow${colDrag.dropClass(i)}`} {...colDrag.itemProps(i)}>
              <div className="tf-colrow-main">
                <span {...colDrag.handleProps(i)}>⠿</span>
                <input
                  style={{ width: 108 }}
                  value={c.key}
                  title="列 key：公式里就这么引用"
                  onChange={(e) => patchColumn(i, { key: e.target.value })}
                />
                <input
                  style={{ width: 120 }}
                  value={c.label}
                  placeholder="列名"
                  onChange={(e) => patchColumn(i, { label: e.target.value })}
                />
                <select
                  style={{ width: 118 }}
                  value={c.computed ? 'formula' : c.type}
                  onChange={(e) => {
                    const t = e.target.value;
                    if (t === 'formula') patchColumn(i, { type: 'number', formula: c.formula || '' });
                    else patchColumn(i, { type: t, formula: '', options: t === 'select' ? (c.options.length ? c.options : ['选项1', '选项2']) : [] });
                  }}
                >
                  {TABLE_CELL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  <option value="formula">计算（JS 表达式）</option>
                </select>
                <select
                  style={{ width: 132 }}
                  value={c.total || ''}
                  title="表尾这一列怎么统计"
                  onChange={(e) => patchColumn(i, { total: e.target.value })}
                >
                  {TOTAL_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
                <input
                  style={{ width: 66 }}
                  value={c.unit || ''}
                  placeholder="单位"
                  onChange={(e) => patchColumn(i, { unit: e.target.value })}
                />
                <input
                  style={{ width: 66 }}
                  value={c.default === undefined || c.default === null ? '' : String(c.default)}
                  placeholder="默认值"
                  title="新增行时的初值（不会写进已有行）"
                  onChange={(e) => patchColumn(i, { default: e.target.value })}
                />
                {!c.computed ? (
                  <label className="inline hint" title="这一列的值以 AES-256-GCM 密文落盘">
                    <input type="checkbox" checked={c.sensitive} onChange={(e) => patchColumn(i, { sensitive: e.target.checked })} /> 密文
                  </label>
                ) : null}
                <span className="grow" />
                <button type="button" className="tf-mini" title="左移" disabled={i === 0} onClick={() => moveColumn(i, -1)}>←</button>
                <button type="button" className="tf-mini" title="右移" disabled={i === cols.length - 1} onClick={() => moveColumn(i, 1)}>→</button>
                <button type="button" className="tf-mini" title="删除这一列（连值一起删）" onClick={() => removeColumn(i)}>×</button>
              </div>
              {c.type === 'select' && !c.computed ? (
                <input
                  placeholder="下拉选项，逗号分隔，例如：未开始，进行中，已完成"
                  value={(c.options || []).join('，')}
                  onChange={(e) => patchColumn(i, { options: e.target.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) })}
                />
              ) : null}
              {c.computed ? (
                <input
                  className="mono"
                  placeholder="公式，例如 qty * price"
                  value={c.formula}
                  onChange={(e) => patchColumn(i, { formula: e.target.value })}
                />
              ) : null}
            </div>
          ))}
          <div className="rowgap">
            <button type="button" className="btn small ghost" onClick={addColumn}>＋ 添加列</button>
            <span className="hint">改完立即生效（保存条目后落盘）。列 key 建议英文，公式里最好写。</span>
          </div>
        </div>
      ) : null}

      {table.errors.length ? (
        <div className="tf-errors">
          {table.errors.slice(0, 3).map((e, k) => (
            <div key={k} className="hint bad">第 {e.row + 1} 行「{cols.find((c) => c.key === e.column)?.label || e.column}」：{e.message}</div>
          ))}
          {table.errors.length > 3 ? <div className="hint bad">另有 {table.errors.length - 3} 处</div> : null}
        </div>
      ) : null}

      {def.hint ? <span className="hint">{def.hint}</span> : null}
    </div>
  );
}

export default TableFieldControl;
