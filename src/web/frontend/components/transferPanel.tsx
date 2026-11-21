// 「导出 / 导入」—— 一个面板，一次心智：选条目树 → 设口令 → 倒出去 / 倒回来。
//
// 导出侧以**条目树**为准：勾一个条目 = 连同它的所有嵌套子条目一起导出；也支持多选、
// 全选和每行「快速导出」。不再按条目模板分栏——模板只负责初始化字段结构，不是聚类维度。
// 包格式仍是 bundle（bundle.json + templates/<id>.zip），所以导入侧复用同一套预览/冲突策略。
//
// 选择语义：`selected` 是一组**根条目 id**；导出时递归展开成「根 + 全部后代」。
// 勾上级会覆盖下级，下级复选框因此显示为「已随上级选中」。
//
// 包里**恒为明文**，保护靠口令：填了 = 整个包 AES-256-GCM 加密（导入时同一个入口先问口令），
// 留空 = 明文 ZIP。加密只作用在最外层，所以「包里有哪些条目」也一并藏住。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DownOutlined, DownloadOutlined, FileOutlined, FolderOpenOutlined, RightOutlined } from '@ant-design/icons';
import { checkZipFile, fmtBytes, isNeedPassphraseError, postZip } from '../api/zip.ts';
import { useStore } from '../store.tsx';
import type { TreeNode } from '../../../shared/tree.ts';
import { Empty, Modal, Tag } from './ui.tsx';

/** 导入预览里的一条冲突（服务端 previewImport 给出）。 */
interface PreviewConflict {
  id: string;
  title: string;
  reason: string;
  existingId: string;
  existingTitle: string;
  copyTitle?: string;
}

/** 全局包预览里单个条目模板的摘要。 */
interface PreviewTemplate {
  id: string;
  title: string;
  willCreate: boolean;
  renamedFrom: string | null;
  entries: { total: number; fresh: number; conflicts: PreviewConflict[] };
  files: { new: number; reused: number; bytes: number; notBundled: number };
  fieldsToAdd: Array<{ key: string; label: string; type: string }>;
  notBundled: number;
}

/** `/api/bundle/import.zip?dry-run=1` 的预览结果（外部 JSON 边界）。 */
interface Preview {
  status: 'preview';
  fileName?: string;
  encrypted: boolean;
  exportedAt?: string;
  withSecrets: boolean;
  templates: PreviewTemplate[];
  totals: {
    templates: number;
    newTemplates: number;
    entries: number;
    fresh: number;
    conflicts: number;
    filesNew: number;
    filesReused: number;
    bytes: number;
  };
  warnings: string[];
}

/** `/api/bundle/import.zip` 的落地结果（面板只读 totals）。 */
interface ApplyResult {
  status: 'ok';
  totals: { templates: number; added: number; copied: number; overwritten: number; skipped: number };
}

interface ZipState { fileName: string; buffer: ArrayBuffer; preview: Preview; passphrase: string }
interface AskState { fileName: string; buffer: ArrayBuffer }

type Conflict = 'skip' | 'copy' | 'overwrite';

async function postJsonZip(url: string, body: unknown): Promise<Blob> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export default function TransferPanel({ fullOnly = false }: { fullOnly?: boolean } = {}) {
  const { boot, toast, guard, reload } = useStore();
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  // 是否携带附件原件：勾上包会大（截图/PDF 都在里面），不勾只有数据本体
  const [withFiles, setWithFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zip, setZip] = useState<ZipState | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null); // 加密包先问口令：{ fileName, buffer }
  const [askPw, setAskPw] = useState('');
  const [conflict, setConflict] = useState<Conflict>('skip');
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => boot?.tree || [], [boot]);
  const byId = useMemo(() => new Map(tree.map((n) => [n.id, n])), [tree]);
  const childMap = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    for (const n of tree) {
      const key = n.parent || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    }
    return map;
  }, [tree]);
  const roots = useMemo(() => tree.filter((n) => !n.parent), [tree]);

  // 初次进入只展开顶层；深层目录留给用户自己点开，避免一屏铺满。
  useEffect(() => {
    setExpanded((prev) => (prev.size ? prev : new Set(roots.map((n) => n.id))));
  }, [roots]);

  // 全量模式（设置页的备份/恢复）不用树选择：范围恒为全部根，子条目靠递归带上。
  // 直接派生选择集，避免先渲染一轮空选择、按钮闪一下灰。
  const selection = useMemo(
    () => (fullOnly ? new Set(roots.map((n) => n.id)) : selected),
    [fullOnly, roots, selected],
  );

  const descendantsOf = (rootsToExpand: Set<string>) => {
    const ids = new Set<string>();
    const walk = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of childMap.get(id) || []) walk(child.id);
    };
    rootsToExpand.forEach(walk);
    return ids;
  };

  const picked = useMemo(() => {
    const ids = new Set<string>();
    const walk = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const child of childMap.get(id) || []) walk(child.id);
    };
    selection.forEach(walk);
    return ids;
  }, [selection, childMap]);
  const pickedCount = picked.size;
  const totalCount = tree.length;
  const isWhole = totalCount > 0 && pickedCount === totalCount;

  // 父子同时被勾时只算一个根：计数按实际导出的「根」算，别让用户看到 2 项却只出去 1 棵。
  const rootCount = useMemo(() => {
    let count = 0;
    for (const id of selection) {
      let parent = byId.get(id)?.parent || null;
      let covered = false;
      while (parent) {
        if (selection.has(parent)) { covered = true; break; }
        parent = byId.get(parent)?.parent || null;
      }
      if (!covered) count += 1;
    }
    return count;
  }, [selection, byId]);

  const coveredByAncestor = (id: string) => {
    let cur: string | null = id;
    while (cur) {
      if (selection.has(cur)) return true;
      cur = byId.get(cur)?.parent || null;
    }
    return false;
  };

  const toggleNode = (id: string) => {
    // 上级已选中时，下级随上级一起导出；这里不再单独改它，避免出现「看起来取消了、其实还在包里」。
    if (!selection.has(id) && coveredByAncestor(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectAll = () => setSelected(new Set(roots.map((n) => n.id)));
  const clearAll = () => setSelected(new Set());

  const exportSelection = guard(async (rootIds: Set<string>, quickLabel?: string) => {
    const ids = [...descendantsOf(rootIds)];
    if (!ids.length) { toast('先选择要导出的条目', 'bad'); return; }
    const pw = passphrase.trim();
    if (pw && pw !== passphrase2) { toast('两次输入的口令不一致', 'bad'); return; }
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const node = byId.get(id);
      if (!node) continue;
      if (!groups.has(node.template)) groups.set(node.template, []);
      groups.get(node.template)!.push(id);
    }
    const selection = [...groups].map(([id, entries]) => ({ id, entries }));
    if (!selection.length) { toast('选中的条目没有可用结构', 'bad'); return; }
    setBusy(true);
    try {
      const blob = await postJsonZip('/api/bundle/export.zip', {
        selection,
        ...(pw ? { passphrase: pw } : {}),
        ...(withFiles ? {} : { 'no-files': true }),
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const safe = (quickLabel || '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 36);
      a.download = safe ? `nx-sk-${safe}-${stamp}.zip` : `nx-sk-bundle-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      // 立刻 remove 会让 Chromium 把下载判成取消；留给它一拍
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      setPassphrase(''); setPassphrase2('');
      toast(`已开始下载：${ids.length} 个条目${pw ? ' · 已加密' : ' · 未设口令（明文包）'}${withFiles ? '' : ' · 不含附件'}`);
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  const exportSelected = () => exportSelection(new Set(selection));

  const renderTree = (node: TreeNode, depth = 0): ReactNode => {
    const kids = childMap.get(node.id) || [];
    const hasKids = kids.length > 0 || !!node.hasChildren;
    const covered = coveredByAncestor(node.id);
    const explicit = selection.has(node.id);
    const open = expanded.has(node.id);
    return (
      <div key={node.id} className="tp-tree-item" role="treeitem" aria-selected={covered} aria-expanded={hasKids ? open : undefined}>
        <div className={`tp-tree-row${covered ? ' on' : ''}`} style={{ paddingLeft: `${depth * 14}px` }}>
          {hasKids ? (
            <button
              type="button"
              className="btn icon-btn tp-tree-toggle"
              onClick={() => toggleExpanded(node.id)}
              aria-label={open ? `收起「${node.title || '未命名'}」的子条目` : `展开「${node.title || '未命名'}」的子条目`}
              aria-expanded={open}
            >
              {open ? <DownOutlined /> : <RightOutlined />}
            </button>
          ) : <span className="tp-tree-spacer" />}
          <input
            type="checkbox"
            checked={covered}
            disabled={covered && !explicit}
            onChange={() => toggleNode(node.id)}
            aria-label={`选择「${node.title || '未命名'}」`}
            title={covered && !explicit ? '已随上级选中' : undefined}
          />
          <button
            type="button"
            className="tp-tree-main"
            onClick={() => toggleNode(node.id)}
            title={`${node.title || '未命名'}${node.templateTitle ? ` · ${node.templateTitle}` : ''}`}
          >
            {hasKids ? <FolderOpenOutlined /> : <FileOutlined />}
            <span className="tp-tree-name">{node.title || '（无名）'}</span>
            {hasKids ? <span className="tp-tree-count">{node.childCount ?? kids.length} 子条目</span> : null}
          </button>
          <button
            type="button"
            className="btn icon-btn tp-tree-quick"
            onClick={() => exportSelection(new Set([node.id]), node.title || '未命名')}
            disabled={busy}
            aria-label={`导出「${node.title || '未命名'}」及全部子条目`}
            title="快速导出本条目及全部子条目"
          >
            <DownloadOutlined />
          </button>
        </div>
        {hasKids && open ? <div>{kids.map((child) => renderTree(child, depth + 1))}</div> : null}
      </div>
    );
  };

  const openZip = (fileName: string, buffer: ArrayBuffer, pass: string): Promise<void> => {
    setBusy(true);
    const qs = new URLSearchParams({ 'dry-run': '1' });
    if (pass) qs.set('passphrase', pass);
    return postZip<Preview>(`/api/bundle/import.zip?${qs}`, buffer, fileName)
      .then((preview) => {
        setZip({ fileName, buffer, preview, passphrase: pass || '' });
        setConflict('skip');
      })
      .finally(() => setBusy(false));
  };

  const handleZip = guard(async (file: File) => {
    if (!file) return;
    const bad = checkZipFile(file);
    if (bad) { toast(bad, 'bad'); return; }
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      toast(`读不到文件：${(e as Error).message}`, 'bad');
      return;
    }
    // 先按明文试一次：加密包由服务端识片（外层 ZIP 里有 payload.enc），
    // 它会说「缺口令」——那时再问，别把「缺口令」当成「包坏了」弹出去。
    try {
      await openZip(file.name, buffer, '');
    } catch (e) {
      if (isNeedPassphraseError(e)) {
        setAsk({ fileName: file.name, buffer });
        setAskPw('');
        return;
      }
      toast((e as Error).message || String(e), 'bad');
    }
  });

  const submitAsk = guard(async () => {
    if (!ask) return;
    const pw = askPw.trim();
    if (!pw) { toast('请输入口令', 'bad'); return; }
    try {
      await openZip(ask.fileName, ask.buffer, pw);
      setAsk(null);
      setAskPw('');
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    }
  });

  const applyZip = guard(async () => {
    if (!zip) return;
    setBusy(true);
    try {
      const qs = new URLSearchParams({ 'on-conflict': conflict });
      if (zip.passphrase) qs.set('passphrase', zip.passphrase);
      const r = await postZip<ApplyResult>(`/api/bundle/import.zip?${qs}`, zip.buffer, zip.fileName);
      setZip(null);
      toast(`导入完成：${r.totals.templates} 套字段结构，新增 ${r.totals.added} / 另存 ${r.totals.copied} / 覆盖 ${r.totals.overwritten} / 跳过 ${r.totals.skipped}`);
      setSelected(new Set());
      await reload();
    } catch (e) {
      toast((e as Error).message || String(e), 'bad');
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="card tp">
      <div className="colhead tp-head">
        {fullOnly ? '全量导出 / 全量导入' : '导出 / 导入'}
        <span className="right tp-headacts">
          <span className="hint">
            {selection.size
              ? `${isWhole ? '全部' : `已选 ${rootCount} 项`} · 含子条目 ${pickedCount} 条`
              : '未选择'}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className="pw"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="口令（留空明文）"
            aria-label="导出口令"
          />
          {passphrase ? (
            <input
              type="password"
              autoComplete="new-password"
              className="pw"
              value={passphrase2}
              onChange={(e) => setPassphrase2(e.target.value)}
              placeholder="再输一次"
              aria-label="确认导出口令"
            />
          ) : null}
          <button type="button" className="btn small" onClick={exportSelected} disabled={busy || !pickedCount}>
            {busy ? '处理中…' : fullOnly ? '导出全量 ZIP' : '导出 ZIP'}
          </button>
        </span>
      </div>

      <div className="tp-grid">
        {/* ── 左：选什么 ─────────────────────────────────────── */}
        <div className="tp-col" aria-label="选择要导出的条目">
          {fullOnly ? (
            <div className="tp-full">
              <div className="tp-full-title">全量范围：{tree.length} 个条目</div>
              <div className="hint">
                包含所有条目、字段结构与附件；父子目录关系一并备份。恢复时同一个入口拖回 ZIP。
              </div>
            </div>
          ) : (
            <>
              <div className="tp-colhead">
                <span className="tp-step">1</span>选择条目
                <span className="grow" />
                <button type="button" className="btn small ghost" onClick={selectAll} disabled={!totalCount || isWhole}>
                  全选
                </button>
                <button type="button" className="btn small ghost" onClick={clearAll} disabled={!selected.size}>清空</button>
              </div>

              <div className="tp-tree" role="tree" aria-label="条目树" aria-multiselectable="true">
                {tree.length ? roots.map((n) => renderTree(n)) : <Empty>还没有条目</Empty>}
              </div>

              <div className="tp-tree-hint hint">
                勾上级 = 连带所有嵌套子条目；右侧下载图标可直接导出该条及其全部子条目。
              </div>
            </>
          )}

          <label className="inline pickall" title="不勾 = 只带数据本体（条目/字段），附件原件不进包——包小很多，但导入后图片/文档引用会指向不存在的附件">
            <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
            <span>携带附件原件{withFiles ? '' : '（包内只有数据）'}</span>
          </label>

          <p className="hint tp-tip">
            填了口令 = 整包 AES-256-GCM 加密，导入时要同一个口令；口令不在文件里，忘了打不开。
            {fullOnly ? '这里是全部条目的整库备份。' : '「全选」就是全部条目，与逐个勾选是同一个包。'}
          </p>
        </div>

        {/* ── 右：倒回来 ─────────────────────────────────────── */}
        <div className="tp-col" aria-label="解密导入">
          <div className="tp-colhead"><span className="tp-step">2</span>解密导入</div>
          <div
            className={`drop-box${dragOver ? ' over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = [...(e.dataTransfer?.files || [])][0];
              handleZip(f);
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }}
          >
            <strong>把导出的 ZIP 拖到这里</strong>
            <span className="hint">或点击选择文件 · 明文包与加密包都认</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = [...(e.target.files || [])][0];
              e.target.value = '';
              handleZip(f);
            }}
          />
          <div className="tp-note">
            <div className="hint">导入前先预览，不写盘：</div>
            <ul className="tp-list">
              <li>哪些条目模板会新建、补哪些字段</li>
              <li>条目逐条列冲突（同 id / 同标题），可选跳过 / 另存 / 覆盖</li>
              <li>附件按 sha256 去重，本机已有就复用</li>
            </ul>
          </div>
        </div>
      </div>

      {ask ? (
        <Modal
          title={`这个包已加密 · ${ask.fileName}`}
          onClose={() => { if (!busy) { setAsk(null); setAskPw(''); } }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setAsk(null)} disabled={busy}>取消</button>
              <button className="btn" onClick={submitAsk} disabled={busy || !askPw.trim()}>
                {busy ? '解密中…' : '打开预览'}
              </button>
            </>
          )}
        >
          <div className="stack">
            <div className="hint">导出时给这个包设了口令。输入同一口令才能预览与导入——口令不在文件里，错了只能重试。</div>
            <input
              type="password"
              autoComplete="off"
              className="pw"
              value={askPw}
              onChange={(e) => setAskPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAsk(); }}
              placeholder="导出时设置的口令"
            />
          </div>
        </Modal>
      ) : null}

      {zip ? (
        <Modal
          title={`导入预览 · ${zip.fileName}`}
          onClose={() => { if (!busy) setZip(null); }}
          footer={(
            <>
              <button className="btn ghost" onClick={() => setZip(null)} disabled={busy}>取消</button>
              <button className="btn" onClick={applyZip} disabled={busy}>{busy ? '导入中…' : '确认导入'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            const t = p.totals;
            return (
              <div className="stack">
                <div className="hint">
                  导出时间 {p.exportedAt || '未知'}
                  {p.encrypted ? '　·　已解密（口令已验证）' : '　·　明文包（未设口令）'}
                </div>
                <div className="rowgap">
                  <Tag>条目模板 {t.templates}{t.newTemplates ? `（新建 ${t.newTemplates}）` : ''}</Tag>
                  <Tag>条目 {t.entries}</Tag>
                  <Tag>新增 {t.fresh}</Tag>
                  {t.conflicts ? <span className="tag bad">冲突 {t.conflicts}</span> : null}
                  <Tag>附件 新增 {t.filesNew} / 复用 {t.filesReused}（{fmtBytes(t.bytes)}）</Tag>
                </div>

                <div className="block">
                  {p.templates.map((s) => (
                    <div key={s.id} className="transfer-sec-row">
                      <strong>{s.title}</strong>
                      <span className="mono muted">{s.id}</span>
                      {s.willCreate ? <span className="tag">新建</span> : null}
                      <span className="hint">
                        条目 {s.entries.total}（新增 {s.entries.fresh}）· 冲突 {s.entries.conflicts.length} · 补字段 {s.fieldsToAdd.length}
                      </span>
                    </div>
                  ))}
                </div>

                {/* 冲突明细：哪条撞了哪条、按什么规则、另存会变成什么 */}
                {t.conflicts ? (
                  <div className="stack">
                    <div className="flabel"><span>冲突明细</span><span className="fkey">撞 = 本地已有同 id 或同标题的条目</span></div>
                    <div className="conflict-list">
                      {p.templates.map((s) => s.entries.conflicts.map((c) => (
                        <div key={`${s.id}-${c.id}`} className="conflict-row">
                          <span className="sec">{s.title}</span>
                          <span className="title">{c.title}</span>
                          <span className="hint">
                            {c.reason === 'id' ? `同 id 撞上「${c.existingTitle}」` : `同标题撞上「${c.existingTitle}」`}
                          </span>
                          {conflict === 'copy' ? <span className="hint ok">→ {c.copyTitle}</span> : null}
                        </div>
                      )))}
                    </div>
                    <div className="flabel"><span>冲突怎么处理</span></div>
                    <label className="inline"><input type="radio" checked={conflict === 'skip'} onChange={() => setConflict('skip')} /> 跳过（保留现有）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'copy'} onChange={() => setConflict('copy')} /> 另存为新条目（标题加「导入」）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'overwrite'} onChange={() => setConflict('overwrite')} /> 覆盖现有条目的字段</label>
                  </div>
                ) : null}

                {p.warnings.slice(0, 8).map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}
    </div>
  );
}

