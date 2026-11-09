const DEFAULT_TIMEOUT_MS = 30000;

/** `api()` 的可选参数（调用方只用到这三个）。 */
export interface ApiOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** 后端错误里带业务码（`AppError.code`），调用方据此区分冲突与参数错误。 */
export interface ApiError extends Error {
  code?: string;
}

/**
 * 统一的后端调用入口。
 *
 * 返回类型默认 `any`：这是**唯一的外部数据边界**——响应形状由后端决定，
 * 面板各处在取值时就地收窄（类型来源见 `shared/model.ts`），
 * 在这里逐端点声明一遍只会变成第二个漂移点。
 */
export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => { throw new Error(`HTTP ${res.status}`); });
    if (!json.ok) {
      const err = new Error(json.error || '请求失败') as ApiError;
      err.code = json.code; // 调用方可据此区分冲突与参数错误
      throw err;
    }
    return json.data;
  } catch (e) {
    if (e && (e as Error).name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
