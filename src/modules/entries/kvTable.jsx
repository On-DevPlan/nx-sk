import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Copyable, Empty } from '../../web/frontend/components/ui.jsx';

/**
 * KV 表格：`kv: true` 栏目的**唯一**编辑界面。
 *
 * 一行 = 一个键值对（名称 → 值）。**没有**条目列表、没有字段表单、没有完整性百分比 ——
 * 密钥就是一张表，别的一概不需要。
 *
 * 读写走 `key *` 那套接口（它本来就是 entry 命令的语法糖，共用同一份 service），
 * 所以这里每个操作都有等价的 CLI 命令，且不可能和 CLI 分叉。
 */
export default function KvTable({ sectionId, sectionTitle }) {
  const { ui, patchUi, toast, guard, dialog, reload } = useStore();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({}); // 名称 → 正在编辑的值
  const [added, setAdded] = useState({ name: '', value: '' });
  const mask = !!ui.mask;

  const load = useCallback(async () => {
    try {
      const q = `section=${encodeURIComponent(sectionId)}${mask ? '&mask=1' : ''}`;
      const d = await api(`/api/keys?${q}`);
      setData(d);
      const next = {};
      for (const k of d.keys) next[k.name] = k.value ?? '';
      setDraft(next);
    } catch (e) {
      toast(e.message, 'bad');
      setData(null);
    }
  }, [sectionId, mask, toast]);

  useEffect(() => { load(); }, [load]);

  const saveValue = guard(async (row) => {
    const next = draft[row.name];
    if ((row.value ?? '') === next) return; // 没改就不发请求
    // 写操作的参数必须放 body —— 后端对非 GET 只合并 body（与 ?query= 无关）
    await api(`/api/keys/${encodeURIComponent(row.name)}`, {
      method: 'PUT', body: { value: next, section: sectionId },
    });
    toast(`已保存 ${row.name}`);
    await load();
  });

  const rename = guard(async (row, newName) => {
    const name = String(newName || '').trim();
    if (!name || name === row.name) return;
    if (data.keys.some((k) => k.name === name)) { toast(`已经有叫「${name}」的键了`, 'bad'); await load(); return; }
    await api(`/api/entries/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { title: name } });
    // draft 的键跟着迁移，否则值输入框（以 row.name 为 key）会显示成空、
    // 下一次 blur 还会把值写到旧键名下
    setDraft((d) => {
      const next = {};
      for (const [k, v] of Object.entries(d)) next[k === row.name ? name : k] = v;
      return next;
    });
    toast(`已重命名为 ${name}`);
    await load();
    await reload();
  });

  const addKey = guard(async () => {
    const name = added.name.trim();
    if (!name) { toast('先填键名，例如 OPENAI_KEY', 'bad'); return; }
    if (data.keys.some((k) => k.name === name)) { toast(`已经有叫「${name}」的键了——直接在上面那行改值即可`, 'bad'); return; }
    await api(`/api/keys/${encodeURIComponent(name)}`, {
      method: 'PUT', body: { value: added.value, section: sectionId },
    });
    setAdded({ name: '', value: '' });
    toast(`已新增 ${name}`);
    await load();
    await reload();
  });

  const removeKey = guard(async (row) => {
    const ok = await dialog({
      message: `删除「${row.name}」？删除前会自动留一份整库快照在 ~/nx-sk/backup。`,
      danger: true, confirmText: '删除',
    });
    if (!ok) return;
    await api(`/api/keys/${encodeURIComponent(row.name)}`, { method: 'DELETE', body: { section: sectionId } });
    toast(`已删除 ${row.name}`);
    await load();
    await reload();
  });

  if (!data) return <div className="pad muted">加载中…</div>;

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>{sectionTitle}</strong>
        <span className="muted">{data.count} 个键 · 名称 → 值</span>
        <span className="grow" />
        <label className="inline hint">
          <input type="checkbox" checked={mask} onChange={() => patchUi({ mask: !mask })} />
          打码显示（投屏/截图时用）
        </label>
        <button className="btn small ghost" onClick={load}>刷新</button>
      </div>

      <div className="card">
        <div className="colhead">
          <span style={{ width: 200 }}>名称</span>
          <span className="grow">值</span>
        </div>
        <div className="colbody">
          {data.keys.length ? data.keys.map((row) => (
            <div key={row.id} className="row">
              <input
                className="mono"
                style={{ width: 200 }}
                defaultValue={row.name}
                title="改完按回车或点开别处即重命名"
                onBlur={(e) => rename(row, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <input
                className="mono grow"
                value={draft[row.name] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [row.name]: e.target.value }))}
                onBlur={() => saveValue(row)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span className="acts">
                <Copyable className="tag" text={draft[row.name] ?? ''} title="点击复制值">复制</Copyable>
                <button className="btn small ghost" onClick={() => removeKey(row)}>删除</button>
              </span>
            </div>
          )) : <Empty>还没有密钥。在下面一行填「名称 / 值」按添加，或 CLI：nx-sk key set OPENAI_KEY sk-xxx</Empty>}

          <div className="row">
            <input
              className="mono"
              style={{ width: 200 }}
              placeholder="新键名，例如 OPENAI_KEY"
              value={added.name}
              onChange={(e) => setAdded((a) => ({ ...a, name: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') addKey(); }}
            />
            <input
              className="mono grow"
              placeholder="值（留空也行，之后再填）"
              value={added.value}
              onChange={(e) => setAdded((a) => ({ ...a, value: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') addKey(); }}
            />
            <span className="acts"><button className="btn small" onClick={addKey}>添加</button></span>
          </div>
        </div>
      </div>

      <div className="pad hint">
        改值：直接在「值」列改完按回车（或点开别处）即保存。改键名同理。
        值以密文落盘，这里显示的是原文；要打码勾上方那个框。删除前自动整库快照。
      </div>

      <CliHints module="entries" />
    </>
  );
}
