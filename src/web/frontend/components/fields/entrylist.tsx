// 结构清单字段（`type: 'entrylist'`）：一个字段装**变长的一张迷你表**。
//
// 场景：一个条目要挂「多组 链接/账号/密码」——tags 存不了结构，拆成多个字段
// 又不知道会有几组。列（子字段）由字段字典声明（def.fields），行自由增删；
// 敏感列与顶层敏感字段同一条边界（密文落盘），输入框按工具栏的「打码显示」
// 切 password 形态（只是显示形态，值始终是草稿里的原文）。
//
// 密集：列头 + 行输入框直接铺开，没有「先展开再编辑」的两段式——这类清单
// 就是拿来快速增删查改的。空行不用管，保存时服务端会剔除全空行。
import { useStore } from '../../store.tsx';
import { reorderAt, useListDrag } from '../listDrag.tsx';
import type { ControlProps } from './types.ts';

export function EntryListControl({ def, value, onChange }: ControlProps) {
  const { ui } = useStore();
  const mask = !!ui.mask;
  const subs = Array.isArray(def.fields) ? def.fields : [];
  const rows = Array.isArray(value) ? value.filter((r: any) => r && typeof r === 'object') : [];
  const template = `${subs.map(() => 'minmax(0, 1fr)').join(' ')} auto`;

  const setRow = (i: number, key: string, v: any) => onChange(rows.map((r: any, idx: number) => (idx === i ? { ...r, [key]: v } : r)));
  const addRow = () => onChange([...rows, {}]);
  const removeRow = (i: number) => onChange(rows.filter((_: any, idx: number) => idx !== i));
  // 行拖拽：清单的输入框里要能选词，所以**只有把手可拖**（与表格同一套）
  const rowDrag = useListDrag((from: number, insertAt: number) => onChange(reorderAt(rows, from, insertAt)));

  if (!subs.length) {
    return <span className="hint">这个清单字段没有声明列（子字段），渲染不出输入格。用 section update 把字段的 fields 子字段补上。</span>;
  }

  return (
    <div className="entrylist">
      <div className="entrylist-head" style={{ gridTemplateColumns: template }}>
        {subs.map((s: any) => (
          <span key={s.key} className="entrylist-col" title={s.hint || ''}>
            {s.label}
            {s.sensitive ? <span className="tag bad">密文</span> : null}
          </span>
        ))}
        <span />
      </div>
      {rows.map((row: any, i: number) => (
        <div
          key={i}
          className={`entrylist-row${rowDrag.draggingIndex === i ? ' dragging' : ''}${rowDrag.dropClass(i)}`}
          style={{ gridTemplateColumns: template }}
          {...rowDrag.itemProps(i)}
        >
          {subs.map((s: any) => (
            <input
              key={s.key}
              type={s.sensitive && mask ? 'password' : 'text'}
              autoComplete="off"
              value={String(row[s.key] ?? '')}
              placeholder={s.sensitive ? '密文落盘' : ''}
              onChange={(e) => setRow(i, s.key, e.target.value)}
            />
          ))}
          {/* 行内操作一律小图标键（不是 btn）：这是密集迷你表，一颗正常大小的按钮
              会把一行的高度和注意力都吃掉 —— 与表格字段同一口径 */}
          <span className="entrylist-acts">
            <span {...rowDrag.handleProps(i)}>⠿</span>
            <button type="button" className="tf-mini" title="删除这一行" onClick={() => removeRow(i)}>×</button>
          </span>
        </div>
      ))}
      <div className="entrylist-add">
        <button type="button" className="btn small" onClick={addRow}>＋ 添加一行</button>
        <span className="hint">{rows.length ? `${rows.length} 行` : '还没有行'}　·　变长，空行保存时自动剔除　·　拖 ⠿ 可调顺序</span>
      </div>
    </div>
  );
}
