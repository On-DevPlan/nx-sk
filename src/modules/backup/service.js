// 加密备份 / 恢复：整份数据用「口令派生密钥 + AES-256-GCM」对称加密。
//
// 导出：用户设置口令 → 随机盐写进备份文件，密钥由 scrypt(口令, 盐) 派生（口令不落盘）。
// 导入：用户输入口令 → 用文件里的盐派生同一把密钥解密；口令错误 GCM 校验失败、明确报错。
//
// 复用 core/crypto.js 的原语（deriveKey / encryptValue / decryptValue），
// 与字段级密钥库（core/vault.js）相互独立：备份口令是一次性的，不写进 vault。
//
// 跨机器恢复：store.json 里凭据原本是「本机 vault key（AES-256-GCM + kid）」加密的，
// 备份打包会把这份密文**再裹一层**——用备份口令派生 key 重加密一份副本，写进
// `reWrapped`。导入时先解开 reWrapped 拿明文，再用**目标机器**的 vault key 重新加密，
// 写回主字段、丢掉 reWrapped。这样：
//   - 备份包在 A 机器上能独立解开（不依赖 A 的 ~/.vaultkey / NX_SK_PASSPHRASE）
//   - 导入 B 机器后，凭据绑的是 B 的本地密钥，跟其他密文一样走 decryptValue
//   - 没有「reWrapped 的密文只能输口令解」的尾巴——一次导入就兑回本机
// 没有 reWrapped 的密文（早期版本/未带口令的导出）依然走 kid 校验；换机会得到明确 BLOCKED。
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { displayPath, snapshotDir } from '../../core/paths.js';
import { ensureDir, fileSize, pathExists, writeAtomic } from '../../core/fsx.js';
import { loadStore, saveStore, snapshotStore } from '../../core/store.js';
import { decryptValue, deriveKey, encryptValue, isCipherBlob } from '../../core/crypto.js';
import { badInput, blocked } from '../../core/errors.js';
import { nowIso, stamp } from '../../core/ids.js';
import { isSensitiveField } from '../../core/fields.js';
import { resolveVaultKey } from '../../core/vault.js';

export const BACKUP_KIND = 'encrypted-backup';
export const BACKUP_VERSION = 1;
export const ENV_BACKUP_PASSWORD = 'NX_SK_BACKUP_PASSWORD';
const EXT = '.nxskbak';

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
 * 给 payload 里的每条密文字段加一层「口令派生的重加密」。
 *
 * 输入是 buildBackup 准备好的 store payload；输出是**新对象**，原对象不变。
 * 已带 reWrapped 的不再二次包——避免循环。
 */
async function reWrapSecretsInPlace(payload, password, salt) {
  const sections = payload.sections || [];
  const entries = payload.entries || [];
  const transportKey = deriveKey(password, salt);
  const { key: vaultKey } = await resolveVaultKey();

  const newEntries = [];
  let reWrapped = 0;
  for (const e of entries) {
    const sec = sections.find((s) => s.id === e.section);
    if (!sec || !e.values) { newEntries.push(e); continue; }
    const nextValues = { ...e.values };
    let touched = false;
    for (const def of sec.fields || []) {
      if (!isSensitiveField(sec, def.key)) continue;
      const v = nextValues[def.key];
      if (!isCipherBlob(v) || v.reWrapped) continue;
      // 用本机 vault key 解开 → 用口令派生 key 重加密 → 挂到 reWrapped 上。
      // 原来的密文保留——A 机用原 vaultKey 仍能解（不动既有逻辑）。
      const plain = decryptValue(vaultKey, v);
      nextValues[def.key] = { ...v, reWrapped: encryptValue(transportKey, plain) };
      touched = true; reWrapped++;
    }
    newEntries.push(touched ? { ...e, values: nextValues } : e);
  }
  return { ...payload, entries: newEntries, _reWrapped: reWrapped };
}

/**
 * 反向：把 reWrapped 副本兑回本机 vault key。
 * 拿不到口令（密码错）会抛 BLOCKED；拿到口令则静默完成，用户不感知。
 */
async function unwrapSecretsToLocal(payload, password, salt) {
  const sections = payload.sections || [];
  const entries = payload.entries || [];
  const transportKey = deriveKey(password, salt);
  const { key: vaultKey } = await resolveVaultKey();

  const newEntries = [];
  let unwrapped = 0;
  for (const e of entries) {
    const sec = sections.find((s) => s.id === e.section);
    if (!sec || !e.values) { newEntries.push(e); continue; }
    const nextValues = { ...e.values };
    let touched = false;
    for (const def of sec.fields || []) {
      if (!isSensitiveField(sec, def.key)) continue;
      const v = nextValues[def.key];
      if (!isCipherBlob(v) || !v.reWrapped) continue;
      const plain = decryptValue(transportKey, v.reWrapped);
      // tenant 用来保留 A 机原 blob 的非密文字段（如 v/alg）但**不能**包含 iv/ct/tag/kid——
      // 这些必须来自新的 encryptValue（用本机 vaultKey 生成的）。否则 spread 后会把
      // 新的 iv/ct/tag 覆盖回 A 机的旧值，写进 store.json 的密文就解不开了。
      const { reWrapped: _rw, iv: _oldIv, ct: _oldCt, tag: _oldTag, kid: _oldKid, ...tenant } = v;
      void _rw; void _oldIv; void _oldCt; void _oldTag; void _oldKid;
      nextValues[def.key] = { ...encryptValue(vaultKey, plain), ...tenant };
      touched = true; unwrapped++;
    }
    newEntries.push(touched ? { ...e, values: nextValues } : e);
  }
  return { ...payload, entries: newEntries, _reWrapped: unwrapped };
}

/** 生成加密备份：返回归档对象（HTTP 端据此让浏览器下载）与条目计数。 */
export async function buildBackup(ctx) {
  const password = passwordFrom(ctx);
  const store = await loadStore();
  const raw = {
    version: store.version,
    settings: store.settings,
    sections: store.sections,
    entries: store.entries,
    exports: store.exports,
  };

  const salt = randomBytes(16);
  const wrapKey = deriveKey(password, salt);
  const payload = await reWrapSecretsInPlace(raw, password, salt);
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
    reWrapped: payload._reWrapped || 0,
  };
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
  if (archive.v !== BACKUP_VERSION) {
    throw badInput(`备份文件版本不受支持: v${archive.v}`);
  }
  return archive;
}

/** 用口令解密归档文本 → 备份时的 store 负载 + archive（带 salt）。口令错误在此抛 BLOCKED。 */
export function decryptBackup(text, password) {
  const archive = parseArchive(text);
  if (!String(password ?? '')) throw badInput('请输入备份时设置的口令。');
  let payload;
  try {
    const key = deriveKey(password, archive.salt);
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
  return { payload, createdAt: archive.createdAt, salt: archive.salt };
}

/** 恢复：解密 → 把 reWrapped 兑回本机 vault key → 留安全快照 → 整份替换。 */
export async function restoreBackup({ content, password, 'dry-run': dryRun }) {
  const { payload, createdAt, salt } = decryptBackup(String(content ?? ''), password);

  if (dryRun) {
    return {
      status: 'dry-run', dryRun: true,
      backupCreatedAt: createdAt || '',
      sections: payload.sections.length,
      entries: payload.entries.length,
      reWrapped: payload._reWrapped || 0,
    };
  }

  // 把 reWrapped 兑回本机 vault key：解口令派生密文 → 用本机 vaultKey 重加密。
  // 失败（口令对但 reWrapped 损坏）会被 unwrapSecretsToLocal 抛 BLOCKED。
  const unwrapped = await unwrapSecretsToLocal(payload, password, salt);

  // 覆盖前留一份可回滚快照（落到 backup/ 目录），避免误操作丢数据
  const safety = await snapshotStore('before-restore');

  await saveStore({
    version: unwrapped.version,
    settings: unwrapped.settings,
    sections: unwrapped.sections,
    entries: unwrapped.entries,
    exports: Array.isArray(unwrapped.exports) ? unwrapped.exports : [],
  });

  return {
    status: 'restored',
    backupCreatedAt: createdAt || '',
    sections: unwrapped.sections.length,
    entries: unwrapped.entries.length,
    reWrapped: unwrapped._reWrapped || 0,
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
    'dry-run': ctx['dry-run'],
  });
}

export function renderBackup(d) {
  if (d.status === 'skipped') {
    return `试运行（未写盘、未下载）\n将加密备份: ${d.sections} 个栏目 / ${d.entries} 条条目（AES-256-GCM）`
      + (d.reWrapped ? `\n携带口令派生重加密的密文字段: ${d.reWrapped} 个（其他机器用本次口令可解开）` : '');
  }
  return [
    `已生成加密备份（AES-256-GCM，口令派生密钥、口令不落盘）`,
    `文件: ${d.file}　${d.bytes} 字节`,
    `内容: ${d.sections} 个栏目 / ${d.entries} 条条目`,
    `携带口令派生重加密的密文字段: ${d.reWrapped || 0} 个（其他机器用本次口令可解开）`,
    `恢复时需要输入本次设置的口令。`,
  ].join('\n');
}

export function renderRestore(d) {
  if (d.status === 'dry-run') {
    return `试运行（未改动当前数据）\n备份可正常解密: ${d.sections} 个栏目 / ${d.entries} 条条目`
      + `，含口令派生重加密的密文字段 ${d.reWrapped || 0} 个，生成于 ${d.backupCreatedAt || '未知'}`;
  }
  return [
    `已从加密备份恢复：${d.sections} 个栏目 / ${d.entries} 条条目`,
    `兑回本机密钥库的密文字段: ${d.reWrapped || 0} 个`,
    `备份生成于: ${d.backupCreatedAt || '未知'}`,
    `恢复前的当前数据已留安全快照: ${d.safetySnapshot}`,
  ].join('\n');
}
