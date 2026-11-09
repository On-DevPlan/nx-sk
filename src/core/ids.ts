import { randomBytes } from 'node:crypto';

/** 短、可读、可排序的实体 id：`e_lx3k9f2a1b3c4d`。 */
export function newId(prefix: string, bytes = 4): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(bytes).toString('hex');
  return `${prefix}_${time}${rand}`;
}

/** 时间戳文件名：`20260924-144238`，本地时区，方便人读。 */
export function stamp(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
