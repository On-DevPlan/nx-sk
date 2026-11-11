// 栏目级导出 / 导入（ZIP）—— 这是**编排模块**，不是数据模块。
//
// 数据模块之间互不依赖（entries 只管条目、sections 只管栏目、files 只管附件）；
// 这里要把三者串起来完成「打一个包 / 解一个包」，所以显式跨模块调用它们的 service。
// 依赖方向是单向的（transfer → entries/sections），不构成环。
//
// 包的形状：
//   manifest.json            栏目定义 + 条目 + 附件清单（sha256）
//   README.txt               给人看的说明
//   attachments/<id><ext>    附件原件
//
// 包里**恒为明文**：保护靠口令（`--passphrase`），不再有「打码 / 明文」二选。
// 打码只保留在**读取侧**——0.11.0 及更早导出、带 `******` 的包仍按旧口径跳过该字段，
// 不会把打码串当新密码存进去。
import fsp from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip, readZip } from '../../core/zip.ts';
import { isEncryptedPackage, openPackage, sealPackage } from '../../core/securezip.ts';
import { loadStore, mutateStore, entryStructures, isDetachedField, type Store, type StoreEntry, type StoreSection } from '../../core/store.ts';
import type { EntryFieldView } from '../../core/store.ts';
import { displayPath, exportDir, VERSION } from '../../core/paths.ts';
import { findSection, inferFieldType, isSensitiveField, sectionNames } from '../../core/fields.ts';
import { decryptValue, isCipherBlob } from '../../core/crypto.ts';
import { resolveVaultKey } from '../../core/vault.ts';
import { CATEGORY_IDS, fileRecordAbs, findFileRecord, importContent } from '../../core/attachments.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { badInput, blocked, notFound } from '../../core/errors.ts';
import { nowIso, stamp } from '../../core/ids.ts';
import { ensureDir, fileSize, writeAtomic } from '../../core/fsx.ts';
import { addEntry, updateEntry } from '../entries/service.ts';
import { addSection, updateSection } from '../sections/service.ts';

import type { ServerResponse } from 'node:http';

const FORMAT = 'nx-sk.section';
const FORMAT_VERSION = 1;
const CONFLICT_POLICIES = ['skip', 'copy', 'overwrite'];

/** 一份已解开的导出包：manifest 是外部 JSON，逐键校验由后面的结构检查负责。 */
interface ParsedBundle {
  // TODO(P4): manifest 来自 ZIP 内的 JSON，键集由 FORMAT_VERSION 约定，未逐键建模
  manifest: any;
  map: Map<string, Buffer>;
  fileName: string;
  encrypted: boolean;
}

interface ZipFile {
  name: string;
  data: Buffer;
}

interface BuildZipOptions {
  entryIds?: unknown;
  passphrase?: unknown;
  includeFiles?: boolean;
}

function safeCategory(cat: unknown): string {
  return CATEGORY_IDS.includes(cat as string) ? String(cat) : 'other';
}

/** 目标 ref 是「栏目 id」还是「栏目标题」：id 可以直接新建，标题不行（会建出非法 id）。 */
const isSectionId = (s: unknown) => /^[a-z0-9][a-z0-9_-]*$/i.test(String(s || ''));

/** 零配置导入：包里的 id 已存在时换一个，绝不静默并进别人的栏目。 */
function uniqueSectionId(store: Store, base: string): string {
  const taken = new Set(store.sections.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
  return `${base}-${Date.now()}`;
}

/** 条目的字段定义清单：自身结构行优先、栏目字典兜底（v3 写时复制，包里要带扩展行的值）。
 *  任务 #20：脱离行（meta.detached）不算——值已不进 values，定义也不进导出包。 */
function entryDefs(section: StoreSection, ownRows: EntryFieldView[] | null | undefined): FieldDefLike[] {
  return ownRows ? ownRows.filter((r) => !isDetachedField(r)).map((r) => r.spec as unknown as FieldDefLike) : (section.fields || []) as unknown as FieldDefLike[];
}

/** 字段定义的宽松读取形状（transfer 只碰这几个键）。 */
interface FieldDefLike {
  key: string;
  label?: string;
  type: string;
  sensitive?: unknown;
  fields?: unknown;
  columns?: unknown;
  [k: string]: unknown;
}

async function plainValues(defs: FieldDefLike[], values: unknown): Promise<Record<string, unknown>> {
  const asSection = { fields: defs };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!isSensitiveField(asSection, k)) { out[k] = v; continue; }
    if (isCipherBlob(v)) {
      const { key } = await resolveVaultKey();
      out[k] = decryptValue(key, v);
    } else {
      out[k] = v;
    }
  }
  // 结构清单（entrylist）的敏感子值也是密文落盘：不解开的话包里会混进密文对象，
  // 导入到另一台机器（另一把密钥）就永远解不开了。
  for (const f of defs) {
    if (f.type !== 'entrylist' || !Array.isArray(out[f.key])) continue;
    const subs = ((f.fields || []) as Array<{ key: string; sensitive?: unknown }>).filter((s) => s.sensitive);
    if (!subs.length) continue;
    const plain: unknown[] = [];
    for (const row of out[f.key] as unknown[]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { plain.push(row); continue; }
      const next = { ...(row as Record<string, unknown>) };
      for (const s of subs) {
        if (isCipherBlob(next[s.key])) {
          const { key } = await resolveVaultKey();
          next[s.key] = decryptValue(key, next[s.key]);
        }
      }
      plain.push(next);
    }
    out[f.key] = plain;
  }
  // 表格（table）的敏感列同理。**列以值自带的 columns 为准**（表格的列存在数据里，
  // 字段定义里只有「初始列」）—— 用 f.columns 会漏掉编辑时新加的敏感列。
  for (const f of defs) {
    if (f.type !== 'table') continue;
    const doc = out[f.key] as { rows?: unknown[]; columns?: unknown } | null | undefined;
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rows)) continue;
    const sensitiveKeys = (Array.isArray(doc.columns) ? doc.columns : [])
      .filter((c) => c && (c as { sensitive?: unknown }).sensitive).map((c) => (c as { key: string }).key);
    if (!sensitiveKeys.length) continue;
    let vaultKey: Buffer | null = null;
    const rows: unknown[] = [];
    for (const row of doc.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { rows.push(row); continue; }
      const next = { ...(row as Record<string, unknown>) };
      for (const k of sensitiveKeys) {
        if (!isCipherBlob(next[k])) continue;
        if (!vaultKey) ({ key: vaultKey } = await resolveVaultKey());
        next[k] = decryptValue(vaultKey, next[k]);
      }
      rows.push(next);
    }
    out[f.key] = { ...doc, rows };
  }
  return out;
}

/** 一个栏目引用了哪些附件：由各类型的 `refs` 决定（导出打包口径：算上资料袋正文图片）。 */
function referencedFileIds(entries: StoreEntry[], defsOf: (e: StoreEntry) => FieldDefLike[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    for (const f of defsOf(e)) {
      const v = e.values?.[f.key];
      if (v === null || v === undefined) continue;
      // 原始资料袋里的 file item 与 text 正文内嵌的图都是正式引用：袋是「字段值从哪来」的
      // 锚点，漏了它导出的包就丢原件/丢图——溯源链条在包里断掉。这就是 sourceTextImages。
      for (const id of behaviorOf(f.type).refs(f, v, { sourceTextImages: true })) ids.add(id);
    }
  }
  return ids;
}

const extensionOf = (rec: { ext?: string | null; name?: string | null }) => rec.ext || extname(rec.name || '').toLowerCase();

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

// 加密包的外层入口名。放在 ZIP 里而不是把整个文件变成密文 ——
// 这样外层始终是合法 ZIP（系统「压缩文件夹」能打开，只会看到一个看不懂的 payload.enc），
// 不会弹「文件夹无效」；同时也让「是不是加密包」的判定只需要看条目名，不用嗅探 magic。
const ENC_ENTRY = 'payload.enc';

/** 把内部 ZIP 用口令加密后，再套一个合法 ZIP。innerReadme 用来说明这个包是什么。 */
function wrapEncrypted(innerZip: Buffer, passphrase: unknown, innerReadme: string): Buffer {
  const readme = [
    'nx-sk 加密导出包',
    '',
    '这个 ZIP 里只有一个 payload.enc —— 真正的数据（栏目、条目、附件）被 AES-256-GCM 加密过，',
    '只有 nx-sk 能解开。用系统自带的压缩文件夹打开也只能看到这个文件，属正常。',
    '',
    '导入：面板「导出导入」页把这个文件拖进去，输入导出时设的口令；或',
    '  nx-sk transfer import <栏目> --file <本文件> --passphrase <口令> --dry-run',
    '',
    '口令不在文件里，忘了就打不开。',
    '',
    '── 以下是无口令时本包内部的说明（同样被加密） ──',
    innerReadme,
  ].join('\n');
  return createZip([
    { name: ENC_ENTRY, data: sealPackage(innerZip, passphrase) },
    { name: 'README.txt', data: readme },
  ]);
}

/** 需要口令的判定：外层有 payload.enc。旧版（0.11.x）把整个文件做成密文，也一并认。 */
export function needsPassphrase(buffer: Buffer): boolean {
  if (isEncryptedPackage(buffer)) return true; // 旧格式：文件本身就是密文
  try {
    return readZip(buffer).some((f) => f.name === ENC_ENTRY);
  } catch {
    return false;
  }
}

/**
 * 取出**内部 ZIP**：明文包原样返回；加密包先解口令。
 * 顺序不能反——必须「先解密内部，再当 zip 读」，这正是导出的逆过程。
 */
function innerZipOf(buffer: Buffer, passphrase?: unknown): ZipFile[] {
  if (isEncryptedPackage(buffer)) {
    // 旧格式（整个文件是密文）：直接解
    return readZip(openPackage(buffer, passphrase));
  }
  const files = readZip(buffer);
  const enc = files.find((f) => f.name === ENC_ENTRY);
  if (!enc) return files; // 明文包
  if (!String(passphrase ?? '')) throw blocked(NEED_PW_MESSAGE);
  return readZip(openPackage(enc.data, passphrase));
}

const NEED_PW_MESSAGE = '这个包已加密，请输入导出时设置的口令';

// 同一个 buffer 在一次请求里会被预览和应用各解析一次；按 buffer 缓存，
// 避免几百 MB 的包被解两遍。
const bundleCache = new WeakMap<Buffer, ParsedBundle>();

/**
 * 归一成「ZIP 条目列表」：传 buffer 就走解密封装，传已经解开的列表就原样用。
 * applyImport 已经解过一次，把列表传进来避免同一个大包被解两遍。
 */
function asZipFiles(bufferOrFiles: Buffer | ZipFile[], passphrase?: unknown): ZipFile[] {
  return Array.isArray(bufferOrFiles) ? bufferOrFiles : innerZipOf(bufferOrFiles, passphrase);
}

function parseBundle(buffer: Buffer | ZipFile[], fileName?: string, passphrase?: unknown): ParsedBundle {
  // 先取内部 ZIP（加密包在这一步校验口令，错了就抛，不会走到后面的解析）
  const files = asZipFiles(buffer, passphrase);
  // 缓存只在**明文包**上用。加密包的解析结果依赖口令，按 buffer 缓存会让后续
  // 「没给口令」的调用命中别人解出来的结果——等于把口令检查绕过去了。
  const cacheKey = buffer as Buffer;
  const hit = isEncryptedPackage(buffer) ? null : bundleCache.get(cacheKey);
  if (hit) return hit;
  const map = new Map(files.map((f) => [f.name, f.data]));
  const raw = map.get('manifest.json');
  if (!raw) throw badInput('ZIP 里没有 manifest.json —— 不是 nx-sk 栏目导出包');
  let manifest: any;
  // TODO(P4): manifest 是外部 JSON，键集由 FORMAT + formatVersion 约定（下方做结构校验）
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badInput('manifest.json 不是合法 JSON');
  }
  if (manifest?.format !== FORMAT) throw badInput(`不是栏目导出包（format=${manifest?.format || '未声明'}）`);
  if (Number(manifest.formatVersion) > FORMAT_VERSION) {
    throw badInput(`导出包版本过新（${manifest.formatVersion}），请先升级 nx-sk`);
  }
  if (!manifest.section || !Array.isArray(manifest.entries) || !Array.isArray(manifest.files)) {
    throw badInput('manifest.json 结构不完整（缺 section / entries / files）');
  }
  const enc = needsPassphrase(buffer as Buffer);
  const parsed = { manifest, map, fileName: fileName || 'upload.zip', encrypted: enc };
  // 缓存只存**明文包**：加密包的解析结果依赖口令，按 buffer 缓存会让后续
  // 「没给口令」的调用命中别人解出来的结果——等于把口令检查绕过去。
  if (!enc) bundleCache.set(cacheKey, parsed);
  return parsed;
}

const entryTitleIndex = (entries: StoreEntry[]): { byTitle: Map<string, StoreEntry>; byId: Map<string, StoreEntry> } => {
  const byTitle = new Map<string, StoreEntry>();
  const byId = new Map<string, StoreEntry>();
  for (const e of entries) {
    byTitle.set(e.title, e);
    byId.set(e.id, e);
  }
  return { byTitle, byId };
};

/**
 * 预览导入：**不落盘**，只回答「会变成什么」。
 * 冲突、字段缺口、附件去重、打码凭据都在这里算清楚，UI 直接展示。
 */
export async function previewImport(ref: unknown, buffer: Buffer | ZipFile[], { fileName, passphrase, encrypted }: { fileName?: string; passphrase?: unknown; encrypted?: boolean } = {}) {
  const parsed = parseBundle(buffer, fileName, passphrase);
  const { manifest, map } = parsed;
  const isEnc = encrypted === undefined ? parsed.encrypted : !!encrypted;
  const store = await loadStore();
  const target = ref ? findSection(store, ref) : null;
  // 目标解析：显式 ref 优先；**不传 ref = 零配置** —— 按包内 id 新建，
  // id 已存在就加序号（同一份包可以反复导入成多份，不会静默合并）。
  let targetId: string = target?.id || (ref && isSectionId(ref) ? (ref as string) : manifest.section.id);
  let sectionTitle: string = target?.title || manifest.section.title;
  let renamedFrom: string | null = null;
  if (!target && !ref) {
    const fresh = uniqueSectionId(store, manifest.section.id);
    if (fresh !== manifest.section.id) {
      renamedFrom = manifest.section.id;
      sectionTitle = `${manifest.section.title}（导入）`;
    }
    targetId = fresh;
  }
  const targetEntries = target ? store.entries.filter((e) => e.section === target.id) : [];
  const { byTitle, byId } = entryTitleIndex(targetEntries);

  const targetFieldKeys = new Set((target?.fields || []).map((f) => f.key));
  const targetGroupIds = new Set((target?.groups || []).map((g) => g.id));
  const fieldsToAdd = (manifest.section.fields || []).filter((f: any) => !targetFieldKeys.has(f.key));
  const groupsToAdd = (manifest.section.groups || []).filter((g: any) => !targetGroupIds.has(g.id));

  const conflicts: Array<{ id: string; title: string; reason: string; existingId: string; existingTitle: string; copyTitle?: string }> = [];
  for (const e of manifest.entries) {
    const hitId = byId.get(e.id);
    const hitTitle = byTitle.get(e.title);
    if (hitId || hitTitle) {
      const hit = (hitId || hitTitle)!;
      conflicts.push({
        id: e.id, title: e.title,
        reason: hitId ? 'id' : 'title',
        existingId: hit.id,
        existingTitle: hit.title,
      });
    }
  }
  // 「另存」时会变成什么标题，提前算给 UI。否则用户只能等导完才知道重名被改成什么样。
  if (conflicts.length) {
    const taken = new Set(targetEntries.map((x) => x.title));
    for (const c of conflicts) {
      c.copyTitle = uniqueTitle(c.title || '（无名）', taken);
      taken.add(c.copyTitle);
    }
  }

  let zipBytes = 0;
  let newFiles = 0;
  let reusedFiles = 0;
  const fileIssues: Array<{ name: string; reason: string }> = [];
  for (const f of manifest.files) {
    const data = map.get(f.zipPath);
    if (!data) { fileIssues.push({ name: f.name, reason: 'zip 里缺文件' }); continue; }
    zipBytes += data.length;
    const sha = createHash('sha256').update(data).digest('hex');
    if (f.sha256 && sha !== f.sha256) { fileIssues.push({ name: f.name, reason: 'sha256 不符' }); continue; }
    if (store.files.some((r) => r.sha256 === sha)) reusedFiles += 1;
    else newFiles += 1;
  }

  // 打码凭据：导入时不能把 `******` 当新密码存进去，只能跳过并提示重填
  let maskedSecrets = 0;
  const sensitiveKeys = new Set<string>((manifest.section.fields || []).filter((f: any) => f.sensitive || f.type === 'secret').map((f: any) => f.key));
  for (const e of manifest.entries) {
    for (const k of sensitiveKeys) {
      const v = e.values?.[k];
      if (typeof v === 'string' && v.includes('******')) maskedSecrets += 1;
    }
  }

  const notBundled = manifest.files.filter((f: any) => f.bundled === false).length;
  const warnings: string[] = [];
  if (notBundled) warnings.push(`${notBundled} 个附件未随包（导出时没勾「携带附件」），导入后这些引用会指向不存在的附件`);
  if (!manifest.withSecrets && maskedSecrets) warnings.push(`${maskedSecrets} 个凭据字段在导出时已打码，导入后需要重新填写`);
  if (fileIssues.length) warnings.push(`${fileIssues.length} 个附件有问题（缺失或校验失败），将被跳过`);
  // 只有「显式指定了目标栏目」时这句才成立；零配置导入是新建，说「当前栏目」会误导
  if (ref && manifest.section.id !== targetId) warnings.push(`ZIP 来自栏目「${manifest.section.title}」（${manifest.section.id}），将导入到当前栏目`);

  return {
    status: 'preview',
    fileName,
    encrypted: isEnc,
    exportedAt: manifest.exportedAt,
    appVersion: manifest.appVersion,
    withSecrets: !!manifest.withSecrets,
    section: {
      source: { id: manifest.section.id, title: manifest.section.title },
      targetId,
      exists: !!target,
      willCreate: !target,
      renamedFrom,
      title: sectionTitle,
      fieldsToAdd: fieldsToAdd.map((f: any) => ({ key: f.key, label: f.label, type: f.type })),
      groupsToAdd: groupsToAdd.map((g: any) => ({ id: g.id, title: g.title })),
    },
    entries: {
      total: manifest.entries.length,
      fresh: manifest.entries.length - conflicts.length,
      conflicts,
      titles: manifest.entries.slice(0, 12).map((e: any) => e.title),
    },
    files: {
      total: manifest.files.length,
      new: newFiles,
      reused: reusedFiles,
      bytes: zipBytes,
      issues: fileIssues,
      // 导出时选了「不带附件」：台账记录还在（知道有哪些引用），但没有原件可落
      notBundled: manifest.files.filter((f: any) => f.bundled === false).length,
    },
    secrets: { sensitiveFields: sensitiveKeys.size, masked: maskedSecrets },
    warnings,
  };
}

function uniqueTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 1; i < 1000; i += 1) {
    const t = i === 1 ? `${base}（导入）` : `${base}（导入 ${i}）`;
    if (!taken.has(t)) return t;
  }
  return `${base}（导入 ${Date.now()}）`;
}

/**
 * 引用重映射：由各类型 `remap` 决定（file 的 id 列表、md 正文、source 袋里的 fileId 与正文图）。
 * v3：键不在字典的（扩展字段）按值推断伪 def 再 remap——否则包里 `备用附件=f_x` 这类
 * 引用会原样带过去，指向源机的附件 id；其余类型 remap 本来就是原样返回。
 */
function remapValues(section: StoreSection, values: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  const out = { ...values };
  const byKey = new Map((section.fields || []).map((f) => [String(f.key), f as unknown as FieldDefLike]));
  for (const [k, v] of Object.entries(out)) {
    const def = byKey.get(k) || ({ key: k, type: inferFieldType(v) } as FieldDefLike);
    out[k] = behaviorOf(String(def.type)).remap(def, v, idMap);
  }
  return out;
}

/** 写入一个附件：同 sha 直接复用，不重复占空间。 */
async function storeAttachment({ data, name, category }: { data: Buffer; name: string; category?: string }) {
  const store = await loadStore();
  const outcome = await importContent(store, { content: data.toString('base64'), name, category: safeCategory(category) });
  if (outcome.duplicate) return { id: outcome.record!.id, reused: true, bytes: 0 };
  await mutateStore((s) => { s.files.push(outcome.record!); });
  return { id: outcome.record!.id, reused: false, bytes: data.length };
}

/**
 * 真正导入。先跑一次 preview（拿同一份 store 视图），再落盘。
 */
export async function applyImport(ref: unknown, buffer: Buffer, { fileName, onConflict = 'skip', passphrase }: { fileName?: string; onConflict?: string; passphrase?: unknown } = {}) {
  if (!CONFLICT_POLICIES.includes(onConflict)) {
    throw badInput(`冲突策略只能是 ${CONFLICT_POLICIES.join(' / ')}，收到 ${JSON.stringify(onConflict)}`);
  }
  // 解密只做一次：预览与随后的落盘都吃这份内部 ZIP，否则同一个大包会被解两遍。
  const plain = innerZipOf(buffer, passphrase);
  const encrypted = needsPassphrase(buffer);
  const preview = await previewImport(ref, plain, { fileName, encrypted });
  const { manifest, map } = parseBundle(plain, fileName);
  const targetId = preview.section.targetId;

  let sectionCreated = false;
  let fieldsAdded: string[] = [];
  let section = findSection(await loadStore(), targetId);
  if (!section) {
    await addSection({
      id: targetId,
      title: preview.section.title || targetId,
      description: manifest.section.description || '',
      order: Number.isFinite(manifest.section.order) ? manifest.section.order : 50,
      groups: manifest.section.groups || [],
      fields: manifest.section.fields || [],
    });
    if (manifest.section.titleField) await updateSection(targetId, { titleField: manifest.section.titleField });
    // 结构随包：KV 表不是字段能表达的，必须单独带过来
    if (manifest.section.kv === true) await updateSection(targetId, { kv: true });
    sectionCreated = true;
    fieldsAdded = (manifest.section.fields || []).map((f: any) => f.key);
  } else if (preview.section.fieldsToAdd.length) {
    const defs = (manifest.section.fields || []).filter((f: any) => preview.section.fieldsToAdd.some((x: any) => x.key === f.key));
    await updateSection(targetId, { 'add-field': defs });
    fieldsAdded = defs.map((f: any) => f.key);
  }
  section = findSection(await loadStore(), targetId)!;

  // 附件先落，拿到「旧 id → 新 id」映射；条目里的引用随后重写
  const idMap = new Map<string, string>();
  let filesAdded = 0;
  let filesReused = 0;
  let filesBytes = 0;
  for (const f of manifest.files) {
    const data = map.get(f.zipPath);
    if (!data) continue;
    const sha = createHash('sha256').update(data).digest('hex');
    if (f.sha256 && sha !== f.sha256) continue;
    const r = await storeAttachment({ data, name: f.name, category: f.category });
    idMap.set(f.id, r.id);
    if (r.reused) filesReused += 1;
    else { filesAdded += 1; filesBytes += r.bytes; }
  }

  const existing = (await loadStore()).entries.filter((e) => e.section === targetId);
  const takenTitles = new Set(existing.map((e) => e.title));
  const byId = new Map(existing.map((e) => [e.id, e]));
  let added = 0;
  let copied = 0;
  let overwritten = 0;
  let skipped = 0;
  let maskedSkipped = 0;

  for (const src of manifest.entries) {
    const values = remapValues(section, src.values || {}, idMap);
    for (const f of section.fields) {
      if (!isSensitiveField(section, f.key)) continue;
      const v = values[f.key];
      if (typeof v === 'string' && v.includes('******')) { delete values[f.key]; maskedSkipped += 1; }
    }
    const hit = byId.get(src.id) || existing.find((e) => e.title === src.title);
    if (hit) {
      if (onConflict === 'skip') { skipped += 1; continue; }
      if (onConflict === 'overwrite') {
        await updateEntry(hit.id, { section: targetId, set: values });
        overwritten += 1;
        continue;
      }
      // copy：另存为新条目，标题去重（标题是 CLI 的定位键，不能重名）。
      // 基准用**原标题**而不是「标题（导入）」—— 否则二次重名会变成「A（导入）（导入）」，
      // 与预览里算给用户看的 copyTitle 也对不上。
    }
    const title = hit
      ? uniqueTitle(src.title, takenTitles)
      : uniqueTitle(src.title, takenTitles);
    const created = await addEntry({ section: targetId, title, set: values, tags: src.tags });
    takenTitles.add(created.title!);
    if (hit) copied += 1;
    else added += 1;
  }

  return {
    status: 'ok',
    encrypted,
    section: { id: targetId, title: section.title, created: sectionCreated },
    entries: { added, copied, overwritten, skipped, total: manifest.entries.length },
    files: { added: filesAdded, reused: filesReused, bytes: filesBytes },
    fieldsAdded,
    maskedSkipped,
    preview,
  };
}


/**
 * 零配置导入：**单栏目包与全局包都吃**。
 *
 * 判据是解开外层之后里面有没有 bundle.json —— 用户不该记住「我这个包是哪种」，
 * 尤其加密包在解开口令前看不出任何结构。全局包走逐栏目复用，单栏目包走原路径。
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

/** CLI：从文件导入（预览 or 应用）。 */
export async function importFromFile(ref: unknown, { file, onConflict = 'skip', dryRun = false, passphrase }: { file?: string; onConflict?: string; dryRun?: boolean; passphrase?: unknown } = {}) {
  if (!file) throw badInput('缺少 --file <zip 路径>');
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(resolve(file));
  } catch (e) {
    throw badInput(`读不到 ZIP: ${file}（${(e as { code?: string; message?: string }).code || (e as { message?: string }).message}）`);
  }
  const fileName = basename(file);
  return dryRun
    ? previewImport(ref, buffer, { fileName, passphrase })
    : applyImport(ref, buffer, { fileName, onConflict, passphrase });
}

/** HTTP：二进制 body（跳过 JSON 解析），直接交给 preview / apply。 */
export function importFromBuffer(ref: unknown, buffer: Buffer, { fileName, onConflict, dryRun, passphrase }: { fileName?: string; onConflict?: string; dryRun?: boolean; passphrase?: unknown }) {
  return dryRun
    ? previewImport(ref, buffer, { fileName, passphrase })
    : applyImport(ref, buffer, { fileName, onConflict, passphrase });
}


// ─── 全局多栏目包（bundle） ──────────────────────────────────────
//
// 外层 zip 只是**容器**：bundle.json 记索引，sections/<id>.zip 是已经验证过的单栏目包。
// 这样全局导入不需要把「结构/附件/冲突」再实现一遍 —— 逐个栏目复用同一套 preview/apply，
// 行为与栏目页的导入天然一致。
const BUNDLE_FORMAT = 'nx-sk.bundle';
const BUNDLE_VERSION = 1;

function normalizeSelection(input: unknown): Array<{ id: string; entries?: unknown }> {
  let arr = input;
  if (typeof arr === 'string') {
    const raw = arr;
    try { arr = JSON.parse(raw); } catch { arr = raw.split(/[,，\s]+/).filter(Boolean); }
  }
  if (!Array.isArray(arr) || !arr.length) throw badInput('至少选一个栏目');
  const out = arr.map((x) => (typeof x === 'string' ? { id: x } : { id: String(x?.id || ''), entries: x?.entries }))
    .filter((x) => x.id);
  if (!out.length) throw badInput('至少选一个栏目');
  return out;
}

export async function buildBundleZip({ sections, passphrase, includeFiles = true }: { sections?: unknown; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const sel = normalizeSelection(sections);
  const parts: ZipFile[] = [];
  const index: Array<{ id: string; title: string; zipPath: string; entries: number; available: number; files: number }> = [];
  for (const item of sel) {
    const { buffer, stats } = await buildSectionZip(item.id, { entryIds: item.entries, includeFiles });
    const zipPath = `sections/${stats.section}.zip`;
    parts.push({ name: zipPath, data: buffer });
    index.push({
      id: stats.section, title: stats.sectionTitle, zipPath,
      entries: stats.entries, available: stats.available, files: stats.files,
    });
  }
  const exportedAt = nowIso();
  const manifest = {
    app: 'nx-sk', format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, appVersion: VERSION,
    exportedAt, withSecrets: true,
    counts: {
      sections: index.length,
      entries: index.reduce((n, x) => n + x.entries, 0),
      files: index.reduce((n, x) => n + x.files, 0),
    },
    sections: index,
  };
  const readme = [
    'nx-sk 全局导出包（多栏目）', '',
    `时间：${exportedAt}`,
    `栏目：${index.length}　条目：${manifest.counts.entries}　附件：${manifest.counts.files}`,
    `凭据：包内为明文，保护靠口令`,
    '',
    '每个栏目在 sections/<id>.zip 里，结构与单栏目导出完全一致；bundle.json 只是索引。',
    '导入：面板「导出导入」页把这个文件拖进去，或',
    '  nx-sk transfer bundle-import --file <本文件> --dry-run',
  ].join('\n');
  const plain = createZip([
    { name: 'bundle.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'README.txt', data: readme },
    ...parts,
  ]);
  // 先加密内部、再打 zip：外层始终是合法 ZIP（系统压缩文件夹能打开，只看到 payload.enc），
  // 同时把「里面有哪些栏目」也一并藏起来。
  const encrypted = !!String(passphrase ?? '');
  const buffer = encrypted ? wrapEncrypted(plain, passphrase, readme) : plain;
  return {
    buffer,
    fileName: `nx-sk-bundle-${stamp()}.zip`,
    stats: {
      sections: index.length, entries: manifest.counts.entries, files: manifest.counts.files,
      bytes: buffer.length, encrypted,
    },
  };
}

export async function exportBundleToFile({ sections, out, dryRun = false, passphrase, includeFiles }: { sections?: unknown; out?: string; dryRun?: boolean; passphrase?: unknown; includeFiles?: boolean } = {}) {
  const { buffer, fileName, stats } = await buildBundleZip({ sections, passphrase, includeFiles });
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

export async function serveBundleZip({ sections, res, passphrase, includeFiles }: { sections?: unknown; res: ServerResponse; passphrase?: unknown; includeFiles?: boolean } = { res: undefined as unknown as ServerResponse }) {
  const { buffer, fileName, stats } = await buildBundleZip({ sections, passphrase, includeFiles });
  res.writeHead(200, {
    // 加密包不是 zip：给 octet-stream，别让浏览器 / 代理按 zip 去嗅探
    'content-type': stats.encrypted ? 'application/octet-stream' : 'application/zip',
    'content-length': buffer.length,
    'content-disposition': `attachment; filename="nx-sk-bundle.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

function parseGlobalBundle(buffer: Buffer, passphrase?: unknown) {
  const files = innerZipOf(buffer, passphrase);
  const map = new Map(files.map((f) => [f.name, f.data]));
  const raw = map.get('bundle.json');
  if (!raw) throw badInput('不是全局导出包：缺少 bundle.json');
  let manifest: any;
  // TODO(P4): bundle.json 是外部 JSON，键集由 BUNDLE_FORMAT + BUNDLE_VERSION 约定
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw badInput('bundle.json 不是合法 JSON'); }
  if (manifest?.format !== BUNDLE_FORMAT) throw badInput(`不是全局导出包（format=${manifest?.format || '未声明'}）`);
  if (Number(manifest.formatVersion) > BUNDLE_VERSION) throw badInput('导出包版本过新，请先升级 nx-sk');
  const items = (manifest.sections || []).map((sec: any) => {
    const data = map.get(sec.zipPath);
    if (!data) throw badInput(`包内缺少栏目 ${sec.id} 的数据（${sec.zipPath}）`);
    return { section: sec, buffer: data };
  });
  if (!items.length) throw badInput('全局导出包里没有栏目');
  return { manifest, items };
}

export async function previewBundle(buffer: Buffer, { fileName, passphrase }: { fileName?: string; passphrase?: unknown } = {}) {
  const { manifest, items } = parseGlobalBundle(buffer, passphrase);
  const list: Array<{ id: string; title: string; willCreate: boolean; renamedFrom: string | null; entries: { total: number; fresh: number; conflicts: unknown[] }; files: { new: number; reused: number; bytes: number; notBundled: number }; fieldsToAdd: Array<{ key: string; label: string; type: string }>; notBundled: number }> = [];
  const warnings: string[] = [];
  for (const it of items) {
    const p = await previewImport(it.section.id, it.buffer, { fileName: it.section.zipPath });
    list.push({
      id: it.section.id,
      title: p.section.title,
      willCreate: p.section.willCreate,
      renamedFrom: p.section.renamedFrom,
      entries: p.entries,
      files: p.files,
      fieldsToAdd: p.section.fieldsToAdd,
      notBundled: p.files.notBundled || 0,
    });
    for (const w of p.warnings) warnings.push(`[${it.section.title}] ${w}`);
  }
  const totals = list.reduce((acc, x) => ({
    sections: acc.sections + 1,
    newSections: acc.newSections + (x.willCreate ? 1 : 0),
    entries: acc.entries + x.entries.total,
    fresh: acc.fresh + x.entries.fresh,
    conflicts: acc.conflicts + x.entries.conflicts.length,
    filesNew: acc.filesNew + x.files.new,
    filesReused: acc.filesReused + x.files.reused,
    bytes: acc.bytes + x.files.bytes,
  }), { sections: 0, newSections: 0, entries: 0, fresh: 0, conflicts: 0, filesNew: 0, filesReused: 0, bytes: 0 });
  return {
    status: 'preview', fileName,
    encrypted: needsPassphrase(buffer),
    exportedAt: manifest.exportedAt,
    withSecrets: !!manifest.withSecrets, sections: list, totals, warnings,
  };
}

export async function applyBundle(buffer: Buffer, { fileName, onConflict = 'skip', passphrase }: { fileName?: string; onConflict?: string; passphrase?: unknown } = {}) {
  const { manifest, items } = parseGlobalBundle(buffer, passphrase);
  const sections: Array<{ id: string; title: string; created: boolean; entries: { added: number; copied: number; overwritten: number; skipped: number }; files: { added: number; reused: number; bytes: number }; fieldsAdded: string[]; maskedSkipped: number }> = [];
  for (const it of items) {
    const r = await applyImport(it.section.id, it.buffer, { fileName, onConflict });
    sections.push({
      id: r.section.id, title: r.section.title, created: r.section.created,
      entries: r.entries, files: r.files, fieldsAdded: r.fieldsAdded, maskedSkipped: r.maskedSkipped,
    });
  }
  const totals = sections.reduce((a, x) => ({
    sections: a.sections + 1,
    createdSections: a.createdSections + (x.created ? 1 : 0),
    added: a.added + x.entries.added,
    copied: a.copied + x.entries.copied,
    overwritten: a.overwritten + x.entries.overwritten,
    skipped: a.skipped + x.entries.skipped,
    filesAdded: a.filesAdded + x.files.added,
    filesReused: a.filesReused + x.files.reused,
  }), { sections: 0, createdSections: 0, added: 0, copied: 0, overwritten: 0, skipped: 0, filesAdded: 0, filesReused: 0 });
  return { status: 'ok', fileName, exportedAt: manifest.exportedAt, sections, totals };
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

// ─── 人读渲染 ────────────────────────────────────────────────────

export function renderExportZip(d: Awaited<ReturnType<typeof exportToFile>>) {
  return [
    `已导出栏目 ${d.sectionTitle}（${d.section}）→ ${d.path}`,
    `条目 ${d.entries}${d.available !== undefined && d.entries !== d.available ? ` / 共 ${d.available}` : ''} · 附件 ${d.files} · ${(d.bytes / 1024).toFixed(1)}KB${d.encrypted ? ' · 已用口令加密' : ''}`,
    d.missingFiles ? `注意：${d.missingFiles} 个附件在磁盘上找不到，未打包` : '',
  ].filter(Boolean).join('\n');
}

/** renderImport 的入参：previewImport 与 applyImport 两种结果共用的读侧形状。 */
interface ImportView {
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
interface BundleExportView {
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


