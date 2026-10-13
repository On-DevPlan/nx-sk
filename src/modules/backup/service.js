// 加密备份 / 恢复：整份数据用「口令派生密钥 + AES-256-GCM」对称加密。
//
// 导出：用户设置口令 → 先把 secret 栏目的密文字段用**本机 vaultKey 解开**（明文），
//       再把整份 payload 用口令派生 key 加密落到备份文件；口令不落盘。
//       v3 起 payload **恒含**附件台账（files）——它随 store.json 走，缺了它任何一次
//       导入都会把台账清零（真实事故）；`--with-files` 再把台账指向的原件读成
//       {rel → {b64, sha256}} 单独加密嵌入（archive.filesData，同一把口令派生 key）。
// 导入（缺省 = 合并）：解密后按「只增不减」并入当前数据——补缺失的栏目/条目/台账行、
//       补空字段、把备份多出的分组与字段只增补进已有栏目（core/fields.js 的 mergeTemplate）；
//       两边都有值且不同 → **保留本地**、列入冲突清单交给用户处理；本地已有数据与结构永不删改。
//       敏感字段在进 values 前用**本机 vaultKey** 重新加密；报告里的值一律打码摘要，
//       密钥明文绝不进报告/日志。
// 导入（--replace）：整份替换（旧行为，灾难恢复/跨机器迁移用），同样带台账与原件，先留安全快照。
//
// 这样跨机器恢复：B 机拿到口令后 secret 字段就是明文，**不再依赖 A 机的 vaultKey**。
// 这是 store.json 内的密文被解开的瞬态——落回磁盘后字段仍是 vaultKey 加密形态（每次
// `key set` 会重新用 B 机 vaultKey 加密），所以单机的"落盘密文"防护没退化。
//
// 复用 core/crypto.js 的原语（deriveKey / encryptValue / decryptValue）。
import fsp from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { displayPath, snapshotDir } from '../../core/paths.js';
import { ensureDir, fileSize, hashFile, pathExists, writeAtomic } from '../../core/fsx.js';
import { loadStore, mutateStore, normalize, saveStore, snapshotStore } from '../../core/store.js';
import { decryptValue, deriveKey, encryptValue, isCipherBlob, maskValue } from '../../core/crypto.js';
import { badInput, blocked } from '../../core/errors.js';
import { newId, nowIso, stamp } from '../../core/ids.js';
import { isSensitiveField, mergeTemplate } from '../../core/fields.js';
import { resolveVaultKey } from '../../core/vault.js';
import { fileRecordAbs, normalizeFileRecord } from '../../core/attachments.js';
import { formatValue, isBlank } from '../../core/render.js';

export const BACKUP_KIND = 'encrypted-backup';
export const BACKUP_VERSION = 3;
// v2（0.5.1–0.6.2）没有附件二进制，其余照读；v3 恒含台账、可选嵌入原件
const SUPPORTED_VERSIONS = new Set([2, 3]);
const ENV_BACKUP_PASSWORD = 'NX_SK_BACKUP_PASSWORD';
const EXT = '.nxskbak';
// 报告明细封顶：超过只给计数 +「…共 N 处」尾行，报告不是数据浏览器
const REPORT_CAP = 20;

function passwordFrom(ctx) {
  const pw = ctx?.password ?? process.env[ENV_BACKUP_PASSWORD];
  const s = String(pw ?? '');
  if (!s) {
    throw badInput(
      `备份口令不能为空（用 --password，或设置环境变量 ${ENV_BACKUP_PASSWORD}）。` +
      '口令用于加密备份文件，导入时需要再次输入。',
    );
  }
  return s;
}

/**
 * 导出时：用本机 vaultKey **解开** secret 栏目的密文字段。
 * 导出文件不再依赖 A 机的 ~/.vaultkey / NX_SK_PASSPHRASE。
 */
async function unsealSecretsForExport(payload) {
  const sections = payload.sections || [];
  const entries = payload.entries || [];
  const { key: vaultKey } = await resolveVaultKey();

  const newEntries = [];
  let unsealed = 0;
  for (const e of entries) {
    const sec = sections.find((s) => s.id === e.section);
    if (!sec || !e.values) { newEntries.push(e); continue; }
    const nextValues = { ...e.values };
    let touched = false;
    for (const def of sec.fields || []) {
      if (!isSensitiveField(sec, def.key)) continue;
      const v = nextValues[def.key];
      if (!isCipherBlob(v)) continue;
      nextValues[def.key] = decryptValue(vaultKey, v);
      touched = true; unsealed++;
    }
    newEntries.push(touched ? { ...e, values: nextValues } : e);
  }
  return { ...payload, entries: newEntries, _unsealed: unsealed };
}

/**
 * 导入时：payload 里的 secret 字段已是明文，**用本机 vaultKey 重新加密**后落盘。
 * 这样 store.json 里仍是密文（落盘防护不丢），B 机后续 key get 走 B 机 vaultKey 解密。
 * 历史 store 里残留的明文 secret 也会被本步统一收紧成密文。
 */
async function resealSecretsForImport(payload) {
  const sections = payload.sections || [];
  const entries = payload.entries || [];
  const { key: vaultKey } = await resolveVaultKey();

  const newEntries = [];
  let resealed = 0;
  for (const e of entries) {
    const sec = sections.find((s) => s.id === e.section);
    if (!sec || !e.values) { newEntries.push(e); continue; }
    const nextValues = { ...e.values };
    let touched = false;
    for (const def of sec.fields || []) {
      if (!isSensitiveField(sec, def.key)) continue;
      const v = nextValues[def.key];
      // 已是本机 vaultKey 加密形态就跳过；明文或旧 kid 都重加密
      if (isCipherBlob(v) && !v.kid) continue;
      const plain = isCipherBlob(v) ? decryptValue(vaultKey, v) : (typeof v === 'string' ? v : null);
      if (plain === null) continue;
      nextValues[def.key] = encryptValue(vaultKey, plain);
      touched = true; resealed++;
    }
    newEntries.push(touched ? { ...e, values: nextValues } : e);
  }
  return { ...payload, entries: newEntries, _resealed: resealed };
}

/**
 * 把台账指向的物理原件读成 {rel → {b64, sha256}}（--with-files 用）。
 * 台账是权威：磁盘上缺的原件记入 missing，不嵌入、不报错——导出不因缺盘而失败。
 */
async function packFiles(store) {
  const map = {};
  let bytes = 0;
  const missing = [];
  for (const rec of store.files) {
    const abs = fileRecordAbs(rec);
    if (!(await pathExists(abs))) { missing.push(rec.rel); continue; }
    const buf = await fsp.readFile(abs);
    map[rec.rel] = { b64: buf.toString('base64'), sha256: createHash('sha256').update(buf).digest('hex') };
    bytes += buf.length;
  }
  return { map, bytes, missing };
}

/** 生成加密备份：返回归档对象（HTTP 端据此让浏览器下载）与条目计数。 */
export async function buildBackup(ctx) {
  const password = passwordFrom(ctx);
  const withFiles = ctx['with-files'] === true;
  const store = await loadStore();
  const raw = {
    version: store.version,
    settings: store.settings,
    sections: store.sections,
    entries: store.entries,
    files: store.files, // v3：台账恒随包（元数据很小；缺了它导入即清空附件域）
    exports: store.exports,
  };

  const salt = randomBytes(16);
  const wrapKey = deriveKey(password, salt);
  const payload = await unsealSecretsForExport(raw);
  const data = encryptValue(wrapKey, JSON.stringify(payload));
  const archive = {
    app: 'nx-sk',
    kind: BACKUP_KIND,
    v: BACKUP_VERSION,
    createdAt: nowIso(),
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    data,
  };
  const counts = {
    sections: store.sections.length,
    entries: store.entries.length,
    files: store.files.length,
    unsealed: payload._unsealed || 0,
  };
  if (withFiles) {
    const packed = await packFiles(store);
    archive.filesData = encryptValue(wrapKey, JSON.stringify(packed.map));
    counts.filesEmbedded = Object.keys(packed.map).length;
    counts.filesBytes = packed.bytes;
    counts.filesMissing = packed.missing.length;
  }
  if (ctx['dry-run']) return { dryRun: true, counts };
  return { archive, counts };
}

/** CLI 导出：把加密备份写成文件（缺省放到 ~/nx-sk/backup）。 */
export async function exportBackup(ctx) {
  const built = await buildBackup(ctx);
  if (built.dryRun) return { status: 'skipped', dryRun: true, ...built.counts };
  const { archive, counts } = built;
  const dir = ctx.out ? resolve(ctx.out) : snapshotDir();
  const name = `nx-sk-backup-${stamp()}${EXT}`;
  await ensureDir(dir);
  const file = resolve(dir, name);
  await writeAtomic(file, JSON.stringify(archive, null, 2) + '\n');
  return {
    status: 'ok',
    file: displayPath(file),
    fileRaw: file,
    bytes: await fileSize(file),
    encrypted: true,
    ...counts,
  };
}

function parseArchive(text) {
  let archive;
  try {
    archive = JSON.parse(text);
  } catch (e) {
    throw badInput(`备份文件不是合法 JSON（${e.message}）——请确认选择的是 nx-sk 导出的 ${EXT} 文件`);
  }
  if (!archive || archive.app !== 'nx-sk' || archive.kind !== BACKUP_KIND || !archive.data) {
    throw badInput(`不是 nx-sk 的加密备份文件（缺少 app/kind 标记）`);
  }
  if (!SUPPORTED_VERSIONS.has(archive.v)) {
    throw badInput(`备份文件版本不受支持: v${archive.v}（本工具支持 v2 / v3）`);
  }
  return archive;
}

/** 用口令解密归档文本 → 备份时的 store 负载。口令错误在此抛 BLOCKED。 */
export function decryptBackup(text, password) {
  const archive = parseArchive(text);
  if (!String(password ?? '')) throw badInput('请输入备份时设置的口令。');
  const key = deriveKey(password, archive.salt);
  let payload;
  try {
    payload = JSON.parse(decryptValue(key, archive.data));
  } catch (e) {
    if (e && (e.code === 'BLOCKED' || /解密失败/.test(String(e.message)))) {
      throw blocked('解密失败：口令不正确，或备份文件已损坏。请确认输入的是导出时设置的口令。');
    }
    throw e;
  }
  if (!payload || !Array.isArray(payload.sections) || !Array.isArray(payload.entries)) {
    throw badInput('备份内容缺少 sections / entries，无法恢复。');
  }
  // 附件原件块（v3 --with-files 才有）：跟着同一把 wrapKey 走，损坏就整体拒绝
  let filesData = null;
  if (archive.filesData) {
    try {
      filesData = JSON.parse(decryptValue(key, archive.filesData));
    } catch {
      throw blocked('备份的附件数据解密失败：文件可能已损坏。');
    }
    if (!filesData || typeof filesData !== 'object' || Array.isArray(filesData)) filesData = null;
  }
  return { payload, createdAt: archive.createdAt, filesData };
}

function tryDecrypt(key, blob) {
  try { return decryptValue(key, blob); } catch { return undefined; }
}

/**
 * 报告用值摘要：敏感字段一律 maskValue（sk-1******cdef 形态），非敏感截 24 字符、
 * 换行折空格。冲突清单会进 CLI 输出与面板 Modal——**密钥明文绝不进报告**。
 */
function summarizeValue(section, key, v, vaultKey) {
  if (isBlank(v)) return '';
  if (isSensitiveField(section, key)) {
    let plain = v;
    if (isCipherBlob(v)) {
      const p = tryDecrypt(vaultKey, v);
      if (p === undefined) return '[无法解密]';
      plain = p;
    }
    return maskValue(String(plain));
  }
  let s;
  if (Array.isArray(v)) s = formatValue(v);
  else if (v !== null && typeof v === 'object') s = JSON.stringify(v);
  else s = formatValue(v);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/** 敏感字段落值前用本机 vaultKey 重加密；解不开的旧密文原样跳过（不写坏数据）。 */
function sealSensitive(sec, key, v, vaultKey, report) {
  if (!isSensitiveField(sec, key)) return v;
  let plain = v;
  if (isCipherBlob(v)) {
    const p = tryDecrypt(vaultKey, v);
    if (p === undefined) return v;
    plain = p;
  }
  report.resealed += 1;
  return encryptValue(vaultKey, plain);
}

/**
 * 备份负载 → 归一化的「来料」形状：栏目分组不变量、files 台账、设置默认值
 * 一并走 normalize() 收口；老版本 payload 顺带完成迁移。
 */
function normalizeIncoming(payload) {
  return normalize({
    version: payload.version,
    settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {},
    sections: payload.sections,
    entries: payload.entries,
    files: Array.isArray(payload.files) ? payload.files : [],
  });
}

/**
 * 合并计划：local + 备份来料 → 纯数据计划（不落盘、不碰物理文件）。
 *
 * 只增不减：
 *   - 栏目：缺 → 新增；同 id → mergeTemplate 把备份多出的分组/字段补进来，本地独有一律保留；
 *     kv 标记不一致 → 不动形状、只警示。
 *   - 条目：kv 栏目按 title（键名；跨机器 id 不可靠）匹配、其余按 id；缺 → 新增；
 *     同条目 → 只补空字段，冲突保留本地并列清单。
 *   - 字段合并遍历「本地字典 ∪ 备份 values」的 key 并集——字典不拦写入是核心不变量，
 *     备份带本地没有的键也必须保值带过来，静默丢弃就是数据丢失。
 *   - settings 只补本地没有的键（'' 是有意义的空，不补）；exports 历史有意不动。
 *   - 附件台账按 id 合并（不做 sha 去重——条目存的是 id，去重会断链；同行共指一文件无害）。
 */
function buildMergePlan(local, incoming, vaultKey) {
  const report = {
    addedSections: [], addedEntries: [], addedEntriesTotal: 0,
    filled: [], filledTotal: 0,
    conflicts: [], conflictsTotal: 0,
    structureAdded: [], structureOnlyLocal: [], kvMismatch: [],
    settingsFilled: [], resealed: 0,
  };
  const sections = local.sections.map((s) => ({ ...s }));
  const entries = local.entries.map((e) => ({ ...e, values: { ...e.values } }));
  const files = local.files.map((f) => ({ ...f }));

  // ① 栏目：缺 → 新增；同 id → 只增补形状（永不删）
  for (const bs of incoming.sections) {
    const ls = sections.find((s) => s.id === bs.id);
    if (!ls) {
      sections.push({ ...bs });
      report.addedSections.push({
        id: bs.id, title: bs.title, fields: bs.fields.length,
        entries: incoming.entries.filter((e) => e.section === bs.id).length,
      });
      continue;
    }
    if ((ls.kv === true) !== (bs.kv === true)) {
      report.kvMismatch.push(ls.id);
      continue;
    }
    const { groups, fields, addedGroups, addedFields } = mergeTemplate(ls, bs);
    if (addedGroups.length || addedFields.length) {
      ls.groups = groups;
      ls.fields = fields;
      ls.updatedAt = nowIso();
      report.structureAdded.push({ id: ls.id, title: ls.title, groups: addedGroups, fields: addedFields });
    }
    const backupKeys = new Set(bs.fields.map((f) => f.key));
    const onlyLocal = ls.fields.filter((f) => !backupKeys.has(f.key)).map((f) => f.key);
    if (onlyLocal.length) {
      report.structureOnlyLocal.push({ id: ls.id, title: ls.title, fields: onlyLocal });
    }
  }

  // ② 条目：kv 按 title、其余按 id；缺 → 新增；同 → 补空/记冲突
  for (const be of incoming.entries) {
    const sec = sections.find((s) => s.id === be.section);
    if (!sec) continue; // 备份自洽时不会发生；防御分支
    const pool = entries.filter((e) => e.section === sec.id);
    const le = sec.kv
      ? pool.find((e) => e.title === be.title)
      : pool.find((e) => e.id === be.id);

    if (!le) {
      const id = entries.some((e) => e.id === be.id) ? newId('e') : be.id;
      const fresh = { ...be, id, updatedAt: nowIso(), values: {} };
      for (const [k, v] of Object.entries(be.values || {})) {
        if (isBlank(v)) continue;
        fresh.values[k] = sealSensitive(sec, k, v, vaultKey, report);
      }
      entries.push(fresh);
      report.addedEntriesTotal += 1;
      if (report.addedEntries.length < REPORT_CAP) {
        report.addedEntries.push({ id, section: sec.id, title: be.title || id });
      }
      continue;
    }

    // 已匹配：本地字典 ∪ 备份 values 的 key 并集（字典不拦写入——见函数头注释）
    const keys = new Set([...sec.fields.map((f) => f.key), ...Object.keys(be.values || {})]);
    let touched = false;
    for (const key of keys) {
      const bv = (be.values || {})[key];
      if (isBlank(bv)) continue;
      const lv = le.values[key];
      if (isBlank(lv)) {
        le.values[key] = sealSensitive(sec, key, bv, vaultKey, report);
        touched = true;
        report.filledTotal += 1;
        if (report.filled.length < REPORT_CAP) {
          const def = sec.fields.find((f) => f.key === key);
          report.filled.push({
            section: sec.id, entry: le.title || le.id, field: key,
            label: def ? def.label : key,
            value: summarizeValue(sec, key, bv, vaultKey),
          });
        }
        continue;
      }
      const lPlain = isCipherBlob(lv) ? tryDecrypt(vaultKey, lv) : lv;
      if (JSON.stringify(lPlain) !== JSON.stringify(bv)) {
        report.conflictsTotal += 1;
        if (report.conflicts.length < REPORT_CAP) {
          const def = sec.fields.find((f) => f.key === key);
          report.conflicts.push({
            section: sec.id, entry: le.title || le.id, field: key,
            label: def ? def.label : key,
            localValue: summarizeValue(sec, key, lPlain, vaultKey),
            backupValue: summarizeValue(sec, key, bv, vaultKey),
          });
        }
      }
    }
    if (touched) le.updatedAt = nowIso();
  }

  // ③ 设置：只补本地没有的键；'' = 用默认值，是**有意义的空**，不补
  const settings = { ...local.settings };
  for (const [k, v] of Object.entries(incoming.settings)) {
    if (settings[k] === undefined && !isBlank(v)) {
      settings[k] = v;
      report.settingsFilled.push(k);
    }
  }

  // ④ 附件台账：按 id 合并；已有 id 一律沿用本地记录
  const filesToAdd = [];
  let filesKept = 0;
  for (const br of incoming.files) {
    if (files.some((r) => r.id === br.id)) { filesKept += 1; continue; }
    files.push(br);
    filesToAdd.push(br);
  }

  return { sections, entries, settings, files, filesToAdd, filesKept, report };
}

/**
 * 把归档里携带的附件原件落到磁盘（只处理带了二进制的记录）。
 * sha 校验通过才写；磁盘已有且完好 → 跳过；内容不同 → **磁盘为准，不覆盖**。
 * 物理文件先行（仓库惯例）：若后续 mutateStore 抛错，最多留下无台账引用的孤儿文件——无害。
 */
async function materializeFiles(filesData, finalFiles, addedIds) {
  const stats = {
    written: 0, healed: 0, skippedExisting: 0, checksumMismatch: 0,
    missingBinary: [], missingBinaryTotal: 0, bytes: 0,
  };
  if (!filesData) {
    for (const rec of finalFiles) {
      if (addedIds.has(rec.id)) { stats.missingBinary.push(rec.rel); stats.missingBinaryTotal += 1; }
    }
    return stats;
  }
  for (const rec of finalFiles) {
    const packed = filesData[rec.rel];
    if (!packed || !packed.b64) {
      if (addedIds.has(rec.id)) { stats.missingBinary.push(rec.rel); stats.missingBinaryTotal += 1; }
      continue;
    }
    const buf = Buffer.from(packed.b64, 'base64');
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== rec.sha256) { stats.checksumMismatch += 1; continue; }
    const abs = fileRecordAbs(rec);
    if (await pathExists(abs)) {
      if ((await hashFile(abs)) === rec.sha256) continue; // 已在且完好
      stats.skippedExisting += 1; // 内容不同：磁盘为准
      continue;
    }
    await writeAtomic(abs, buf);
    stats.bytes += buf.length;
    if (addedIds.has(rec.id)) stats.written += 1;
    else stats.healed += 1;
  }
  return stats;
}

/**
 * 恢复 / 合并导入。
 * 缺省（merge）：按「只增不减」并入当前数据，出完整报告；--replace 才整份替换。
 * 两种方式都先留安全快照。
 */
export async function restoreBackup({ content, password, replace, 'dry-run': dryRun }) {
  const { payload, createdAt, filesData } = decryptBackup(String(content ?? ''), password);
  const backupCreatedAt = createdAt || '';
  const filesInBackup = Array.isArray(payload.files) ? payload.files.length : 0;

  if (replace) {
    // —— 整份替换（旧行为）：reseal → 快照 → saveStore（v3 起带上台账与原件）——
    const resealed = await resealSecretsForImport(payload);
    const finalFiles = (payload.files || []).map(normalizeFileRecord).filter(Boolean);
    if (dryRun) {
      return {
        status: 'skipped', dryRun: true, mode: 'replace', backupCreatedAt,
        sections: payload.sections.length, entries: payload.entries.length,
        filesInBackup, resealed: resealed._resealed || 0,
      };
    }
    const safety = await snapshotStore('before-restore');
    const files = await materializeFiles(filesData, finalFiles, new Set(finalFiles.map((r) => r.id)));
    await saveStore({
      version: resealed.version,
      settings: resealed.settings,
      sections: resealed.sections,
      entries: resealed.entries,
      files: finalFiles,
      exports: Array.isArray(resealed.exports) ? resealed.exports : [],
    });
    return {
      status: 'restored', mode: 'replace', backupCreatedAt,
      sections: resealed.sections.length,
      entries: resealed.entries.length,
      resealed: resealed._resealed || 0,
      filesInBackup, filesStats: files,
      safetySnapshot: displayPath(safety),
    };
  }

  // —— 合并（缺省）：先出纯计划，dry-run 即返回；落盘时物理文件先行 → mutateStore ——
  const local = await loadStore();
  const incoming = normalizeIncoming(payload);
  const { key: vaultKey } = await resolveVaultKey();
  const plan = buildMergePlan(local, incoming, vaultKey);
  plan.report.exportsSkipped = Array.isArray(payload.exports) ? payload.exports.length : 0;

  if (dryRun) {
    return {
      status: 'skipped', dryRun: true, mode: 'merge', backupCreatedAt,
      sections: payload.sections.length, entries: payload.entries.length,
      filesInBackup, ...plan.report,
      files: { kept: plan.filesKept, toAdd: plan.filesToAdd.length },
    };
  }

  const safety = await snapshotStore('before-import');
  const addedIds = new Set(plan.filesToAdd.map((r) => r.id));
  const files = await materializeFiles(filesData, plan.files, addedIds);
  await mutateStore((s) => {
    s.sections = plan.sections;
    s.entries = plan.entries;
    s.settings = plan.settings;
    s.files = plan.files; // exports 有意不动：那是本机的操作历史，不是用户数据
  });
  return {
    status: 'ok', mode: 'merge', backupCreatedAt,
    ...plan.report,
    files: { kept: plan.filesKept, toAdd: plan.filesToAdd.length, ...files },
    counts: {
      sectionsBefore: local.sections.length, sectionsAfter: plan.sections.length,
      entriesBefore: local.entries.length, entriesAfter: plan.entries.length,
    },
    safetySnapshot: displayPath(safety),
  };
}

/** CLI 导入：从文件读取归档文本后恢复。 */
export async function importBackup(ctx) {
  const file = resolve(String(ctx.file ?? ''));
  if (!ctx.file || !(await pathExists(file))) {
    throw badInput(`找不到备份文件: ${ctx.file || '（未用 --file 指定）'}`);
  }
  const text = await fsp.readFile(file, 'utf8');
  return restoreBackup({
    content: text,
    password: ctx.password ?? process.env[ENV_BACKUP_PASSWORD],
    replace: ctx.replace === true,
    'dry-run': ctx['dry-run'],
  });
}

export function renderBackup(d) {
  const fileLine = () => {
    if (d.files == null) return null;
    if (d.filesEmbedded != null) {
      return `附件: 台账 ${d.files} 条；嵌入原件 ${d.filesEmbedded} 个（共 ${d.filesBytes} 字节）`
        + (d.filesMissing ? `、${d.filesMissing} 个在磁盘上缺失未嵌入` : '');
    }
    return `附件: 台账 ${d.files} 条（未嵌原件；要连文件一起备请加 --with-files）`;
  };
  if (d.status === 'skipped') {
    return `试运行（未写盘、未下载）\n将加密备份: ${d.sections} 个栏目 / ${d.entries} 条条目（AES-256-GCM）`
      + (d.unsealed ? `\n含明文保存的密钥字段: ${d.unsealed} 个（其他机器用本次口令可解开）` : '')
      + (fileLine() ? `\n${fileLine()}` : '');
  }
  return [
    `已生成加密备份（AES-256-GCM，口令派生密钥、口令不落盘）`,
    `文件: ${d.file}　${d.bytes} 字节`,
    `内容: ${d.sections} 个栏目 / ${d.entries} 条条目`,
    `本次解开为明文的密钥字段: ${d.unsealed || 0} 个（其他机器用本次口令可解开）`,
    fileLine(),
    `恢复时需要输入本次设置的口令。缺省导入为「合并」；要整份替换用 --replace。`,
  ].filter(Boolean).join('\n');
}

function renderConflictLine(c) {
  return `  - ${c.section} / ${c.entry} · ${c.label}(${c.field}): 本地 ${c.localValue || '（空）'} ｜ 备份 ${c.backupValue || '（空）'}`;
}

function renderFilesStats(f) {
  if (!f) return null;
  const parts = [];
  if (f.written) parts.push(`落盘原件 ${f.written} 个`);
  if (f.healed) parts.push(`补齐缺失原件 ${f.healed} 个`);
  if (f.bytes) parts.push(`共 ${f.bytes} 字节`);
  if (f.skippedExisting) parts.push(`磁盘已有但内容不同、保留磁盘 ${f.skippedExisting} 个`);
  if (f.checksumMismatch) parts.push(`校验不符被拒 ${f.checksumMismatch} 个`);
  if (f.missingBinaryTotal) parts.push(`${f.missingBinaryTotal} 条台账无原件（备份未携带，预览/下载会报错）`);
  return parts.length ? `附件: ${parts.join('；')}` : '附件: 台账已并入，原件均已就位';
}

export function renderRestore(d) {
  if (d.dryRun) {
    if (d.mode === 'replace') {
      return [
        '试运行（未改动当前数据）',
        `备份可正常解密: ${d.sections} 个栏目 / ${d.entries} 条条目，生成于 ${d.backupCreatedAt || '未知'}`,
        `导入模式: 整份替换——当前数据将被备份整体覆盖（含 ${d.filesInBackup} 条附件台账）`,
      ].join('\n');
    }
    return [
      '试运行（未改动当前数据）',
      `备份可正常解密: ${d.sections} 个栏目 / ${d.entries} 条条目，生成于 ${d.backupCreatedAt || '未知'}`,
      '导入模式: 合并（缺省）——预计'
      + `新增栏目 ${(d.addedSections || []).length} 个、新增条目 ${d.addedEntriesTotal || 0} 条、`
      + `补空 ${d.filledTotal || 0} 处、冲突 ${d.conflictsTotal || 0} 处、`
      + `补结构 ${d.structureAdded.length ? d.structureAdded.reduce((n, x) => n + x.fields.length, 0) : 0} 个字段`,
      '（--replace 则整份替换：当前数据将被备份整体覆盖）',
    ].join('\n');
  }

  if (d.mode === 'replace') {
    return [
      `已从加密备份整份替换恢复：${d.sections} 个栏目 / ${d.entries} 条条目`,
      renderFilesStats(d.filesStats),
      `用本机密钥库重新加密的密钥字段: ${d.resealed || 0} 个`,
      `备份生成于: ${d.backupCreatedAt || '未知'}`,
      `恢复前的当前数据已留安全快照: ${d.safetySnapshot}`,
    ].filter(Boolean).join('\n');
  }

  // 合并报告：只增不减的完整交代
  const lines = ['已按「合并」导入备份（只增补、不覆盖本地已有值，本地结构未被删改）'];
  lines.push(
    `新增栏目 ${(d.addedSections || []).length} 个 / 新增条目 ${d.addedEntriesTotal || 0} 条；`
    + `补空 ${d.filledTotal || 0} 处；冲突 ${d.conflictsTotal || 0} 处（保留本地值，请手动核对）`,
  );
  if ((d.addedSections || []).length) {
    lines.push('新增栏目:');
    for (const s of d.addedSections) lines.push(`  - ${s.id}（${s.title}）: ${s.fields} 个字段 / ${s.entries} 条条目`);
  }
  if (d.filledTotal) {
    lines.push('补空明细:');
    for (const f of d.filled) lines.push(`  - ${f.section} / ${f.entry} · ${f.label}(${f.field}) = ${f.value || '（空）'}`);
    if (d.filledTotal > d.filled.length) lines.push(`  …共 ${d.filledTotal} 处`);
  }
  if (d.conflictsTotal) {
    lines.push('冲突明细（两边都有值且不同，已保留本地）:');
    for (const c of d.conflicts) lines.push(renderConflictLine(c));
    if (d.conflictsTotal > d.conflicts.length) lines.push(`  …共 ${d.conflictsTotal} 处`);
  }
  if ((d.structureAdded || []).length) {
    lines.push('结构补齐（只增）:');
    for (const s of d.structureAdded) {
      lines.push(`  - ${s.id}: +${s.fields.length} 个字段 [${s.fields.join(', ')}]`
        + (s.groups.length ? `，+分组 [${s.groups.join(', ')}]` : ''));
    }
  }
  if ((d.structureOnlyLocal || []).length) {
    lines.push('本地独有字段（备份里没有，已原样保留）:');
    for (const s of d.structureOnlyLocal) lines.push(`  - ${s.id}: [${s.fields.join(', ')}]`);
  }
  if ((d.kvMismatch || []).length) {
    lines.push(`kv 标记与备份不一致、未合并结构的栏目: ${d.kvMismatch.join(', ')}`);
  }
  if ((d.settingsFilled || []).length) lines.push(`设置补空: ${d.settingsFilled.join(', ')}`);
  if (d.exportsSkipped) lines.push(`备份里的导出历史 ${d.exportsSkipped} 条未并入（保留本机记录）`);
  const f = renderFilesStats(d.files);
  if (f) lines.push(f);
  if (d.resealed) lines.push(`用本机密钥库重新加密的密钥字段: ${d.resealed} 个`);
  lines.push(`备份生成于: ${d.backupCreatedAt || '未知'}`);
  lines.push(`导入前的当前数据已留安全快照: ${d.safetySnapshot}`);
  return lines.join('\n');
}
