import fsp from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '../../core/zip.ts';
import { loadStore, entryStructures, type StoreEntry } from '../../core/store.ts';
import { displayPath, exportDir, VERSION } from '../../core/paths.ts';
import { findSection, sectionNames } from '../../core/fields.ts';
import { fileRecordAbs, findFileRecord } from '../../core/attachments.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { nowIso, stamp } from '../../core/ids.ts';
import { ensureDir, fileSize, writeAtomic } from '../../core/fsx.ts';
import { FORMAT, FORMAT_VERSION, entryDefs, extensionOf, plainValues, referencedFileIds, safeCategory, wrapEncrypted, type BuildZipOptions, type ZipFile } from './common.ts';

import type { ServerResponse } from 'node:http';

/**
 * 生成栏目 ZIP（内存里）。返回 { buffer, fileName, stats }。
 */
export async function buildSectionZip(ref: unknown, { entryIds, passphrase, includeFiles = true }: BuildZipOptions = {}) {
  const store = await loadStore();
  const structures = entryStructures(store);
  const section = findSection(store, ref);
  if (!section) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  const all = store.entries.filter((e) => e.section === section.id);
  const defsOf = (e: StoreEntry) => entryDefs(section, structures.get(e.id));
  // 精确导出：按 id 或标题选条目；**只打包被选条目引用到的附件**（否则包会带一堆无关文件）
  let rows = all;
  const picked = (Array.isArray(entryIds) ? entryIds : []).map(String).filter(Boolean);
  if (picked.length) {
    const wanted = new Set(picked);
    rows = all.filter((e) => wanted.has(e.id) || wanted.has(e.title));
    const missing = picked.filter((x) => !rows.some((e) => e.id === x || e.title === x));
    if (missing.length) throw badInput(`找不到条目: ${missing.join(', ')}（用 'nx-sk entry list --section ${section.id}' 看现有条目）`);
  }

  const entries: Array<{ id: string; title: string; tags: string[]; createdAt: string | null; updatedAt: string | null; values: Record<string, unknown> }> = [];
  for (const e of rows) {
    const plain = await plainValues(defsOf(e), e.values);
    entries.push({
      id: e.id,
      title: e.title,
      tags: e.tags || [],
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
    section: {
      id: section.id, title: section.title, description: section.description || '',
      titleLabel: section.titleLabel || '名称', titleField: section.titleField || null,
      order: section.order, kv: section.kv === true,
      groups: section.groups || [], fields: section.fields || [],
    },
    counts: { entries: entries.length, available: all.length, files: fileRecords.length },
    selection: { partial: rows.length !== all.length, requested: picked },
    entries,
    files: fileRecords,
  };
  const readme = [
    'nx-sk 栏目导出包',
    '',
    `栏目：${section.title}（${section.id}）`,
    `时间：${exportedAt}`,
    `条目：${entries.length}　附件：${fileRecords.length}`,
    `凭据：包内为明文，保护靠口令`,
    '',
    '导入：在面板对应栏目点「更多 → 导入 ZIP」，或',
    `  nx-sk transfer import ${section.id} --file <本文件> --dry-run   # 先预览`,
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
    fileName: `${section.id}-${stamp()}.zip`,
    stats: {
      section: section.id, sectionTitle: section.title, entries: entries.length,
      available: all.length, files: fileRecords.length, bytes: buffer.length, missingFiles,
      encrypted,
    },
  };
}

/** CLI：写到磁盘（缺省 ~/nx-sk/export）。 */
export async function exportToFile(ref: unknown, { out, entryIds, passphrase, includeFiles }: { out?: string; entryIds?: unknown; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const { buffer, fileName, stats } = await buildSectionZip(ref, { entryIds, passphrase, includeFiles });
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
  const { buffer, fileName, stats } = await buildSectionZip(ref, { entryIds, passphrase, includeFiles });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': buffer.length,
    // filename* 传中文/特殊字符，filename 给老客户端兜底（纯 ASCII）
    'content-disposition': `attachment; filename="section-${stats.section}.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}
