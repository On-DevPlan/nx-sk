import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Copyable, Tag } from '../../web/frontend/components/ui.jsx';
import * as nav from '../../web/frontend/components/navModel.js';
import NavManager from './navManager.jsx';
import ReadableExportPanel from '../../web/frontend/components/readableExport.jsx';

export default function SettingsView() {
  const { boot, reload, toast, guard } = useStore();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [navCfg, setNavCfg] = useState(nav.emptyConfig());
  // 保存后的基准：脏值判断与「放弃改动」都以它为准，不靠逐项对比
  const [baseline, setBaseline] = useState(null);
  // 面板地址不写死：直接取用户此刻访问的这个 origin，换端口/换 host 都自动跟上
  const panelUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const panelPort = typeof window === 'undefined' ? '' : (window.location.port || '80');

  const sections = useMemo(() => data?.sections || [], [data]);
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/settings');
      const nextForm = { ...d.settings };
      const nextNav = nav.configFromSettings(d.settings);
      setData(d);
      setForm(nextForm);
      setNavCfg(nextNav);
      setBaseline({ form: nextForm, navCfg: nextNav });
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const problems = useMemo(() => (form ? nav.validate(navCfg, sectionIds) : []), [navCfg, sectionIds, form]);
  const dirty = !!baseline && (nav.isDirty(navCfg, baseline.navCfg) || nav.isDirty(form, baseline.form));

  // 一次保存全部设置：标量项 + 导航（分组 / 隐藏）。分成两块各存各的，
  // 用户就得记住「刚才那块存了没」——统一保存 + 统一的脏值提示才是清晰的。
  const save = guard(async () => {
    if (problems.length) { toast(`保存失败：${problems[0].message}`, 'bad'); return; }
    const r = await api('/api/settings', {
      method: 'PATCH',
      body: {
        set: {
          exportDir: form.exportDir,
          exportFormat: form.exportFormat,
          includeSecretsInExport: !!form.includeSecretsInExport,
          defaultSection: form.defaultSection,
          ...nav.configToPayload(navCfg),
        },
      },
    });
    const nextForm = { ...r.set };
    const nextNav = nav.configFromSettings(r.set);
    setData({ ...data, settings: r.set });
    setForm(nextForm);
    setNavCfg(nextNav);
    setBaseline({ form: nextForm, navCfg: nextNav });
    toast('设置已保存');
    await reload();
  });

  const discard = () => {
    if (!baseline) return;
    setForm({ ...baseline.form });
    setNavCfg(structuredClone(baseline.navCfg));
  };

  if (!data || !form) return <div className="pad muted">加载中…</div>;

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>设置</strong>
        <span className="muted">本机配置与运行状态</span>
        <span className="grow" />
        {dirty ? (
          <span className="rowgap">
            <span className="tag">有未保存的改动</span>
            <button className="btn small" onClick={() => { void save(); }}>保存</button>
            <button className="btn small ghost" onClick={discard}>放弃改动</button>
          </span>
        ) : <span className="muted">已保存</span>}
        <button className="btn small ghost" onClick={load}>重新读取</button>
      </div>

      <div className="card">
        <div className="colhead">
          栏目管理
          <span className="right muted">
            头部显示 {sectionIds.length - navCfg.hidden.length} 个 · 隐藏 {navCfg.hidden.length} 个
            {navCfg.groups.length ? ` · ${navCfg.groups.length} 个分组` : ''}
          </span>
        </div>
        <div className="pad stack">
          <div className="hint">
            拖动就是把结构摆成你要的样子：栏目可以拖进分组、组内换位、拖回平铺区即移出；拖分组把手换分组顺序。
            被隐藏的栏目只是头部不显示入口，用 <code>#/栏目id</code> 直达仍可用。
          </div>
          <NavManager sections={sections} value={navCfg} onChange={setNavCfg} />
          {problems.length ? (
            <div className="stack">
              {problems.map((p) => <div key={p.field} className="hint bad">· {p.message}</div>)}
            </div>
          ) : null}
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
              <div className="flabel"><span>默认栏目</span><span className="fkey">打开面板时落在哪</span></div>
              <div className="fctrl">
                <select value={form.defaultSection || ''} onChange={(e) => setForm({ ...form, defaultSection: e.target.value })}>
                  <option value="">（第一个栏目）</option>
                  {sections.map((s) => <option key={s.id} value={s.id}>{s.title}（{s.id}）</option>)}
                  {/* 历史值指向已删栏目：留着看得见（而不是被悄悄改成第一项），
                      保存时后端会拒绝并提示现有栏目 */}
                  {form.defaultSection && !sections.some((s) => s.id === form.defaultSection) ? (
                    <option value={form.defaultSection}>{form.defaultSection}（栏目已不存在）</option>
                  ) : null}
                </select>
              </div>
              <div className="hint">地址里带 <code>#/栏目id</code> 时以地址为准；改完下次打开生效。</div>
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
        </div>
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

      {/* 可读导出（JSON / Markdown）放设置里而不是导出页 ——
          导出页（「导出导入」）的语义是「取数据」，这里是「留一份人能读的副本」。 */}
      <ReadableExportPanel />

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
