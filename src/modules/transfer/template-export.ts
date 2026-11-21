import fsp from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '../../core/zip.ts';
import { loadStore, entryStructures, type StoreEntry } from '../../core/store.ts';
import { displayPath, exportDir, VERSION } from '../../core/paths.ts';
import { findTemplate, templateNames } from '../../core/fields.ts';
import { fileRecordAbs, findFileRecord } from '../../core/attachments.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { nowIso, stamp } from '../../core/ids.ts';
import { ensureDir, fileSize, writeAtomic } from '../../core/fsx.ts';
import { FORMAT, FORMAT_VERSION, entryDefs, extensionOf, plainValues, referencedFileIds, safeCategory, wrapEncrypted, type BuildZipOptions, type ZipFile } from './common.ts';

import type { ServerResponse } from 'node:http';

/**
 * 生成条目模板 ZIP（内存里）。返回 { buffer, fileName, stats }。
 */
export async function buildTemplateZip(ref: unknown, { entryIds, passphrase, includeFiles = true }: BuildZipOptions = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  const template = findTemplate(store, ref);
  if (!template) throw notFound(`找不到条目模板: ${ref} —— 现有: ${templateNames(store)}`);
  const all = store.entries.filter((e) => e.template === template.id);
  const defsOf = (e: StoreEntry) => entryDefs(template, structures.get(e.id));
  // 精确导出：按 id 或标题选条目；**只打包被选条目引用到的附件**（否则包会带一堆无关文件）
  let rows = all;
  const picked = (Array.isArray(entryIds) ? entryIds : []).map(String).filter(Boolean);
  if (picked.length) {
    const wanted = new Set(picked);
    rows = all.filter((e) => wanted.has(e.id) || wanted.has(e.title));
    const missing = picked.filter((x) => !rows.some((e) => e.id === x || e.title === x));
    if (missing.length) throw badInput(`找不到条目: ${missing.join(', ')}（用 'nx-sk entry list --template ${template.id}' 看现有条目）`);
  }

  const entries: Array<{ id: string; title: string; tags: string[]; parent: string | null; sort: number; createdAt: string | null; updatedAt: string | null; values: Record<string, unknown> }> = [];
  const rowIds = new Set(rows.map((e) => e.id));
  for (const e of rows) {
    const plain = await plainValues(defsOf(e), e.values);
    entries.push({
      id: e.id,
      title: e.title,
      tags: e.tags || [],
      // 只保留「父也在本包里」的父子关系：选子树时父可能没被选，导入后它就是根，
      // 不能让它指向包里不存在的 id。
      parent: e.parent && rowIds.has(e.parent) ? e.parent : null,
      sort: Number(e.sort) || 0,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      values: plain,
    });
  }

  const fileRecords = [];
  const zipEntries: ZipFile[] = [];
  let missingFiles = 0;
  for (const id of referencedFileIds(rows, defsOf)) {
    const rec = findFileRecord(store, id);
    if (!rec) { missingFiles += 1; continue; }
    const zipPath = `attachments/${rec.id}${extensionOf(rec)}`;
    // 不带附件：台账条目仍记录（导入时知道有哪些引用），但不打包原件、
    // 也不写 zipPath —— 预览里据此提示「N 个附件未随包」。
    if (!includeFiles) {
      fileRecords.push({
        id: rec.id, name: rec.name, ext: rec.ext || '', category: safeCategory(rec.category),
        bytes: Number(rec.bytes) || 0, sha256: rec.sha256 || '', zipPath: '', bundled: false,
      });
      continue;
    }
    let data: Buffer;
    try {
      data = await fsp.readFile(fileRecordAbs(rec));
    } catch {
      missingFiles += 1;
      continue;
    }
    fileRecords.push({
      id: rec.id, name: rec.name, ext: rec.ext || '', category: safeCategory(rec.category),
      bytes: data.length, sha256: rec.sha256 || createHash('sha256').update(data).digest('hex'), zipPath,
      bundled: true,
    });
    zipEntries.push({ name: zipPath, data });
  }

  const exportedAt = nowIso();
  const manifest = {
    app: 'nx-sk',
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: VERSION,
    exportedAt,
    withSecrets: true,
    template: {
      id: template.id, title: template.title, description: template.description || '',
      titleLabel: template.titleLabel || '名称', titleField: template.titleField || null,
      order: template.order,
      tags: template.tags || [],
      // 0.42：分组即字段（type='group' 的那几条），导出只带 fields，不再有 groups 键。
      fields: template.fields || [],
    },
    counts: { entries: entries.length, available: all.length, files: fileRecords.length },
    selection: { partial: rows.length !== all.length, requested: picked },
    entries,
    files: fileRecords,
  };
  const readme = [
    'nx-sk 条目模板导出包',
    '',
    `条目模板：${template.title}（${template.id}）`,
    `时间：${exportedAt}`,
    `条目：${entries.length}　附件：${fileRecords.length}`,
    `凭据：包内为明文，保护靠口令`,
    '',
    '导入：把本 ZIP 拖进面板对应条目模板页，或到「导入导出」页导入，或',
    `  nx-sk transfer import ${template.id} --file <本文件> --dry-run   # 先预览`,
    '',
    'manifest.json 是数据本体；attachments/ 是附件原件。',
  ].join('\n');

  const plain = createZip([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'README.txt', data: readme },
    ...zipEntries,
  ]);
  // 加密时**先加密内部、再打 zip**：外层始终是合法 ZIP，
  // 所以用系统自带的「压缩文件夹」也能打开（里面只有一个看不懂的 payload.enc），
  // 不会弹「文件夹无效」。反过来说，只有 nx-sk 能解开它。
  const encrypted = !!String(passphrase ?? '');
  const buffer = encrypted ? wrapEncrypted(plain, passphrase, readme) : plain;

  return {
    buffer,
    fileName: `${template.id}-${stamp()}.zip`,
    entries,
    nodes: rows.map((e) => ({ id: e.id, parent: e.parent ?? null, sort: Number(e.sort) || 0 })),
    stats: {
      template: template.id, templateTitle: template.title, entries: entries.length,
      available: all.length, files: fileRecords.length, bytes: buffer.length, missingFiles,
      encrypted,
    },
  };
}

/** CLI：写到磁盘（缺省 ~/nx-sk/export）。 */
export async function exportToFile(ref: unknown, { out, entryIds, passphrase, includeFiles }: { out?: string; entryIds?: unknown; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const { buffer, fileName, stats } = await buildTemplateZip(ref, { entryIds, passphrase, includeFiles });
  let target = out ? resolve(out) : join(exportDir(), fileName);
  // --out 指向已存在的目录时自动拼文件名；否则按文件路径处理
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) target = join(target, fileName);
  } catch { /* 不存在：按文件路径处理 */ }
  await ensureDir(dirname(target));
  await writeAtomic(target, buffer);
  // bytes 取 zip 缓冲长度（stats.bytes）；这里保留一次 fileSize 调用，与历史行为一致
  await fileSize(target);
  return { status: 'ok', path: displayPath(target), pathRaw: target, ...stats };
}

/** HTTP raw：直接回 zip 流。 */
export async function serveExportZip(ref: unknown, { res, entryIds, passphrase, includeFiles }: { res: ServerResponse; entryIds?: unknown; passphrase?: unknown; includeFiles?: boolean } = { res: undefined as unknown as ServerResponse }) {
  const { buffer, fileName, stats } = await buildTemplateZip(ref, { entryIds, passphrase, includeFiles });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': buffer.length,
    // filename* 传中文/特殊字符，filename 给老客户端兜底（纯 ASCII）
    'content-disposition': `attachment; filename="template-${stats.template}.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

