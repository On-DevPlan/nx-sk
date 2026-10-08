// 加密备份 / 恢复：整份数据用「口令派生密钥 + AES-256-GCM」对称加密。
//
// 导出：用户设置口令 → 随机盐写进备份文件，密钥由 scrypt(口令, 盐) 派生（口令不落盘）。
// 导入：用户输入口令 → 用文件里的盐派生同一把密钥解密；口令错误 GCM 校验失败、明确报错。
//
// 复用 core/crypto.js 的原语（deriveKey / encryptValue / decryptValue），
// 与字段级密钥库（core/vault.js）相互独立：备份口令是一次性的，不写进 vault。
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { displayPath, snapshotDir } from '../../core/paths.js';
import { ensureDir, fileSize, pathExists, writeAtomic } from '../../core/fsx.js';
import { loadStore, saveStore, snapshotStore } from '../../core/store.js';
import { deriveKey, encryptValue, decryptValue } from '../../core/crypto.js';
import { badInput, blocked } from '../../core/errors.js';
import { nowIso, stamp } from '../../core/ids.js';

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

/** 生成加密备份：返回归档对象（HTTP 端据此让浏览器下载）与条目计数。 */
export async function buildBackup(ctx) {
  const password = passwordFrom(ctx);
  const store = await loadStore();
  const payload = {
    version: store.version,
    settings: store.settings,
    sections: store.sections,
    entries: store.entries,
    exports: store.exports,
  };

  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  const data = encryptValue(key, JSON.stringify(payload));
  const archive = {
    app: 'nx-sk',
    kind: BACKUP_KIND,
    v: BACKUP_VERSION,
    createdAt: nowIso(),
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    data,
  };
  const counts = { sections: store.sections.length, entries: store.entries.length };
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

/** 用口令解密归档文本 → 备份时的 store 负载。口令错误在此抛 BLOCKED。 */
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
  return { payload, createdAt: archive.createdAt };
}

/** 恢复：解密 → 先给当前数据留安全快照 → 整份替换（写入会过 normalize 迁移到当前版本）。 */
export async function restoreBackup({ content, password, 'dry-run': dryRun }) {
  const { payload, createdAt } = decryptBackup(String(content ?? ''), password);

  if (dryRun) {
    return {
      status: 'dry-run', dryRun: true,
      backupCreatedAt: createdAt || '',
      sections: payload.sections.length,
      entries: payload.entries.length,
    };
  }

  // 覆盖前留一份可回滚快照（落到 backup/ 目录），避免误操作丢数据
  const safety = await snapshotStore('before-restore');

  await saveStore({
    version: payload.version,
    settings: payload.settings,
    sections: payload.sections,
    entries: payload.entries,
    exports: Array.isArray(payload.exports) ? payload.exports : [],
  });

  return {
    status: 'restored',
    backupCreatedAt: createdAt || '',
    sections: payload.sections.length,
    entries: payload.entries.length,
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
    return `试运行（未写盘、未下载）\n将加密备份: ${d.sections} 个栏目 / ${d.entries} 条条目（AES-256-GCM）`;
  }
  return [
    `已生成加密备份（AES-256-GCM，口令派生密钥、口令不落盘）`,
    `文件: ${d.file}　${d.bytes} 字节`,
    `内容: ${d.sections} 个栏目 / ${d.entries} 条条目`,
    `恢复时需要输入本次设置的口令。`,
  ].join('\n');
}

export function renderRestore(d) {
  if (d.status === 'dry-run') {
    return `试运行（未改动当前数据）\n备份可正常解密: ${d.sections} 个栏目 / ${d.entries} 条条目，生成于 ${d.backupCreatedAt || '未知'}`;
  }
  return [
    `已从加密备份恢复：${d.sections} 个栏目 / ${d.entries} 条条目`,
    `备份生成于: ${d.backupCreatedAt || '未知'}`,
    `恢复前的当前数据已留安全快照: ${d.safetySnapshot}`,
  ].join('\n');
}
