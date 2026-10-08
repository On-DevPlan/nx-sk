import { useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { CliHints, Empty, Modal } from '../../web/frontend/components/ui.jsx';

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function BackupView() {
  const { toast, guard, dialog, reload } = useStore();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [restorePw, setRestorePw] = useState('');
  const [picked, setPicked] = useState(null);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const doExport = guard(async () => {
    if (!pw) { toast('请先设置备份口令', 'bad'); return; }
    if (pw !== pw2) { toast('两次输入的口令不一致', 'bad'); return; }
    const r = await api('/api/backup', { method: 'POST', body: { password: pw } });
    const filename = `nx-sk-backup-${fileStamp()}.nxskbak`;
    downloadText(filename, JSON.stringify(r.archive, null, 2) + '\n');
    toast(`已生成加密备份：${r.counts.sections} 栏目 / ${r.counts.entries} 条目`);
    setPw(''); setPw2('');
  });

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPicked({ name: file.name, bytes: file.size, text });
  };

  const doRestore = guard(async () => {
    if (!picked) { toast('请先选择备份文件', 'bad'); return; }
    if (!restorePw) { toast('请输入备份口令', 'bad'); return; }
    const ok = await dialog({
      danger: true,
      confirmText: '解密并整份恢复',
      message: '恢复会用备份内容整份替换当前数据。',
      detail: `备份文件：${picked.name}\n恢复前会自动给当前数据留一份安全快照（可回滚）。`,
    });
    if (!ok) return;
    const r = await api('/api/backup/restore', {
      method: 'POST',
      body: { password: restorePw, content: picked.text },
    });
    setResult(r);
    setRestorePw('');
    setPicked(null);
    if (fileRef.current) fileRef.current.value = '';
    await reload();
  });

  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>加密备份</strong>
        <span className="muted">整份数据用口令对称加密（AES-256-GCM）；导出设口令、恢复输口令，口令不落盘</span>
      </div>

      <div className="card">
        <div className="colhead">加密导出</div>
        <div className="pad stack">
          <div className="grid">
            <div className="field">
              <div className="flabel"><span>设置备份口令</span><span className="fkey">建议至少 6 位</span></div>
              <div className="fctrl">
                <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="备份口令" />
              </div>
            </div>
            <div className="field">
              <div className="flabel"><span>再输入一次</span></div>
              <div className="fctrl">
                <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="确认口令" />
              </div>
            </div>
          </div>
          <div className="hint">导出为单个 .nxskbak 文件并在浏览器下载；文件内含随机盐，密钥由口令经 scrypt 派生。恢复时需要输入同一口令。</div>
          <div className="rowgap">
            <button className="btn" onClick={doExport}>加密导出并下载</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">解密恢复（导入）</div>
        <div className="pad stack">
          <div className="grid">
            <div className="field">
              <div className="flabel"><span>备份文件</span><span className="fkey">.nxskbak</span></div>
              <div className="fctrl">
                <input ref={fileRef} type="file" accept=".nxskbak,application/json" onChange={onPick} />
              </div>
            </div>
            <div className="field">
              <div className="flabel"><span>输入备份口令</span></div>
              <div className="fctrl">
                <input type="password" autoComplete="off" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} placeholder="导出时设置的口令" />
              </div>
            </div>
          </div>
          {picked ? (
            <div className="row">
              <span className="mono name">{picked.name}</span>
              <span className="acts"><span className="tag">{picked.bytes} 字节</span></span>
            </div>
          ) : <Empty>还没有选择备份文件。</Empty>}
          <div className="hint">口令错误或文件损坏会明确报错、不会改动当前数据；确认恢复前会先留安全快照。</div>
          <div className="rowgap">
            <button className="btn danger" onClick={doRestore}>解密并恢复</button>
          </div>
        </div>
      </div>

      <CliHints module="backup" />

      {result ? (
        <Modal title="恢复完成" onClose={() => setResult(null)}>
          <div className="stack">
            <div>已从加密备份恢复：{result.sections} 个栏目 / {result.entries} 条条目</div>
            <div className="muted">备份生成于 {result.backupCreatedAt || '未知'}</div>
            <pre className="block">恢复前的安全快照：{result.safetySnapshot}</pre>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
