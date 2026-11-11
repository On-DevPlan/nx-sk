// 面板端口档案（portfile）与「CLI 找面板」的唯一实现（任务 #22）。
//
// 要根治的问题：Windows 上第二个进程打开 SQLite 与运行中的 serve 冲突
// （残留 mmap / disk I/O error 类故障）。serve 顺延过端口（7866 被占→7867…）后，
// CLI 只探默认端口会误判「面板不在跑」而退回直连开库——所以 serve 把
// **真实端口**记进 `<home>/serve.json`，CLI 先读档案、校验 pid 存活，再探默认端口。
//
// 认领判据比 serve-port.ts 的「app 名相同」更严一层：**app 名 + storePathRaw 都相等**
// 才算「那是我的面板」。多面板并存（live 一个 + 走查/冒烟临时 home 一个）时，
// 这条判据保证 CLI 只代理到**同一个库**的面板——`--store` / 环境变量换库自然落空，
// 落空就走直跑，与改动前行为完全一致。
//
// 注意：本文件不与 core/serve-port.ts 合并——那份在所有 nx-xx 项目间逐字节相同，
// 带项目语义的端口档案只能放这里。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, DEFAULT_PORT, appHome } from './paths.ts';
import { storePathInUse } from './store.ts';
import { probePanel } from './serve-port.ts';

/** portfile 的形状：面板真实端口 + 面板进程 pid（reuse 场景拿不到 pid 时为 null）。 */
export interface PanelPortfile {
  port: number;
  pid: number | null;
}

export function panelPortfilePath(): string {
  return join(appHome(), 'serve.json');
}

/** serve 启动成功后写端口档案；写失败不致命（CLI 还有默认端口探测兜底）。 */
export function writePanelPortfile(port: number, pid: number | null): void {
  try {
    writeFileSync(panelPortfilePath(), JSON.stringify({ port, pid, at: Date.now() }) + '\n');
  } catch { /* 只读目录等极端情况：探测兜底仍工作 */ }
}

/** serve 退出时清档案；**只清自己写的**（pid 不是自己就不动，防误删另一个实例的档案）。 */
export function clearPanelPortfile(): void {
  try {
    const f = readPanelPortfile();
    if (!f || f.pid === null || f.pid === process.pid) {
      if (existsSync(panelPortfilePath())) unlinkSync(panelPortfilePath());
    }
  } catch { /* 尽力而为 */ }
}

export function readPanelPortfile(): PanelPortfile | null {
  try {
    const j = JSON.parse(readFileSync(panelPortfilePath(), 'utf8'));
    if (!j || typeof j.port !== 'number' || j.port <= 0) return null;
    if (j.pid !== null && j.pid !== undefined && (typeof j.pid !== 'number' || j.pid <= 0)) return null;
    return { port: j.port, pid: typeof j.pid === 'number' && j.pid > 0 ? j.pid : null };
  } catch {
    return null;
  }
}

/** 进程是否还活着（kill 0 只探测不发信号；EPERM 也算活着——那是权限问题不是没进程）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 探测返回体里我们关心的认领字段（bootstrap 的真实形状，比 serve-port 的最小类型宽）。 */
interface PanelClaim {
  app?: { name?: string };
  storePathRaw?: string;
}

async function claimPanel(port: number): Promise<boolean> {
  const data = await probePanel(port) as PanelClaim | null;
  if (!data || data.app?.name !== APP_NAME) return false;
  // 面板必须报出自己的库路径且与**本 CLI 当前要用的库**一致，才认「那是我的面板」。
  // 报不出路径（老面板）一律不认——宁可直跑，不可代理到别的库。
  return typeof data.storePathRaw === 'string' && data.storePathRaw === storePathInUse();
}

/**
 * 找一个「可以代理执行」的面板端口：
 *   1. portfile 在且 pid 活着（或档案没记 pid）→ 探那个端口；
 *   2. 否则探默认端口 7866。
 * 探不到返回 null（调用方直跑，行为与 #22 之前完全相同）。
 */
export async function discoverPanelPort(): Promise<number | null> {
  const f = readPanelPortfile();
  if (f && (f.pid === null || isPidAlive(f.pid))) {
    if (await claimPanel(f.port)) return f.port;
  }
  if (f && f.port === DEFAULT_PORT) return null; // 档案已探过，默认端口就是它，不重复探
  if (await claimPanel(DEFAULT_PORT)) return DEFAULT_PORT;
  return null;
}
