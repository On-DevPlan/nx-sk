// 模板编辑器里的一个字段块：一行基础属性 + 可展开的「字段属性」。
//
// 从 dictEditor.tsx 拆出来，是因为模板编辑器本身已经接近行数登记档；字段块的
// 交互（拖拽把手、类型、填写策略、options / maxItems / maxRows / 默认值）是独立的，
// 放在一起只会让「新增字段 / 分组编排」那条主线更难读。
import { useEffect, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Tag } from '../../components/ui.tsx';
import type { FieldDef, FieldType } from '../../../../shared/fields/types.ts';

export const LIST_TYPES: string[] = ['entrylist', 'table'];
/** 后端会强制 maxItems 的类型（table 用 maxRows，单独处理）。 */
const MAX_ITEM_TYPES = new Set(['tags', 'file', 'debug', 'entrylist']);

/** 回车即失焦：文本类改动在 blur 时提交，回车提交比「点别处」更符合手感。 */
export const blurOnEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };

/** 默认值的展示：字符串原样，其他按 JSON。 */
function fmtDefault(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 默认值输入：能当 JSON 用就当（数字/布尔/数组/对象），否则按普通文本。 */
function parseDefault(s: string): unknown {
  const raw = s.trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

interface FieldBlockProps {
  f: FieldDef;
  types: FieldType[];
  labels: Record<string, string>;
  locked: boolean;
  cls: string;
  onRowOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDropRow: () => void;
  onStart: (e: ReactDragEvent<HTMLElement>) => void;
  onEnd: () => void;
  onSet: (patch: Record<string, unknown>) => void;
  onFill: (policy: string) => void;
  onRemove: () => void;
}

export function FieldBlock({ f, types, labels, locked, cls, onRowOver, onDropRow, onStart, onEnd, onSet, onFill, onRemove }: FieldBlockProps) {
  const [label, setLabel] = useState(f.label);
  const [hint, setHint] = useState(f.hint || '');
  const [openProps, setOpenProps] = useState(false);
  const optionsText = f.type === 'select' ? (f.options || []).join(', ') : '';
  const maxValue = f.type === 'table' ? f.maxRows : (MAX_ITEM_TYPES.has(f.type) ? f.maxItems : undefined);
  const defaultText = fmtDefault(f.defaultValue);
  const [opts, setOpts] = useState(optionsText);
  const [max, setMax] = useState(maxValue == null ? '' : String(maxValue));
  const [def, setDef] = useState(defaultText);
  useEffect(() => { setLabel(f.label); setHint(f.hint || ''); }, [f.label, f.hint]);
  useEffect(() => { setOpts(optionsText); }, [optionsText]);
  useEffect(() => { setMax(maxValue == null ? '' : String(maxValue)); }, [maxValue]);
  useEffect(() => { setDef(defaultText); }, [defaultText]);
  const isList = LIST_TYPES.includes(f.type);
  const cols: unknown[] = isList
    ? (('fields' in f ? f.fields : undefined) || ('columns' in f ? f.columns : undefined) || [])
    : [];
  const supportsOptions = f.type === 'select';
  const supportsMax = f.type === 'table' || MAX_ITEM_TYPES.has(f.type);
  const supportsSummary = f.type === 'table';
  const supportsDefault = f.type !== 'group';
  const showProps = supportsOptions || supportsMax || supportsSummary || supportsDefault;

  const commitLabel = () => {
    const v = label.trim();
    if (!v || v === f.label) { setLabel(f.label); return; }
    onSet({ label: v });
  };
  const commitHint = () => {
    const v = hint.trim();
    if (v === (f.hint || '')) return;
    onSet({ hint: v });
  };
  const commitOptions = () => {
    const list = opts.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    if (list.join('\u0000') === (f.type === 'select' ? (f.options || []) : []).join('\u0000')) return;
    onSet({ options: list });
  };
  const commitMax = () => {
    const raw = max.trim();
    if (!raw) {
      if (maxValue != null) onSet(f.type === 'table' ? { maxRows: null } : { maxItems: null });
      return;
    }
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) { setMax(maxValue == null ? '' : String(maxValue)); return; }
    if (n === maxValue) return;
    onSet(f.type === 'table' ? { maxRows: n } : { maxItems: n });
  };
  const commitDefault = () => {
    const v = parseDefault(def);
    if (JSON.stringify(v) === JSON.stringify(f.defaultValue ?? null)) return;
    onSet({ defaultValue: v });
  };

  return (
    <>
      <div className={cls} onDragOver={onRowOver} onDrop={(e) => { e.preventDefault(); onDropRow(); }}>
        <span
          className="tf-grip"
          draggable
          onDragStart={onStart}
          onDragEnd={onEnd}
          title="拖动：组内换序；拖进别的分组 = 挪过去"
          aria-label="拖动调整顺序或挪分组"
        >⠿</span>
        <input
          className="d-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={blurOnEnter}
          title="字段标签（改名不影响已填的值）"
        />
        <span className="mono muted d-key" title="key 不能改：条目里的值按 key 存，改了就读不出来了">{f.key}</span>
        <select
          style={{ width: 140 }}
          value={f.type}
          onChange={(e) => onSet({ type: e.target.value })}
          title="字段类型"
        >
          {types.map((t) => (
            <option key={t} value={t} disabled={LIST_TYPES.includes(t) && !isList}>
              {labels[t] ? `${labels[t]}（${t}）` : t}
            </option>
          ))}
        </select>
        <select
          style={{ width: 76 }}
          value={f.fill || 'normal'}
          onChange={(e) => onFill(e.target.value)}
          title="必填策略：选填与避免填都不计入完整度（避免填还会提示别填）"
        >
          <option value="normal">必填</option>
          <option value="optional">选填</option>
          <option value="avoid">避免填</option>
        </select>
        <input
          className="d-hint"
          placeholder="提示（hint）"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          onBlur={commitHint}
          onKeyDown={blurOnEnter}
        />
        {isList ? <Tag>{cols.length} 列</Tag> : null}
        {f.sensitive ? <Tag kind="bad">密文</Tag> : null}
        {showProps ? (
          <button
            type="button"
            className={`btn small ghost${openProps ? ' active' : ''}`}
            onClick={() => setOpenProps((v) => !v)}
            aria-expanded={openProps}
            title="字段属性：选项 / 上限 / 默认值 / 表尾统计"
          >
            属性
          </button>
        ) : null}
        <button
          type="button"
          className="btn small ghost danger-ghost"
          disabled={locked}
          onClick={onRemove}
          title={locked ? '「原始资料」是每个条目模板自带的字段，删了下回读又会补回来' : '从字典里删掉这个字段（已填的值会留在条目里，只是不再显示/校验）'}
        >
          删除
        </button>
      </div>
      {openProps && showProps ? (
        <div className="dprops">
          {supportsOptions ? (
            <label className="dprop">
              <span>选项</span>
              <input
                style={{ width: 300 }}
                placeholder="逗号分隔，例如：未开始，进行中，已完成"
                value={opts}
                onChange={(e) => setOpts(e.target.value)}
                onBlur={commitOptions}
                onKeyDown={blurOnEnter}
              />
            </label>
          ) : null}
          {supportsMax ? (
            <label className="dprop">
              <span>{f.type === 'table' ? '最多行数' : '最多项'}</span>
              <input
                type="number"
                min={1}
                style={{ width: 90 }}
                placeholder="不限"
                value={max}
                onChange={(e) => setMax(e.target.value)}
                onBlur={commitMax}
                onKeyDown={blurOnEnter}
              />
            </label>
          ) : null}
          {supportsSummary ? (
            <label className="dprop inline hint" title="表格底部显示合计行">
              <input
                type="checkbox"
                checked={f.type === 'table' && f.summary !== false}
                onChange={(e) => onSet({ summary: e.target.checked })}
              />
              显示表尾统计
            </label>
          ) : null}
          {supportsDefault ? (
            <label className="dprop">
              <span>默认值</span>
              <input
                style={{ width: 220 }}
                placeholder="新建条目 / 同步补行时落这个；文本或 JSON"
                value={def}
                onChange={(e) => setDef(e.target.value)}
                onBlur={commitDefault}
                onKeyDown={blurOnEnter}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
