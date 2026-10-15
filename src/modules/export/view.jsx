import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Copyable, Empty, Modal, Tag } from '../../web/frontend/components/ui.jsx';
import BackupPanel from '../backup/view.jsx';

// 「导出与备份」合并页：明文导出（带走可读文件）与口令加密备份（整份可还原）
// 对用户来说是同一件事——把数据倒出去、再倒回来，所以并成一个 tab。
// 后端仍是 export / backup 两个模块、两组 CLI 命令；页脚的 CliHints 把两组合成一条提示。
export default function ExportView() {
  const { boot, toast, guard } = useStore();
  const [sections, setSections] = useState([]);
  const [history, setHistory] = useState(null);
  const [form, setForm] = useState({ format: 'both', section: '', out: '', withSecrets: false });
  const [modal, setModal] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api('/api/sections'), api('/api/exports')]);
      setSections(s.sections);
      setHistory(h);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const s = boot?.settings;
    if (!s) return;
    setForm((f) => ({ ...f, format: s.exportFormat || 'both', withSecrets: !!s.includeSecretsInExport, out: s.exportDir || '' }));
  }, [boot]);

  const body = () => ({
    format: form.format,
    out: form.out.trim() || undefined,
    section: form.section || undefined,
    ...(form.withSecrets ? { 'with-secrets': true } : { 'no-secrets': true }),
  });

  const run = guard(async (dryRun) => {
    const r = await api('/api/export', { method: 'POST', body: { ...body(), 'dry-run': !!dryRun } });
    if (dryRun) {
      setModal({
        title: '试运行（没有写盘）',
        body: <pre className="block">{`目录: ${r.wouldWrite.dir}\n栏目: ${r.wouldWrite.sections}　条目: ${r.wouldWrite.entries}\n凭据: ${r.wouldWrite.withSecrets ? '含明文' : '已打码'}\n\n${r.wouldWrite.files.map((f) => `${f.name}  ${f.bytes} 字节`).join('\n')}`}</pre>,
      });
      return;
    }
    toast(`已导出到 ${r.dir}`);
    setModal({
      title: '导出完成',
      body: (
        <div className="stack">
          <div>目录 <Copyable className="mono" text={r.dirRaw}>{r.dir}</Copyable></div>
          <div className="muted">{r.sections} 个栏目 / {r.entries} 条条目 · 凭据：{r.withSecrets ? '含明文' : '已打码'}</div>
          <pre className="block">{r.files.map((f) => `${f.path}  ${f.bytes} 字节`).join('\n')}</pre>
        </div>
      ),
    });
    await load();
  });

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>导出与备份</strong>
        <span className="muted">明文导出走可读文件（JSON / Markdown），加密备份走口令保护的 .nxskbak（整份可还原）；都只在本机落盘</span>
      </div>

      <div className="card">
        <div className="colhead">导出为 JSON / Markdown</div>
        <div className="pad">
          <div className="grid">
            <div className="field">
              <div className="flabel"><span>格式</span></div>
              <div className="fctrl">
                <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                  <option value="both">JSON + Markdown</option>
                  <option value="json">仅 JSON</option>
                  <option value="md">仅 Markdown</option>
                </select>
              </div>
            </div>
            <div className="field">
              <div className="flabel"><span>范围</span></div>
              <div className="fctrl">
                <select value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}>
                  <option value="">全部栏目</option>
                  {sections.map((s) => <option key={s.id} value={s.id}>{s.title}（{s.entries} 条）</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <div className="flabel"><span>输出目录</span><span className="fkey">留空 = ~/nx-sk/export</span></div>
              <div className="fctrl"><input value={form.out} onChange={(e) => setForm({ ...form, out: e.target.value })} placeholder="~/nx-sk/export" /></div>
            </div>
            <div className="field">
              <div className="flabel"><span>凭据字段</span><span className="fkey">默认打码</span></div>
              <div className="fctrl">
                <label className="inline">
                  <input type="checkbox" checked={form.withSecrets} onChange={(e) => setForm({ ...form, withSecrets: e.target.checked })} />
                  <span className={form.withSecrets ? 'bad' : 'muted'}>
                    {form.withSecrets ? '导出明文密钥（导出文件将含真实凭据，注意存放位置）' : '只导出打码后的凭据'}
                  </span>
                </label>
              </div>
            </div>
          </div>
          <div className="rowgap" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => run(false)}>开始导出</button>
            <button className="btn ghost" onClick={() => run(true)}>试运行（不写盘）</button>
          </div>
        </div>
      </div>

      <BackupPanel />

      <div className="card">
        <div className="colhead">历次导出<span className="right muted">{history?.count ?? 0}</span></div>
        <div className="colbody">
          {history?.history?.length ? history.history.map((h, i) => (
            <div key={`${h.at}-${i}`} className="row">
              <span className="name">{h.at}</span>
              <Tag>{h.format}</Tag>
              {h.withSecrets ? <Tag kind="bad">含明文</Tag> : <Tag>已打码</Tag>}
              <span className="desc">{h.dir}</span>
              <span className="acts">
                <span className="tag">{h.sections} 栏目</span>
                <span className="tag">{h.entries} 条目</span>
              </span>
            </div>
          )) : <Empty>还没有导出记录。</Empty>}
        </div>
      </div>

      <div className="card">
        <div className="colhead">导出目录里的文件<span className="right muted">{history?.disk?.length ?? 0}</span></div>
        <div className="colbody">
          {(history?.dirs || [history?.dir]).filter(Boolean).map((d) => (
            <div key={d} className="row">
              <span className="desc">目录</span>
              <span className="acts"><Copyable className="mono" text={d}>{d}</Copyable></span>
            </div>
          ))}
          {history?.disk?.length ? history.disk.map((f) => (
            <div key={`${f.dir}/${f.name}`} className="row">
              <span className="mono name">{f.name}</span>
              <span className="desc mono nowrap">{f.dir}</span>
            </div>
          )) : <Empty>目录里还没有文件。</Empty>}
        </div>
      </div>

      <CliHints module={['export', 'backup']} />

      {modal ? <Modal title={modal.title} onClose={() => setModal(null)}>{modal.body}</Modal> : null}
    </>
  );
}
