// action 规格：校验 / 强转 / 路由编译 / 用法串。
//
// 为什么 flag 要随 action 声明、而不是用全局白名单：
// `entry update --mask x` 里 `--mask` 是布尔型（不取值），全局白名单猜不出来；
// 只有 action 自己知道。同理 `type:'number'` 让两端都得到数字，不必各写一遍 parseInt。
import { readFileSync } from 'node:fs';
import { APP_NAME } from '../core/paths.js';
import { badInput } from '../core/errors.js';
import { BOOL_FALSE, BOOL_TRUE } from '../core/fields.js';

export function cliPathsOf(action) {
  const c = action.cli;
  // `cli: []` 也要算「没有 CLI 命令」——否则会得到一个空路径，装载期自检形同虚设
  if (!c || !c.length) return [];
  return Array.isArray(c[0]) ? c : [c];
}

export function argSpecsOf(action) {
  return (action.args || []).map((a) => (typeof a === 'string'
    ? { name: a, required: true }
    : { name: a.name, required: a.required !== false }));
}

export function flagSpecsOf(action) {
  return Object.entries(action.flags || {}).map(([name, spec]) => ({ name, type: 'string', required: false, ...spec }));
}

/** 用法串：`nx-sk entry update <id> [--section <section>] [--mask]` */
export function usageOf(action) {
  const paths = cliPathsOf(action);
  const parts = [APP_NAME, ...(paths[0] || [action.id])];
  for (const a of argSpecsOf(action)) parts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
  for (const f of flagSpecsOf(action)) {
    if (f.type === 'boolean') { parts.push(f.required ? `--${f.name}` : `[--${f.name}]`); continue; }
    // 值的占位符优先用 enum 展开，其次显式 hint，最后才退回 flag 名——
    // `--side <side>` 这种读起来没有信息量
    const hint = f.enum ? f.enum.join('|') : f.hint || f.name;
    const token = `--${f.name} <${hint}>`;
    parts.push(f.required ? token : `[${token}]`);
  }
  return parts.join(' ');
}

function coerce(spec, value) {
  const type = spec.type || 'string';
  if (type === 'string') return String(value);
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) throw badInput(`--${spec.name} 需要数字，收到 ${JSON.stringify(value)}`);
    return n;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (BOOL_TRUE.includes(s)) return true;
    if (BOOL_FALSE.includes(s) || s === '') return false;
    throw badInput(`--${spec.name} 需要是/否，收到 ${JSON.stringify(value)}`);
  }
  if (type === 'array') {
    // **每个元素都要再按逗号切一次**：CLI 解析层会把 array 型 flag 收成数组
    // （`--tags a --tags b` → ['a','b']），若这里只看「是不是数组」就跳过切分，
    // `--tags a,b` 会变成**一个**叫 "a,b" 的元素 —— 文档写的「逗号分隔」形同虚设，
    // `--unset a,b` 更是直接报「没有字段: a,b」。
    const raw = Array.isArray(value) ? value : [value];
    const out = [];
    for (const v of raw) {
      for (const piece of String(v ?? '').split(',')) {
        const s = piece.trim();
        if (s !== '') out.push(s);
      }
    }
    return out;
  }
  if (type === 'json') {
    if (typeof value === 'object' && value !== null) return value;
    const s = String(value).trim();
    if (s.startsWith('@')) {
      // 命令行塞不下大 JSON 时用 `--data @file.json`——agent 的常用姿势
      return readFileTextSync(s.slice(1), spec.name);
    }
    try { return JSON.parse(s); } catch (e) { throw badInput(`--${spec.name} 不是合法 JSON: ${e.message}`); }
  }
  if (type === 'kv') {
    // CLI: `--set name=值`（可重复）；HTTP: `{set: {name: '值'}}` 或 `{set: ['name=值']}`
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
    const list = Array.isArray(value) ? value : [value];
    const out = {};
    for (const item of list) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq <= 0) throw badInput(`--${spec.name} 需要 key=value 形式，收到 ${JSON.stringify(item)}`);
      out[s.slice(0, eq).trim()] = s.slice(eq + 1);
    }
    return out;
  }
  return value;
}

// 同步读文件（`@file` 展开）。用 readFileSync 是因为 applySpec 在两端都是同步契约的一部分。
function readFileTextSync(p, flagName) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw badInput(`--${flagName} 读取文件失败: ${p}（${e.message}）`);
  }
}

/**
 * 把「两端拼出来的扁平对象」变成 ctx：只保留声明的键，做 required 校验与强转。
 * 严格过滤是有意的——HTTP body 里的多余字段不该悄悄流进 service。
 */
export function applySpec(action, raw = {}) {
  const usage = usageOf(action);
  const ctx = {};
  for (const a of argSpecsOf(action)) {
    const v = raw[a.name];
    if (v === undefined || v === null || v === '') {
      if (a.required) throw badInput(`用法: ${usage} —— 缺少参数 <${a.name}>`);
      continue;
    }
    ctx[a.name] = String(v);
  }
  for (const s of flagSpecsOf(action)) {
    const v = raw[s.name];
    if (v === undefined || v === null || v === '') {
      // ⚠️ 读命令的过滤 flag **不要声明 default**——参数层无条件注入默认值会让
      // 「不传 = 全部」的分支永远走不到（不报错、不崩，只是永远返回半个结果）
      if (s.default !== undefined) { ctx[s.name] = s.default; continue; }
      if (s.required) throw badInput(`用法: ${usage} —— 缺少参数 --${s.name}`);
      continue;
    }
    const coerced = coerce(s, v);
    if (s.enum && !s.enum.includes(coerced)) {
      throw badInput(`--${s.name} 只能是 ${s.enum.join(' / ')}，收到 ${JSON.stringify(coerced)}`);
    }
    ctx[s.name] = coerced;
  }
  return ctx;
}

export function compileRoute(http) {  const [method, path] = http;
  const segs = String(path).split('/').filter(Boolean);
  const keys = [];
  const parts = segs.map((s) => {
    if (s.startsWith(':')) { keys.push(s.slice(1)); return '([^/]+)'; }
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { method: String(method).toUpperCase(), path, segs, keys, regex: new RegExp(`^/${parts.join('/')}/?$`) };
}

/**
 * 路由按「字面量段优先」排序，让**声明顺序不影响匹配**。
 * 否则 `GET /api/sections/templates` 会被 `GET /api/sections/:id` 遮蔽，
 * 而命中哪条取决于 actions 数组的顺序——有人调整顺序就静默错乱。
 */
export function compareRoutes(a, b) {
  const n = Math.max(a.segs.length, b.segs.length);
  for (let i = 0; i < n; i++) {
    const x = a.segs[i];
    const y = b.segs[i];
    if (x === undefined) return 1; // 段数少的排后面（更笼统）
    if (y === undefined) return -1;
    const xp = x.startsWith(':') ? 1 : 0;
    const yp = y.startsWith(':') ? 1 : 0;
    if (xp !== yp) return xp - yp; // 字面量优先
  }
  return 0;
}
