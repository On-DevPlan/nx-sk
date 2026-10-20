// 字段编辑器：按字段字典的 type 决定控件。
// 字典来自后端（section.fields），所以**面板能填的字段与 CLI 能填的字段天然一致**。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { fileToDataUrl, listAttachments, mergeFiles, refreshAttachments } from '../api/files.js';
import { Copyable, copyText } from './ui.jsx';
import { Lightbox } from './lightbox.jsx';
import { MdView, imageRecord } from './mdView.jsx';
import { SourceFieldControl } from './sourcePanel.jsx';
import { imageRefs, linkCount } from '../mdInline.js';
import { smartStats } from '../mdSmart.js';
import { taskStats, toggleTaskAtLine } from '../mdSource.js';
import { useStore } from '../store.jsx';

/**
 * 自适应高度 textarea：所见即所得，填多少显示多少。
 * - 初始 `minRows` 行（避免空字段塌成一坨）；输入后按 scrollHeight 撑开
 * - `resize: none` + `overflow: hidden` 关掉浏览器默认的拖拽手柄与滚动条（自适应时两者会打架）
 * - reset 'auto' → 测 scrollHeight → 设回：删字时能正确回缩，而不是黏在上一次的高
 * - 用 useLayoutEffect 而非 useEffect，避免一帧的「旧高度 + 新内容」闪一下
 * - `textareaRef` 供图文字段读光标位置；其余 props 透传（onPaste 等）
 */
function AutoTextarea({ value, onChange, minRows = 2, placeholder, disabled, maxLength, maxHeight, textareaRef, ...rest }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    // maxHeight 用于长文（图文 SOP 动辄几百行）：不封顶的话 auto-height 会把
    // 整页撑到几千像素，下面的预览和图库全被推到看不见的地方。
    el.style.height = `${maxHeight ? Math.min(h, maxHeight) : h}px`;
    el.style.overflowY = maxHeight && h > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  return (
    <textarea
      {...rest}
      ref={(el) => {
        ref.current = el;
        if (textareaRef) textareaRef.current = el;
      }}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      rows={minRows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
      style={{ resize: 'none', overflow: 'hidden', width: '100%' }}
    />
  );
}

/**
 * 字段值 → 附件 id 数组。
 * 一个 `file` 字段可挂**多个**附件：新写入统一存数组；历史形态有单值字符串、
 * 甚至旧版连写的 `"f_a,f_b"`（0.8.0 前 `--set` 不拆逗号）——统一拆分隔符归一。
 * 前端不能 import core，所以这里自带一份同口径的归一化。
 */
function toIds(value) {
  const raw = value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  const out = [];
  for (const x of raw) {
    for (const piece of String(x ?? '').split(/[,，、;；]+/)) {
      const id = piece.trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * file 字段控件（**多值**）：值 = 附件 id 的列表，一个字段能挂多个附件
 * （简历多版本、头像多张……）。
 *
 * **上传 / 选择就发生在这里**（「文件在栏目中链接」）；「附件」中心只负责统一展示与
 * 库存管理，不在这里做指派，也不预定义任何槽位。
 * 列表逐行显示：缩略图/扩展名徽标 + 名称（内联预览）+ 下载 + 复制物理路径 + 移除；
 * 底部是添加入口（可**多选**上传、或从库里选一个追加）。
 */
export function FileFieldControl({ def, value, onChange }) {
  const { toast, guard, patchUi } = useStore();
  const [data, setData] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // 附件多的时候不把表单撑长：默认只露 5 行，窗口内上下滚动；需要看全时一键展开
  const [expanded, setExpanded] = useState(false);
  const uploadRef = useRef(null);
  // dragenter/dragleave 在子元素间穿梭时会成对触发，用深度计数避免「还没离开就熄掉高亮」
  const dragDepth = useRef(0);
  const ids = toIds(value);
  const max = Number(def.maxItems) || 0;
  const full = max > 0 && ids.length >= max;

  const load = useCallback(async (force = false) => {
    // 挂载时强制刷新：附件可能刚被 CLI / 另一个标签页导入，缓存里的旧表会让
    // 已关联的文件显示成「不存在」
    try { setData(await listAttachments(force)); } catch { /* 附件库读不到时仍可上传 */ }
  }, []);
  useEffect(() => { load(true); }, [load]);

  const all = data?.files || [];
  const byId = (id) => all.find((f) => f.id === id) || null;
  const available = all.filter((f) => !ids.includes(f.id));

  const upload = guard(async (fileList) => {
    const picked = [...(fileList || [])];
    if (!picked.length) return;
    if (full) { toast(`「${def.label}」最多 ${max} 个附件，先移除一个`, 'bad'); return; }
    const next = [...ids];
    let duplicated = 0;
    for (const file of picked) {
      const content = await fileToDataUrl(file);
      const r = await api('/api/files', { method: 'POST', body: { content, name: file.name } });
      if (next.includes(r.id)) { duplicated += 1; continue; }
      next.push(r.id);
    }
    onChange(next);
    const added = picked.length - duplicated;
    toast(duplicated
      ? `已上传并关联 ${added} 个；${duplicated} 个库里已有，直接引用`
      : `已上传并关联 ${picked.length} 个`);
    setData(await refreshAttachments());
  });

  const add = (id) => { if (id && !ids.includes(id)) onChange([...ids, id]); };
  const removeAt = (id) => onChange(ids.filter((x) => x !== id));

  // 拖拽文件进字段框 = 直接上传并追加（与「附件」中心同一套手感）
  const onDrop = guard(async (e) => {
    dragDepth.current = 0;
    setDragOver(false);
    await upload(e.dataTransfer?.files);
  });

  return (
    <div
      className={`file-picker ${dragOver ? 'drag' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
      onDrop={onDrop}
    >
      {ids.length ? (
        <div className={`file-picker-list${expanded ? ' expanded' : ''}`}>
          {ids.map((id) => {
            const rec = byId(id);
            if (!rec) {
              return (
                <div className="file-preview" key={id}>
                  <span className="hint bad grow">引用的附件已不存在（{id}）—— 重新上传，或移除。</span>
                  <button type="button" className="btn small ghost" onClick={() => removeAt(id)}>移除</button>
                </div>
              );
            }
            return (
              <div className="file-preview" key={id}>
                {rec.isImage
                  ? <img src={rec.url} alt={rec.name} />
                  : <span className="ext-badge" style={{ fontSize: 13, width: 40, textAlign: 'center' }}>{rec.ext ? rec.ext.slice(1).toUpperCase() : 'FILE'}</span>}
                <a className="file-preview-name grow" href={rec.url} target="_blank" rel="noreferrer" title={rec.displayPath}>{rec.name}</a>
                <a className="btn small ghost" href={rec.downloadUrl}>下载</a>
                <Copyable className="hint" text={rec.path} title="点击复制物理路径">路径</Copyable>
                <button type="button" className="btn small ghost" onClick={() => removeAt(id)}>移除</button>
              </div>
            );
          })}
        </div>
      ) : null}
      {!ids.length ? <span className="hint">还没有附件。</span> : null}
      {ids.length > 5 ? (
        <div className="file-pick-row">
          <span className="hint">共 {ids.length} 个附件{expanded ? '（已展开全部）' : '（窗口内上下滚动查看）'}</span>
          <button type="button" className="btn small ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起到 5 行' : '展开全部'}
          </button>
        </div>
      ) : null}
      <div className="file-pick-row">
        <select value="" disabled={full || !available.length} onChange={(e) => add(e.target.value)}>
          <option value="">{available.length ? '（从附件库选一个，选中即追加）' : '（库里没有可再选的附件）'}</option>
          {available.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button type="button" className="btn small" disabled={full} onClick={() => uploadRef.current?.click()}>上传文件</button>
        <button type="button" className="btn small ghost" onClick={() => { patchUi({ view: 'files' }); window.location.hash = '#/files'; }}>附件中心</button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
        />
      </div>
      {full ? <span className="hint">已达上限（{max} 个）：先移除一个，或把字段的 maxItems 调大。</span> : null}
      {def.hint ? <span className="hint">{def.hint}</span> : null}
    </div>
  );
}

/**
 * 图文字段（`type: 'md'`）：一段 markdown 文字，里面可以嵌图片、写待办。
 *
 * 存在理由：部署 SOP 这类内容天然是「说明 + 截屏」混排。用 textarea 存不了图；
 * 用 file 字段又只有一堆附件、没有步骤叙述。所以这里让**正文即真相**：
 *
 *   ![截图](f_xxx)      ← 标准 markdown，导出/贴进仓库 README 都能直接渲染
 *   - [ ] 改完配置重启   ← 任务列表：预览里点一下勾，写回正文的 `[x]`
 *
 * 四条交互：
 *   1. 贴图不离场：Ctrl+V / 拖进来 / 选文件 → 上传到附件库 → 插到光标处；
 *   2. 图片统一列在下方：长文里不用翻找，点开就是大图（滚轮缩放、拖动看细节）；
 *   3. 正文下方就地预览：标题/列表/表格/代码块都按 markdown 渲染，
 *      http 网址直接可点，待办勾选框可直接点（改的是正文，不是另一份状态）；
 *   4. 阅读优先：有内容时先给预览，点「编辑正文」才展开输入框。
 *
 * 渲染本身交给 `./mdView.jsx`（react-markdown + remark-gfm）；
 * 这里只管「正文怎么被编辑」（上传、插入、写回），以及下方图库。
 */

/** 粘贴来的截图往往没有可用文件名。这个名字会进正文说明文字，也进附件库。 */
function pastedName(file, index = 0) {
  const raw = String(file.name || '').trim();
  const generic = !raw || /^image\.(png|jpe?g)$/i.test(raw) || /^blob$/i.test(raw);
  if (!generic) return raw;
  const m = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.exec(file.type || '');
  const ext = m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}` : '.png';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `粘贴截图-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${index ? `-${index + 1}` : ''}${ext}`;
}

export function MdImageFieldControl({ def, value, onChange }) {
  const { toast, guard } = useStore();
  const [lib, setLib] = useState([]);
  const [libReady, setLibReady] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [busy, setBusy] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // 阅读优先：已有内容时先给预览，点「编辑正文」才展开输入框。
  // 长文（SOP 动辄几百行）如果一直摊开 auto-height 的 textarea，整页会被撑到几千像素，
  // 下面的预览和图库全被推走 —— 新手根本看不到图。
  const [editing, setEditing] = useState(() => !String(value ?? '').trim());
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);

  const text = String(value ?? '');

  const loadImages = useCallback(async (force = false) => {
    try {
      const d = await listAttachments(force);
      return (d?.files || []).filter((f) => f.isImage);
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

  const byId = useMemo(() => new Map((lib || []).map((f) => [f.id, f])), [lib]);
  const refs = useMemo(() => imageRefs(text), [text]);
  const links = useMemo(() => linkCount(text), [text]);
  const tasks = useMemo(() => taskStats(text), [text]);
  const smart = useMemo(() => smartStats(text), [text]);
  // 同一张图在正文里出现两次只列一次：下方是「这个字段用到了哪些图」，不是出现次数
  const uniqueRefs = useMemo(() => {
    const seen = new Set();
    return refs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [refs]);

  /** 插到光标处（未聚焦时落尾）；与前后各垫一个空格，免得跟文字粘成一串。 */
  const insert = (snippet) => {
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

  const uploadImages = guard(async (fileList) => {
    const all = [...(fileList || [])];
    const picked = all.filter((f) => f && String(f.type || '').startsWith('image/'));
    if (!picked.length) {
      toast(all.length ? '只支持图片：截图直接 Ctrl+V 粘进来即可' : '没有可插入的文件', 'bad');
      return;
    }
    setBusy({ done: 0, total: picked.length });
    try {
      const parts = [];
      const fresh = [];
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
        .then((d) => setLib((d?.files || []).filter((f) => f.isImage)))
        .catch(() => { /* 拉不到就沿用上面并进去的那份，预览不受影响 */ });
    } finally {
      setBusy(null);
    }
  });

  // 粘贴：只有「剪贴板里真的有图片」才接管；纯文字粘贴交给浏览器默认（光标处插入）
  const onPaste = (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const imgs = [];
    for (const it of dt.items || []) {
      if (it.kind !== 'file') continue;
      if (!String(it.type || '').startsWith('image/')) continue;
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
    if (!imgs.length && dt.files) {
      imgs.push(...[...dt.files].filter((f) => String(f.type || '').startsWith('image/')));
    }
    if (!imgs.length) return;
    e.preventDefault();
    uploadImages(imgs);
  };

  const onDrop = (e) => {
    dragDepth.current = 0;
    setDragOver(false);
    e.preventDefault();
    // 阅读态拖图进来 = 想加图：先展开编辑器，否则插入的内容看不见
    if (!editing) setEditing(true);
    uploadImages(e.dataTransfer?.files);
  };

  const insertFromLib = (id) => {
    const rec = byId.get(id);
    if (rec) insert(`![${rec.name}](${rec.id})`);
  };

  const openZoom = useCallback((rec) => setZoom(rec), []);

  // 预览里勾选待办 = 改正文那一行。正文是唯一真相：没有第二份「勾选状态」，
  // 所以刷新、导出、CLI 读到的都是勾完之后的样子。
  const toggleTask = useCallback((line) => onChange(toggleTaskAtLine(text, line)), [text, onChange]);

  // 正文里的 IP 点击即复制：反馈与 Copyable 同一套，用户不用再去别处找「复制」按钮
  const copyMd = useCallback(async (value) => {
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
      className={`md-field ${dragOver ? 'drag' : ''}`}
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
            {lib.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
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
                {uniqueRefs.map((r) => {
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

/**
 * 结构清单字段（`type: 'entrylist'`）：一个字段装**变长的一张迷你表**。
 *
 * 场景：一个条目要挂「多组 链接/账号/密码」——tags 存不了结构，拆成多个字段
 * 又不知道会有几组。列（子字段）由字段字典声明（def.fields），行自由增删；
 * 敏感列与顶层敏感字段同一条边界（密文落盘），输入框按工具栏的「打码显示」
 * 切 password 形态（只是显示形态，值始终是草稿里的原文）。
 *
 * 密集：列头 + 行输入框直接铺开，没有「先展开再编辑」的两段式——这类清单
 * 就是拿来快速增删查改的。空行不用管，保存时服务端会剔除全空行。
 */
export function EntryListFieldControl({ def, value, onChange }) {
  const { ui } = useStore();
  const mask = !!ui.mask;
  const subs = Array.isArray(def.fields) ? def.fields : [];
  const rows = Array.isArray(value) ? value.filter((r) => r && typeof r === 'object') : [];
  const template = `${subs.map(() => 'minmax(0, 1fr)').join(' ')} auto`;

  const setRow = (i, key, v) => onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  const addRow = () => onChange([...rows, {}]);
  const removeRow = (i) => onChange(rows.filter((_, idx) => idx !== i));

  if (!subs.length) {
    return <span className="hint">这个清单字段没有声明列（子字段），渲染不出输入格。用 section update 把字段的 fields 子字段补上。</span>;
  }

  return (
    <div className="entrylist">
      <div className="entrylist-head" style={{ gridTemplateColumns: template }}>
        {subs.map((s) => (
          <span key={s.key} className="entrylist-col" title={s.hint || ''}>
            {s.label}
            {s.sensitive ? <span className="tag bad">密文</span> : null}
          </span>
        ))}
        <span />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="entrylist-row" style={{ gridTemplateColumns: template }}>
          {subs.map((s) => (
            <input
              key={s.key}
              type={s.sensitive && mask ? 'password' : 'text'}
              autoComplete="off"
              value={String(row[s.key] ?? '')}
              placeholder={s.sensitive ? '密文落盘' : ''}
              onChange={(e) => setRow(i, s.key, e.target.value)}
            />
          ))}
          <button type="button" className="btn small ghost" title="删除这一行" onClick={() => removeRow(i)}>×</button>
        </div>
      ))}
      <div className="entrylist-add">
        <button type="button" className="btn small" onClick={addRow}>＋ 添加一行</button>
        <span className="hint">{rows.length ? `${rows.length} 行` : '还没有行'}　·　变长，空行保存时自动剔除</span>
      </div>
    </div>
  );
}

export function FieldControl({ def, value, onChange, disabled, ctx }) {
  const type = def.type || 'text';
  const v = value === null || value === undefined ? '' : value;

  if (type === 'md') {
    return <MdImageFieldControl def={def} value={v} onChange={onChange} />;
  }

  if (type === 'file') {
    return <FileFieldControl def={def} value={v} onChange={onChange} />;
  }

  if (type === 'source') {
    return <SourceFieldControl def={{ ...def, ...(ctx || {}) }} value={v} onChange={onChange} />;
  }

  if (type === 'entrylist') {
    return <EntryListFieldControl def={def} value={v} onChange={onChange} />;
  }

  if (type === 'bool') {
    const checked = v === true || v === 'true' || v === '是';
    return (
      <label className="inline">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="muted">{checked ? '是' : '否'}</span>
      </label>
    );
  }

  if (type === 'select') {
    const options = def.options || [];
    const isCustom = v !== '' && !options.includes(v);
    return (
      <select value={isCustom ? '__custom' : String(v)} onChange={(e) => onChange(e.target.value === '__custom' ? '' : e.target.value)}>
        <option value="">（未填写）</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        {isCustom ? <option value="__custom">{String(v)}（当前值，不在候选里）</option> : null}
      </select>
    );
  }

  if (type === 'textarea') {
    return <AutoTextarea value={v} onChange={onChange} />;
  }

  if (type === 'tags') {
    const text = Array.isArray(v) ? v.join('、') : String(v);
    return (
      <input
        value={text}
        placeholder={def.maxItems ? `多个用「、」分隔，最多 ${def.maxItems} 个` : '多个用「、」分隔'}
        onChange={(e) => onChange(e.target.value.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean))}
      />
    );
  }

  const inputType = type === 'number' ? 'number' : (type === 'date' ? 'date' : (type === 'month' ? 'month' : 'text'));
  if (type === 'secret') {
    return (
      <input
        type="text"
        value={String(v)}
        placeholder="密文落盘；原样保留占位则视为不修改"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return <input type={inputType} value={String(v)} onChange={(e) => onChange(e.target.value)} />;
}

/** 一整组字段（同一 group）的矩阵。 */
export function FieldGroup({ title, fields, draft, onPatch, sectionTitle, entryTitle }) {
  return (
    <>
      <div className="group-title">{title}</div>
      <div className="pad">
        <div className="grid">
          {fields.map((def) => (
            <div key={def.key} className={`field ${['textarea', 'file', 'md', 'entrylist', 'source'].includes(def.type) ? 'wide' : ''}`}>
              <div className="flabel">
                <span>{def.label}</span>
                {def.sensitive ? <span className="tag bad">密文</span> : null}
                {/* 填写策略来自后端字段字典；不计入完整度，所以标签用中性色而不是红色——
                    用户是**主动**跳过它，不是出错。 */}
                {def.fill && def.fill !== 'normal' ? <span className="tag">{def.fillLabel || def.fill}</span> : null}
                <span className="fkey">{def.key}</span>
              </div>
              <div className="fctrl">
                <FieldControl
                  def={def}
                  value={draft[def.key]}
                  onChange={(v) => onPatch(def.key, v)}
                  ctx={{ sectionTitle, entryTitle }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
