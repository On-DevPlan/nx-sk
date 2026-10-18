// 附件库的前端读取：带缓存的列表，供字段编辑器等多处复用。
// 工作台导入/删除后调 refreshAttachments() 失效缓存。
import { api } from './client.js';

let pending = null;
let fetchedAt = 0;
// 缓存只为「同一屏多个字段同时挂载」服务，不该是永久快照：
// 数据可能被 CLI、另一个标签页或附件中心改掉（例如批量导入 SOP 截图）。
// 永久缓存会让字段按旧表渲染，图片明明在库里却显示「缺失」。
const TTL_MS = 1500;

export function listAttachments(force = false) {
  if (!force && pending && Date.now() - fetchedAt < TTL_MS) return pending;
  fetchedAt = Date.now();
  pending = api('/api/files')
    .then((d) => d)
    .catch((e) => { pending = null; throw e; });
  return pending;
}

export function refreshAttachments() {
  pending = null;
  return listAttachments(true);
}

/**
 * 把「刚上传的记录」并进已有列表：按 id 去重，新记录在前。
 *
 * 为什么必须有这一步：上传成功后调 `listAttachments()` 拿到的可能还是**挂载时那份缓存**，
 * 新文件的 id 不在里面；而预览是按 id 查表渲染的 —— 于是图已经在附件中心了，
 * 字段里却一直显示「图片缺失」。就地合并让预览不依赖列表刷新。
 */
export function mergeFiles(prev, fresh) {
  const list = Array.isArray(prev) ? prev : [];
  const add = (Array.isArray(fresh) ? fresh : []).filter(Boolean);
  if (!add.length) return list;
  const ids = new Set(add.map((f) => f.id));
  return [...add, ...list.filter((f) => !ids.has(f.id))];
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
