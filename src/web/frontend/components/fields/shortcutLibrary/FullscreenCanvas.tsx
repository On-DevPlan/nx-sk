// FullscreenCanvas.tsx —— 全屏快捷键热力键盘（Keyboard Heatmap Canvas）
// 与参考实现 shortcut-library/src/pages/FullscreenCanvas.tsx 的结构、交互、类名一致。
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { ShortcutItem } from '../../../../../shared/fields/types.ts';
import { MAIN_ROWS, NAV_ROWS, NUMPAD_KEYS, type KeyDef, type NumpadKeyDef } from './keyboardLayout.ts';

export interface FullscreenCanvasProps {
  open: boolean;
  onClose: () => void;
  shortcuts: ShortcutItem[];
  groupName: string;
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
const WHEEL_FACTOR = 1.1;

// 频度色阶：0 → 未用（灰）；1-5+ → 冷→暖
const FREQ_COLORS = [
  '#2a2d35', // 0
  '#2b6cb0', // 1
  '#3182ce', // 2
  '#805ad5', // 3
  '#d69e2e', // 4
  '#e53e3e', // 5+
] as const;

function freqColor(count: number): string {
  if (count <= 0) return FREQ_COLORS[0];
  if (count >= 5) return FREQ_COLORS[5];
  return FREQ_COLORS[count];
}

/** 计算每个 code 在当前组出现的次数（同一 combo 内同键重复算 1 次） */
function buildFreqMap(shortcuts: ShortcutItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of shortcuts) {
    const seen = new Set<string>();
    for (const k of s.combo) {
      if (seen.has(k.code)) continue;
      seen.add(k.code);
      map.set(k.code, (map.get(k.code) ?? 0) + 1);
    }
  }
  return map;
}

export interface BindingItem {
  comboLabel: string;
  description: string;
}

/** 按 code 聚合：该键参与了哪些 shortcut（combo 标签 + 描述）。 */
function buildBindingsByCode(shortcuts: ShortcutItem[]): Map<string, BindingItem[]> {
  const map = new Map<string, BindingItem[]>();
  for (const s of shortcuts) {
    const comboLabel = s.combo.map((k) => k.label).join('+');
    const item: BindingItem = { comboLabel, description: s.description };
    const seen = new Set<string>();
    for (const k of s.combo) {
      if (seen.has(k.code)) continue;
      seen.add(k.code);
      const arr = map.get(k.code);
      if (arr) arr.push(item);
      else map.set(k.code, [item]);
    }
  }
  return map;
}

export default function FullscreenCanvas({ open, onClose, shortcuts, groupName }: FullscreenCanvasProps) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);

  const freqMap = useMemo(() => buildFreqMap(shortcuts), [shortcuts]);
  const bindingsMap = useMemo(() => buildBindingsByCode(shortcuts), [shortcuts]);

  // ESC 关闭。capture + stopPropagation：否则 Peek 外壳会先一步把整个面板关掉。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // 把键盘整体 fit 居中到 stage（初始打开 + resize 时重算）
  const fitCenter = useCallback(() => {
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!stage || !world) return;
    const stageRect = stage.getBoundingClientRect();
    const worldRect = world.getBoundingClientRect();
    const fitScale = Math.min(
      (stageRect.width - 64) / worldRect.width,
      (stageRect.height - 64) / worldRect.height,
      1,
    );
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale || 1));
    const cx = (stageRect.width - worldRect.width * s) / 2;
    const cy = (stageRect.height - worldRect.height * s) / 2;
    setScale(s);
    setTx(cx);
    setTy(cy);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => fitCenter());
    return () => cancelAnimationFrame(id);
  }, [open, fitCenter]);

  // 滚轮缩放（以鼠标位置为锚）
  function onWheel(e: ReactWheelEvent<HTMLDivElement>): void {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
    setScale((prevScale) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * delta));
      const ratio = newScale / prevScale;
      setTx((prevTx) => mx - (mx - prevTx) * ratio);
      setTy((prevTy) => my - (my - prevTy) * ratio);
      return newScale;
    });
  }

  // 拖动平移
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseTx: tx, baseTy: ty };
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (!d) return;
    setTx(d.baseTx + (e.clientX - d.startX));
    setTy(d.baseTy + (e.clientY - d.startY));
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  }

  const reset = useCallback(() => { fitCenter(); }, [fitCenter]);

  if (!open) return null;

  // 渲染一个键：键帽（label + 频度）+ 该键绑定的快捷键列表
  const renderKey = (k: KeyDef | NumpadKeyDef, index: number): ReactElement => {
    const w = k.w ?? 1;
    if (k.spacer) {
      return <div key={`sp-${index}`} className="sl-sl-canvas-key sl-sl-canvas-key--spacer" style={{ ['--k-w' as string]: String(w) } as CSSProperties} aria-hidden="true" />;
    }
    const count = freqMap.get(k.code) ?? 0;
    const bindings = bindingsMap.get(k.code) ?? [];
    const nk = k as NumpadKeyDef;
    const numpadStyle = nk.col !== undefined
      ? {
          gridColumn: `${nk.col} / span ${nk.colSpan ?? 1}`,
          gridRow: `${nk.row} / span ${nk.rowSpan ?? 1}`,
        }
      : {};
    return (
      <div
        key={k.code}
        className={`sl-sl-canvas-key${count === 0 ? ' is-cold' : ' is-hot'}`}
        style={{
          ['--k-w' as string]: String(w),
          background: freqColor(count),
          ...numpadStyle,
        } as CSSProperties}
        data-code={k.code}
        data-freq={count}
      >
        <div className="sl-sl-canvas-key__cap">
          <span className="sl-sl-canvas-key__main">{k.label || k.code}</span>
          {count > 0 && <span className="sl-sl-canvas-key__freq">×{count}</span>}
        </div>
        {bindings.length > 0 && (
          <ul className="sl-sl-canvas-key__bindings">
            {bindings.map((b, bi) => (
              <li key={bi} className="sl-sl-canvas-key__binding">
                <span className="sl-sl-canvas-key__combo">{b.comboLabel}</span>
                <span className="sl-sl-canvas-key__desc">{b.description || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return createPortal(
    <div className="sl-sl-canvas-backdrop" role="dialog" aria-label={`${groupName} 快捷键热力键盘`}>
      <header className="sl-sl-canvas__head">
        <h3 className="sl-sl-canvas__title">{groupName} · 快捷键热力</h3>
        <div className="sl-sl-canvas__ctrls">
          <button className="sl-sl-icon-btn" aria-label="缩小" onClick={() => setScale((s) => Math.max(MIN_SCALE, s / 1.2))}>−</button>
          <span className="sl-sl-canvas__scale">{Math.round(scale * 100)}%</span>
          <button className="sl-sl-icon-btn" aria-label="放大" onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.2))}>+</button>
          <button className="sl-sl-icon-btn" aria-label="重置" onClick={reset}>1:1</button>
          <button className="sl-sl-icon-btn" aria-label="关闭" onClick={onClose}>×</button>
        </div>
      </header>
      <div
        ref={stageRef}
        className="sl-sl-canvas__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      >
        <div
          ref={worldRef}
          className="sl-sl-canvas__world"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
        >
          <div className="sl-sl-canvas__cluster">
            {MAIN_ROWS.map((row, ri) => (
              <div key={`mr-${ri}`} className="sl-sl-canvas__row">
                {row.map((k, ki) => renderKey(k, ki))}
              </div>
            ))}
          </div>
          <div className="sl-sl-canvas__cluster sl-sl-canvas__cluster--nav">
            {NAV_ROWS.map((row, ri) => (
              <div key={`nr-${ri}`} className="sl-sl-canvas__row">
                {row.map((k, ki) => renderKey(k, ki))}
              </div>
            ))}
          </div>
          <div className="sl-sl-canvas__cluster sl-sl-canvas__cluster--numpad">
            {NUMPAD_KEYS.map((k, ki) => renderKey(k, ki))}
          </div>
        </div>
      </div>
      <footer className="sl-sl-canvas__legend">
        <span className="sl-sl-canvas__legend-label">频度</span>
        {FREQ_COLORS.map((c, i) => (
          <span key={i} className="sl-sl-canvas__legend-chip" style={{ background: c }}>
            {i === 0 ? '0' : i === 5 ? '5+' : `${i}`}
          </span>
        ))}
      </footer>
    </div>,
    document.body,
  );
}

