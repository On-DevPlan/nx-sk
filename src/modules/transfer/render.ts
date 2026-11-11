import type { exportToFile } from './section-export.ts';
import type { applyBundle, previewBundle } from './bundle.ts';

// ─── 人读渲染 ────────────────────────────────────────────────────

export function renderExportZip(d: Awaited<ReturnType<typeof exportToFile>>) {
  return [
    `已导出栏目 ${d.sectionTitle}（${d.section}）→ ${d.path}`,
    `条目 ${d.entries}${d.available !== undefined && d.entries !== d.available ? ` / 共 ${d.available}` : ''} · 附件 ${d.files} · ${(d.bytes / 1024).toFixed(1)}KB${d.encrypted ? ' · 已用口令加密' : ''}`,
    d.missingFiles ? `注意：${d.missingFiles} 个附件在磁盘上找不到，未打包` : '',
  ].filter(Boolean).join('\n');
}

/** renderImport 的入参：previewImport 与 applyImport 两种结果共用的读侧形状。 */
export interface ImportView {
  status?: string;
  fileName?: string;
  exportedAt?: string | null;
  encrypted?: boolean;
  warnings?: string[];
  section: {
    title: string;
    id: string;
    source?: { id: string; title: string };
    targetId?: string;
    willCreate?: boolean;
    renamedFrom?: string | null;
    created?: boolean;
    fieldsToAdd?: Array<{ key: string; label: string; type: string }>;
  };
  entries: {
    total?: number;
    fresh?: number;
    conflicts?: Array<{ title: string; reason: string }>;
    added?: number;
    copied?: number;
    overwritten?: number;
    skipped?: number;
  };
  files: { new?: number; reused?: number; bytes: number; added?: number };
  secrets?: { masked?: number };
  fieldsAdded?: string[];
  maskedSkipped?: number;
}

export function renderImport(d: ImportView) {
  if (d.status === 'preview') {
    const s = d.section;
    const lines = [
      `ZIP: ${d.fileName}（${d.exportedAt || '未知时间'}）`,
      `来源栏目: ${s.source!.title}（${s.source!.id}）→ 目标: ${s.targetId}${s.willCreate ? '（将新建）' : ''}${s.renamedFrom ? `（id ${s.renamedFrom} 已存在，另存为 ${s.targetId}）` : ''}`,
      `条目: 共 ${d.entries.total}，新增 ${d.entries.fresh}，冲突 ${d.entries.conflicts!.length}`,
      `字段: 将补 ${s.fieldsToAdd!.length} 个${s.fieldsToAdd!.length ? `（${s.fieldsToAdd!.map((f) => f.key).join(', ')}）` : ''}`,
      `附件: 新增 ${d.files.new}，复用 ${d.files.reused}，${(d.files.bytes / 1024).toFixed(1)}KB`,
      `凭据: ${d.secrets!.masked ? `${d.secrets!.masked} 个需重填` : '随包（明文，靠口令保护）'}${d.encrypted ? ' · 已加密' : ''}`,
    ];
    if (d.entries.conflicts!.length) {
      lines.push('冲突（默认跳过，可用 --on-conflict copy|overwrite）:');
      for (const c of d.entries.conflicts!.slice(0, 8)) lines.push(`  · ${c.title}（${c.reason}）`);
      if (d.entries.conflicts!.length > 8) lines.push(`  … 共 ${d.entries.conflicts!.length} 条`);
    }
    for (const w of d.warnings!) lines.push(`注意: ${w}`);
    return lines.join('\n');
  }
  return [
    `导入完成 → 栏目 ${d.section.title}（${d.section.id}）${d.section.created ? '（新建）' : ''}`,
    `条目 新增 ${d.entries.added} / 另存 ${d.entries.copied} / 覆盖 ${d.entries.overwritten} / 跳过 ${d.entries.skipped}`,
    `附件 新增 ${d.files.added} / 复用 ${d.files.reused}（${(d.files.bytes / 1024).toFixed(1)}KB）`,
    d.fieldsAdded!.length ? `新增字段: ${d.fieldsAdded!.join(', ')}` : '',
    d.maskedSkipped ? `跳过 ${d.maskedSkipped} 个打码凭据（需重新填写）` : '',
  ].filter(Boolean).join('\n');
}

/** renderBundleExport 的入参：exportBundleToFile 的落盘 / 试运行两种结果。 */
export interface BundleExportView {
  status?: string;
  wouldWrite?: { sections: number; entries: number; files: number; bytes: number; fileName: string };
  sections?: number;
  entries?: number;
  files?: number;
  bytes?: number;
  encrypted?: boolean;
  path?: string;
}

export function renderBundleExport(d: BundleExportView) {
  if (d.status === 'skipped') {
    const w = d.wouldWrite!;
    return `试运行（未写盘）：${w.sections} 栏目 / ${w.entries} 条目 / ${w.files} 附件 · ${(w.bytes / 1024 / 1024).toFixed(1)}MB → ${w.fileName}`;
  }
  return [
    `已导出 ${d.sections} 个栏目 / ${d.entries} 条条目 / ${d.files} 个附件 → ${d.path}`,
    `${(d.bytes! / 1024 / 1024).toFixed(1)}MB${d.encrypted ? ' · 已用口令加密' : ''}`,
  ].join('\n');
}

export function renderBundlePreview(d: Awaited<ReturnType<typeof previewBundle>>) {
  const t = d.totals;
  const lines = [
    `全局包: ${d.fileName}（${d.exportedAt || '未知时间'}）`,
    `栏目 ${t.sections}（将新建 ${t.newSections}）· 条目 ${t.entries}（新增 ${t.fresh} / 冲突 ${t.conflicts}）`,
    `附件 新增 ${t.filesNew} / 复用 ${t.filesReused}（${(t.bytes / 1024).toFixed(1)}KB）${d.encrypted ? ' · 口令已验证' : ''}`,
  ];
  for (const s of d.sections) {
    lines.push(`  · ${s.title}（${s.id}）${s.willCreate ? ' 新建' : ''}：条目 ${s.entries.total}，冲突 ${s.entries.conflicts.length}，补字段 ${s.fieldsToAdd.length}`);
  }
  for (const w of d.warnings.slice(0, 6)) lines.push(`注意: ${w}`);
  return lines.join('\n');
}

export function renderBundleApply(d: Awaited<ReturnType<typeof applyBundle>>) {
  const t = d.totals;
  return [
    `导入完成：${t.sections} 个栏目（新建 ${t.createdSections}）`,
    `条目 新增 ${t.added} / 另存 ${t.copied} / 覆盖 ${t.overwritten} / 跳过 ${t.skipped}`,
    `附件 新增 ${t.filesAdded} / 复用 ${t.filesReused}`,
  ].join('\n');
}
