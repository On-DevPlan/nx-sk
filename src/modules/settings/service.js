// settings 是**基础模块**：允许被其它模块单向只读依赖（见 eslint 互依禁列——它故意不在里面）。
// 设置的唯一读写入口在这里，别绕过去直接改 store.settings。
import { loadStore, mutateStore, snapshotStore } from '../../core/store.js';
import { findSection } from '../../core/fields.js';
import { badInput, notFound } from '../../core/errors.js';

export const SETTING_KEYS = ['exportDir', 'exportFormat', 'includeSecretsInExport', 'defaultSection', 'navGroups', 'navHidden', 'navOrder'];

const SCHEMA = {
  exportDir: { type: 'string', hint: '导出目录，留空 = ~/nx-sk/export' },
  exportFormat: { type: 'string', enum: ['json', 'md', 'both'], hint: '整体导出默认格式' },
  includeSecretsInExport: { type: 'boolean', hint: '整体导出是否默认带密钥明文（默认否）' },
  defaultSection: { type: 'string', hint: '默认栏目 id' },
  navGroups: { type: 'json', hint: '头部导航分组：[{title, sections:[栏目id…]}]，数组顺序 = 显示顺序', coerce: coerceNavGroups },
  navHidden: { type: 'json', hint: '头部隐藏的栏目 id（入口不显示，`#/栏目` 直达仍可用）', coerce: coerceNavHidden },
  navOrder: { type: 'json', hint: '平铺区的显示顺序（栏目 id 数组；没列进去的按栏目自身顺序跟在后面）', coerce: coerceNavOrder },
};

export function settingsSchema() {
  return Object.entries(SCHEMA).map(([key, s]) => ({ key, ...s }));
}

export async function getSettings() {
  const store = await loadStore();
  return {
    settings: store.settings,
    // 栏目清单随设置一起给：面板的「栏目管理」按它渲染，CLI 也能一次看全
    sections: store.sections.map((s) => ({
      id: s.id,
      title: s.title,
      entries: store.entries.filter((e) => e.section === s.id).length,
    })),
    schema: settingsSchema(),
  };
}

/**
 * 头部导航分组（`settings.navGroups`）的形状校验 + 归一。
 *
 * 分组是**显示配置**，写坏了头部就少一块，所以这里不静默丢任何东西：
 * 栏目不存在 / 一个栏目进了两个组 / 空组 —— 一律报错并说清是哪一组哪一项。
 * 归一：栏目可以写 id 也可以写标题（统一存成真实 id）；组内去重保序。
 */
function coerceNavGroups(value, store) {
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch (e) {
      throw badInput(`navGroups 需要 JSON 数组（${e.message}）：[{"title":"求职","sections":["projects",…]}, …]`);
    }
  }
  if (!Array.isArray(arr)) {
    throw badInput('navGroups 需要是数组：[{"title":"求职","sections":["projects",…]}, …]');
  }
  const owner = new Map();
  return arr.map((g, i) => {
    if (!g || typeof g !== 'object') throw badInput(`第 ${i + 1} 个分组不是对象`);
    const title = String(g.title ?? '').trim();
    if (!title) throw badInput(`第 ${i + 1} 个分组缺少 title（组名）`);
    const sections = [];
    const inGroup = new Set();
    for (const raw of (Array.isArray(g.sections) ? g.sections : [])) {
      const ref = String(raw ?? '').trim();
      if (!ref) continue;
      const sec = findSection(store, ref);
      if (!sec) throw badInput(`分组「${title}」里的栏目不存在: ${ref}`);
      if (inGroup.has(sec.id)) continue; // 同组里 id / 标题混着写同一个栏目 → 去重
      if (owner.has(sec.id)) {
        throw badInput(`栏目 ${sec.id} 同时在分组「${owner.get(sec.id)}」与「${title}」里——一个栏目只能属于一个分组`);
      }
      inGroup.add(sec.id);
      owner.set(sec.id, title);
      sections.push(sec.id);
    }
    if (!sections.length) throw badInput(`分组「${title}」没有任何栏目——要么勾一个，要么删掉这个分组`);
    return { title, sections };
  });
}

/**
 * 「栏目 id 清单」校验（隐藏清单 / 平铺顺序共用）：每一项都必须是真实存在的栏目；
 * 去重保序，并归一成真实 id（写标题也认）。label 只影响报错措辞。
 */
function coerceSectionIdList(value, store, label) {
  // 三种写法都吃：数组（面板）、`a,b`（CLI 省事写法）、`["a","b"]`（CLI 的 JSON 写法）
  let raw = value;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        raw = JSON.parse(s);
      } catch (e) {
        throw badInput(`${label}需要 JSON 数组或逗号分隔：${e.message}`);
      }
    }
  }
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const item of list) {
    const ref = String(item ?? '').trim();
    if (!ref) continue;
    const sec = findSection(store, ref);
    if (!sec) throw badInput(`${label}里的栏目不存在: ${ref}`);
    if (!out.includes(sec.id)) out.push(sec.id);
  }
  return out;
}

// 用**函数声明**（会提升）：SCHEMA 在模块顶层就引用了它们，const 箭头函数会踩 TDZ
function coerceNavHidden(value, store) {
  return coerceSectionIdList(value, store, '隐藏清单');
}

function coerceNavOrder(value, store) {
  return coerceSectionIdList(value, store, '平铺顺序');
}

function coerceSetting(key, value, store) {
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
  if (s.enum && !s.enum.includes(str)) throw badInput(`设置项 ${key} 只能是 ${s.enum.join(' / ')}`);
  return str;
}

/** PATCH 语义：只改传入的项，未传的保持原值。 */
export async function updateSettings({ set, key, value, 'dry-run': dryRun } = {}) {
  let patch = {};
  if (set && typeof set === 'object') patch = { ...set };
  if (key !== undefined) patch[key] = value;

  const keys = Object.keys(patch);
  if (!keys.length) throw badInput('至少要给一项：setting set --key <名> --value <值>，或 --set k=v（可重复）');

  // 校验要拿 store 做参照（navGroups 里的栏目 id 必须真实存在）
  const store = await loadStore();
  const resolved = {};
  for (const k of keys) resolved[k] = coerceSetting(k, patch[k], store);

  if (dryRun) return { status: 'skipped', dryRun: true, wouldSet: resolved };

  const snapshot = await snapshotStore('setting-set');
  const result = await mutateStore((s) => {
    const before = {};
    for (const [k, v] of Object.entries(resolved)) { before[k] = s.settings[k]; s.settings[k] = v; }
    return { before, after: { ...resolved } };
  });
  return { status: 'ok', set: result.after, before: result.before, snapshot, path: '~/nx-sk/store.json' };
}

export function renderSettings(data) {
  const lines = ['当前设置（改：nx-sk setting set --set k=v）'];
  for (const s of data.schema) {
    if (s.coerce) continue; // 结构化项（导航分组 / 隐藏）单独可读地列在下面
    const v = data.settings[s.key];
    const shown = s.type === 'boolean' ? (v ? '是' : '否')
      : (v === '' || v === undefined ? '（空）' : String(v));
    lines.push(`  ${s.key.padEnd(22)} ${shown.padEnd(10)} ${s.hint}`);
  }

  const settings = data.settings || {};
  const hidden = new Set(settings.navHidden || []);
  if (data.sections?.length) {
    lines.push('', `栏目（${data.sections.length}）· 隐藏 ${hidden.size} 个`);
    for (const s of data.sections) {
      lines.push(`  ${String(s.id).padEnd(18)} ${String(s.title).padEnd(14)} ${hidden.has(s.id) ? '隐藏' : '显示'}`);
    }
  }

  const order = settings.navOrder || [];
  if (data.sections?.length) {
    const ranked = order.filter((id) => data.sections.some((s) => s.id === id));
    if (ranked.length) lines.push(`平铺顺序（前 ${ranked.length} 个已显式排序）: ${ranked.join(' → ')}`);
  }

  const groups = settings.navGroups || [];
  lines.push('', groups.length
    ? `分组（${groups.length}）· 组顺序 = 头部顺序，组内顺序 = 展开列表顺序`
    : '分组：无（全部栏目平铺在头部）');
  for (const g of groups) lines.push(`  ${g.title}: ${g.sections.join(' → ')}`);
  lines.push('', '例：nx-sk setting set --set \'navGroups=[{"title":"求职","sections":["projects"]}]\' --dry-run');
  return lines.join('\n');
}

export function renderSettingSet(d) {
  if (d.status === 'skipped') return `试运行：将设置 ${JSON.stringify(d.wouldSet)}（未落盘）`;
  const lines = ['已更新设置：'];
  for (const [k, v] of Object.entries(d.set)) lines.push(`  ${k}: ${JSON.stringify(d.before[k])} -> ${JSON.stringify(v)}`);
  if (d.snapshot) lines.push(`快照: ${d.snapshot}`);
  return lines.join('\n');
}
