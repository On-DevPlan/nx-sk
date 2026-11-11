import type { ReactNode } from 'react';
import type { BlockLayout } from '../../../../shared/blockLayout.ts';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';

/** `/api/sections/:id/dump` 的栏目摘要。 */
export interface SectionDumpInfo {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  kv: boolean;
  titleField: string | null;
  titleLabel: string;
  fields: number;
}

/** `/api/sections/:id/dump` 的响应（外部 JSON 边界）。 */
export interface SectionDump {
  section: SectionDumpInfo;
  groups: Array<{ id: string; title: string }>;
  layout: BlockLayout | null;
  fields: FieldDef[];
  count: number;
  entries: SerializedEntry[];
}

/** 正在编辑的草稿：id + 标题 + 值（与 `current` 对比算脏值）。 */
export interface Draft {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

/** 单栏目导入预览里的一条冲突。 */
export interface PreviewConflict {
  id: string;
  title: string;
  reason: string;
  existingId: string;
  existingTitle: string;
  copyTitle?: string;
}

/** `/api/sections/:id/import.zip?dry-run=1` 的预览（外部 JSON 边界）。 */
export interface ImportPreview {
  status: string;
  fileName?: string;
  encrypted: boolean;
  exportedAt?: string;
  withSecrets: boolean;
  section: {
    source: { id: string; title: string };
    targetId: string;
    exists: boolean;
    willCreate: boolean;
    renamedFrom: string | null;
    title: string;
    fieldsToAdd: Array<{ key: string; label: string; type: string }>;
    groupsToAdd: Array<{ id: string; title: string }>;
  };
  entries: { total: number; fresh: number; conflicts: PreviewConflict[]; titles: string[] };
  files: { total: number; new: number; reused: number; bytes: number; issues: unknown[]; notBundled: number };
  secrets: { sensitiveFields: number; masked: number };
  warnings: string[];
}

export interface ZipState { fileName: string; buffer: ArrayBuffer; preview: ImportPreview; passphrase: string }
export interface AskState { fileName: string; buffer: ArrayBuffer }

/** `/api/sections/:id/import.zip` 的落地结果（面板只读 entries 四个数）。 */
export interface ApplySectionResult {
  entries: { added: number; copied: number; overwritten: number; skipped: number };
}

export type Conflict = 'skip' | 'copy' | 'overwrite';

export interface ModalState { title: string; body: ReactNode }

// 脏值比较用：对象/数组（tags、entrylist 的行）必须走 JSON 序列化——
// String(obj) 恒为 '[object Object]'，会把「没改」误判成「每处都改了」
export const norm = (x: unknown) => (x === null || x === undefined ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)));

/**
 * 选中条目后把 `?entry=<id>` 同步进地址栏，让当前地址本身就能分享/新开标签。
 * 只在地址栏已经指向这个栏目时替换——兜底选出来的栏目仍然不补 hash（见 App.tsx）。
 */
export function syncEntryHash(sectionId: string, entryId: string): void {
  if (!sectionId) return;
  const base = `#/${encodeURIComponent(sectionId)}`;
  const hash = window.location.hash || '';
  if (hash !== base && !hash.startsWith(`${base}?`)) return;
  const next = `${base}?entry=${encodeURIComponent(entryId)}`;
  if (hash !== next) window.history.replaceState(null, '', next);
}
