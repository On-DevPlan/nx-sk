// 条目内字段的两个弹窗（任务 #24 验收反馈：块头「⋯ → 查看字段 / 编辑字段属性」）。
//
// 为什么单独成文件而不是塞进 entries/view.tsx：那个视图已经贴着行数预算的 approved 档，
// 而「字段详情 / 属性编辑」与正文版式（块布局、拖拽）没有关系，放一起只会让两件事互相拖累。
//
// 口径（与 add-field / remove-field 同一条写时复制纪律）：
//   - **查看**只读：定义（label / key / 类型 / 分组 / 来源 / 密文 / 填写策略 / 描述）、
//     当前值、定位符（可复制给 agent）。
//   - **编辑**只写**这一条条目的结构行**（display label + desc），不动栏目字典与其他条目；
//     值（field_data）也不碰——改个显示名不该把草稿里的值一起提交。
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useStore } from '../store.tsx';
import { copyText, Modal } from './ui.tsx';
import type { FieldDef } from '../../../shared/fields/types.ts';

/** 字段来源的人读标签：模板字段来自栏目字典，扩展字段只属于这一条。 */
const ORIGIN_LABEL = { template: '栏目模板字段', extension: '条目扩展字段' } as const;

/** 值的展示形态：对象/数组走 JSON，其余原样；空值给一句人话。 */
function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (typeof v === 'object') {
    const s = JSON.stringify(v, null, 2);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  }
  return String(v);
}

export interface FieldInfoModalProps {
  entryId: string;
  def: FieldDef;
  value: unknown;
  sectionTitle?: string;
  entryTitle?: string;
  onClose: () => void;
}

/** 「查看字段」：定义 + 当前值 + 定位符，纯只读。 */
export function FieldInfoModal({ entryId, def, value, sectionTitle, entryTitle, onClose }: FieldInfoModalProps) {
  const { toast } = useStore();
  const locator = `nx-sk://field/${entryId}/${def.key}`;
  const origin = def.template === false ? ORIGIN_LABEL.extension : ORIGIN_LABEL.template;
  const rows: Array<[string, string]> = [
    ['显示名', def.label || def.key],
    ['字段 key', def.key],
    ['类型', def.type],
    ['分组', def.group || '—'],
    ['来源', origin],
    ['填写策略', def.fillLabel || def.fill || 'normal'],
  ];
  if (def.sensitive) rows.push(['密文', '是（读出口默认原文，打码模式下掩码）']);
  if (def.hint) rows.push(['描述', def.hint]);

  const copyLoc = async () => {
    const ok = await copyText(locator);
    toast(ok ? `已复制定位符：${locator}` : '复制失败：浏览器拒绝了剪贴板访问', ok ? 'ok' : 'bad');
  };

  return (
    <Modal
      title={`字段详情 · ${def.label || def.key}`}
      onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>关闭</button>}
    >
      <div className="stack">
        <div className="hint nowrap">
          {sectionTitle || ''}{entryTitle ? ` › ${entryTitle}` : ''} · {entryId}
        </div>
        <div className="fldinfo">
          {rows.map(([k, v]) => (
            <div key={k} className="fldinfo-row">
              <span className="fldinfo-k">{k}</span>
              <span className="fldinfo-v">{v}</span>
            </div>
          ))}
          <div className="fldinfo-row">
            <span className="fldinfo-k">定位符</span>
            <span className="fldinfo-v">
              <code className="mono fldinfo-loc" title="贴给 agent 即可定位这个字段">{locator}</code>
              <button type="button" className="btn small ghost" onClick={copyLoc}>复制</button>
            </span>
          </div>
        </div>
        <div className="field wide">
          <div className="flabel"><span>当前值</span><span className="fkey">只读预览</span></div>
          <pre className="block fldinfo-value">{valueText(value)}</pre>
        </div>
        <div className="hint">
          「编辑字段属性」只改<b>这一条条目</b>的显示名与描述（写时复制），栏目模板与其他条目不受影响；
          要改整栏目的字段字典，请到栏目设置里改。
        </div>
      </div>
    </Modal>
  );
}

export interface FieldEditModalProps {
  entryId: string;
  def: FieldDef;
  onClose: () => void;
  /** 保存成功：父级重新拉 dump（块头标签要立刻变）。 */
  onSaved: () => void | Promise<void>;
}

/** 「编辑字段属性」：显示名 + 描述 → PATCH 条目结构行。 */
export function FieldEditModal({ entryId, def, onClose, onSaved }: FieldEditModalProps) {
  const { toast, guard } = useStore();
  const [label, setLabel] = useState(def.label || def.key);
  const [hint, setHint] = useState(def.hint || '');
  const [busy, setBusy] = useState(false);

  const same = label.trim() === (def.label || def.key) && hint === (def.hint || '');

  const submit = guard(async () => {
    if (!label.trim()) { toast('显示名不能为空', 'bad'); return; }
    setBusy(true);
    try {
      await api(`/api/entries/${encodeURIComponent(entryId)}/fields/${encodeURIComponent(def.key)}`, {
        method: 'PATCH',
        body: { label: label.trim(), hint },
      });
      toast(`已更新字段「${label.trim()}」的属性（仅本条目）`);
      await onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  });

  return (
    <Modal
      title={`编辑字段属性 · ${def.label || def.key}`}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={submit} disabled={busy || same || !label.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <div className="hint">
          只作用于<b>这一条条目</b>（写时复制）：栏目「{def.template === false ? '扩展字段' : '模板'}」与其他条目保持原样，
          值不受影响。
        </div>
        <div className="grid">
          <div className="field">
            <div className="flabel"><span>显示名</span><span className="fkey">label</span></div>
            <div className="fctrl">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：预算（万元）" />
            </div>
          </div>
          <div className="field wide">
            <div className="flabel"><span>描述</span><span className="fkey">hint</span></div>
            <div className="fctrl">
              <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="这个字段怎么填 / 口径是什么（可留空）" />
            </div>
          </div>
        </div>
        <div className="hint mono">{`nx-sk://field/${entryId}/${def.key}`} · 字段 key 不可改（改 key 等于换一个字段）</div>
      </div>
    </Modal>
  );
}
