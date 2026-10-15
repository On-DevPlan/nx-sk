import { useRef, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useStore } from '../../web/frontend/store.jsx';
import { Empty, Modal } from '../../web/frontend/components/ui.jsx';

// Web 上传走 JSON 文本体，接口上限 32MB——留出余量在前端先拦，
// 超限建议走 CLI（命令行没有请求体上限）。
const MAX_PICK_BYTES = 28 * 1024 * 1024;
const REPORT_CAP = 20;

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

/** 报告小节：有内容才渲染，超过封顶给「…共 N 处」尾行。 */
function ReportList({ title, items, render, total }) {
  if (!items || !items.length) return null;
  const over = total != null && total > items.length;
  return (
    <div>
      <div className="flabel"><span>{title}</span>{over ? <span className="fkey">共 {total} 处</span> : null}</div>
      <ul className="stack" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {items.slice(0, REPORT_CAP).map((x, i) => <li key={i}>{render(x)}</li>)}
      </ul>
    </div>
  );
}

function MergeReport({ r }) {
  const files = r.files || {};
  return (
    <div className="stack">
      <div>
        新增栏目 {(r.addedSections || []).length} 个 / 新增条目 {r.addedEntriesTotal || 0} 条；
        补空 {r.filledTotal || 0} 处；冲突 {r.conflictsTotal || 0} 处
        （{r.counts ? `栏目 ${r.counts.sectionsBefore} → ${r.counts.sectionsAfter}，条目 ${r.counts.entriesBefore} → ${r.counts.entriesAfter}` : ''}）
      </div>
      <ReportList title="补空明细（本地留空，已用备份值填上）" items={r.filled} total={r.filledTotal}
        render={(x) => <span>{x.section} / {x.entry} · {x.label} = {x.value || '（空）'}</span>} />
      <ReportList title="冲突（两边都有值且不同，已保留本地，请手动核对）" items={r.conflicts} total={r.conflictsTotal}
        render={(x) => <span>{x.section} / {x.entry} · {x.label}: 本地 {x.localValue || '（空）'} ｜ 备份 {x.backupValue || '（空）'}</span>} />
      <ReportList title="结构补齐（只增：备份多出的分组/字段已补进本地栏目）" items={r.structureAdded}
        render={(x) => <span>{x.id}: +{x.fields.length} 字段 [{x.fields.join(', ')}]{x.groups.length ? `，+分组 [${x.groups.join(', ')}]` : ''}</span>} />
      <ReportList title="本地独有字段（备份里没有，已原样保留）" items={r.structureOnlyLocal}
        render={(x) => <span>{x.id}: [{x.fields.join(', ')}]</span>} />
      {(r.kvMismatch || []).length ? <div className="muted">kv 标记与备份不一致、未合并结构的栏目: {r.kvMismatch.join(', ')}</div> : null}
      {(r.settingsFilled || []).length ? <div>设置补空: {r.settingsFilled.join(', ')}</div> : null}
      <div>{renderFilesLine(files)}</div>
      {r.exportsSkipped ? <div className="muted">备份里的导出历史 {r.exportsSkipped} 条未并入（保留本机记录）</div> : null}
      {r.resealed ? <div className="muted">用本机密钥库重新加密的密钥字段: {r.resealed} 个</div> : null}
      <div className="muted">备份生成于 {r.backupCreatedAt || '未知'}</div>
      <pre className="block">导入前的安全快照：{r.safetySnapshot}</pre>
    </div>
  );
}

function renderFilesLine(f) {
  const parts = [];
  if (f.toAdd != null) parts.push(`台账新增 ${f.toAdd} 条、沿用本地 ${f.kept || 0} 条`);
  if (f.written) parts.push(`落盘原件 ${f.written} 个`);
  if (f.healed) parts.push(`补齐缺失原件 ${f.healed} 个`);
  if (f.skippedExisting) parts.push(`磁盘已有但内容不同、保留磁盘 ${f.skippedExisting} 个`);
  if (f.checksumMismatch) parts.push(`校验不符被拒 ${f.checksumMismatch} 个`);
  if (f.missingBinaryTotal) parts.push(`${f.missingBinaryTotal} 条台账无原件（备份未携带）`);
  if (!parts.length) return '附件: 台账已并入，原件均已就位';
  return `附件: ${parts.join('；')}${f.bytes ? `（共 ${f.bytes} 字节）` : ''}`;
}

function ReplaceReport({ r }) {
  const f = r.filesStats || {};
  return (
    <div className="stack">
      <div>已整份替换为备份内容：{r.sections} 个栏目 / {r.entries} 条条目（附件台账 {r.filesInBackup || 0} 条）</div>
      <div>{renderFilesLine({ ...f })}</div>
      {r.resealed ? <div className="muted">用本机密钥库重新加密的密钥字段: {r.resealed} 个</div> : null}
      <div className="muted">备份生成于 {r.backupCreatedAt || '未知'}</div>
      <pre className="block">恢复前的安全快照：{r.safetySnapshot}</pre>
    </div>
  );
}

// 备份半页：由「导出与备份」合并页（export 模块的 view.jsx）组合渲染，
// 所以不带页面头与 CLI 提示（CliHints 在合并页统一出一条）。tab: false，不单独出现在导航。
export default function BackupPanel() {
  const { toast, guard, dialog, reload } = useStore();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [withFiles, setWithFiles] = useState(false);
  const [restorePw, setRestorePw] = useState('');
  const [picked, setPicked] = useState(null);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const doExport = guard(async () => {
    if (!pw) { toast('请先设置备份口令', 'bad'); return; }
    if (pw !== pw2) { toast('两次输入的口令不一致', 'bad'); return; }
    const r = await api('/api/backup', { method: 'POST', body: { password: pw, 'with-files': withFiles } });
    const filename = `nx-sk-backup-${fileStamp()}.nxskbak`;
    downloadText(filename, JSON.stringify(r.archive, null, 2) + '\n');
    const c = r.counts;
    const filesBit = withFiles
      ? `；嵌入原件 ${c.filesEmbedded} 个`
      : `；附件台账 ${c.files || 0} 条未嵌原件`;
    toast(`已生成加密备份：${c.sections} 栏目 / ${c.entries} 条目${filesBit}`);
    setPw(''); setPw2('');
  });

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPicked({ name: file.name, bytes: file.size, text });
  };

  const precheck = () => {
    if (!picked) { toast('请先选择备份文件', 'bad'); return false; }
    if (!restorePw) { toast('请输入备份口令', 'bad'); return false; }
    if (picked.bytes > MAX_PICK_BYTES) {
      toast('备份文件超过 28MB，可能超过接口上限；请改用 CLI 导入：nx-sk backup import', 'bad');
      return false;
    }
    return true;
  };

  const postImport = (r) => {
    setResult(r);
    setRestorePw('');
    setPicked(null);
    if (fileRef.current) fileRef.current.value = '';
    return reload();
  };

  // 合并导入（缺省）：只增补、不覆盖，冲突保留本地并列进报告
  const doRestore = guard(async () => {
    if (!precheck()) return;
    const ok = await dialog({
      confirmText: '解密并合并导入',
      message: '合并导入：只把备份里有、而当前缺失或留空的内容补进来，不会覆盖你已填过的值，也不会删改本地栏目结构。',
      detail: `备份文件：${picked.name}\n冲突（两边都有值且不同）会保留本地、列在导入报告里。\n导入前会自动给当前数据留一份安全快照（可回滚）。`,
    });
    if (!ok) return;
    const r = await api('/api/backup/restore', {
      method: 'POST',
      body: { password: restorePw, content: picked.text },
    });
    await postImport(r);
  });

  // 整份替换（旧行为）：灾难恢复 / 跨机器迁移用，危险操作
  const doReplace = guard(async () => {
    if (!precheck()) return;
    const ok = await dialog({
      danger: true,
      confirmText: '解密并整份替换',
      message: '整份替换：当前数据会被备份内容整体覆盖，包括删掉备份里没有的条目。',
      detail: `备份文件：${picked.name}\n替换前会自动给当前数据留一份安全快照（可回滚）。`,
    });
    if (!ok) return;
    const r = await api('/api/backup/restore', {
      method: 'POST',
      body: { password: restorePw, content: picked.text, replace: true },
    });
    await postImport(r);
  });

  return (
    <>
      <div className="card">
        <div className="colhead">加密备份（口令 .nxskbak）</div>
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
          <label className="row">
            <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
            <span>连附件原件一起打包（体积显著变大；附件台账始终随包）</span>
          </label>
          <div className="hint">导出为单个 .nxskbak 文件并在浏览器下载；文件内含随机盐，密钥由口令经 scrypt 派生。恢复时需要输入同一口令。</div>
          <div className="rowgap">
            <button className="btn" onClick={doExport}>加密导出并下载</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="colhead">解密导入（.nxskbak）</div>
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
          <div className="hint">缺省「合并」：只增补、不覆盖你已填过的值，冲突保留本地并列入报告。口令错误或文件损坏会明确报错、不会改动当前数据；导入前会先留安全快照。</div>
          <div className="rowgap">
            <button className="btn" onClick={doRestore}>解密并导入（合并）</button>
            <button className="btn danger" onClick={doReplace}>整份替换…</button>
          </div>
        </div>
      </div>

      {result ? (
        <Modal
          title={result.mode === 'replace' ? '导入完成（整份替换）' : '导入完成（合并）'}
          onClose={() => setResult(null)}
        >
          {result.mode === 'replace' ? <ReplaceReport r={result} /> : <MergeReport r={result} />}
        </Modal>
      ) : null}
    </>
  );
}
