// KeyChip.tsx —— 单个按键芯片（与参考实现 shortcut-library/src/components/KeyChip.tsx 一致）
import type { ShortcutStroke } from '../../../../../shared/fields/types.ts';

interface Props {
  keyStroke: ShortcutStroke;
  size?: 'sm' | 'md';
}

export default function KeyChip({ keyStroke, size = 'md' }: Props) {
  return (
    <span className={`sl-sl-chip sl-sl-chip--${size} ${keyStroke.isModifier ? 'sl-sl-chip--mod' : 'sl-sl-chip--key'}`}>
      {keyStroke.label}
    </span>
  );
}

export function ComboDisplay({ combo }: { combo: ShortcutStroke[] }) {
  if (combo.length === 0) return <span className="sl-sl-empty">未设置</span>;
  return (
    <span className="sl-sl-combo">
      {combo.map((k, i) => (
        <span key={`${k.code}-${i}`} className="sl-sl-combo__cell">
          <KeyChip keyStroke={k} size="sm" />
          {i < combo.length - 1 && <span className="sl-sl-combo__plus">+</span>}
        </span>
      ))}
    </span>
  );
}

