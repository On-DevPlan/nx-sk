// debug（资源引用）字段控件：值 = locator 数组的文档 `{v, refs}`。
//
// 三块职责（任务 #18 用户裁决原文：「在下面生成小格子，鼠标悬浮在上面就支持
// 直接预览出这个字段引用的内容」）：
//   1. **格子（chip）**：每个引用一格，显示被引用资源的标题（resolve 拿）；
//      resolve 不到 = 引用失效 → 显示 locator 原文并标灰「已失效」。
//      点格子 = 复制 locator（粘给 agent 即可定位）；× = 移除该引用。
//   2. **悬浮预览**：鼠标停在格子上 → 浮层直接预览被引用内容（形态沿用 peek 外壳
//      的头部三件套：标题 / 副题 / 类型；密文值在 resolve 出口就已打码）。
//   3. **＋ 引用资源**：打开检索面板（与侧栏共用 `resource.search`），
//      选中即把 locator 追加进 refs——值仍走「N 处改动 → 保存」的既有通路。
//
// 配色纪律：无边框 Notion——格子静止无底色、hover 才现 --hover 色块；浮层用 --paper + 弱线。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { copyText } from '../../entryRef.ts';
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
}

const KIND_LABEL: Record<string, string> = { section: '栏目', entry: '条目', field: '字段', file: '附件' };

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
  const { toast } = useStore() as any;
  const refs = useMemo(() => readRefs(value), [value]);
  const refsKey = refs.join('\n');
  const warnings: string[] = Array.isArray((value as any)?.warnings) ? (value as any).warnings : [];
  /** locator → resolve 摘要；`false` = 解析失败（引用已失效）。 */
  const [resolved, setResolved] = useState<Record<string, ResolveInfo | false>>({});
  const [hover, setHover] = useState<{ locator: string; x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickQ, setPickQ] = useState('');
  const [pickHits, setPickHits] = useState<SearchHit[]>([]);
  const chipRefs = useRef<Record<string, HTMLElement | null>>({});

  // 每个 ref 解析一次（坏链不重试——resolve 404 是常态：条目被删后引用留证）。
  useEffect(() => {
    const todo = refs.filter((r) => resolved[r] === undefined);
    if (!todo.length) return;
    let dead = false;
    void Promise.all(todo.map(async (loc) => {
      try {
        return [loc, await api<ResolveInfo>(`/api/resources/resolve?loc=${encodeURIComponent(loc)}`)] as const;
      } catch {
        return [loc, false] as const;
      }
    })).then((pairs) => {
      if (dead) return;
      setResolved((prev) => {
        const next = { ...prev };
        for (const [loc, info] of pairs) next[loc] = info;
        return next;
      });
    });
    return () => { dead = true; };
    // resolved 不进依赖：只补「还没解析过」的 locator，避免自激循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);

  // 悬浮浮层跟着当前 hover 的格子实时定位（滚动/改宽都对）。
  useEffect(() => {
    if (!hover) return undefined;
    const onScroll = () => setHover(null);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [hover]);

  const showHover = (loc: string, el: HTMLElement | null) => {
    if (!el) return;
    const b = el.getBoundingClientRect();
    setHover({ locator: loc, x: b.left, y: b.bottom + 6 });
  };

  const removeRef = (loc: string) => {
    const next = refs.filter((r) => r !== loc);
    onChange(next.length ? { v: 1, refs: next } : { v: 1, refs: [] });
    if (hover?.locator === loc) setHover(null);
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
        const d = await api<{ items: SearchHit[] }>(`/api/resources/search?q=${encodeURIComponent(term)}`);
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

  const hoverInfo = hover ? resolved[hover.locator] : null;

  return (
    <div className="dbg-field">
      {refs.length ? (
        <div className="dbg-chips">
          {refs.map((loc) => {
            const info = resolved[loc];
            const dead = info === false;
            const title = info && !dead && info.title ? String(info.title) : loc;
            const kindLabel = info && !dead ? (KIND_LABEL[String(info.kind)] || '') : '';
            return (
              <span
                key={loc}
                ref={(el) => { chipRefs.current[loc] = el; }}
                className={`dbg-chip${dead ? ' dead' : ''}`}
                data-locator={loc}
                title={dead ? `引用已失效：${loc}` : `${loc}\n（点击复制定位符）`}
                onMouseEnter={() => showHover(loc, chipRefs.current[loc])}
                onMouseLeave={() => setHover((h) => (h?.locator === loc ? null : h))}
                onClick={() => copyLoc(loc)}
              >
                {kindLabel ? <span className="dbg-chip-kind">{kindLabel}</span> : null}
                <span className="dbg-chip-label nowrap">{title}</span>
                {dead ? <span className="tag">已失效</span> : null}
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
      {warnings.length ? <div className="hint">非法引用已忽略 {warnings.length} 条：{warnings.slice(0, 3).join('　')}</div> : null}

      <div className="dbg-add-row">
        <button type="button" className="btn small" onClick={() => setPickerOpen((v) => !v)}>＋ 引用资源</button>
        <span className="hint">悬浮格子预览内容 · 点格子复制定位符</span>
      </div>

      {pickerOpen ? (
        <div className="dbg-pick-panel">
          <div className="dbg-pick-search">
            <input
              autoFocus
              value={pickQ}
              placeholder="搜栏目 / 条目 / 字段 / 附件"
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

      {/* 悬浮预览浮层：portal 到 body（块体被网格锁着，绝对定位会被裁） */}
      {hover && hoverInfo ? createPortal(
        <div
          className="dbg-hover"
          style={{ left: Math.min(hover.x, window.innerWidth - 320), top: hover.y }}
          role="tooltip"
          aria-label="引用预览"
        >
          <div className="dbg-hover-head">
            <span className="tag">{KIND_LABEL[String(hoverInfo.kind)] || String(hoverInfo.kind)}</span>
            <strong className="nowrap">{String(hoverInfo.title || hover.locator)}</strong>
          </div>
          <div className="dbg-hover-body">{previewLines(hoverInfo)}</div>
          <div className="dbg-hover-loc mono">{hover.locator}</div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
