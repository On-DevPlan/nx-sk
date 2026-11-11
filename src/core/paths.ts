// 路径与安全校验的**唯一定义处**。别在别处再拼一次 home 路径。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badInput } from './errors.ts';

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const ASSETS_DIR = join(PROJECT_ROOT, 'assets');
// 判据是**相对 import.meta.url 的深度**，不是写死 PROJECT_ROOT/src：
// src/core/paths.ts → src/web/public；dist/core/paths.js → dist/web/public。
// 两种布局（源码直跑 / 发布产物）各走各的，serve 不用知道自己在哪一种里。
export const PUBLIC_DIR = resolve(fileURLToPath(new URL('../web/public/', import.meta.url)));

interface PackageJson {
  name: string;
  version: string;
  nxSk?: { port?: number; vitePort?: number };
}

const pkg: PackageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
export const APP_NAME = pkg.name; // 'nx-sk'
export const APP_LABEL = 'nx-sk · 个人资源管理器';
export const VERSION = pkg.version;
export const SKILL_NAME = APP_NAME;

// 端口只有一个来源：package.json 的 nxSk.port。服务端与 vite 代理都从这里取——
// 散成字面量的话改一次就会漏一处，而漏掉 vite 代理的表现是「dev 模式下 /api 全 404」，
// 很难和「端口」联系起来。
export const DEFAULT_PORT = Number(pkg.nxSk?.port ?? 7866);
export const DEV_VITE_PORT = Number(pkg.nxSk?.vitePort ?? 5180);

/**
 * 数据根目录：`~/nx-sk/`
 *
 * 骨架 ref [[05-state-storage]] 的默认是 `~/.<主题名>/`（隐藏目录）。
 * 本项目按用户明确要求改成 `~/nx-sk/`——一眼能找到、能手动改、能整体拷走，
 * 这对「本地绝对安全 + 支持整体导出」的诉求更重要。
 *
 * 环境变量覆盖**不是可选项**：没有它，测试会写脏用户的真实数据。
 */
export const ENV_HOME = 'NX_SK_HOME';
export const ENV_STORE = 'NX_SK_STORE';
export const ENV_STORE_DB = 'NX_SK_STORE_DB';
export const ENV_PASSPHRASE = 'NX_SK_PASSPHRASE';

const DEFAULT_HOME = join(homedir(), APP_NAME);

export function appHome(): string {
  const fromEnv = process.env[ENV_HOME];
  return fromEnv ? resolve(fromEnv) : DEFAULT_HOME;
}

/**
 * SQLite 主库路径：`~/nx-sk/nxsk.db`（`NX_SK_STORE_DB` 覆盖）。
 *
 * 0.36 起存储从 store.json 换成 SQLite，这里就是**唯一真相**的落点。
 * 环境变量覆盖不是可选项：没有它，测试会写脏用户的真实库。
 */
export function dbFile(): string {
  const fromEnv = process.env[ENV_STORE_DB];
  return fromEnv ? resolve(fromEnv) : join(appHome(), 'nxsk.db');
}

/**
 * 旧版 store.json 的路径（`NX_SK_STORE` 覆盖）。
 * 现在只作为**首启导入的来源**：导入成功后改名留证 `store.json.imported-<ts>`，
 * 运行时不再读写它。
 */
export function storeFile(): string {
  const fromEnv = process.env[ENV_STORE];
  return fromEnv ? resolve(fromEnv) : join(appHome(), 'store.json');
}

export function exportDir(): string {
  return join(appHome(), 'export');
}

/** 附件统一存储目录：`~/nx-sk/files/`（简历、头像、成绩单等二进制原件都落在这里）。 */
export function filesDir(): string {
  return join(appHome(), 'files');
}

/** 迁移时的原始文件副本目录。**不是备份目录**——本地备份功能已移除，
 *  这里只保留「store 版本升级前留一份原始文件」那一次性动作。 */
export function migrationDir(): string {
  return join(appHome(), 'migrate');
}

export function vaultKeyFile(): string {
  return join(appHome(), '.vaultkey');
}

export function vaultSaltFile(): string {
  return join(appHome(), '.vaultsalt');
}

/** 把用户给的相对路径挂到 base 下，并保证结果仍在 base 内（拒绝 `..` 越界）。 */
export function resolveInside(base: string, rel: string): string {
  const baseAbs = resolve(base);
  const target = resolve(baseAbs, rel);
  if (target !== baseAbs && !target.startsWith(baseAbs + sep)) {
    throw badInput(`路径越界: ${rel}`);
  }
  return target;
}

export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/** 统一的展示用路径：正斜杠、home 前缀缩写成 `~/`。不参与任何文件操作。 */
export function displayPath(p: string): string {
  if (!p) return '';
  const posix = String(p).split(sep).join('/');
  const home = homedir().split(sep).join('/');
  return posix.startsWith(home + '/') ? '~' + posix.slice(home.length) : posix;
}

// —— 名称/ID 校验 ——
// 名称与路径**分开校验**：用「目录名」的规则去卡文件路径会误伤 `.gitignore` 这类正常文件。

/** section id：小写字母开头，只允许 [a-z0-9_-]，最长 64。 */
export function assertSafeId(id: unknown, what = 'id'): string {
  const s = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(s)) {
    throw badInput(`${what} 非法: ${JSON.stringify(id)}（小写字母开头，仅含 a-z 0-9 _ -，最长 64）`);
  }
  return s;
}

/** skill 名等：单段名称，不含路径分隔符、不是绝对路径、不含 `..`。 */
export function assertSafeName(name: unknown, what = '名称'): string {
  const s = String(name ?? '').trim();
  if (!s) throw badInput(`${what}不能为空`);
  if (isAbsolute(s) || s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`${what} 非法: ${JSON.stringify(name)}（不允许路径分隔符或 '..'）`);
  }
  if (!/^[\w.@-]{1,64}$/.test(s)) {
    throw badInput(`${what} 非法: ${JSON.stringify(name)}（仅允许字母数字与 . _ @ -，最长 64）`);
  }
  return s;
}

/**
 * 字段 key。**允许中文**——字典是「已用字段的台账」，用户敲什么键就该存什么键
 * （`--set 微信号=xxx` 之后 `values` 里就是 `微信号`，不用记一个英文别名）。
 * 仍然挡掉空白、路径分隔符与 `..`：那些会让 CLI 与 URL 变难用。
 */
export function assertFieldKey(key: unknown): string {
  const s = String(key ?? '').trim();
  if (!s) throw badInput('字段 key 不能为空');
  if (s.length > 48) throw badInput(`字段 key 过长（${s.length} > 48）: ${s}`);
  if (/[\s/\\]/.test(s) || s.includes('..')) {
    throw badInput(`字段 key 非法: ${JSON.stringify(key)}（不允许空白、路径分隔符或 '..'；中文可以）`);
  }
  return s;
}

/** 归一化跨平台相对路径，用于目录树比对。 */
export function toPosix(p: string): string {
  return String(p).split(sep).join('/');
}

/** 相对 base 的 posix 路径，越界返回 null。 */
export function relPosix(base: string, target: string): string | null {
  const r = relative(resolve(base), resolve(target));
  if (!r || r.startsWith('..') || isAbsolute(r)) return null;
  return toPosix(r);
}

export { normalize as normalizePath };
