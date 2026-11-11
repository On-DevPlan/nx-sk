import { extname } from 'node:path';
import { createZip, readZip } from '../../core/zip.ts';
import { isEncryptedPackage, openPackage, sealPackage } from '../../core/securezip.ts';
import { isDetachedField, type Store, type StoreEntry, type StoreSection } from '../../core/store.ts';
import type { EntryFieldView } from '../../core/store.ts';
import { isSensitiveField } from '../../core/fields.ts';
import { decryptValue, isCipherBlob } from '../../core/crypto.ts';
import { resolveVaultKey } from '../../core/vault.ts';
import { CATEGORY_IDS } from '../../core/attachments.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { badInput, blocked } from '../../core/errors.ts';

export const FORMAT = 'nx-sk.section';
export const FORMAT_VERSION = 1;
export const CONFLICT_POLICIES = ['skip', 'copy', 'overwrite'];

/** 一份已解开的导出包：manifest 是外部 JSON，逐键校验由后面的结构检查负责。 */
export interface ParsedBundle {
  // TODO(P4): manifest 来自 ZIP 内的 JSON，键集由 FORMAT_VERSION 约定，未逐键建模
  manifest: any;
  map: Map<string, Buffer>;
  fileName: string;
  encrypted: boolean;
}

export interface ZipFile {
  name: string;
  data: Buffer;
}

export interface BuildZipOptions {
  entryIds?: unknown;
  passphrase?: unknown;
  includeFiles?: boolean;
}

export function safeCategory(cat: unknown): string {
  return CATEGORY_IDS.includes(cat as string) ? String(cat) : 'other';
}

/** 目标 ref 是「栏目 id」还是「栏目标题」：id 可以直接新建，标题不行（会建出非法 id）。 */
export const isSectionId = (s: unknown) => /^[a-z0-9][a-z0-9_-]*$/i.test(String(s || ''));

/** 零配置导入：包里的 id 已存在时换一个，绝不静默并进别人的栏目。 */
export function uniqueSectionId(store: Store, base: string): string {
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
export function entryDefs(section: StoreSection, ownRows: EntryFieldView[] | null | undefined): FieldDefLike[] {
  return ownRows ? ownRows.filter((r) => !isDetachedField(r)).map((r) => r.spec as unknown as FieldDefLike) : (section.fields || []) as unknown as FieldDefLike[];
}

/** 字段定义的宽松读取形状（transfer 只碰这几个键）。 */
export interface FieldDefLike {
  key: string;
  label?: string;
  type: string;
  sensitive?: unknown;
  fields?: unknown;
  columns?: unknown;
  [k: string]: unknown;
}

export async function plainValues(defs: FieldDefLike[], values: unknown): Promise<Record<string, unknown>> {
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
export function referencedFileIds(entries: StoreEntry[], defsOf: (e: StoreEntry) => FieldDefLike[]): Set<string> {
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

export const extensionOf = (rec: { ext?: string | null; name?: string | null }) => rec.ext || extname(rec.name || '').toLowerCase();

// 加密包的外层入口名。放在 ZIP 里而不是把整个文件变成密文 ——
// 这样外层始终是合法 ZIP（系统「压缩文件夹」能打开，只会看到一个看不懂的 payload.enc），
// 不会弹「文件夹无效」；同时也让「是不是加密包」的判定只需要看条目名，不用嗅探 magic。
export const ENC_ENTRY = 'payload.enc';

/** 把内部 ZIP 用口令加密后，再套一个合法 ZIP。innerReadme 用来说明这个包是什么。 */
export function wrapEncrypted(innerZip: Buffer, passphrase: unknown, innerReadme: string): Buffer {
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
export function innerZipOf(buffer: Buffer, passphrase?: unknown): ZipFile[] {
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

export const NEED_PW_MESSAGE = '这个包已加密，请输入导出时设置的口令';

// 同一个 buffer 在一次请求里会被预览和应用各解析一次；按 buffer 缓存，
// 避免几百 MB 的包被解两遍。
export const bundleCache = new WeakMap<Buffer, ParsedBundle>();

/**
 * 归一成「ZIP 条目列表」：传 buffer 就走解密封装，传已经解开的列表就原样用。
 * applyImport 已经解过一次，把列表传进来避免同一个大包被解两遍。
 */
export function asZipFiles(bufferOrFiles: Buffer | ZipFile[], passphrase?: unknown): ZipFile[] {
  return Array.isArray(bufferOrFiles) ? bufferOrFiles : innerZipOf(bufferOrFiles, passphrase);
}

export function parseBundle(buffer: Buffer | ZipFile[], fileName?: string, passphrase?: unknown): ParsedBundle {
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

export const BUNDLE_FORMAT = 'nx-sk.bundle';
export const BUNDLE_VERSION = 1;
