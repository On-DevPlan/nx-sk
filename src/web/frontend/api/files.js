// 附件库的前端读取：带缓存的列表，供字段编辑器等多处复用。
// 工作台导入/删除后调 refreshAttachments() 失效缓存。
import { api } from './client.js';

let pending = null;

export function listAttachments(force = false) {
  if (!force && pending) return pending;
  pending = api('/api/files')
    .then((d) => d)
    .catch((e) => { pending = null; throw e; });
  return pending;
}

export function refreshAttachments() {
  pending = null;
  return listAttachments(true);
}

/** 读取 File 对象为 base64（data URL）。 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
