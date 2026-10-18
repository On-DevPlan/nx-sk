// 极简 ZIP 读写（store / deflate），零依赖。
//
// 为什么自己写：nx-sk 的运行时**不装任何 npm 包**（镜像、离线、审计都靠这一点）。
// 这里只需要「打一个包 / 解一个包」：条目上限 2000、单文件上限 100MB，
// 足够栏目导出（JSON + 截图 + PDF）。不支持 Zip64 / 加密 —— 遇到就报清晰的错，
// 而不是解出半个包。
//
// 写：默认 store（不压缩）。图片/PDF 本来就是压缩格式，再 deflate 省不了多少，
// 反而让「用系统工具打开 zip 排查」变复杂。`compress: true` 时才 deflate 文本。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;

const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/** DOS 时间戳：ZIP 只存到 2 秒精度；用导出时刻，方便按时间排序。 */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * zip 内路径必须**相对且干净**：绝对路径、盘符、`..` 段一律拒绝。
 * 这不是洁癖——导入时我们会按这个路径写文件，放过去就是任意文件写入。
 */
export function assertSafeZipName(name) {
  const n = String(name ?? '');
  if (!n || n.includes('\0')) throw new Error('ZIP 条目名为空或含非法字符');
  if (n.startsWith('/') || n.startsWith('\\') || /^[A-Za-z]:/.test(n)) {
    throw new Error(`ZIP 条目不能是绝对路径: ${n}`);
  }
  const parts = n.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..')) throw new Error(`ZIP 条目不能包含 ..: ${n}`);
  return n;
}

/**
 * 生成 ZIP。
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{compress?: boolean, mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function createZip(entries, { compress = false, mtime = new Date() } = {}) {
  const list = (entries || []).map((e) => {
    const name = assertSafeZipName(e.name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const body = compress ? deflateRawSync(data) : data;
    return { name, nameBuf: Buffer.from(name, 'utf8'), data, body, method: compress ? 8 : 0, crc: crc32(data) };
  });
  if (list.length > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${list.length} > ${MAX_ENTRIES}）`);

  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of list) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(e.nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, e.nameBuf, e.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(e.nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, e.nameBuf);

    offset += local.length + e.nameBuf.length + e.body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 解 ZIP，返回 `[{ name, data }]`（目录条目不返回）。
 * 只支持 store / deflate；加密、Zip64、超大包都明确报错。
 */
export function readZip(buf, { maxEntries = MAX_ENTRIES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 22) throw new Error('不是有效的 ZIP：文件太小');

  // EOCD 可能被注释顶到后面；从尾部往前找，最多 64KB 注释
  const min = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i -= 1) {
    if (b.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到目录结尾（EOCD）');

  const total = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOff = b.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw new Error('暂不支持 Zip64（条目或体积超过 4GB）');
  if (total > maxEntries) throw new Error(`ZIP 条目过多（${total} > ${maxEntries}）`);
  if (cdOff + cdSize > b.length) throw new Error('ZIP 目录区越界：文件可能被截断');

  const out = [];
  let totalBytes = 0;
  let p = cdOff;

  for (let i = 0; i < total; i += 1) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP 目录项损坏');
    const flags = b.readUInt16LE(p + 8);
    if (flags & 0x1) throw new Error('ZIP 已加密，暂不支持');
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const compSize = b.readUInt32LE(p + 20);
    const uncompSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOff = b.readUInt32LE(p + 42);
    if (p + 46 + nameLen > b.length) throw new Error('ZIP 目录项越界');

    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录条目

    const safe = assertSafeZipName(name);
    if (uncompSize > MAX_FILE_BYTES) throw new Error(`ZIP 内单文件过大: ${safe}（${uncompSize} 字节）`);
    totalBytes += uncompSize;
    if (totalBytes > maxTotalBytes) throw new Error('ZIP 解压后总体积过大');

    if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`ZIP 条目头损坏: ${safe}`);
    const lNameLen = b.readUInt16LE(localOff + 26);
    const lExtraLen = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > b.length) throw new Error(`ZIP 条目被截断: ${safe}`);

    const raw = b.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}: ${safe}`);
    if (data.length !== uncompSize) throw new Error(`ZIP 条目长度不符: ${safe}`);
    if (crc32(data) !== crc) throw new Error(`ZIP 条目校验失败（CRC 不符）: ${safe}`);

    out.push({ name: safe, data });
  }
  return out;
}
