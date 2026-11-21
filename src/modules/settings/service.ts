// settings 是**基础模块**：允许被其它模块单向只读依赖（见 eslint 互依禁列——它故意不在里面）。
// 设置的唯一读写入口在这里，别绕过去直接改 store.settings。
import { loadStore, mutateStore, pruneHistoryNow } from '../../core/store.ts';
import type { Store, StoreSettings } from '../../core/store.ts';
import { findTemplate } from '../../core/fields.ts';
import { badInput, notFound } from '../../core/errors.ts';
import { dbFile, displayPath } from '../../core/paths.ts';

export const SETTING_KEYS = ['defaultTemplate', 'navGroups', 'navHidden', 'navOrder', 'autoSaveFields', 'historyMode', 'historyCount', 'historyDays'];

interface SettingSchemaItem {
  type: string;
  hint: string;
  coerce?: (value: unknown, store: Store) => unknown;
  listed?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
}

const SCHEMA: Record<string, SettingSchemaItem> = {
  defaultTemplate: {
    type: 'string',
    hint: '打开面板时落地的条目模板 id（空 = 第一个条目模板；地址里带 #/条目模板 时以地址为准）',
    coerce: coerceDefaultTemplate,
    // 标量项，但带校验器 —— 渲染时不要把它当成「结构化项」跳过
    listed: true,
  },
  navGroups: { type: 'json', hint: '头部导航分组：[{title, templates:[条目模板id…]}]，数组顺序 = 显示顺序', coerce: coerceNavGroups },
  navHidden: { type: 'json', hint: '头部隐藏的条目模板 id（入口不显示，`#/条目模板` 直达仍可用）', coerce: coerceNavHidden },
  navOrder: { type: 'json', hint: '平铺区的显示顺序（条目模板 id 数组；没列进去的按条目模板自身顺序跟在后面）', coerce: coerceNavOrder },
  // 任务 #26：编辑字段后防抖自动保存（默认否）。面板与 CLI 读同一份值。
  autoSaveFields: { type: 'boolean', hint: '编辑字段后自动保存（800ms 防抖；否 = 只走手动保存）' },
  // 任务 #27：字段历史的保留方式（默认每个字段最近 50 版）。改完立即裁剪存量历史。
  historyMode: { type: 'string', enum: ['count', 'time'], hint: '字段历史保留方式：count = 只留最近 N 版；time = 只留最近 N 天' },
  historyCount: { type: 'number', min: 1, max: 1000, hint: '按条数保留：每个字段最多留多少版（默认 50）' },
  historyDays: { type: 'number', min: 1, max: 3650, hint: '按时间保留：留最近多少天（默认 90）' },
};

export function settingsSchema() {
  return Object.entries(SCHEMA).map(([key, s]) => ({ key, ...s }));
}

export async function getSettings() {
  const store = await loadStore();
  return {
    settings: store.settings,
    // 条目模板清单随设置一起给：面板的「条目模板管理」按它渲染，CLI 也能一次看全
    templates: store.templates.map((s) => ({
      id: s.id,
      title: s.title,
      entries: store.entries.filter((e) => e.template === s.id).length,
    })),
    schema: settingsSchema(),
  };
}

/**
 * 头部导航分组（`settings.navGroups`）的形状校验 + 归一。
 *
 * 分组是**显示配置**，写坏了头部就少一块，所以这里不静默丢任何东西：
 * 条目模板不存在 / 一个条目模板进了两个组 / 空组 —— 一律报错并说清是哪一组哪一项。
 * 归一：条目模板可以写 id 也可以写标题（统一存成真实 id）；组内去重保序。
 */
function coerceNavGroups(value: unknown, store: Store) {
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch (e) {
      throw badInput(`navGroups 需要 JSON 数组（${(e as Error).message}）：[{"title":"求职","templates":["projects",…]}, …]`);
    }
  }
  if (!Array.isArray(arr)) {
    throw badInput('navGroups 需要是数组：[{"title":"求职","templates":["projects",…]}, …]');
  }
  const owner = new Map<string, string>();
  return arr.map((g, i) => {
    if (!g || typeof g !== 'object') throw badInput(`第 ${i + 1} 个分组不是对象`);
    const title = String(g.title ?? '').trim();
    if (!title) throw badInput(`第 ${i + 1} 个分组缺少 title（组名）`);
    const templates: string[] = [];
    const inGroup = new Set<string>();
    for (const raw of (Array.isArray(g.templates) ? g.templates : [])) {
      const ref = String(raw ?? '').trim();
      if (!ref) continue;
      const sec = findTemplate(store, ref);
      if (!sec) throw badInput(`分组「${title}」里的条目模板不存在: ${ref}`);
      if (inGroup.has(sec.id)) continue; // 同组里 id / 标题混着写同一个条目模板 → 去重
      if (owner.has(sec.id)) {
        throw badInput(`条目模板 ${sec.id} 同时在分组「${owner.get(sec.id)}」与「${title}」里——一个条目模板只能属于一个分组`);
      }
      inGroup.add(sec.id);
      owner.set(sec.id, title);
      templates.push(sec.id);
    }
    if (!templates.length) throw badInput(`分组「${title}」没有任何条目模板——要么勾一个，要么删掉这个分组`);
    return { title, templates };
  });
}

/**
 * 「条目模板 id 清单」校验（隐藏清单 / 平铺顺序共用）：每一项都必须是真实存在的条目模板；
 * 去重保序，并归一成真实 id（写标题也认）。label 只影响报错措辞。
 */
function coerceTemplateIdList(value: unknown, store: Store, label: string): string[] {
  // 三种写法都吃：数组（面板）、`a,b`（CLI 省事写法）、`["a","b"]`（CLI 的 JSON 写法）
  let raw = value;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        raw = JSON.parse(s);
      } catch (e) {
        throw badInput(`${label}需要 JSON 数组或逗号分隔：${(e as Error).message}`);
      }
    }
  }
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const item of list) {
    const ref = String(item ?? '').trim();
    if (!ref) continue;
    const sec = findTemplate(store, ref);
    if (!sec) throw badInput(`${label}里的条目模板不存在: ${ref}`);
    if (!out.includes(sec.id)) out.push(sec.id);
  }
  return out;
}

// 用**函数声明**（会提升）：SCHEMA 在模块顶层就引用了它们，const 箭头函数会踩 TDZ
function coerceNavHidden(value: unknown, store: Store) {
  return coerceTemplateIdList(value, store, '隐藏清单');
}

function coerceNavOrder(value: unknown, store: Store) {
  return coerceTemplateIdList(value, store, '平铺顺序');
}

/**
 * 默认条目模板必须指向**真实存在**的条目模板（空 = 交给面板取第一个）。
 *
 * 不校验的后果是配置静默失效：删掉某条目模板之后 defaultTemplate 还指着它，
 * 于是「打开面板落在哪」这种问题变得无从解释。宁可写入时报错，并列出可选项。
 */
function coerceDefaultTemplate(value: unknown, store: Store) {
  const ref = String(value ?? '').trim();
  if (!ref) return '';
  const sec = findTemplate(store, ref);
  if (!sec) {
    const have = store.templates.map((s) => `${s.id}（${s.title}）`).join('、') || '（还没有条目模板）';
    throw badInput(`默认条目模板不存在: ${ref} —— 现有: ${have}`);
  }
  return sec.id;
}

function coerceSetting(key: string, value: unknown, store: Store) {
  const s = SCHEMA[key];
  if (!s) throw notFound(`未知设置项: ${key}（可用: ${SETTING_KEYS.join(', ')}）`);
  // 结构化设置项（导航分组 / 隐藏）自带校验器；标量项走下面这套
  if (s.coerce) return s.coerce(value, store);
  if (s.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const v = String(value).trim().toLowerCase();
    if (['是', 'true', '1', 'yes'].includes(v)) return true;
    if (['否', 'false', '0', 'no', ''].includes(v)) return false;
    throw badInput(`设置项 ${key} 需要是/否，收到 ${JSON.stringify(value)}`);
  }
  const str = String(value);
  if (s.type === 'number') {
    const n = Number(value);
    if (value === '' || !Number.isFinite(n)) throw badInput(`设置项 ${key} 需要一个数字，收到 ${JSON.stringify(value)}`);
    const int = Math.trunc(n);
    if (s.min !== undefined && int < s.min) throw badInput(`设置项 ${key} 不能小于 ${s.min}（收到 ${int}）`);
    if (s.max !== undefined && int > s.max) throw badInput(`设置项 ${key} 不能大于 ${s.max}（收到 ${int}）`);
    return int;
  }
  if (s.enum && !s.enum.includes(str)) throw badInput(`设置项 ${key} 只能是 ${s.enum.join(' / ')}`);
  return str;
}

/** PATCH 语义：只改传入的项，未传的保持原值。 */
export async function updateSettings({ set, key, value, 'dry-run': dryRun }: { set?: Record<string, unknown>; key?: string; value?: unknown; 'dry-run'?: boolean } = {}) {
  let patch: Record<string, unknown> = {};
  if (set && typeof set === 'object') patch = { ...set };
  if (key !== undefined) patch[key] = value;

  const keys = Object.keys(patch);
  if (!keys.length) throw badInput('至少要给一项：setting set --key <名> --value <值>，或 --set k=v（可重复）');

  // 校验要拿 store 做参照（navGroups 里的条目模板 id 必须真实存在）
  const store = await loadStore();
  const resolved: Record<string, unknown> = {};
  for (const k of keys) resolved[k] = coerceSetting(k, patch[k], store);

  if (dryRun) return { status: 'skipped', dryRun: true, wouldSet: resolved };

  const result = await mutateStore((s) => {
    const settings = s.settings as unknown as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved)) { before[k] = settings[k]; settings[k] = v; }
    return { before, after: { ...resolved } };
  }) as { before: Record<string, unknown>; after: Record<string, unknown> };
  // 任务 #27：保留策略改完立即对存量历史生效（不必等下一次写入才发现「说好的 5 版还是 500 版」）。
  let pruned = 0;
  if (Object.keys(resolved).some((k) => k.startsWith('history'))) pruned = await pruneHistoryNow();
  return { status: 'ok', set: result.after, before: result.before, pruned, path: displayPath(dbFile()) };
}

export function renderSettings(data: {
  schema: ReturnType<typeof settingsSchema>;
  settings: StoreSettings;
  templates?: { id: string; title: string }[];
}) {
  const lines = ['当前设置（改：nx-sk setting set --set k=v）'];
  const settingsMap = data.settings as unknown as Record<string, unknown>;
  for (const s of data.schema) {
    // 结构化项（导航分组 / 隐藏 / 顺序）在这里跳过，下面单独以可读形式列出；
    // 带校验器的标量项（defaultTemplate）用 listed 标记留下
    if (s.coerce && !s.listed) continue;
    const v = settingsMap[s.key];
    const shown = s.type === 'boolean' ? (v ? '是' : '否')
      : (v === '' || v === undefined ? '（空）' : String(v));
    lines.push(`  ${s.key.padEnd(22)} ${shown.padEnd(10)} ${s.hint}`);
  }

  const settings = data.settings as unknown as Record<string, unknown>;
  const hidden = new Set<string>((settings.navHidden as string[]) || []);
  if (data.templates?.length) {
    lines.push('', `条目模板（${data.templates.length}）· 隐藏 ${hidden.size} 个`);
    for (const s of data.templates) {
      lines.push(`  ${String(s.id).padEnd(18)} ${String(s.title).padEnd(14)} ${hidden.has(s.id) ? '隐藏' : '显示'}`);
    }
  }

  const order = (settings.navOrder as string[]) || [];
  if (data.templates?.length) {
    const ranked = order.filter((id: string) => data.templates!.some((s) => s.id === id));
    if (ranked.length) lines.push(`平铺顺序（前 ${ranked.length} 个已显式排序）: ${ranked.join(' → ')}`);
  }

  const groups = (settings.navGroups as { title: string; templates: string[] }[]) || [];
  lines.push('', groups.length
    ? `分组（${groups.length}）· 组顺序 = 头部顺序，组内顺序 = 展开列表顺序`
    : '分组：无（全部条目模板平铺在头部）');
  for (const g of groups) lines.push(`  ${g.title}: ${g.templates.join(' → ')}`);
  lines.push('', '例：nx-sk setting set --set \'navGroups=[{"title":"求职","templates":["projects"]}]\' --dry-run');
  return lines.join('\n');
}

export function renderSettingSet(d: {
  status: string;
  wouldSet: unknown;
  set: Record<string, unknown>;
  before: Record<string, unknown>;
}) {
  if (d.status === 'skipped') return `试运行：将设置 ${JSON.stringify(d.wouldSet)}（未落盘）`;
  const lines = ['已更新设置：'];
  for (const [k, v] of Object.entries(d.set)) lines.push(`  ${k}: ${JSON.stringify(d.before[k])} -> ${JSON.stringify(v)}`);
  return lines.join('\n');
}

