// CLI 代理执行（任务 #22）：面板存活时把 action 打到 serve 的 `POST /api/cli`，
// 本进程完全不碰 SQLite 库文件——根治 Windows 上第二进程开库与运行中 serve 的冲突
// （残留 mmap / disk I/O error 类故障）。
//
// 三条纪律：
//   - **失败不回退直连**：面板活着但代理请求失败/超时 → 报错（带端口与 action id）。
//     静默回退直连等于把要消灭的撞库行为藏进重试里。逃生口是显式 `--direct`。
//   - **ctx 在本地 applySpec 之后原样转发**：参数/用法类错误在本地就报出来，
//     文案与直跑逐字一致；服务端二次 applySpec 对已归一的值是幂等的
//     （string/number/boolean 原样，kv 对象展开，array 按逗号再切一次也不变）。
//   - **binaryBody 上传以 base64 随 JSON 走**：读不到本地文件时**不塞 bodyB64**，
//     让 service 在面板侧给出与直跑完全一致的「文件不存在」文案。
import { readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { AppError, external } from '../core/errors.ts';
import type { Action, Ctx } from './spec.ts';

/** 代理请求的应答窗口：本地环回 + 本地计算，60s 用不完；真用不完说明面板卡死，报错比干等诚实。 */
export const PROXY_TIMEOUT_MS = 60_000;

/** 走查/冒烟用的观测开关：设真值时 CLI 在 stderr 打一行「经面板代理」，正常输出不受影响。 */
export const PROXY_DEBUG_ENV = 'NX_SK_CLI_PROXY_DEBUG';

/**
 * 代理执行一个 action，返回与 `action.run` 直跑**同形状**的 data。
 * 错误以 AppError 抛出（code/message 与面板返回一致），由 runCli 的统一 catch 出口渲染。
 */
export async function proxyRun(action: Action, ctx: Ctx, port: number): Promise<unknown> {
  const body: Record<string, unknown> = { actionId: action.id, ctx };
  if (action.binaryBody && typeof ctx.file === 'string' && ctx.file) {
    try {
      const buf = readFileSync(resolvePath(ctx.file));
      body.bodyB64 = buf.toString('base64');
      body.fileName = basename(ctx.file);
    } catch { /* 读不到就原样代理：service 的错误文案与直跑一致 */ }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const why = (e as Error)?.name === 'AbortError' ? `应答超时（${Math.round(PROXY_TIMEOUT_MS / 1000)}s）` : ((e as Error)?.message || String(e));
    throw external(`面板代理失败（:${port} · ${action.id}）：${why}。面板在跑时 CLI 不回退直连开库；确需直跑加 --direct`);
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: string; code?: string } | null;
  if (!json || typeof json.ok !== 'boolean') {
    throw external(`面板代理响应异常（:${port} · ${action.id} · HTTP ${res.status}）`);
  }
  if (!json.ok) throw new AppError(json.code || 'INTERNAL', json.error || '面板执行失败');
  return json.data;
}
