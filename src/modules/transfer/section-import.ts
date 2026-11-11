import fsp from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadStore, mutateStore, type StoreEntry, type StoreSection } from '../../core/store.ts';
import { findSection, inferFieldType, isSensitiveField } from '../../core/fields.ts';
import { importContent } from '../../core/attachments.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { badInput } from '../../core/errors.ts';
import { addEntry, updateEntry } from '../entries/service.ts';
import { addSection, updateSection } from '../sections/service.ts';
import { CONFLICT_POLICIES, innerZipOf, isSectionId, needsPassphrase, parseBundle, safeCategory, uniqueSectionId, type FieldDefLike, type ZipFile } from './common.ts';

export const entryTitleIndex = (entries: StoreEntry[]): { byTitle: Map<string, StoreEntry>; byId: Map<string, StoreEntry> } => {
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

export function uniqueTitle(base: string, taken: Set<string>): string {
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
export function remapValues(section: StoreSection, values: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  const out = { ...values };
  const byKey = new Map((section.fields || []).map((f) => [String(f.key), f as unknown as FieldDefLike]));
  for (const [k, v] of Object.entries(out)) {
    const def = byKey.get(k) || ({ key: k, type: inferFieldType(v) } as FieldDefLike);
    out[k] = behaviorOf(String(def.type)).remap(def, v, idMap);
  }
  return out;
}

/** 写入一个附件：同 sha 直接复用，不重复占空间。 */
export async function storeAttachment({ data, name, category }: { data: Buffer; name: string; category?: string }) {
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
