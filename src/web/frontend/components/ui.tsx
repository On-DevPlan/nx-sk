import { Component, Fragment, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../store.tsx';

/** 复制到剪贴板，返回是否成功。`Copyable` 与 md 正文里的 IP（点击即复制）共用一条实现。 */
export async function copyText(value: unknown): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(String(value ?? ''));
    return true;
  } catch {
    return false;
  }
}

export interface CopyableProps {
  text: string;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function Copyable({ text, children, className = '', title }: CopyableProps) {
  const { toast } = useStore();
  const onClick = async () => {
    const ok = await copyText(text);
    if (ok) toast('已复制');
    else toast('复制失败：浏览器拒绝了剪贴板访问', 'bad');
  };
  return (
    <span
      className={`copyable ${className}`}
      title={title || `点击复制：${text}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      {children ?? text}
    </span>
  );
}

export function Tag({ children, kind = '' }: { children?: ReactNode; kind?: string }) {
  return <span className={`tag ${kind}`}>{children}</span>;
}

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  err: unknown;
}

/** 懒加载视图的兜底：没有它，一个视图崩掉就是**整页白屏**，用户连切 tab 自救都不行。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return { err };
  }

  render() {
    if (this.state.err) {
      const err = this.state.err as Error | null;
      return (
        <div className="pad stack">
          <div><strong>这个视图崩了</strong></div>
          <div className="muted">{String(err?.message || err)}</div>
          <div className="hint">切到别的 tab 仍然可用；修好之后本页会自愈。</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Toasts() {
  const { toasts } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'ok' ? '' : 'bad'}`}>{t.message}</div>)}
    </div>
  );
}

export interface ModalProps {
  title?: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
}

export function Modal({ title, children, onClose, footer }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="mask" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="dialog">
        <div className="dialog-title">
          <span className="grow nowrap">{title}</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 确认弹窗。输入框用 ref 读，不用 document.querySelector（页面上出现第二个同名 class 就会读错）。 */
export function DialogHost() {
  const { dialogState, closeDialog } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dialogState?.input && inputRef.current) inputRef.current.focus();
  }, [dialogState]);
  if (!dialogState) return null;
  const { message, detail, danger, input, confirmText = '确定', cancelText = '取消', hideCancel } = dialogState;
  return (
    <div className="mask">
      <div className="dialog">
        <div className="dialog-title">{danger ? '危险操作' : '确认'}</div>
        <div className="dialog-body stack">
          <div>{message}</div>
          {detail ? <pre className="block">{detail}</pre> : null}
          {input ? (
            <input ref={inputRef} defaultValue={input.defaultValue || ''} placeholder={input.placeholder || ''} />
          ) : null}
        </div>
        <div className="dialog-foot">
          {hideCancel ? null : <button className="btn ghost" onClick={() => closeDialog(null)}>{cancelText}</button>}
          <button
            className={`btn ${danger ? 'danger' : ''}`}
            onClick={() => closeDialog(input ? (inputRef.current?.value ?? '') : true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 「这个页面每个按钮都有同构 CLI 命令」——提示**由数据派生**，不手写（手写必然与实际命令漂移）。 */
// module 可以是单个 id，也可以是数组——合并页（如「导出与备份」）一个页面承载
// 多个模块的命令，提示合成一条而不是每半页各来一句。
export function CliHints({ module }: { module: string | string[] }) {
  const { boot } = useStore();
  const mods: string[] = Array.isArray(module) ? module : [module];
  const cmds = (boot?.commands || []).filter((c) => mods.includes(c.module));
  if (!cmds.length) return null;
  return (
    <div className="cli-hint">
      <span className="cli-hint-label">这个页面上的每个操作都有一条同构的 CLI 命令：</span>
      {cmds.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 ? <span className="cli-hint-sep"> · </span> : null}
          <Copyable className="cli-cmd" text={c.command || ''} title={`点击复制：${c.usage}`}>{c.command}</Copyable>
        </Fragment>
      ))}
      <span className="cli-hint-tail">。加 <code className="cli-cmd">--json</code> 得机器可读输出。</span>
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <div className="row muted">{children}</div>;
}
