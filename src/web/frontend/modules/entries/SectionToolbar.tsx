import type { ChangeEvent, RefObject } from 'react';
import { Tag } from '../../components/ui.tsx';
import type { SectionDumpInfo } from './viewTypes.ts';

/**
 * 栏目工具条：标题 / 条数 / 打码开关 / 刷新 / 「更多」菜单 / 隐藏的 zip 选择框 / 新建条目。
 * 纯展示，所有状态与动作都由容器传入。
 */
export default function SectionToolbar({
  section,
  count,
  mask,
  onToggleMask,
  onRefresh,
  moreRef,
  selectedCount,
  onExport,
  onCloseMore,
  zipInput,
  onZipChange,
  onAddEntry,
}: {
  section: SectionDumpInfo;
  count: number;
  mask: boolean;
  onToggleMask: () => void;
  onRefresh: () => void;
  moreRef: RefObject<HTMLDetailsElement>;
  selectedCount: number;
  onExport: (withSecrets: boolean) => void;
  onCloseMore: () => void;
  zipInput: RefObject<HTMLInputElement>;
  onZipChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onAddEntry: () => void;
}) {
  return (
    <div className="toolbar rowgap pad">
      <strong>{section.title}</strong>
      <Tag>{section.id}</Tag>
      <span className="muted">{count} 条 / {section.fields} 字段</span>
      {section.description ? <span className="desc muted nowrap grow">{section.description}</span> : <span className="grow" />}
      <label className="inline hint">
        <input type="checkbox" checked={mask} onChange={onToggleMask} />
        打码显示（投屏/截图时用）
      </label>
      <button className="btn small ghost" onClick={onRefresh}>刷新</button>
      <details className="more" ref={moreRef}>
        <summary className="btn small ghost">更多</summary>
        <div className="more-menu">
          <button type="button" onClick={() => onExport(true)}>
            {selectedCount ? `导出选中 ${selectedCount} 条（含凭据）` : '导出 ZIP（含凭据）'}
          </button>
          <button type="button" onClick={() => onExport(false)}>
            {selectedCount ? `导出选中 ${selectedCount} 条（打码）` : '导出 ZIP（打码）'}
          </button>
          <button type="button" onClick={() => { onCloseMore(); zipInput.current?.click(); }}>导入 ZIP…</button>
        </div>
      </details>
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        style={{ display: 'none' }}
        onChange={onZipChange}
      />
      <button className="btn small" onClick={onAddEntry}>新建条目</button>
    </div>
  );
}
