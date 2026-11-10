// CapturePopover.tsx —— 点击弹出的"按键录入"窗口（与参考实现一致）
// 监听 keydown 累积按键(KeyStroke[]);支持 Backspace 删最后一键、Esc 取消、Enter 确认
// 可选 condition 输入:仅在弹出框打开期间持有,确认时随 combo 一起回调

import { useEffect, useRef, useState } from 'react';
import type { ShortcutStroke } from '../../../../../shared/fields/types.ts';
import { isModifier, labelFor } from './keymap.ts';
import KeyChip from './KeyChip.tsx';

interface Props {
  onConfirm: (combo: ShortcutStroke[], condition: string) => void;
  onCancel: () => void;
  initial?: ShortcutStroke[];
  initialCondition?: string;
}

export default function CapturePopover({
  onConfirm,
  onCancel,
  initial = [],
  initialCondition = '',
}: Props) {
  const [combo, setCombo] = useState<ShortcutStroke[]>(initial);
  const [condition, setCondition] = useState<string>(initialCondition);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    popRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 修饰键单独按下:加入并等待主键
      if (isModifier(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        setCombo((prev) => {
          if (prev.some((k) => k.code === e.code)) return prev;
          return [...prev, { code: e.code, label: labelFor(e.code, e.key), isModifier: true }];
        });
        return;
      }
      // Backspace → 删除最后一键
      if (e.code === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        setCombo((prev) => prev.slice(0, -1));
        return;
      }
      // Escape → 取消
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      // Enter → 确认(至少要有一个非修饰键)
      if (e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (combo.some((k) => !k.isModifier)) onConfirm(combo, condition);
        return;
      }
      // 其它键 → 作为主键加入
      if (e.code === 'Tab' || e.code === 'CapsLock' || e.code === 'NumLock') return;
      e.preventDefault();
      e.stopPropagation();
      const stroke: ShortcutStroke = {
        code: e.code,
        label: labelFor(e.code, e.key),
        isModifier: false,
      };
      // 主键只能有一个:替换已有的主键
      setCombo((prev) => {
        const mods = prev.filter((k) => k.isModifier);
        return [...mods, stroke];
      });
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [combo, condition, onConfirm, onCancel]);

  const hasNonModifier = combo.some((k) => !k.isModifier);

  return (
    <div className="sl-sl-popover" ref={popRef} tabIndex={-1}>
      <div className="sl-sl-popover__head">
        <span className="sl-sl-popover__title">录入快捷键</span>
        <span className="sl-sl-popover__hint">按 Backspace 撤销 · Esc 取消 · Enter 确认</span>
      </div>
      <div className="sl-sl-popover__chips">
        {combo.length === 0 ? (
          <span className="sl-sl-popover__placeholder">请按下组合键 (例如 Ctrl+R)</span>
        ) : (
          combo.map((k, i) => (
            <span key={`${k.code}-${i}`} className="sl-sl-popover__chip-cell">
              <KeyChip keyStroke={k} />
              {i < combo.length - 1 && <span className="sl-sl-popover__plus">+</span>}
            </span>
          ))
        )}
      </div>
      <label className="sl-sl-popover__condition">
        <span className="sl-sl-popover__condition-label">激活条件 (备注,可选)</span>
        <input
          className="sl-sl-input sl-sl-input--inline"
          placeholder="例如 选中文本时 / 仅 macOS"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <div className="sl-sl-popover__actions">
        <button className="sl-sl-btn sl-sl-btn--ghost" onClick={onCancel}>取消</button>
        <button
          className="sl-sl-btn sl-sl-btn--primary"
          disabled={!hasNonModifier}
          onClick={() => onConfirm(combo, condition)}
        >
          确认
        </button>
      </div>
    </div>
  );
}
