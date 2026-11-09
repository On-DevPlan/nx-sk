// 表格字段（`type: 'table'`）的编辑界面 —— 目标手感是「Notion 的数据库」。
//
// **这张表是自描述的**：列、行、公式、统计配置全部存在条目数据里（不在栏目字典里）。
// 所以这里除了填格子，还能直接**加列 / 改列类型 / 改公式**——改完就是这条数据的一部分，
// 不会影响同栏目下的其它条目。字段定义里的 columns 只是「新建时的初始列」。
//
// 六条刻意的取舍：
//   1. **行与列都有抓手**：行抓手在**左侧沟槽**（⠿ 拖动 + ⋮ 菜单），列抓手就是表头本身。
//      排序是这类表最常见的编辑动作，一排 ↑↓ 按钮既占地方又说不清「会插到哪」。
//   2. **列管理挂在列头上**（⋮ 打开）：改名 / 换类型 / 单位 / 汇总 / 默认值 / 密文 / 选项 / 公式
//      + 左移右移、左右插入、复制属性、删除属性。以前那一大块「列设置」表单铺在表格下面，
//      一列一行、七八个输入框，读起来像后台配置页——现在收进列头的弹层，表格回到「只有数据」。
//   3. **计算列不落盘、也不可编辑**：它由公式从同行的值算出来；把结果存下来，
//      下次改了一个数字而忘记重算，就会出现「存下来的合计和现在的数据对不上」。
//   4. **合计就摆在表尾**，不是另一个面板。看数的人不该先点一个按钮才知道总数。
//   5. **回车往下走**（最后一格回车就新起一行），Alt+↑/↓ 改上下行的同一个格子 ——
//      录一张表时手不用离开键盘，这是「像表格」和「像一堆输入框」的分界。
//   6. 每行都是**独立 grid**：列宽只由列定义决定，内容再长也不会把某一行撑歪。
//
// P3.5：实现从 `components/tableField.jsx` 原样迁入本文件（控件不再有第二份实现）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TABLE_CELL_TYPES, computeTable, columnToDef, formatCellValue } from '../../../../shared/table.ts';
import { useStore } from '../../store.tsx';
import { reorderAt, useListDrag } from '../listDrag.tsx';
import type { ControlProps } from './types.ts';

// behavior-parity §4-D1 的已知缺陷（基线同款，1:1 保留）：这里引用的 `setOptsTick`
// 在基线里就没有定义，运行期会抛 ReferenceError（选项状态已更新，仅控制台留痕）。
// `declare` 不产生任何运行时代码，只是让 TS 认这个名字；行为与基线逐字相同。
declare const setOptsTick: (fn: (n: number) => number) => void;

const GUTTER = 30; // 左侧沟槽：行号 / 抓手 / 行菜单。写死宽度——它是操作区，不是内容列
const TRAIL = 34;  // 表头末尾的「＋」列：加列的入口就长在列该长的位置（Notion 的做法）

const alignOf = (col: any) => col.align || (col.type === 'number' ? 'right' : (col.type === 'bool' ? 'center' : 'left'));

/** 列头的类型记号：只用单色字符（emoji 在面板里是禁的，见 consistency 测试）。 */
const TYPE_GLYPH: Record<string, string> = {
  text: 'Aa', textarea: '¶', number: '#', bool: '□', select: '▾', date: '▦', month: '▦', tags: '≡',
};

const TOTAL_OPTIONS: [string, string][] = [
  ['', '按类型自动'],
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

const TYPE_LABEL: Record<string, string> = {
  text: '文本', textarea: '长文本', number: '数字', bool: '勾选',
  select: '单选', date: '日期', month: '月份', tags: '多选',
};

function cellText(col: any, v: any) {
  if (v === null || v === undefined) return '';
  if (col.type === 'tags') return Array.isArray(v) ? v.join('、') : String(v);
  return String(v);
}

interface CellInputProps {
  col: any;
  value: any;
  mask: boolean;
  cellRef: string;
  onPatch: (v: any) => void;
  onEnter: () => void;
  onArrow: (dir: number) => void;
}

/** 一格输入控件。计算列不在这里 —— 它渲染成只读文本。 */
function CellInput({ col, value, mask, cellRef, onPatch, onEnter, onArrow }: CellInputProps) {
  const onKeyDown = (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); return; }
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); onArrow(1); return; }
    if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); onArrow(-1); }
  };
  // className 由每个分支自己写（checkbox 用 tf-check，其余 tf-input / num / tf-select）
  const common = { 'data-cell': cellRef, onKeyDown };

  if (col.type === 'bool') {
    const checked = value === true || value === 'true' || value === '是' || value === 1 || value === '1';
    return (
      <label className="tf-bool" title={checked ? '是（点击改成否）' : '否（点击改成是）'}>
        <input {...common} className="tf-check" type="checkbox" checked={checked} onChange={(e) => onPatch(e.target.checked)} />
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
        {opts.map((o: any) => <option key={o} value={o}>{o}</option>)}
        {custom ? <option value={v}>{v}（不在候选里）</option> : null}
      </select>
    );
  }

  if (col.type === 'number') {
    return (
      <input {...common} type="number" step="any" className="tf-input num" value={cellText(col, value)} onChange={(e) => onPatch(e.target.value)} />
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

interface PopoverProps {
  anchor: { left: number; top: number; bottom: number };
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

interface PopoverPos {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** 浮层：锚在某个元素上，点外面 / Esc 关闭。挂到 body，免得被表格的滚动容器裁掉。 */
function Popover({ anchor, onClose, children, width = 300 }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 先按估算高度摆一次，挂载后量到真实高度再校正 —— 只按「下面是 300px 够不够」猜，
  // 行菜单这种 130px 的小弹层会被无谓地翻到上面去（真实体验：菜单跑到屏幕上方）。
  const place = (h: number): PopoverPos => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.left - 12, vw - width - 8));
    const below = vh - anchor.bottom - 8;
    const above = anchor.top - 8;
    const openUp = below < h && above > below;
    return openUp
      ? { left, bottom: vh - anchor.top + 6, maxHeight: Math.max(160, Math.min(above, 520)) }
      : { left, top: anchor.bottom + 6, maxHeight: Math.max(160, Math.min(below, 520)) };
  };
  const [pos, setPos] = useState<PopoverPos>(() => place(220));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = place(el.offsetHeight);
    setPos((cur) => (cur.top === next.top && cur.bottom === next.bottom && cur.left === next.left && cur.maxHeight === next.maxHeight ? cur : next));
    // place 只依赖 anchor 与 width，跟着这两个走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div className="tf-pop" ref={ref} style={{ ...pos, width }} role="dialog">
      {children}
    </div>,
    document.body,
  );
}

interface MenuItemProps {
  glyph: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

/** 弹层里的一行操作（图标用字符，不用 emoji）。 */
function MenuItem({ glyph, onClick, danger, disabled, children }: MenuItemProps) {
  return (
    <button type="button" className={`tf-pop-item${danger ? ' danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="tf-pop-glyph">{glyph}</span>
      <span className="grow nowrap">{children}</span>
    </button>
  );
}

export function TableControl({ def, value, onChange }: ControlProps) {
  // store 目前还是 JSX（P5 才迁 TS），`createContext(null)` 让 TS 把它推成 never。
  const { ui } = useStore() as any;
  const mask = !!ui.mask;
  const rootRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState('');
  const [colMenu, setColMenu] = useState<any>(null); // { idx, rect }
  const [rowMenu, setRowMenu] = useState<any>(null); // { idx, rect }

  const table = useMemo(() => computeTable(def, value), [def, value]);
  const cols: any[] = table.columns;
  const rows = useMemo(() => table.rows.map((r: any) => r.raw), [table]);

  /** 一次改动 = 一份**完整的**表格文档（列、行都在里面），而不是只回写行。 */
  const commit = useCallback((patch: any = {}) => {
    const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    onChange({
      ...base,
      v: 1,
      columns: patch.columns || table.columns.map((c: any) => columnToDef(c)),
      rows: patch.rows || table.rows.map((r: any) => r.raw),
    });
  }, [onChange, table, value]);

  /** 表尾统计的总开关。开 = 去掉这个键（回到「按类型自动」），关 = 显式写 false。 */
  const setSummary = (on: boolean) => {
    const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const next: any = { ...base, v: 1, columns: cols.map((c) => columnToDef(c)), rows };
    if (on) {
      delete next.summary;
      if (Array.isArray(next.totals) && !next.totals.length) delete next.totals;
    } else next.summary = false;
    onChange(next);
  };

  useEffect(() => {
    if (!pending) return;
    const el: any = rootRef.current?.querySelector(`[data-cell="${pending}"]`);
    if (el) {
      el.focus();
      if (el.select && el.type !== 'checkbox') el.select();
    }
    setPending('');
  }, [pending, rows.length]);

  const grid = `${GUTTER}px ${cols.map((c) => (c.width ? `${c.width}px` : 'minmax(96px, 1fr)')).join(' ')} ${TRAIL}px`;
  // 行宽的下限：列多了就把容器撑开、横向滚动，而不是把每列压到看不见。
  const minWidth = cols.reduce((sum: number, c: any) => sum + (c.width || 96), 0) + GUTTER + TRAIL;

  const setCell = (i: number, key: string, v: any) => commit({ rows: rows.map((r: any, idx: number) => (idx === i ? { ...r, [key]: v } : r)) });

  /** 新增行时按列的 `default` 预填：没有默认值的列留空（不写 null，空着就是空着）。 */
  const seedRow = () => {
    const seed: Record<string, any> = {};
    for (const c of cols) {
      if (c.computed) continue;
      if (c.default !== undefined && c.default !== null) seed[c.key] = c.default;
    }
    return seed;
  };
  const addRow = (at?: number) => {
    const pos = at === undefined ? rows.length : at;
    const next = [...rows.slice(0, pos), seedRow(), ...rows.slice(pos)];
    commit({ rows: next });
    return pos;
  };
  const duplicateRow = (i: number) => commit({ rows: [...rows.slice(0, i + 1), { ...rows[i] }, ...rows.slice(i + 1)] });
  const removeRow = (i: number) => commit({ rows: rows.filter((_: any, idx: number) => idx !== i) });

  // 拖拽排序：落点给的是**插入位**。拖回原位时 reorderAt 返回同一个数组 —— 这时不 commit，
  // 否则条目会被标成「有改动」而其实没动。
  const rowDrag = useListDrag((from: number, insertAt: number) => {
    const next = reorderAt(rows, from, insertAt);
    if (next !== rows) commit({ rows: next });
  }, { axis: 'y' });
  const colDrag = useListDrag((from: number, insertAt: number) => {
    const next = reorderAt(cols.map(columnToDef), from, insertAt);
    if (next !== cols) commit({ columns: next });
  }, { axis: 'x' });

  const patchColumn = (i: number, patch: any) => {
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
      nextRows = rows.map((r: any) => {
        if (!(oldKey in r)) return r;
        const copy = { ...r };
        copy[nextKey] = copy[oldKey];
        delete copy[oldKey];
        return copy;
      });
    }
    commit({ columns: next, rows: nextRows });
  };

  const uniqueKey = (base: string) => {
    let key = base;
    let n = 2;
    while (cols.some((c) => c.key === key)) { key = `${base}${n}`; n += 1; }
    return key;
  };
  const newColumn = (label: string) => ({ key: uniqueKey(`col${cols.length + 1}`), label, type: 'text' });
  const insertColumn = (i: number) => {
    const at = Math.max(0, Math.min(cols.length, i));
    const next = cols.map(columnToDef);
    next.splice(at, 0, newColumn(`列${cols.length + 1}`));
    commit({ columns: next });
    setColMenu(null);
  };
  const duplicateColumn = (i: number) => {
    const src = cols[i];
    const key = uniqueKey(`${src.key}Copy`);
    const next = cols.map(columnToDef);
    next.splice(i + 1, 0, { ...columnToDef(src), key, label: `${src.label} 副本` });
    // 连值一起复制：只复制定义会得到一列全是空的「副本」
    const nextRows = rows.map((r: any) => ({ ...r, [key]: r[src.key] }));
    commit({ columns: next, rows: nextRows });
    setColMenu(null);
  };
  const moveColumn = (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const next = cols.map(columnToDef);
    [next[i], next[j]] = [next[j], next[i]];
    commit({ columns: next });
    setColMenu((m: any) => (m ? { ...m, idx: j } : m));
  };
  /** 删列要连值一起删：只删定义会让那些格子变成「没有列的数据」，写入时被挡下来。 */
  const removeColumn = (i: number) => {
    const gone = cols[i];
    const next = cols.filter((_: any, idx: number) => idx !== i).map(columnToDef);
    const nextRows = rows.map((r: any) => {
      const copy = { ...r };
      delete copy[gone.key];
      return copy;
    });
    commit({ columns: next, rows: nextRows });
    setColMenu(null);
  };

  const focusCell = (i: number, key: string) => {
    const el: any = rootRef.current?.querySelector(`[data-cell="${i}:${key}"]`);
    if (el) {
      el.focus();
      if (el.select && el.type !== 'checkbox' && el.type !== 'select') el.select();
    }
  };
  /** 回车：下一行同一列；已经是最后一行就新起一行，焦点落在新格子上。 */
  const enterFrom = (i: number, col: any) => {
    if (i + 1 < rows.length) { focusCell(i + 1, col.key); return; }
    addRow();
    setPending(`${i + 1}:${col.key}`);
  };
  /** Alt+↑/↓：同列上下移动。 */
  const arrowFrom = (i: number, col: any, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    focusCell(j, col.key);
  };

  const summaryOn = table.summary !== false;
  const menuCol = colMenu ? cols[colMenu.idx] : null;
  const menuRow = rowMenu ? rowMenu.idx : null;

  return (
    <div className="tablefield" ref={rootRef}>
      {cols.length ? (
        <div className="tf-scroll">
          <div className="tf-body" style={{ minWidth }}>
            {/* 表头：整格可拖（里面没有输入框，不会跟文本选择打架）—— 拖表头就是搬这一列 */}
            <div className="tf-row tf-head" style={{ gridTemplateColumns: grid }}>
              <div className="tf-gutter tf-gutter-head" />
              {cols.map((c, idx) => (
                <div
                  key={c.key}
                  className={`tf-th ${alignOf(c)}${colDrag.dropClass(idx)}`}
                  {...colDrag.dragStartProps(idx)}
                  {...colDrag.itemProps(idx)}
                >
                  <span className={`tf-glyph${c.computed ? ' calc' : ''}`} aria-hidden>
                    {c.computed ? 'ƒ' : (TYPE_GLYPH[c.type] || 'Aa')}
                  </span>
                  <span className="tf-th-label" title={c.hint || (c.computed ? `计算列：${c.formula}` : c.label)}>{c.label}</span>
                  {c.unit ? <span className="tf-unit">{c.unit}</span> : null}
                  {c.sensitive ? <span className="tf-badge bad" title="这一列的值密文落盘">密</span> : null}
                  <button
                    type="button"
                    className="tf-th-more"
                    title="这一列的设置"
                    aria-label={`「${c.label}」列设置`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setColMenu({ idx, rect });
                    }}
                  >⋮</button>
                </div>
              ))}
              <div className="tf-th-add">
                <button type="button" className="tf-th-add-btn" title="在最右边添加一列" onClick={() => {
                  const next = cols.map(columnToDef);
                  next.push(newColumn(`列${cols.length + 1}`));
                  commit({ columns: next });
                  setColMenu({ idx: next.length - 1, rect: rootRef.current!.getBoundingClientRect() });
                }}>＋</button>
              </div>
            </div>

            {/* 数据行：左侧沟槽 = 行号 / 抓手 / 行菜单 */}
            {table.rows.map((row: any, i: number) => (
              <div
                key={i}
                className={`tf-row${rowDrag.draggingIndex === i ? ' dragging' : ''}${rowDrag.dropClass(i)}`}
                style={{ gridTemplateColumns: grid }}
                {...rowDrag.itemProps(i)}
              >
                <div className="tf-gutter">
                  <span className="tf-rownum">{i + 1}</span>
                  <button
                    type="button"
                    className="tf-row-more"
                    title="这一行的操作"
                    aria-label={`第 ${i + 1} 行操作`}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setRowMenu({ idx: i, rect });
                    }}
                  >⋮</button>
                  <span {...rowDrag.handleProps(i)} className="tf-grip" title="拖动调整这一行的顺序">⠿</span>
                </div>
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
                <div className="tf-td tf-td-add" />
              </div>
            ))}

            {/* 统计行：合计就摆在表尾，不用点开任何东西 */}
            {table.totals.map((t: any, ti: number) => (
              <div key={`t${ti}`} className="tf-row tf-total" style={{ gridTemplateColumns: grid }}>
                <div className="tf-gutter" />
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
                <div className="tf-td tf-td-add" />
              </div>
            ))}

            {/* 新建行：像 Notion 那样就是表尾一整行，不用去工具栏找按钮 */}
            <button type="button" className="tf-addrow" style={{ gridTemplateColumns: grid }} onClick={() => {
              const at = addRow();
              const first = cols.find((c) => !c.computed);
              if (first) setPending(`${at}:${first.key}`);
            }}>
              <span className="tf-gutter"><span className="tf-plus">＋</span></span>
              <span className="tf-addrow-label" style={{ gridColumn: '2 / -1' }}>新建一行</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="tf-empty hint">这张表还没有列。先「添加列」，或一次把整份数据写进来（CLI 的 columns + rows）。</div>
      )}

      <div className="tf-bar">
        {cols.length ? null : (
          <button type="button" className="btn small" onClick={() => {
            const next = cols.map(columnToDef);
            next.push(newColumn('列1'));
            commit({ columns: next });
            setColMenu({ idx: 0, rect: rootRef.current!.getBoundingClientRect() });
          }}>＋ 添加列</button>
        )}
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

      {table.errors.length ? (
        <div className="tf-errors">
          {table.errors.slice(0, 3).map((e: any, k: number) => (
            <div key={k} className="hint bad">第 {e.row + 1} 行「{cols.find((c) => c.key === e.column)?.label || e.column}」：{e.message}</div>
          ))}
          {table.errors.length > 3 ? <div className="hint bad">另有 {table.errors.length - 3} 处</div> : null}
        </div>
      ) : null}

      {def.hint ? <span className="hint">{def.hint}</span> : null}

      {menuCol ? (
        <Popover anchor={colMenu.rect} onClose={() => setColMenu(null)} width={344}>
          <div className="tf-pop-head">
            <span className="tf-glyph large" aria-hidden>{menuCol.computed ? 'ƒ' : (TYPE_GLYPH[menuCol.type] || 'Aa')}</span>
            <input
              className="tf-pop-title"
              value={menuCol.label}
              placeholder="列名"
              aria-label="列名"
              onChange={(e) => patchColumn(colMenu.idx, { label: e.target.value })}
            />
            <select
              className="tf-pop-type"
              value={menuCol.computed ? 'formula' : menuCol.type}
              aria-label="列类型"
              onChange={(e) => {
                const t = e.target.value;
                if (t === 'formula') patchColumn(colMenu.idx, { type: 'number', formula: menuCol.formula || '' });
                else patchColumn(colMenu.idx, { type: t, formula: '', options: t === 'select' ? (menuCol.options?.length ? menuCol.options : ['选项1', '选项2']) : [] });
              }}
            >
              {TABLE_CELL_TYPES.map((t: string) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
              <option value="formula">计算列（JS）</option>
            </select>
          </div>

          <div className="tf-pop-field">
            <span className="tf-pop-key">key</span>
            <input
              className="mono"
              value={menuCol.key}
              placeholder="列 key（公式里引用它）"
              aria-label="列 key"
              onChange={(e) => patchColumn(colMenu.idx, { key: e.target.value })}
            />
          </div>

          {menuCol.computed ? (
            <div className="tf-pop-field">
              <span className="tf-pop-key">公式</span>
              <input
                className="mono"
                value={menuCol.formula || ''}
                placeholder="例如 qty * price"
                aria-label="公式"
                onChange={(e) => patchColumn(colMenu.idx, { formula: e.target.value })}
              />
            </div>
          ) : (
            <>
              <div className="tf-pop-row">
                <label className="tf-pop-field tight">
                  <span className="tf-pop-key">单位</span>
                  <input value={menuCol.unit || ''} placeholder="元 / 小时" onChange={(e) => patchColumn(colMenu.idx, { unit: e.target.value })} />
                </label>
                <label className="tf-pop-field tight">
                  <span className="tf-pop-key">默认值</span>
                  <input
                    value={menuCol.default === undefined || menuCol.default === null ? '' : String(menuCol.default)}
                    placeholder="新增行时的初值"
                    onChange={(e) => patchColumn(colMenu.idx, { default: e.target.value })}
                  />
                </label>
              </div>
              {menuCol.type === 'select' ? (
                <div className="tf-pop-field">
                  <span className="tf-pop-key">选项</span>
                  <input
                    value={(menuCol.options || []).join('，')}
                    placeholder="未开始，进行中，已完成"
                    aria-label="下拉选项"
                    onChange={(e) => {
                      const options = e.target.value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
                      patchColumn(colMenu.idx, { options });
                      setOptsTick((n) => n + 1);
                    }}
                  />
                </div>
              ) : null}
            </>
          )}

          <div className="tf-pop-field">
            <span className="tf-pop-key">统计</span>
            <select
              value={menuCol.total || ''}
              aria-label="表尾统计方式"
              onChange={(e) => patchColumn(colMenu.idx, { total: e.target.value })}
            >
              {TOTAL_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            {!menuCol.computed ? (
              <label className="tf-pop-check" title="这一列的值以 AES-256-GCM 密文落盘">
                <input type="checkbox" checked={!!menuCol.sensitive} onChange={(e) => patchColumn(colMenu.idx, { sensitive: e.target.checked })} />
                密文
              </label>
            ) : null}
          </div>

          <div className="tf-pop-sep" />
          <div className="tf-pop-grid">
            <MenuItem glyph="←" disabled={colMenu.idx === 0} onClick={() => moveColumn(colMenu.idx, -1)}>左移</MenuItem>
            <MenuItem glyph="→" disabled={colMenu.idx === cols.length - 1} onClick={() => moveColumn(colMenu.idx, 1)}>右移</MenuItem>
            <MenuItem glyph="⇤" onClick={() => insertColumn(colMenu.idx)}>向左插入列</MenuItem>
            <MenuItem glyph="⇥" onClick={() => insertColumn(colMenu.idx + 1)}>向右插入列</MenuItem>
            <MenuItem glyph="⧉" onClick={() => duplicateColumn(colMenu.idx)}>复制属性</MenuItem>
            <MenuItem glyph="×" danger onClick={() => removeColumn(colMenu.idx)}>删除属性</MenuItem>
          </div>
          <div className="tf-pop-foot">改动立即生效（保存条目后落盘）。key 建议英文，公式里最好写。</div>
        </Popover>
      ) : null}

      {menuRow !== null ? (
        <Popover anchor={rowMenu.rect} onClose={() => setRowMenu(null)} width={184}>
          <div className="tf-pop-grid one">
            <MenuItem glyph="⇧" onClick={() => { addRow(menuRow); setRowMenu(null); }}>在上方插入一行</MenuItem>
            <MenuItem glyph="⇩" onClick={() => { addRow(menuRow + 1); setRowMenu(null); }}>在下方插入一行</MenuItem>
            <MenuItem glyph="⧉" onClick={() => { duplicateRow(menuRow); setRowMenu(null); }}>复制这一行</MenuItem>
            <MenuItem glyph="×" danger onClick={() => { removeRow(menuRow); setRowMenu(null); }}>删除这一行</MenuItem>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
