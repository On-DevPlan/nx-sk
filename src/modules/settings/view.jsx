import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Copyable, Empty, Tag } from '../../web/frontend/components/ui.jsx';

export default function SettingsView() {
  const { boot, reload, toast, guard } = useStore();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [groups, setGroups] = useState([]);
  // 面板地址不写死：直接取用户此刻访问的这个 origin，换端口/换 host 都自动跟上
  const panelUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const panelPort = typeof window === 'undefined' ? '' : (window.location.port || '80');

  const load = useCallback(async () => {
    try {
      const d = await api('/api/settings');
      setData(d);
      setForm({ ...d.settings });
      setGroups((d.settings.navGroups || []).map((g) => ({ title: g.title, sections: [...g.sections] })));
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const save = guard(async () => {
    const body = {
      exportDir: form.exportDir,
      exportFormat: form.exportFormat,
      includeSecretsInExport: !!form.includeSecretsInExport,
      defaultSection: form.defaultSection,
    };
    const r = await api('/api/settings', { method: 'PATCH', body });
    toast('设置已保存');
    setData({ ...data, settings: r.set });
    await reload();
  });

  // 头部导航分组：组顺序 = 头部显示顺序；一个栏目只能属于一个组（别组已勾的置灰）
  const patchGroup = (gi, patch) => setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, ...patch } : g)));

  const toggleMember = (gi, sid) => setGroups((gs) => gs.map((g, i) => {
    if (i !== gi) return g;
    const has = g.sections.includes(sid);
    return { ...g, sections: has ? g.sections.filter((x) => x !== sid) : [...g.sections, sid] };
  }));

  const moveGroup = (gi, delta) => setGroups((gs) => {
    const to = gi + delta;
    if (to < 0 || to >= gs.length) return gs;
    const next = [...gs];
    [next[gi], next[to]] = [next[to], next[gi]];
    return next;
  });

  const saveGroups = guard(async () => {
    const naked = groups.find((g) => !String(g.title).trim());
    if (naked) { toast('每个分组都要有组名', 'bad'); return; }
    const empty = groups.find((g) => !g.sections.length);
    if (empty) { toast(`分组「${empty.title}」还没有勾选栏目——要么勾一个，要么删掉这个分组`, 'bad'); return; }
    const r = await api('/api/settings', { method: 'PATCH', body: { navGroups: groups } });
    toast(groups.length ? `已保存 ${groups.length} 个导航分组` : '已取消分组，栏目恢复平铺');
    setData({ ...data, settings: r.set });
    setGroups((r.set.navGroups || []).map((g) => ({ title: g.title, sections: [...g.sections] })));
    await reload();
  });

  if (!data || !form) return <div className="pad muted">加载中…</div>;

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>设置</strong>
        <span className="muted">本机配置与运行状态</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={load}>重新读取</button>
      </div>

      <div className="card">
        <div className="colhead">存储与运行</div>
        <div className="colbody">
          <InfoRow label="数据目录" value={boot?.home} copy={boot?.home} />
          <InfoRow label="store.json" value={boot?.storePath} copy={boot?.storePathRaw} />
          <InfoRow label="栏目 / 条目" value={boot ? `${boot.counts.sections} / ${boot.counts.entries}` : ''} />
          <InfoRow label="命令条数" value={boot ? String(boot.counts.commands) : ''} />
          <InfoRow label="app / node" value={boot ? `v${boot.app.version} · node ${boot.app.node} · ${boot.app.platform}` : ''} />
          <InfoRow
            label="环境变量覆盖"
            value={boot ? Object.entries(boot.envOverrides).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('　') || '（无）' : ''}
          />
        </div>
      </div>

      <div className="card">
        <div className="colhead">密钥（密文落盘）</div>
        <div className="colbody">
          <InfoRow label="密钥来源" value={boot?.vault?.source === 'env' ? '环境变量 NX_SK_PASSPHRASE（口令不落盘）' : '本机密钥文件'} />
          <InfoRow label="密钥文件" value={boot?.vault?.keyFile || boot?.vault?.saltFile || ''} copy={boot?.vault?.keyFile || boot?.vault?.saltFile} />
          <div className="row">
            <span className="desc">{boot?.vault?.note}</span>
          </div>
          <div className="row">
            <span className="desc bad">删掉密钥文件或换掉口令后，已存的密文都解不开了——导出前先确认密钥可用。</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">面板与 CLI</div>
        <div className="colbody">
          <div className="row">
            <span className="name">面板地址</span>
            <span className="desc mono">{panelUrl}</span>
            <span className="acts"><Copyable className="mono" text={panelUrl}>复制</Copyable></span>
          </div>
          <div className="row">
            <span className="name">重启面板</span>
            <span className="desc">面板本身就是 serve 提供的；改代码后重启它即可</span>
            <span className="acts"><Copyable className="mono" text={`nx-sk serve --port ${panelPort}`}>{`nx-sk serve --port ${panelPort}`}</Copyable></span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">
          头部导航分组
          <span className="right muted">{groups.length ? `${groups.length} 个分组` : '未分组（全部平铺）'}</span>
        </div>
        <div className="pad stack">
          <div className="hint">
            把同域栏目收拢成一个头部入口：头部只显示组名，**悬浮展开上下列表**选具体栏目。
            不勾进任何分组的栏目保持平铺；组顺序 = 头部显示顺序；一个栏目只能属于一个分组。
          </div>
          {groups.map((g, gi) => (
            <div className="stack" key={gi} style={{ borderTop: gi ? 'var(--border)' : 0, paddingTop: gi ? 8 : 0 }}>
              <div className="rowgap">
                <input
                  value={g.title}
                  placeholder="组名，如「求职」"
                  onChange={(e) => patchGroup(gi, { title: e.target.value })}
                  style={{ minWidth: 160 }}
                />
                <button className="btn small ghost" disabled={gi === 0} onClick={() => moveGroup(gi, -1)}>上移</button>
                <button className="btn small ghost" disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)}>下移</button>
                <button className="btn small ghost" onClick={() => setGroups((gs) => gs.filter((_, i) => i !== gi))}>删除组</button>
                <span className="muted">已选 {g.sections.length} 个栏目</span>
              </div>
              <div className="rowgap">
                {(boot?.sections || []).map((s) => {
                  const checked = g.sections.includes(s.id);
                  const elsewhere = groups.some((o, oi) => oi !== gi && o.sections.includes(s.id));
                  return (
                    <label className="inline" key={s.id} title={elsewhere ? '已归入其它分组' : ''}>
                      <input type="checkbox" checked={checked} disabled={elsewhere} onChange={() => toggleMember(gi, s.id)} />
                      <span className={elsewhere ? 'muted' : ''}>{s.title}<span className="count"> {s.entries}</span></span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          {!groups.length ? <div className="muted">还没有分组——所有栏目都平铺在头部。</div> : null}
          <div className="rowgap">
            <button className="btn" onClick={saveGroups}>保存分组</button>
            <button className="btn small ghost" onClick={() => setGroups((gs) => [...gs, { title: '', sections: [] }])}>新增分组</button>
            {groups.length ? <button className="btn small ghost" onClick={() => setGroups([])}>清空（恢复平铺）</button> : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">默认行为</div>
        <div className="pad">
          <div className="grid">
            <div className="field">
              <div className="flabel"><span>默认导出格式</span></div>
              <div className="fctrl">
                <select value={form.exportFormat} onChange={(e) => setForm({ ...form, exportFormat: e.target.value })}>
                  <option value="both">JSON + Markdown</option>
                  <option value="json">仅 JSON</option>
                  <option value="md">仅 Markdown</option>
                </select>
              </div>
            </div>
            <div className="field">
              <div className="flabel"><span>默认导出目录</span><span className="fkey">留空 = ~/nx-sk/export</span></div>
              <div className="fctrl"><input value={form.exportDir} onChange={(e) => setForm({ ...form, exportDir: e.target.value })} /></div>
            </div>
            <div className="field">
              <div className="flabel"><span>默认栏目</span><span className="fkey">CLI 未指定 --section 时的首选</span></div>
              <div className="fctrl"><input value={form.defaultSection} onChange={(e) => setForm({ ...form, defaultSection: e.target.value })} /></div>
            </div>
            <div className="field">
              <div className="flabel"><span>导出默认带明文密钥</span><span className="fkey">默认开；要分享出去时关掉</span></div>
              <div className="fctrl">
                <label className="inline">
                  <input type="checkbox" checked={!!form.includeSecretsInExport} onChange={(e) => setForm({ ...form, includeSecretsInExport: e.target.checked })} />
                  <span className={form.includeSecretsInExport ? 'muted' : 'bad'}>{form.includeSecretsInExport ? '开（导出文件含真实凭据，注意别外发）' : '关（凭据打码后再导出）'}</span>
                </label>
              </div>
            </div>
          </div>
          <div className="rowgap" style={{ marginTop: 8 }}>
            <button className="btn" onClick={save}>保存设置</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">自动快照<span className="right muted">{boot?.snapshots?.length ?? 0}</span></div>
        <div className="colbody">
          <div className="row">
            <span className="desc">每次删除条目 / 栏目、修改设置前，都会在 ~/nx-sk/backup 留一份可回滚的整库快照。</span>
          </div>
          {boot?.snapshots?.length ? boot.snapshots.map((s) => (
            <div key={s.name} className="row">
              <span className="mono name">{s.name}</span>
              <span className="desc">{s.at}</span>
              <span className="acts"><span className="tag">{Math.ceil(s.bytes / 1024)} KB</span></span>
            </div>
          )) : <Empty>还没有快照。</Empty>}
        </div>
      </div>

      {boot?.migration ? (
        <div className="card">
          <div className="colhead">数据迁移</div>
          <div className="colbody">
            <div className="row">
              <span className="desc">store 已从 v{boot.migration.from} 迁到 v{boot.migration.to}：密钥栏目字段 {boot.migration.fieldsBefore} → {boot.migration.fieldsAfter}，{boot.migration.entries} 条条目</span>
            </div>
            <div className="row">
              <span className="desc">迁移前的原始文件</span>
              <span className="acts"><Copyable className="mono" text={boot.migration.snapshotRaw || ''}>{boot.migration.snapshot}</Copyable></span>
            </div>
            {boot.migration.legacyValuesKept ? (
              <div className="row">
                <span className="desc">另保留了 {boot.migration.legacyValuesKept} 个旧字段的值（不再显示，但没删）</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {boot?.corrupt ? (
        <div className="card">
          <div className="colhead">上次读取异常</div>
          <div className="colbody">
            <div className="row">
              <span className="desc bad">store.json 解析失败，已挪到 {boot.corrupt.to}（原文件没有被覆盖）</span>
            </div>
          </div>
        </div>
      ) : null}

      <CliHints module="settings" />
    </>
  );
}

function InfoRow({ label, value, copy }) {
  return (
    <div className="row">
      <span className="name">{label}</span>
      <span className="desc mono">{value || '（空）'}</span>
      {copy ? <span className="acts"><Copyable className="mono" text={copy}>复制</Copyable></span> : <Tag> </Tag>}
    </div>
  );
}
