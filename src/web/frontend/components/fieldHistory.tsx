// 字段值历史的两个弹窗（任务 #27）：
//   - FieldHistoryModal：块头「⋯ → 变化历史」——单个字段的版本列表 + 恢复；
//   - EntryHistoryModal：条目底部「变化历史」——全字段变化按时间倒序的时间线。
//
// 纯展示组件：数据只从 /api 读，恢复动作调 REST 接口，刷新由容器（view.tsx）负责。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { useStore } from '../store.tsx';
import { Modal } from './ui.tsx';
import type { FieldDef } from '../../../shared/fields/types.ts';

interface HistoryItem {
  rev: number;
  key: string;
  label: string;
  type: string;
  op: string;
  at: string;
  value: unknown;
  prevValue: unknown;
  sensitive: boolean;
}

interface FieldHistoryData {
  id: string;
  title: string;
  sectionTitle: string;
  field: { key: string; label: string; type: string };
  current: unknown;
  count: number;
  items: HistoryItem[];
}

interface EntryHistoryData {
  id: string;
  title: string;
  sectionTitle: string;
  count: number;
  items: HistoryItem[];
}

const OP_LABEL: Record<string, string> = { set: '修改', clear: '清空', restore: '恢复' };

function fmtAt(at: string): string {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function valueText(v: unknown, max = 1200): string {
  if (v === null || v === undefined || v === '') return '（空）';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return norm(a) === norm(b);
}

/** 单个字段的历史：版本号 = rev（恢复也追加新版本，历史只增不改）。 */
export function FieldHistoryModal({
  entryId,
  def,
  onClose,
  onRestored,
}: {
  entryId: string;
  def: FieldDef;
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}) {
  const { toast, guard, dialog } = useStore();
  const [data, setData] = useState<FieldHistoryData | null>(null);
  const [error, setError] = useState('');
  const [busyRev, setBusyRev] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await api<FieldHistoryData>(
        `/api/entries/${encodeURIComponent(entryId)}/fields/${encodeURIComponent(def.key)}/history?limit=100`,
      );
      setData(d);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [entryId, def.key]);

  useEffect(() => { load(); }, [load]);

  const restore = guard(async (rev: number) => {
    const ok = await dialog({
      title: '恢复字段版本',
      message: `把「${def.label || def.key}」恢复到 v${rev}？`,
      detail: '恢复会写回该版本的值，并记为新版本；当前值仍留在历史里，可以再恢复回来。',
      confirmText: '恢复',
    });
    if (!ok) return;
    setBusyRev(rev);
    try {
      await api(`/api/entries/${encodeURIComponent(entryId)}/fields/${encodeURIComponent(def.key)}/restore`, {
        method: 'POST',
        body: { rev },
      });
      toast(`已恢复到 v${rev}`);
      await load();
      await onRestored();
    } finally {
      setBusyRev(0);
    }
  });

  const current = data?.current;
  return (
    <Modal
      title={`变化历史 · ${def.label || def.key}`}
      onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>关闭</button>}
    >
      <div className="stack">
        <div className="hint nowrap">
          {data?.sectionTitle || ''}{data?.title ? ` › ${data.title}` : ''} · {entryId}
        </div>
        <div className="hint">
          共 <b>{data?.count ?? 0}</b> 个版本（越靠上是越新的）。当前值：
          <code className="mono">{valueText(current, 200)}</code>
        </div>
        {error ? <div className="hint bad">{error}</div> : null}
        {!data && !error ? <div className="hint">加载中…</div> : null}
        {data && !data.count ? (
          <div className="hint">还没有历史：从升级后的第一次修改开始记录。</div>
        ) : null}
        {data?.items.map((it) => (
          <div key={`${it.rev}-${it.at}`} className="fldinfo-row">
            <span className="fldinfo-k mono">v{it.rev}</span>
            <span className="fldinfo-v">
              <span className="hint nowrap">{fmtAt(it.at)} · {OP_LABEL[it.op] || it.op}</span>
              <pre className="block fldinfo-value">{valueText(it.value)}</pre>
              <button
                type="button"
                className="btn small ghost"
                disabled={busyRev !== 0 || sameValue(it.value, current)}
                onClick={() => { void restore(it.rev); }}
                title={sameValue(it.value, current) ? '与当前值相同' : `恢复到 v${it.rev}`}
              >
                {busyRev === it.rev ? '恢复中…' : '恢复此版'}
              </button>
            </span>
          </div>
        ))}
        <div className="hint">
          版本按「保存」计数：自动保存每触发一次就是新版本。嫌版本太多，可在
          <b> 设置 → 默认行为 → 字段历史保留 </b>改成「最近 N 版」或「最近 N 天」。
        </div>
      </div>
    </Modal>
  );
}

/** 一个条目的变化流程：所有字段的历史按时间倒序摊平成一条时间线。 */
export function EntryHistoryModal({
  entryId,
  entryTitle,
  onClose,
}: {
  entryId: string;
  entryTitle: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<EntryHistoryData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const d = await api<EntryHistoryData>(
          `/api/entries/${encodeURIComponent(entryId)}/history?limit=200`,
        );
        setData(d);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [entryId]);

  return (
    <Modal
      title={`变化历史 · ${entryTitle || entryId}`}
      onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>关闭</button>}
    >
      <div className="stack">
        <div className="hint">
          {data?.sectionTitle || ''} · 共 <b>{data?.count ?? 0}</b> 条字段变化（按时间倒序）。
          单字段恢复在块的「⋯ → 变化历史」里。
        </div>
        {error ? <div className="hint bad">{error}</div> : null}
        {!data && !error ? <div className="hint">加载中…</div> : null}
        {data && !data.count ? (
          <div className="hint">还没有历史：从升级后的第一次修改开始记录。</div>
        ) : null}
        {data?.items.map((it) => (
          <div key={`${it.key}-${it.rev}-${it.at}`} className="fldinfo-row">
            <span className="fldinfo-k mono">v{it.rev}</span>
            <span className="fldinfo-v">
              <span className="nowrap">
                <b>{it.label}</b>
                <span className="hint">（{it.key}）· {fmtAt(it.at)} · {OP_LABEL[it.op] || it.op}</span>
              </span>
              <pre className="block fldinfo-value">
                {it.op === 'clear'
                  ? `${valueText(it.prevValue, 400)} → （清空）`
                  : it.prevValue === null
                    ? valueText(it.value, 400)
                    : `${valueText(it.prevValue, 300)} → ${valueText(it.value, 300)}`}
              </pre>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
