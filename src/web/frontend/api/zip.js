// 栏目 ZIP 的前端入口：导入走**原始二进制** body（不 JSON/base64）。
// 文件名用 x-file-name 头带过去，后端只用于展示，不参与路径。
export async function postZip(url, buffer, fileName) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(fileName || 'upload.zip') },
    body: buffer,
  });
  const json = await res.json().catch(() => { throw new Error(`HTTP ${res.status}`); });
  if (!json.ok) throw new Error(json.error || '导入失败');
  return json.data;
}

export const fmtBytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 简单校验：只接 zip，且不超过后端 64MB 原始 body 上限。 */
export function checkZipFile(file) {
  if (!file) return '没有选择文件';
  if (!/\.zip$/i.test(file.name)) return '只支持 .zip 文件';
  if (file.size > 64 * 1024 * 1024) return 'ZIP 超过 64MB，请改用 CLI 导入';
  return '';
}

// 加密信封的 magic（与 core/securezip.js 的 ENC_MAGIC 一致）。
// 前端只需要「是不是加密包」这一个判断：是的话先问口令，再送去预览。
const ENC_MAGIC = 'NXSKENC1';
const ENC_HEADER = ENC_MAGIC.length + 16 + 12 + 16;

/** 看头 8 字节判定加密包；数据不够长时按明文处理。 */
export function isEncryptedZip(buffer) {
  const b = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer?.buffer || buffer || []);
  if (b.length < ENC_HEADER) return false;
  for (let i = 0; i < ENC_MAGIC.length; i += 1) {
    if (b[i] !== ENC_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
