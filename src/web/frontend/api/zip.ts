// 栏目 ZIP 的前端入口：导入走**原始二进制** body（不 JSON/base64）。
// 文件名用 x-file-name 头带过去，后端只用于展示，不参与路径。
export async function postZip<T = any>(url: string, buffer: Blob | ArrayBuffer, fileName: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(fileName || 'upload.zip') },
    body: buffer,
  });
  const json = await res.json().catch(() => { throw new Error(`HTTP ${res.status}`); });
  if (!json.ok) throw new Error(json.error || '导入失败');
  return json.data;
}

export const fmtBytes = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 简单校验：只接 zip，且不超过后端 64MB 原始 body 上限。 */
export function checkZipFile(file: File | null | undefined): string {
  if (!file) return '没有选择文件';
  if (!/\.zip$/i.test(file.name)) return '只支持 .zip 文件';
  if (file.size > 64 * 1024 * 1024) return 'ZIP 超过 64MB，请改用 CLI 导入';
  return '';
}

/**
 * 这个错误是不是「包已加密、还缺口令」。
 *
 * 加密包的判定放在**服务端**（看 ZIP 里有没有 payload.enc），前端不解析 ZIP ——
 * 少一份 zip 解析代码，也不会因为格式演进而两边不一致。流程因此是：
 * 先按明文试一次预览，服务端说缺口令，再问用户要口令重试。
 */
export function isNeedPassphraseError(err: unknown): boolean {
  const msg = String((err && (err as Error).message) || err || '');
  return /已加密|口令/.test(msg);
}
