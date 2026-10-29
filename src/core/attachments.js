// 附件（二进制原件）的磁盘管理：~/nx-sk/files/ 下存储，元数据随 store.json 落盘。
//
// 设计要点：
//   - 本机路径导入**默认移动**（用户明确要求：提交附件 = 把文件搬进 nx-sk 目录），
//     `--copy` 才保留原件；Web 上传只有「复制」语义（浏览器删不掉任意路径的文件）。
//   - 「可逆」：`file restore` 能把附件移回原始位置（或指定目录），并撤销台账记录；
//     `--copy` 则只导出一份副本、库中保留。
//   - 同 sha256 去重：完全相同的文件不重复占空间，直接回已有记录。
//   - 元数据是**台账**：物理文件永远以台账 rel 为准；所有移动先改物理文件、再在事务里改台账。
//   - 链接方式：条目里 `file` 字段的值 = 附件 id（或唯一文件名）。id 全局唯一，
//     天然实现「各条目各自的附件空间互不串台」；同一份原件也可被多条条目复用（去重后同 id）。
//     附件**不预定义任何分类/槽位结构**：附件中心按「哪些栏目在用它」动态分组（见 fileReferences）。
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { badInput } from './errors.js';
import { displayPath, filesDir, isInside, toPosix } from './paths.js';
import { ensureDir, hashFile } from './fsx.js';
import { newId, nowIso } from './ids.js';
import { mdImageIds } from './mdimages.js';

// —— 分类 ——
export const FILE_CATEGORIES = [
  { id: 'resume', label: '简历' },
  { id: 'avatar', label: '头像' },
  { id: 'transcript', label: '成绩单' },
  { id: 'certificate', label: '证书' },
  { id: 'document', label: '文档' },
  { id: 'other', label: '其他' },
];

export const CATEGORY_IDS = FILE_CATEGORIES.map((c) => c.id);
export const categoryLabel = (id) => FILE_CATEGORIES.find((c) => c.id === id)?.label || '其他';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.ico']);
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.wps', '.ofd']);

export function isImageExt(ext) {
  return IMAGE_EXT.has(String(ext || '').toLowerCase());
}

/** 按扩展名猜分类；猜不准归「其他」（头像/简历这种语义由调用方显式给）。 */
export function categoryFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (isImageExt(e)) return 'other';
  if (DOC_EXT.has(e)) return 'document';
  return 'other';
}

// —— 流式输出的 MIME ——
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wps': 'application/octet-stream',
  '.ofd': 'application/octet-stream',
};

// Windows 保留设备名，做文件名会让文件无法正常访问。
const RESERVED_STEMS = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** 把任意来源的名字收成跨平台可用的单段文件名（保留中文）。 */
export function safeFileName(name) {
  let s = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!s) s = 'file';
  const stem = parse(s).name;
  if (RESERVED_STEMS.has(stem.toLowerCase())) s = `_${s}`;
  return s.slice(0, 140);
}

/** 在台账里为「分类 + 文件名」找一个不冲突的 posix 相对路径（`(2)` 递增）。 */
function uniqueRel(store, category, fileName, excludeId = null) {
  const { name: stem, ext } = parse(fileName);
  let rel = toPosix(join(category, fileName));
  let n = 1;
  while (store.files.some((r) => r.id !== excludeId && r.rel === rel)) {
    n += 1;
    rel = toPosix(join(category, `${stem} (${n})${ext}`));
  }
  return rel;
}

// —— 台账记录 ——
export function normalizeFileRecord(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.rel) return null;
  const name = String(raw.name || basename(String(raw.rel)));
  return {
    id: String(raw.id),
    // 分类只是**磁盘分目录**用的内部属性（`files/<分类>/`），不是用户要维护的「槽位」。
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'other',
    name,
    rel: toPosix(String(raw.rel)),
    originalName: String(raw.originalName || name),
    ext: String(raw.ext || extname(name).toLowerCase()),
    bytes: Number(raw.bytes) || 0,
    sha256: String(raw.sha256 || ''),
    // 原始绝对路径（posix）；Web 上传没有，留空——还原时需显式给目标目录
    sourcePath: String(raw.sourcePath || ''),
    mode: ['move', 'copy', 'upload'].includes(raw.mode) ? raw.mode : 'upload',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    note: String(raw.note || ''),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

/**
 * 一个 `file` 字段的值 → 附件 id 数组（**全仓库唯一的归一化入口**）。
 *
 * 字段可以挂**多个**附件：新写入统一存数组（哪怕只有一个）。要吃下三种历史形态：
 * 单值字符串、id 数组、以及旧版把多个 id **连写成一个字符串**（`"f_a,f_b"`——
 * 0.8.0 之前 `--set` 不拆逗号），所以字符串统一按分隔符拆开。
 * 去空、去重、保序：同一个附件在一个字段里出现两次没有意义。
 */
export function fileIdsOf(value) {
  const raw = value === null || value === undefined
    ? []
    : (Array.isArray(value) ? value : [value]);
  const out = [];
  for (const x of raw) {
    for (const piece of String(x ?? '').split(/[,，、;；]+/)) {
      const id = piece.trim();
      if (!id || out.includes(id)) continue;
      out.push(id);
    }
  }
  return out;
}

/** 附件定位：id 优先，其次唯一文件名。 */
export function findFileRecord(store, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const byId = store.files.find((r) => r.id === key);
  if (byId) return byId;
  const byName = store.files.filter((r) => r.name === key);
  if (byName.length === 1) return byName[0];
  return null;
}

/**
 * 反向链接：哪些条目的**哪些字段**引用了这个附件。
 *
 * 三种引用方式都要认，否则附件中心会把「只在正文里贴过」的图片、
 * 或「躺在原始资料袋里」的原始文件判成未引用，然后被 cleanup 删掉：
 *   1. `file` 字段 —— 值是附件 id（或唯一文件名），一个字段可挂多个，
 *      按 `fileIdsOf` 逐个成员判断，**任一** id 命中即算。
 *   2. `md` 字段  —— 正文里的 `![说明](f_xxx)`（见 mdimages.mdImageIds）。
 *      图片是**内嵌在 markdown 里**的，和 file 字段一样是正式引用。
 *   3. `source` 字段 —— 原始资料袋里 kind='file' 的 item（袋是溯源的锚点：
 *      字段值是从这份原件整理出来的，原件被删，溯源就成了空话）。
 * 同一个（条目, 字段）只出一条。附件中心据此显示「被哪些栏目 / 条目 / 字段用到」。
 */
export function fileReferences(store, rec) {
  if (!rec) return [];
  // 按 **id** 判定命中，不做对象引用比较（`===`）：调用方拿到的往往是
  // listFiles 加工过的副本，引用比较会静默失配 —— 附件就被误判成「未引用」了。
  // 正文里也可能是文件名而不是 id，所以两种解析结果都算命中。
  const targetId = String(rec.id ?? '');
  const targetName = String(rec.name ?? '');
  const hits = (refs) => refs.some((ref) => {
    if (targetId && ref === targetId) return true;
    const found = findFileRecord(store, ref);
    if (!found) return false;
    return (targetId && found.id === targetId) || (targetName && found.name === targetName);
  });

  const out = [];
  for (const sec of store.sections || []) {
    // 一次栏目只扫一遍条目，别在字段循环里反复全表扫
    const entries = (store.entries || []).filter((e) => e.section === sec.id);
    if (!entries.length) continue;
    const fileFields = (sec.fields || []).filter((f) => f.type === 'file');
    const mdFields = (sec.fields || []).filter((f) => f.type === 'md');
    const sourceFields = (sec.fields || []).filter((f) => f.type === 'source');
    if (!fileFields.length && !mdFields.length && !sourceFields.length) continue;

    for (const e of entries) {
      const push = (f) => out.push({
        sectionId: sec.id, sectionTitle: sec.title,
        entryId: e.id, entryTitle: e.title,
        fieldKey: f.key, fieldLabel: f.label,
      });
      for (const f of fileFields) {
        const ids = fileIdsOf(e.values?.[f.key]);
        if (ids.length && hits(ids)) push(f);
      }
      for (const f of mdFields) {
        const ids = mdImageIds(e.values?.[f.key]);
        if (ids.length && hits(ids)) push(f);
      }
      for (const f of sourceFields) {
        // 袋值应是 item 数组（normalizeSourceItems 的产物）；形状不对就当没有，别炸引用扫描
        const bag = Array.isArray(e.values?.[f.key]) ? e.values[f.key] : [];
        const ids = bag
          .filter((x) => x && typeof x === 'object' && x.kind === 'file' && x.fileId)
          .map((x) => x.fileId);
        if (ids.length && hits(ids)) push(f);
      }
    }
  }
  return out;
}

/**
 * 附件中心的分组素材：哪些栏目**可能**引用附件。
 * 中心据此按栏目筛选 / 分组 —— 组织方式**完全由栏目驱动，不预定义任何分类或槽位**。
 * 带 `file` / `md` 字段的栏目都算数：md 字段正文里贴的图也是正式引用；
 * `source` 袋也算——袋里的原始文件是溯源的锚点，同样要能按栏目筛出来。
 */
export function collectFileSections(store) {
  return (store.sections || [])
    .filter((s) => (s.fields || []).some((f) => ['file', 'md', 'source'].includes(f.type)))
    .map((s) => ({ id: s.id, title: s.title }));
}

export function fileRecordAbs(rec) {
  return join(filesDir(), rec.rel.split('/').join(sep));
}

export function fileLinks(rec) {
  const u = `/api/files/${encodeURIComponent(rec.id)}/content`;
  return { url: u, downloadUrl: `${u}?download=1` };
}

/** 对外（CLI / Web）的完整描述：物理路径 + 展示路径 + 链接（+ 可选的反向引用）。 */
export function describeFile(rec, store = null) {
  const abs = fileRecordAbs(rec);
  return {
    ...rec,
    categoryLabel: categoryLabel(rec.category),
    isImage: isImageExt(rec.ext),
    path: abs,
    displayPath: displayPath(abs),
    sourceDisplay: rec.sourcePath ? displayPath(rec.sourcePath) : '',
    usedBy: store ? fileReferences(store, rec) : [],
    ...fileLinks(rec),
  };
}

function buildRecord({ id, category, rel, srcAbs, originalName, ext: e, bytes, sha, mode, tags, note }) {
  return normalizeFileRecord({
    id, category, name: basename(rel), rel,
    originalName: originalName || basename(rel),
    ext: e, bytes, sha256: sha,
    sourcePath: srcAbs ? toPosix(srcAbs) : '',
    mode,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    note: String(note || ''),
    createdAt: nowIso(), updatedAt: nowIso(),
  });
}

/**
 * 从本机路径导入。默认**移动**，copy=true 才复制。
 * dryRun 只做读取与落点计算，不碰目标位置。
 */
export async function importLocalFile(store, opts = {}) {
  const { path: src, category, copy, tags, note, name, dryRun } = opts;
  if (!src) throw badInput('缺少文件路径：--path <本机文件路径>');
  const srcAbs = resolve(String(src));
  let st;
  try { st = await fsp.stat(srcAbs); } catch {
    throw badInput(`读不到文件: ${displayPath(srcAbs)}`);
  }
  if (!st.isFile()) throw badInput(`不是文件: ${displayPath(srcAbs)}`);
  if (isInside(filesDir(), srcAbs)) {
    throw badInput('该文件已经在附件库目录里，无需重复导入');
  }

  const sha = await hashFile(srcAbs);
  const dup = store.files.find((r) => r.sha256 === sha);
  if (dup) return { record: dup, duplicate: true, dryRun: false };

  const e = extname(srcAbs).toLowerCase();
  const cat = category || categoryFromExt(e);
  const fileName = safeFileName(name || basename(srcAbs));
  const rel = uniqueRel(store, cat, fileName);
  const record = buildRecord({
    id: newId('f'), category: cat, rel, srcAbs, originalName: basename(srcAbs),
    ext: e, bytes: st.size, sha, mode: copy ? 'copy' : 'move', tags, note,
  });
  if (dryRun) return { record, duplicate: false, dryRun: true };

  const dst = join(filesDir(), rel.split('/').join(sep));
  await ensureDir(dirname(dst));
  if (copy) {
    await fsp.copyFile(srcAbs, dst);
  } else {
    try {
      await fsp.rename(srcAbs, dst);
    } catch (err) {
      // EXDEV：跨卷 rename 不被支持，退成「复制 + 删原件」，语义不变
      if (err && err.code === 'EXDEV') {
        await fsp.copyFile(srcAbs, dst);
        await fsp.unlink(srcAbs);
      } else throw err;
    }
  }
  return { record, duplicate: false, dryRun: false, moved: !copy };
}

function decodeBase64(content) {
  let b64 = String(content || '');
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma >= 0) b64 = b64.slice(comma + 1);
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch {
    throw badInput('上传内容不是合法的 base64');
  }
  if (!buf.length) throw badInput('上传内容为空');
  return buf;
}

/** Web 上传：base64（或 data URL）内容直接写进库。 */
export async function importContent(store, opts = {}) {
  const { content, name, category, tags, note, dryRun } = opts;
  if (content === undefined || content === null) throw badInput('缺少上传内容');
  if (!name) throw badInput('上传必须带文件名');
  const buf = decodeBase64(content);
  const sha = createHash('sha256').update(buf).digest('hex');
  const dup = store.files.find((r) => r.sha256 === sha);
  if (dup) return { record: dup, duplicate: true, dryRun: false };

  const originalName = safeFileName(name);
  const e = extname(originalName).toLowerCase();
  const cat = category || categoryFromExt(e);
  const rel = uniqueRel(store, cat, originalName);
  const record = buildRecord({
    id: newId('f'), category: cat, rel, srcAbs: null, originalName,
    ext: e, bytes: buf.length, sha, mode: 'upload', tags, note,
  });
  if (dryRun) return { record, duplicate: false, dryRun: true };

  const dst = join(filesDir(), rel.split('/').join(sep));
  await ensureDir(dirname(dst));
  await fsp.writeFile(dst, buf);
  return { record, duplicate: false, dryRun: false, moved: false };
}

/**
 * 改分类 / 文件名：物理文件先搬到新落点，返回新记录（由 service 在事务里落台账）。
 */
export async function relocateFile(store, rec, { category, name }) {
  const cat = category || rec.category;
  // 改名时**不带扩展名**就把原扩展名接回去——否则物理文件丢掉 .jpg/.pdf，
  // 一切按扩展名认类型的地方（内联预览 / Content-Type / 系统默认程序打开 /
  // 历史迁移 / 导入还原出来的文件）都会哑掉，而台账里的 ext 字段还骗人说没丢。
  let wanted = name || rec.name;
  const originalExt = rec.ext || extname(rec.name).toLowerCase();
  if (name && originalExt && !extname(wanted)) wanted += originalExt;
  const fileName = safeFileName(wanted);
  const same = cat === rec.category && fileName === rec.name;
  const rel = same ? rec.rel : uniqueRel(store, cat, fileName, rec.id);
  if (!same) {
    const oldAbs = fileRecordAbs(rec);
    const newAbs = join(filesDir(), rel.split('/').join(sep));
    await ensureDir(dirname(newAbs));
    await fsp.copyFile(oldAbs, newAbs);
    await fsp.unlink(oldAbs);
  }
  return normalizeFileRecord({ ...rec, category: cat, name: basename(rel), rel, updatedAt: nowIso() });
}

/** 删除物理原件；文件本就不存在视为成功（台账是权威）。 */
export async function deletePhysical(rec) {
  try {
    await fsp.unlink(fileRecordAbs(rec));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

function nonClashPath(dir, fileName) {
  const { name: stem, ext } = parse(fileName);
  let dst = join(dir, fileName);
  let n = 1;
  const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
  return (async () => {
    while (await exists(dst)) { n += 1; dst = join(dir, `${stem} (${n})${ext}`); }
    return dst;
  })();
}

/**
 * 还原 / 导出：把附件复制到目标位置；copy=false（默认）时再删掉库内原件
 * （由 service 负责撤销台账记录）。
 */
export async function restoreFile(store, rec, { to, copy } = {}) {
  const targetDir = resolve(String(to || (rec.sourcePath ? dirname(rec.sourcePath) : '')));
  if (!targetDir || targetDir === sep) {
    throw badInput('该附件没有原始位置，需要给目标目录：--to <目录>');
  }
  const dst = await nonClashPath(targetDir, rec.name);
  if (!copy && isInside(filesDir(), dst)) {
    throw badInput('还原落点在附件库目录内，会自己覆盖自己；换一个目录');
  }
  await ensureDir(targetDir);
  await fsp.copyFile(fileRecordAbs(rec), dst);
  if (!copy) await fsp.unlink(fileRecordAbs(rec));
  return { path: dst, displayPath: displayPath(dst), kept: copy === true };
}

/** 以正确的 Content-Type 把附件流式输出给浏览器；download=true 时强制下载。 */
export function streamRecord(res, rec, { download = false } = {}) {
  const file = fileRecordAbs(rec);
  return new Promise((resolve, reject) => {
    const rs = createReadStream(file);
    rs.once('error', reject);
    rs.once('open', () => {
      res.writeHead(200, {
        'content-type': MIME_TYPES[rec.ext] || 'application/octet-stream',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
        'cache-control': 'no-cache',
      });
      rs.pipe(res);
      rs.once('end', resolve);
      rs.once('error', reject);
    });
  });
}
