// 图文字段（`type: 'md'`）：一段 markdown 文字，里面可以嵌图片、写待办。
//
// 存在理由：部署 SOP 这类内容天然是「说明 + 截屏」混排。用 textarea 存不了图；
// 用 file 字段又只有一堆附件、没有步骤叙述。所以这里让**正文即真相**：
//
//   ![截图](f_xxx)      ← 标准 markdown，导出/贴进仓库 README 都能直接渲染
//   - [ ] 改完配置重启   ← 任务列表：预览里点一下勾，写回正文的 `[x]`
//
// 四条交互：
//   1. 贴图不离场：Ctrl+V / 拖进来 / 选文件 → 上传到附件库 → 插到光标处；
//   2. 图片统一列在下方：长文里不用翻找，点开就是大图（滚轮缩放、拖动看细节）；
//   3. 正文下方就地预览：标题/列表/表格/代码块都按 markdown 渲染，
//      http 网址直接可点，待办勾选框可直接点（改的是正文，不是另一份状态）；
//   4. 阅读优先：有内容时先给预览，点「编辑正文」才展开输入框。
//
// 渲染本身交给 `../mdView.tsx`（react-markdown + remark-gfm）；
// 这里只管「正文怎么被编辑」（上传、插入、写回），以及下方图库。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { fileToDataUrl, listAttachments, mergeFiles, refreshAttachments } from '../../api/files.ts';
import { copyText } from '../ui.tsx';
import { Lightbox } from '../lightbox.tsx';
import { MdView, imageRecord } from '../mdView.tsx';
import { imageRefs, linkCount } from '../../mdInline.ts';
import { smartStats } from '../../mdSmart.ts';
import { taskStats, toggleTaskAtLine } from '../../mdSource.ts';
import { useStore } from '../../store.tsx';
import { AutoTextarea } from './autoTextarea.tsx';
import type { ControlProps } from './types.ts';

/** 粘贴来的截图往往没有可用文件名。这个名字会进正文说明文字，也进附件库。 */
function pastedName(file: any, index = 0) {
  const raw = String(file.name || '').trim();
  const generic = !raw || /^image\.(png|jpe?g)$/i.test(raw) || /^blob$/i.test(raw);
  if (!generic) return raw;
  const m = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.exec(file.type || '');
  const ext = m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}` : '.png';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `粘贴截图-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${index ? `-${index + 1}` : ''}${ext}`;
}

export function MdControl({ def, value, onChange }: ControlProps) {
  // store 目前还是 JSX（P5 才迁 TS），`createContext(null)` 让 TS 把它推成 never。
  const { toast, guard } = useStore() as any;
  const [lib, setLib] = useState<any[]>([]);
  const [libReady, setLibReady] = useState(false);
  const [zoom, setZoom] = useState<any>(null);
  const [busy, setBusy] = useState<any>(null);
  const [dragOver, setDragOver] = useState(false);
  // 阅读优先：已有内容时先给预览，点「编辑正文」才展开输入框。
  // 长文（SOP 动辄几百行）如果一直摊开 auto-height 的 textarea，整页会被撑到几千像素，
  // 下面的预览和图库全被推走 —— 新手根本看不到图。
  const [editing, setEditing] = useState(() => !String(value ?? '').trim());
  const taRef = useRef<any>(null);
  const fileRef = useRef<any>(null);
  const dragDepth = useRef(0);

  const text = String(value ?? '');

  const loadImages = useCallback(async (force = false) => {
    try {
      const d = await listAttachments(force);
      return (d?.files || []).filter((f: any) => f.isImage);
    } catch {
      return [];
    }
  }, []);
  // 首次挂载**强制拉一次**：正文里的图片可能是 CLI 批量导入的（如整份 SOP），
  // 浏览器里那份缓存比它们更早，按缓存渲染就会整篇「图片缺失」。
  // libReady 用来区分「还没拉到」和「真的不存在」—— 前者不该报警。
  useEffect(() => {
    let alive = true;
    loadImages(true).then((list) => {
      if (!alive) return;
      setLib(list);
      setLibReady(true);
    });
    return () => { alive = false; };
  }, [loadImages]);

  const byId = useMemo(() => new Map((lib || []).map((f: any) => [f.id, f])), [lib]);
  const refs = useMemo(() => imageRefs(text), [text]);
  const links = useMemo(() => linkCount(text), [text]);
  const tasks = useMemo(() => taskStats(text), [text]);
  const smart = useMemo(() => smartStats(text), [text]);
  // 同一张图在正文里出现两次只列一次：下方是「这个字段用到了哪些图」，不是出现次数
  const uniqueRefs = useMemo(() => {
    const seen = new Set<string>();
    return refs.filter((r: any) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [refs]);

  /** 插到光标处（未聚焦时落尾）；与前后各垫一个空格，免得跟文字粘成一串。 */
  const insert = (snippet: string) => {
    const el = taRef.current;
    const start = el && el.selectionStart !== null ? el.selectionStart : text.length;
    const end = el && el.selectionEnd !== null ? el.selectionEnd : start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const padL = before && !/\s$/.test(before) ? ' ' : '';
    const padR = after && !/^\s/.test(after) ? ' ' : '';
    onChange(`${before}${padL}${snippet}${padR}${after}`);
    const caret = before.length + padL.length + snippet.length;
    requestAnimationFrame(() => {
      const t = taRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(caret, caret);
    });
  };

  const uploadImages = guard(async (fileList: any) => {
    const all = [...(fileList || [])];
    const picked = all.filter((f: any) => f && String(f.type || '').startsWith('image/'));
    if (!picked.length) {
      toast(all.length ? '只支持图片：截图直接 Ctrl+V 粘进来即可' : '没有可插入的文件', 'bad');
      return;
    }
    setBusy({ done: 0, total: picked.length });
    try {
      const parts: string[] = [];
      const fresh: any[] = [];
      for (let i = 0; i < picked.length; i += 1) {
        setBusy({ done: i + 1, total: picked.length });
        const name = pastedName(picked[i], i);
        const content = await fileToDataUrl(picked[i]);
        const r = await api('/api/files', { method: 'POST', body: { content, name } });
        // 先把刚上传的记录攒下来：预览与图库都靠 byId 解析，而 lib 来自**带缓存**的
        // 附件列表（挂载时那份）。只靠上传后再拉列表，刚贴的图会一直显示「图片缺失」——
        // 图明明已经在库里了（这也是「复制到了附件中心但预览不出来」的根因）。
        fresh.push({ id: r.id, name: r.name || name, url: r.url, isImage: true });
        parts.push(`![${name}](${r.id})`);
      }
      setLib((prev) => mergeFiles(prev, fresh));
      // 一次插入全部：连续插入会跟光标位置打架（第一张插完 DOM 光标还没更新）
      insert(parts.join(' '));
      const skipped = all.length - picked.length;
      toast(`已插入 ${parts.length} 张图${skipped ? `（忽略 ${skipped} 个非图片文件）` : ''}`);
      // 再把完整台账换成服务端的（强制失效缓存：默认参数会直接返回挂载时那份旧列表）
      refreshAttachments()
        .then((d: any) => setLib((d?.files || []).filter((f: any) => f.isImage)))
        .catch(() => { /* 拉不到就沿用上面并进去的那份，预览不受影响 */ });
    } finally {
      setBusy(null);
    }
  });

  // 粘贴：只有「剪贴板里真的有图片」才接管；纯文字粘贴交给浏览器默认（光标处插入）
  const onPaste = (e: any) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const imgs: any[] = [];
    for (const it of dt.items || []) {
      if (it.kind !== 'file') continue;
      if (!String(it.type || '').startsWith('image/')) continue;
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
    if (!imgs.length && dt.files) {
      imgs.push(...[...dt.files].filter((f: any) => String(f.type || '').startsWith('image/')));
    }
    if (!imgs.length) return;
    e.preventDefault();
    uploadImages(imgs);
  };

  const onDrop = (e: any) => {
    dragDepth.current = 0;
    setDragOver(false);
    e.preventDefault();
    // 阅读态拖图进来 = 想加图：先展开编辑器，否则插入的内容看不见
    if (!editing) setEditing(true);
    uploadImages(e.dataTransfer?.files);
  };

  const insertFromLib = (id: string) => {
    const rec = byId.get(id);
    if (rec) insert(`![${rec.name}](${rec.id})`);
  };

  const openZoom = useCallback((rec: any) => setZoom(rec), []);

  // 预览里勾选待办 = 改正文那一行。正文是唯一真相：没有第二份「勾选状态」，
  // 所以刷新、导出、CLI 读到的都是勾完之后的样子。
  const toggleTask = useCallback((line: number) => onChange(toggleTaskAtLine(text, line)), [text, onChange]);

  // 正文里的 IP 点击即复制：反馈与 Copyable 同一套，用户不用再去别处找「复制」按钮
  const copyMd = useCallback(async (value: string) => {
    const ok = await copyText(value);
    if (ok) toast(`已复制 ${value}`);
    else toast('复制失败：浏览器拒绝了剪贴板访问', 'bad');
  }, [toast]);

  // 一行说清「这篇里有什么」：图片张数 / 待办进度 / 可点链接数（含自动补协议的裸域名）/ IP 数
  const stats = [
    `图片 ${uniqueRefs.length} 张`,
    tasks.total ? `待办 ${tasks.done}/${tasks.total}` : '',
    links + smart.url ? `链接 ${links + smart.url} 个` : '',
    smart.copy ? `IP ${smart.copy} 个（点击复制）` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={`md-field ${editing ? 'editing' : 'reading'} ${dragOver ? 'drag' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
      onDrop={onDrop}
    >
      {editing ? (
        <AutoTextarea
          value={text}
          onChange={onChange}
          minRows={4}
          maxHeight={360}
          textareaRef={taRef}
          onPaste={onPaste}
          placeholder="步骤说明…　截图直接 Ctrl+V 粘进来；裸 IP 点击即复制，网址点击直接打开"
        />
      ) : null}

      {editing ? (
        <div className="md-tools">
          <button type="button" className="btn small" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy ? `上传中 ${busy.done}/${busy.total}…` : '插入图片'}
          </button>
          <select value="" disabled={!lib.length} onChange={(e) => { insertFromLib(e.target.value); e.target.value = ''; }}>
            <option value="">{lib.length ? '从附件库插入…' : '附件库里还没有图片'}</option>
            {lib.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <span className="hint">
            语法 <code>![说明](附件id)</code>　待办 <code>- [ ]</code>　{stats}
          </span>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>完成</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              // FileList 是活的：先拷成数组再清 value，否则 uploadImages 收到的是空列表
              const picked = [...(e.target.files || [])];
              e.target.value = '';
              uploadImages(picked);
            }}
          />
        </div>
      ) : (
        <div className="md-tools">
          <button type="button" className="btn small ghost" onClick={() => setEditing(true)}>编辑正文</button>
          <span className="hint">
            {text.length} 字 · {stats}　只读预览（勾选框可点，IP 点击复制）
          </span>
        </div>
      )}

      <div className={`md-preview${editing ? '' : ' reading'}`}>
        {!libReady && refs.length
          ? <span className="hint">正在加载图片…</span>
          : text.trim()
            ? <MdView text={text} byId={byId} onOpenImage={openZoom} onToggleTask={toggleTask} onCopy={copyMd} />
            : <span className="hint">（还没有内容）</span>}
      </div>

      {/* 阅读态 + 正文里没有图：这块只剩「图片（0）」和一句空提示，是纯噪音（上线清单这种
          纯文字字段尤其明显）。编辑态留着 —— 它是「贴进来的图会出现在这里」的落点提示。 */}
      {uniqueRefs.length || editing ? (
        <div className="md-gallery">
          <div className="md-gallery-head">
            <span>图片（{uniqueRefs.length}）</span>
            <span className="hint">点击放大 · 滚轮缩放 · 拖动看细节</span>
          </div>
          {uniqueRefs.length ? (
            !libReady ? <span className="hint">正在加载图片…</span> : (
              <div className="md-thumbs">
                {uniqueRefs.map((r: any) => {
                  const rec = imageRecord(byId, r.id, r.alt);
                  if (!rec) {
                    return <span key={r.id} className="md-thumb missing" title="这条引用指向的附件已不在库里（可能已在附件中心删除）">缺</span>;
                  }
                  return (
                    <button type="button" key={r.id} className="md-thumb" title={`${rec.name}（点击放大）`} onClick={() => openZoom(rec)}>
                      <img src={rec.url} alt={rec.name} />
                      <span className="md-thumb-name">{r.alt || rec.name}{r.remote ? '（外链）' : ''}</span>
                    </button>
                  );
                })}
              </div>
            )
          ) : <span className="hint">正文里还没有图片。粘贴/拖入的图会出现在这里。</span>}
        </div>
      ) : null}

      {def.hint ? <span className="hint">{def.hint}</span> : null}
      {zoom ? <Lightbox item={zoom} onClose={() => setZoom(null)} /> : null}
    </div>
  );
}
