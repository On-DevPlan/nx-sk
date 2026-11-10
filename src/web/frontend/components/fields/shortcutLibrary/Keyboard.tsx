// Keyboard.tsx —— ANSI 104 键 1:1 物理键盘预览
// 与参考实现 shortcut-library/src/pages/Keyboard.tsx 的结构、类名、交互一致。
import { type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  MAIN_ROWS, NAV_ROWS, NUMPAD_KEYS, MAC_LABEL_OVERRIDES,
  type KeyDef, type NumpadKeyDef,
} from './keyboardLayout.ts';

interface Props {
  highlightedCodes: Set<string>;
  hoveredCodes: Set<string>;
  heldKeys: Set<string>;
  onPress: (code: string) => void;
  onRelease: (code: string) => void;
  onKeyHoverEnter: (code: string, rect: DOMRect) => void;
  onKeyHoverLeave: (code: string) => void;
  onDoubleClickKey: (code: string, rect: DOMRect) => void;
  boundCodes?: Set<string>;
  platform?: 'win' | 'mac';
  showNumpad?: boolean;
}

export default function Keyboard({
  highlightedCodes, hoveredCodes, heldKeys,
  onPress, onRelease, onKeyHoverEnter, onKeyHoverLeave, onDoubleClickKey,
  boundCodes, platform = 'win', showNumpad = true,
}: Props) {
  const labelOf = (k: KeyDef): string =>
    (platform === 'mac' && MAC_LABEL_OVERRIDES[k.code]) || k.label;

  function renderKey(k: KeyDef, i: number, extraStyle?: CSSProperties) {
    if (k.spacer) {
      return (
        <span
          key={`sp-${i}`}
          className="sl-sl-kb__spacer"
          style={{ ['--sl-kb-w' as string]: String(k.w ?? 1) }}
          aria-hidden="true"
        />
      );
    }
    const cls = [
      'sl-sl-kb__key',
      heldKeys.has(k.code) ? 'is-on' : '',
      (hoveredCodes.has(k.code) || highlightedCodes.has(k.code)) ? 'is-hover' : '',
      boundCodes?.has(k.code) ? 'has-binding' : '',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={k.code}
        className={cls}
        data-shortcut-code={k.code}
        title={k.code}
        style={{
          '--sl-kb-w': k.w ?? 1,
          '--sl-kb-col': (extraStyle as Record<string, string> | undefined)?.['--sl-kb-col'],
          '--sl-kb-row': (extraStyle as Record<string, string> | undefined)?.['--sl-kb-row'],
          '--sl-kb-colspan': (extraStyle as Record<string, string> | undefined)?.['--sl-kb-colspan'],
          '--sl-kb-rowspan': (extraStyle as Record<string, string> | undefined)?.['--sl-kb-rowspan'],
        } as CSSProperties}
        onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          onPress(k.code);
        }}
        onPointerUp={(e: ReactPointerEvent<HTMLDivElement>) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          onRelease(k.code);
        }}
        onPointerLeave={() => {
          onRelease(k.code);
          onKeyHoverLeave(k.code);
        }}
        onPointerOut={() => onRelease(k.code)}
        onPointerCancel={() => onRelease(k.code)}
        onMouseEnter={(e: ReactMouseEvent<HTMLDivElement>) =>
          onKeyHoverEnter(k.code, e.currentTarget.getBoundingClientRect())}
        onDoubleClick={(e: ReactMouseEvent<HTMLDivElement>) =>
          onDoubleClickKey(k.code, e.currentTarget.getBoundingClientRect())}
      >
        {k.sub && <span className="sl-sl-kb__sub">{k.sub}</span>}
        <span className="sl-sl-kb__label">{labelOf(k)}</span>
      </div>
    );
  }

  return (
    <div className="sl-sl-kb" role="group" aria-label="键盘预览">
      <div className="sl-sl-kb__cluster sl-sl-kb__cluster--main">
        {MAIN_ROWS.map((row, r) => (
          <div className="sl-sl-kb__row" key={`m${r}`}>{row.map((k, i) => renderKey(k, i))}</div>
        ))}
      </div>

      <div className="sl-sl-kb__cluster sl-sl-kb__cluster--nav">
        {NAV_ROWS.map((row, r) => (
          <div className="sl-sl-kb__row" key={`n${r}`}>
            {row.length
              ? row.map((k, i) => renderKey(k, i))
              : <span className="sl-sl-kb__spacer" style={{ ['--sl-kb-w' as string]: '3' }} />}
          </div>
        ))}
      </div>

      {showNumpad && (
        <div className="sl-sl-kb__cluster sl-sl-kb__cluster--numpad">
          {NUMPAD_KEYS.map((k: NumpadKeyDef, i) =>
            renderKey(k, i, {
              ['--sl-kb-col' as string]: String(k.col),
              ['--sl-kb-row' as string]: String(k.row),
              ['--sl-kb-colspan' as string]: String(k.colSpan ?? 1),
              ['--sl-kb-rowspan' as string]: String(k.rowSpan ?? 1),
            } as CSSProperties & Record<string, string>))}
        </div>
      )}
    </div>
  );
}

