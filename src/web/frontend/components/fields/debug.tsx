// debug（资源引用）字段控件：值 = locator 数组的文档 `{v, refs}`。
//
// 三块职责（任务 #18 用户裁决 + #21 验收反馈「内联数据板、实时响应绑定的位置的结果」）：
//   1. **格子（chip）= 内联数据板**：每个引用一格，显示被引用资源的标题 +
//      **绑定位置的实时值**（字段值 / 条目完整度 / 附件字节——resolve-batch 一次取回，
//      任何一次 reload 都会刷新）；resolve 不到 = 引用失效 → 显示 locator 原文并标灰。
//      点格子 = 复制 locator（粘给 agent 即可定位）；× = 移除该引用。
//      引用只允许**数据位置**（条目/条目-字段/附件）：结构引用在写入点就被拒（#21）。
//   2. **悬浮预览**：鼠标停在格子上 → 浮层直接预览被引用内容（形态沿用 peek 外壳
//      的头部三件套：标题 / 副题 / 类型；密文值在 resolve 出口就已打码）。
//      #23 验收反馈：「至少悬浮的时候保证每次都是实时查值」——**每次 mouseenter 都
//      单查这个 locator**，浮层与格子内联值随结果更新；另外**点击所在块任意处**
//      （含块头）整板批量重查，外部（CLI / 别的页面）改的值不用等保存也能刷出来。
//   3. **＋ 引用资源**：打开检索面板（与侧栏共用 `resource.search`，但只呈现
//      条目/条目-字段/附件——结构类命中被过滤），选中即把 locator 追加进 refs——
//      值仍走「N 处改动 → 保存」的既有通路。
//
// 配色纪律：无边框 Notion——格子静止无底色、hover 才现 --hover 色块；浮层用 --paper + 弱线。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { copyText } from '../../entryRef.ts';
import { controlOf } from './index.ts';
import type { ControlProps } from './types.ts';

/** resolve 出口返回的摘要（面板只读这些键）。 */
interface ResolveInfo {
  locator: string;
  kind: string;
  exists: boolean;
  title?: string;
  [k: string]: unknown;
}
interface SearchHit {
  locator: string;
  kind: string;
  title: string;
  subtitle: string;
  entryId?: string;
}

const KIND_LABEL: Record<string, string> = { section: '栏目', entry: '条目', field: '字段', file: '附件' };

/**
 * 悬浮预览里**直接渲染整块**的类型（任务 #25 验收反馈：悬浮要「加载对应的块的整体 field 进行显示」）。
 *
 * 只收轻量控件：它们挂载即渲染、无外部拉取、无监听器。md / table / file / source / debug
 * 要么会拉附件或起编辑器，要么会递归（debug 里再渲染 debug），所以退回文本预览——
 * 那几类本来也不是「一个输入框」的形态，文本反而更清楚。
 */
const PREVIEW_CONTROL_TYPES = new Set([
  'text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags', 'secret', 'entrylist', 'shortcut',
]);

/** 值的文本形态（对象走 JSON，空值给一句人话）。 */
function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  const text = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/**
 * 内联数据板（#21 + #24 验收反馈「内联值要具体内容，不要字段标签」）：
 * 格子主文本 = **被引用位置的实时内容**，不是它的名字/类型。
 *   field → 字段值（空值给「（空）」）；entry → 条目名；file → 文件名；section → 栏目标题。
 * 次文本 = 只有「内容之外还需要一句量词」时才给（条目完整度 / 附件字节 / 条目数）。
 */
function chipMain(r: ResolveInfo): string {
  if (r.kind === 'field') {
    const v = r.value;
    if (v === null || v === undefined || v === '') return '（空）';
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  const title = String(r.title ?? '').trim();
  if (title) return title;
  return r.kind === 'file' ? String(r.name ?? '') : '';
}

function chipSub(r: ResolveInfo): string {
  if (r.kind === 'entry') {
    const c = r.completeness as { ratio?: number } | null;
    return c && typeof c.ratio === 'number' ? `完整度 ${c.ratio}%` : '';
  }
  if (r.kind === 'file') return `${String(r.bytes ?? 0)} 字节`;
  if (r.kind === 'section') return `${String(r.entryCount ?? 0)} 条条目`;
  return '';
}

function readRefs(value: any): string[] {
  const refs = value && typeof value === 'object' && Array.isArray(value.refs) ? value.refs : [];
  const out: string[] = [];
  for (const r of refs) {
    const s = String(r ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 悬浮预览的正文行（不展开成长文——引用预览要的是「一眼知道那是什么」）。 */
function previewLines(r: ResolveInfo): ReactNode[] {
  const lines: ReactNode[] = [];
  if (r.kind === 'section') {
    lines.push(<span key="1">{String(r.entryCount ?? 0)} 条条目</span>);
    if (r.description) lines.push(<span key="2" className="muted">{String(r.description)}</span>);
  } else if (r.kind === 'entry') {
    lines.push(<span key="1">栏目 {String(r.sectionTitle || r.sectionId || '')}</span>);
    const c = r.completeness as { ratio?: number } | null;
    if (c && typeof c.ratio === 'number') lines.push(<span key="2" className="muted">完整度 {c.ratio}%</span>);
  } else if (r.kind === 'field') {
    const def = r.def as { label?: string; type?: string } | null;
    lines.push(<span key="1">{String(def?.type || 'text')} 字段 · {String(r.key || '')}</span>);
    if (r.value !== null && r.value !== undefined && r.value !== '') {
      const text = typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value);
      lines.push(<span key="2" className="dbg-preview-value">{text.length > 220 ? `${text.slice(0, 220)}…` : text}</span>);
      if (r.masked) lines.push(<span key="3" className="muted">（密文已打码）</span>);
    } else if (r.note) {
      lines.push(<span key="3" className="muted">{String(r.note)}</span>);
    }
  } else if (r.kind === 'file') {
    lines.push(<span key="1">{String(r.bytes ?? 0)} 字节 · {String(r.path ?? '')}</span>);
    lines.push(<span key="2" className={r.physicalExists ? 'muted' : 'bad'}>{r.physicalExists ? '物理文件在' : '物理文件已丢失'}</span>);
  }
  return lines;
}

export function DebugControl({ value, onChange }: ControlProps) {
  const { toast, boot } = useStore() as any;
  const refs = useMemo(() => readRefs(value), [value]);
  const refsKey = refs.join('\n');
  const warnings: string[] = Array.isArray((value as any)?.warnings) ? (value as any).warnings : [];
  /** locator → resolve 摘要；`false` = 解析失败（引用已失效）。 */
  const [resolved, setResolved] = useState<Record<string, ResolveInfo | false>>({});
  // 悬浮预览 = 底部寄存框（#25）：`locator` 决定加载谁，位置固定在视口底部——
  // 不再跟着鼠标飘（块体被网格锁着，飘窗既容易出视口，也放不下「整块」）。
  const [dock, setDock] = useState<{ locator: string } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickQ, setPickQ] = useState('');
  const [pickHits, setPickHits] = useState<SearchHit[]>([]);
  const chipRefs = useRef<Record<string, HTMLElement | null>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  // **内联数据板**（#21 + #23）：一次批量解析全部引用；refs 变、boot 变（保存后的
  // reload）、或**点击所在块任意处**都整体重取——绑定位置的值变了，格子跟着变。
  // 坏链照常标灰（resolve-batch 不抛）；网络失败保留上一轮值（不误导成「全失效」）。
  const refreshAll = useCallback(() => {
    if (!refs.length) { setResolved({}); return; }
    void api<{ items: Array<{ locator: string; ok: boolean; info?: ResolveInfo }> }>(
      '/api/resources/resolve-batch', { method: 'POST', body: { refs } },
    ).then((d) => {
      const next: Record<string, ResolveInfo | false> = {};
      for (const x of d.items) next[x.locator] = x.ok && x.info ? x.info : false;
      for (const r of refs) if (next[r] === undefined) next[r] = false;
      setResolved(next);
    }).catch(() => { /* 保留上一轮 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);

  useEffect(() => { refreshAll(); }, [refreshAll, boot]);

  // #23：单查一个引用——悬浮每次都问一遍「现在那是什么值」，不求元素级推送，
  // 但鼠标一停、格子与浮层必须是实时值。
  const refreshOne = useCallback(async (loc: string) => {
    try {
      const info = await api<ResolveInfo>(`/api/resources/resolve?loc=${encodeURIComponent(loc)}`);
      setResolved((prev) => ({ ...prev, [loc]: info }));
    } catch {
      setResolved((prev) => ({ ...prev, [loc]: false }));
    }
  }, []);

  // 点击所在块（含块头）= 整板实时重查：从控件里向上找 .blk 挂监听，
  // 卸载时摘掉；读边界只到 resolve，不写任何东西。
  useEffect(() => {
    const el = rootRef.current?.closest('.blk') || null;
    if (!el) return undefined;
    const on = () => refreshAll();
    el.addEventListener('click', on);
    return () => { el.removeEventListener('click', on); };
  }, [refreshAll]);

  // 寄存框的关闭规则：Esc / 页面滚动（框内滚动除外）/ 指针离开格子与框（延迟 260ms，
  // 留出「从格子移到框里」的那段路——否则想看长内容时一移就灭）。
  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setDock(null), 260);
  }, [cancelClose]);

  useEffect(() => {
    if (!dock) return undefined;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('.dbg-dock')) return;
      setDock(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDock(null); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [dock]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // #25：**每次进入格子都重新查一次**（同一个格子重复悬浮也算）——用户要的是
  // 「鼠标一停就是此刻的值」，不是「第一次打开时的值」。
  const openDock = (loc: string) => {
    cancelClose();
    setDock({ locator: loc });
    void refreshOne(loc);
  };

  const removeRef = (loc: string) => {
    const next = refs.filter((r) => r !== loc);
    onChange(next.length ? { v: 1, refs: next } : { v: 1, refs: [] });
    if (dock?.locator === loc) setDock(null);
  };

  const copyLoc = useCallback(async (loc: string) => {
    const ok = await copyText(loc);
    toast(ok ? `已复制定位符：${loc}` : '复制失败：浏览器拒绝了剪贴板访问', ok ? 'ok' : 'bad');
  }, [toast]);

  const addRef = (loc: string) => {
    if (!loc || refs.includes(loc)) return;
    onChange({ v: 1, refs: [...refs, loc] });
    toast('已追加引用（记得点「保存」）');
  };

  // 检索面板：与侧栏同一后端；300ms 防抖。
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const term = pickQ.trim();
    if (!term) { setPickHits([]); return undefined; }
    let dead = false;
    const timer = setTimeout(async () => {
      try {
        // #21：scope=debug——后端只出**数据位置**（条目/条目-字段/附件），
        // 字段命中直接是条目上的位置（模板行/扩展行都算），栏目与模板字段不出现。
        const d = await api<{ items: SearchHit[] }>(
          `/api/resources/search?q=${encodeURIComponent(term)}&scope=debug`,
        );
        if (!dead) setPickHits(d.items || []);
      } catch {
        if (!dead) setPickHits([]);
      }
    }, 300);
    return () => { dead = true; clearTimeout(timer); };
  }, [pickerOpen, pickQ]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen]);

  const dockInfo = dock ? resolved[dock.locator] : null;

  return (
    <div className="dbg-field" ref={rootRef}>
      {refs.length ? (
        <div className="dbg-chips">
          {refs.map((loc) => {
            const info = resolved[loc];
            const dead = info === false;
            const main = info && !dead ? chipMain(info) : loc;
            const sub = info && !dead ? chipSub(info) : '';
            return (
              <span
                key={loc}
                ref={(el) => { chipRefs.current[loc] = el; }}
                className={`dbg-chip${dead ? ' dead' : ''}`}
                data-locator={loc}
                title={dead ? `引用已失效：${loc}` : `${loc}\n（点击复制定位符）`}
                onMouseEnter={() => openDock(loc)}
                onMouseLeave={scheduleClose}
                onClick={() => copyLoc(loc)}
              >
                <span className="dbg-chip-main nowrap">{main}</span>
                {sub ? <span className="dbg-chip-sub nowrap">{sub}</span> : null}
                {dead ? <span className="dbg-chip-sub">已失效</span> : null}
                <button
                  type="button"
                  className="dbg-chip-x"
                  title="移除这个引用"
                  onClick={(e) => { e.stopPropagation(); removeRef(loc); }}
                >×</button>
              </span>
            );
          })}
        </div>
      ) : <span className="hint">还没有引用。</span>}
      {warnings.length ? <div className="hint">引用已忽略 {warnings.length} 条：{warnings.slice(0, 3).join('　')}</div> : null}

      <div className="dbg-add-row">
        <button type="button" className="btn small" onClick={() => setPickerOpen((v) => !v)}>＋ 引用资源</button>
        <span className="hint">格子内联显示内容 · 悬浮在底部预览整块 · 点格子复制定位符</span>
      </div>

      {pickerOpen ? (
        <div className="dbg-pick-panel">
          <div className="dbg-pick-search">
            <input
              autoFocus
              value={pickQ}
              placeholder="搜条目 / 字段 / 附件（不引用结构）"
              onChange={(e) => setPickQ(e.target.value)}
            />
            <span className="hint nowrap">{pickHits.length}</span>
            <button type="button" className="btn small ghost" onClick={() => setPickerOpen(false)}>关闭</button>
          </div>
          <div className="dbg-pick-list">
            {pickHits.map((h) => (
              <button
                type="button"
                key={h.locator}
                className="dbg-pick-item"
                title="点击追加到本字段"
                onClick={() => addRef(h.locator)}
              >
                <span className="tag">{KIND_LABEL[h.kind] || h.kind}</span>
                <span className="dbg-pick-name nowrap">{h.title}</span>
                <span className="hint nowrap">{h.subtitle}</span>
              </button>
            ))}
            {!pickHits.length ? <div className="hint pad">{pickQ.trim() ? '没有命中' : '输入关键字开始检索'}</div> : null}
          </div>
        </div>
      ) : null}

      {/* 底部寄存框（#25）：portal 到 body；悬浮格子即加载被引用位置，
          field 引用**直接渲染那一块的控制件**（只读），其余种类给文本摘要 */}
      {dock ? createPortal(
        <div
          className="dbg-dock"
          role="dialog"
          aria-label="引用预览"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="dbg-dock-head">
            {dockInfo && typeof dockInfo === 'object' ? (
              <>
                <span className="tag">{KIND_LABEL[String(dockInfo.kind)] || String(dockInfo.kind)}</span>
                <strong className="nowrap">{String(dockInfo.title || dock.locator)}</strong>
                <span className="dbg-dock-loc mono nowrap" title={dock.locator}>{dock.locator}</span>
              </>
            ) : (
              <>
                <strong className="nowrap">{dockInfo === false ? '引用已失效' : '加载中…'}</strong>
                <span className="dbg-dock-loc mono nowrap">{dock.locator}</span>
              </>
            )}
            <span className="right rowgap">
              <button type="button" className="btn small ghost" onClick={() => copyLoc(dock.locator)}>复制定位符</button>
              <button type="button" className="btn small ghost" onClick={() => setDock(null)}>关闭</button>
            </span>
          </div>
          <div className="dbg-dock-body">
            {dockInfo === false ? (
              <div className="hint">这个定位符解不到资源（可能已被删除，或引用的条目字段已移除）。</div>
            ) : dockInfo ? (
              <DockContent info={dockInfo} />
            ) : <div className="hint">正在取当前值…</div>}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/**
 * 寄存框正文：field 引用渲染**整块**（标签 + 该类型的真实控件，disabled 只读），
 * 其它种类沿用文本摘要。被引用位置的当前值由 resolve 的实时结果提供。
 */
function DockContent({ info }: { info: ResolveInfo }) {
  if (info.kind !== 'field') {
    return <div className="dbg-dock-lines">{previewLines(info)}</div>;
  }
  const def = (info.def || {}) as { type?: string; label?: string; key?: string; [k: string]: unknown };
  const type = String(def.type || 'text');
  const label = String(def.label || def.key || info.key || '');
  if (!PREVIEW_CONTROL_TYPES.has(type)) {
    return (
      <div className="dbg-dock-block">
        <div className="dbg-dock-blocklabel">
          <span>{label}</span>
          <span className="tag">{type}</span>
        </div>
        <pre className="block dbg-dock-pre">{valueText(info.value)}</pre>
        {info.masked ? <div className="hint">（密文已打码）</div> : null}
      </div>
    );
  }
  const Control = controlOf(type);
  return (
    <div className="dbg-dock-block">
      <div className="dbg-dock-blocklabel">
        <span>{label}</span>
        <span className="tag">{type}</span>
        {info.masked ? <span className="tag bad">密文</span> : null}
      </div>
      {/* fieldset disabled：只读预览——控件仍是真实形态（尺寸/排版/格式化一致），
          但不接收输入（secret 之外的控件不看 disabled 属性，靠 fieldset 兜住） */}
      <fieldset className="dbg-dock-frame" disabled>
        <Control def={def} value={info.value === null || info.value === undefined ? '' : info.value} onChange={() => {}} />
      </fieldset>
    </div>
  );
}
