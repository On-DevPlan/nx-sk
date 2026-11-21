import fsp from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createZip } from '../../core/zip.ts';
import { displayPath, exportDir, VERSION } from '../../core/paths.ts';
import { badInput } from '../../core/errors.ts';
import { nowIso, stamp } from '../../core/ids.ts';
import { ensureDir, fileSize, writeAtomic } from '../../core/fsx.ts';
import { mutateStore } from '../../core/store.ts';
import { BUNDLE_FORMAT, BUNDLE_VERSION, asZipFiles, innerZipOf, needsPassphrase, wrapEncrypted, type ZipFile } from './common.ts';
import { buildTemplateZip } from './template-export.ts';
import { applyImport, previewImport } from './template-import.ts';

import type { ServerResponse } from 'node:http';

// ─── 全局多条目模板包（bundle） ──────────────────────────────────────
//
// 外层 zip 只是**容器**：bundle.json 记索引，templates/<id>.zip 是已经验证过的单条目模板包。
// 这样全局导入不需要把「结构/附件/冲突」再实现一遍 —— 逐个条目模板复用同一套 preview/apply，
// 行为与条目模板页的导入天然一致。
export function normalizeSelection(input: unknown): Array<{ id: string; entries?: unknown }> {
  let arr = input;
  if (typeof arr === 'string') {
    const raw = arr;
    try { arr = JSON.parse(raw); } catch { arr = raw.split(/[,，\s]+/).filter(Boolean); }
  }
  if (!Array.isArray(arr) || !arr.length) throw badInput('至少选一个条目模板');
  const out = arr.map((x) => (typeof x === 'string' ? { id: x } : { id: String(x?.id || ''), entries: x?.entries }))
    .filter((x) => x.id);
  if (!out.length) throw badInput('至少选一个条目模板');
  return out;
}

export async function buildBundleZip({ templates, passphrase, includeFiles = true }: { templates?: unknown; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const sel = normalizeSelection(templates);
  const parts: ZipFile[] = [];
  const index: Array<{ id: string; title: string; zipPath: string; entries: number; available: number; files: number }> = [];
  // 条目可能跨包成树（文件夹用 __blank__、子条目用各自模板）。每个内层包只知道自己的局部父子，
  // 所以 bundle 顶层再带一份全量边：导入时等所有包落完，再统一把父挂回去。
  const tree: Array<{ id: string; parent: string | null; sort: number }> = [];
  for (const item of sel) {
    const { buffer, stats, nodes } = await buildTemplateZip(item.id, { entryIds: item.entries, includeFiles });
    const zipPath = `templates/${stats.template}.zip`;
    parts.push({ name: zipPath, data: buffer });
    tree.push(...nodes);
    index.push({
      id: stats.template, title: stats.templateTitle, zipPath,
      entries: stats.entries, available: stats.available, files: stats.files,
    });
  }
  const exportedAt = nowIso();
  const manifest = {
    app: 'nx-sk', format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, appVersion: VERSION,
    exportedAt, withSecrets: true,
    counts: {
      templates: index.length,
      entries: index.reduce((n, x) => n + x.entries, 0),
      files: index.reduce((n, x) => n + x.files, 0),
    },
    templates: index,
    tree,
  };
  const readme = [
    'nx-sk 全局导出包（多条目模板）', '',
    `时间：${exportedAt}`,
    `条目模板：${index.length}　条目：${manifest.counts.entries}　附件：${manifest.counts.files}`,
    `凭据：包内为明文，保护靠口令`,
    '',
    '每个条目模板在 templates/<id>.zip 里，结构与单条目模板导出完全一致；bundle.json 只是索引。',
    'bundle.json 的 tree 记录跨模板的父子关系，导入时按它恢复目录层级。',
    '导入：面板「导出导入」页把这个文件拖进去，或',
    '  nx-sk transfer bundle-import --file <本文件> --dry-run',
  ].join('\n');
  const plain = createZip([
    { name: 'bundle.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'README.txt', data: readme },
    ...parts,
  ]);
  // 先加密内部、再打 zip：外层始终是合法 ZIP（系统压缩文件夹能打开，只看到 payload.enc），
  // 同时把「里面有哪些条目模板」也一并藏起来。
  const encrypted = !!String(passphrase ?? '');
  const buffer = encrypted ? wrapEncrypted(plain, passphrase, readme) : plain;
  return {
    buffer,
    fileName: `nx-sk-bundle-${stamp()}.zip`,
    stats: {
      templates: index.length, entries: manifest.counts.entries, files: manifest.counts.files,
      bytes: buffer.length, encrypted,
    },
  };
}

export async function exportBundleToFile({ templates, out, dryRun = false, passphrase, includeFiles }: { templates?: unknown; out?: string; dryRun?: boolean; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const { buffer, fileName, stats } = await buildBundleZip({ templates, passphrase, includeFiles });
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldWrite: { fileName, ...stats } };
  }
  let target = out ? resolve(out) : join(exportDir(), fileName);
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) target = join(target, fileName);
  } catch { /* 不存在：按文件路径 */ }
  await ensureDir(dirname(target));
  await writeAtomic(target, buffer);
  // bytes 取 zip 缓冲长度（stats.bytes）；这里保留一次 fileSize 调用，与历史行为一致
  await fileSize(target);
  return { status: 'ok', path: displayPath(target), pathRaw: target, ...stats };
}

export async function serveBundleZip({ templates, res, passphrase, includeFiles }: { templates?: unknown; res: ServerResponse; passphrase?: unknown; includeFiles?: boolean } = { res: undefined as unknown as ServerResponse }) {
  const { buffer, fileName, stats } = await buildBundleZip({ templates, passphrase, includeFiles });
  res.writeHead(200, {
    // 加密包不是 zip：给 octet-stream，别让浏览器 / 代理按 zip 去嗅探
    'content-type': stats.encrypted ? 'application/octet-stream' : 'application/zip',
    'content-length': buffer.length,
    'content-disposition': `attachment; filename="nx-sk-bundle.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

export function parseGlobalBundle(buffer: Buffer, passphrase?: unknown) {
  const files = innerZipOf(buffer, passphrase);
  const map = new Map(files.map((f) => [f.name, f.data]));
  const raw = map.get('bundle.json');
  if (!raw) throw badInput('不是全局导出包：缺少 bundle.json');
  let manifest: any;
  // TODO(P4): bundle.json 是外部 JSON，键集由 BUNDLE_FORMAT + BUNDLE_VERSION 约定
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw badInput('bundle.json 不是合法 JSON'); }
  if (manifest?.format !== BUNDLE_FORMAT) throw badInput(`不是全局导出包（format=${manifest?.format || '未声明'}）`);
  if (Number(manifest.formatVersion) > BUNDLE_VERSION) throw badInput('导出包版本过新，请先升级 nx-sk');
  const items = (manifest.templates || []).map((sec: any) => {
    const data = map.get(sec.zipPath);
    if (!data) throw badInput(`包内缺少条目模板 ${sec.id} 的数据（${sec.zipPath}）`);
    return { template: sec, buffer: data };
  });
  if (!items.length) throw badInput('全局导出包里没有条目模板');
  return { manifest, items };
}

export async function previewBundle(buffer: Buffer, { fileName, passphrase }: { fileName?: string; passphrase?: unknown } = {}) {
  const { manifest, items } = parseGlobalBundle(buffer, passphrase);
  const list: Array<{ id: string; title: string; willCreate: boolean; renamedFrom: string | null; entries: { total: number; fresh: number; conflicts: unknown[] }; files: { new: number; reused: number; bytes: number; notBundled: number }; fieldsToAdd: Array<{ key: string; label: string; type: string }>; notBundled: number }> = [];
  const warnings: string[] = [];
  for (const it of items) {
    const p = await previewImport(it.template.id, it.buffer, { fileName: it.template.zipPath });
    list.push({
      id: it.template.id,
      title: p.template.title,
      willCreate: p.template.willCreate,
      renamedFrom: p.template.renamedFrom,
      entries: p.entries,
      files: p.files,
      fieldsToAdd: p.template.fieldsToAdd,
      notBundled: p.files.notBundled || 0,
    });
    for (const w of p.warnings) warnings.push(`[${it.template.title}] ${w}`);
  }
  const totals = list.reduce((acc, x) => ({
    templates: acc.templates + 1,
    newTemplates: acc.newTemplates + (x.willCreate ? 1 : 0),
    entries: acc.entries + x.entries.total,
    fresh: acc.fresh + x.entries.fresh,
    conflicts: acc.conflicts + x.entries.conflicts.length,
    filesNew: acc.filesNew + x.files.new,
    filesReused: acc.filesReused + x.files.reused,
    bytes: acc.bytes + x.files.bytes,
  }), { templates: 0, newTemplates: 0, entries: 0, fresh: 0, conflicts: 0, filesNew: 0, filesReused: 0, bytes: 0 });
  return {
    status: 'preview', fileName,
    encrypted: needsPassphrase(buffer),
    exportedAt: manifest.exportedAt,
    withSecrets: !!manifest.withSecrets, templates: list, totals, warnings,
  };
}

export async function applyBundle(buffer: Buffer, { fileName, onConflict = 'skip', passphrase }: { fileName?: string; onConflict?: string; passphrase?: unknown } = {}) {
  const { manifest, items } = parseGlobalBundle(buffer, passphrase);
  const templates: Array<{ id: string; title: string; created: boolean; entries: { added: number; copied: number; overwritten: number; skipped: number }; files: { added: number; reused: number; bytes: number }; fieldsAdded: string[]; maskedSkipped: number }> = [];
  // 跨包的源 id → 目标 id。每个内层包只知道自己包内的映射，这里把全包的合起来，
  // 等全部落完再按 bundle.json 的 tree 统一挂父（父可能在另一个模板包里）。
  const entryIdMap = new Map<string, string>();
  const moved = new Set<string>();
  for (const it of items) {
    const r = await applyImport(it.template.id, it.buffer, { fileName, onConflict, withIdMap: true }) as any;
    for (const [src, target] of Object.entries(r.entryIds || {})) entryIdMap.set(String(src), String(target));
    for (const id of r.moved || []) moved.add(String(id));
    templates.push({
      id: r.template.id, title: r.template.title, created: r.template.created,
      entries: r.entries, files: r.files, fieldsAdded: r.fieldsAdded, maskedSkipped: r.maskedSkipped,
    });
  }
  const links: Array<{ id: string; parent: string | null; sort: number }> = Array.isArray(manifest.tree) ? manifest.tree : [];
  if (moved.size && links.length) {
    await mutateStore((s) => {
      for (const link of links) {
        if (!moved.has(link.id)) continue;
        const target = s.entries.find((e) => e.id === entryIdMap.get(link.id));
        if (!target) continue;
        target.parent = link.parent && entryIdMap.has(link.parent) ? entryIdMap.get(link.parent)! : null;
        target.sort = Number.isFinite(Number(link.sort)) ? Number(link.sort) : 0;
      }
    });
  }
  const totals = templates.reduce((a, x) => ({
    templates: a.templates + 1,
    createdTemplates: a.createdTemplates + (x.created ? 1 : 0),
    added: a.added + x.entries.added,
    copied: a.copied + x.entries.copied,
    overwritten: a.overwritten + x.entries.overwritten,
    skipped: a.skipped + x.entries.skipped,
    filesAdded: a.filesAdded + x.files.added,
    filesReused: a.filesReused + x.files.reused,
  }), { templates: 0, createdTemplates: 0, added: 0, copied: 0, overwritten: 0, skipped: 0, filesAdded: 0, filesReused: 0 });
  return { status: 'ok', fileName, exportedAt: manifest.exportedAt, templates, totals };
}

export async function importBundleFromFile({ file, onConflict = 'skip', dryRun = false, passphrase }: { file?: string; onConflict?: string; dryRun?: boolean; passphrase?: unknown } = {}) {
  if (!file) throw badInput('缺少 --file <zip 路径>');
  let buffer: Buffer;
  try { buffer = await fsp.readFile(resolve(file)); } catch (e) { throw badInput(`读不到 ZIP: ${file}（${(e as { code?: string; message?: string }).code || (e as { message?: string }).message}）`); }
  const fileName = basename(file);
  return dryRun
    ? previewBundle(buffer, { fileName, passphrase })
    : applyBundle(buffer, { fileName, onConflict, passphrase });
}

export function importBundleFromBuffer(buffer: Buffer, { fileName, onConflict, dryRun, passphrase }: { fileName?: string; onConflict?: string; dryRun?: boolean; passphrase?: unknown } = {}) {
  return dryRun
    ? previewBundle(buffer, { fileName, passphrase })
    : applyBundle(buffer, { fileName, onConflict, passphrase });
}

/**
 * 零配置导入：**单条目模板包与全局包都吃**。
 *
 * 判据是解开外层之后里面有没有 bundle.json —— 用户不该记住「我这个包是哪种」，
 * 尤其加密包在解开口令前看不出任何结构。全局包走逐条目模板复用，单条目模板包走原路径。
 */
export async function importAuto(buffer: Buffer | null | undefined, { fileName, onConflict = 'skip', dryRun = false, passphrase, file }: { fileName?: string; onConflict?: string; dryRun?: boolean; passphrase?: unknown; file?: string } = {}) {
  // CLI 传的是路径，HTTP 传的是 buffer —— 在这里归一，调用方不必分叉
  if (!buffer && file) {
    try {
      buffer = await fsp.readFile(resolve(file));
    } catch (e) {
      throw badInput(`读不到 ZIP: ${file}（${(e as { code?: string; message?: string }).code || (e as { message?: string }).message}）`);
    }
    fileName = fileName || basename(file);
  }
  const files = asZipFiles(buffer!, passphrase);
  const isBundle = files.some((f) => f.name === 'bundle.json');
  if (!isBundle) {
    return dryRun
      ? previewImport(null, buffer!, { fileName, passphrase })
      : applyImport(null, buffer!, { fileName, onConflict, passphrase });
  }
  return dryRun
    ? previewBundle(buffer!, { fileName, passphrase })
    : applyBundle(buffer!, { fileName, onConflict, passphrase });
}

