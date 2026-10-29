// 纯渲染逻辑（不碰磁盘、不碰平台）——值格式化、条目序列化、栏目全量视图。
// 放 core 是为了能单测：这些函数决定了「读出去的形状」，是最该被钉住的契约。
//
// 这里**不解密**：解密需要密钥（异步、且属于安全边界），所以由调用方把一个
// `decrypt(blob) => 明文` 传进来（core/vault.js 的 `sensitiveViewer` 负责造它）。
// 这样 render 保持纯函数，而「什么时候允许看明文」仍然只有一个决策点。
import { isCipherBlob, maskValue } from './crypto.js';
import { FILL_LABELS, fillPolicy, isExcludedField, isSensitiveField } from './fields.js';
// 表格的「字段定义 + 数据」怎么合成一份自描述文档，只有一份实现（见 shared/table.js）。
import { columnToDef, normalizeSpec } from '../shared/table.js';

export function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  // 表格文档：一行都没有就算没填（有列没数据不算填了内容）。
  // 密文对象没有 rows，不受这条影响。
  if (typeof v === 'object' && Array.isArray(v.rows)) return v.rows.length === 0;
  return String(v).trim() === '';
}

/**
 * 「这个字段真的没有东西可带出去」—— 与 isBlank 的区别只在表格：
 *
 *   - `isBlank` 决定**完整度**：有列没行的表算「没填」（不然一张空表就把进度撑满了）。
 *   - `isStoredEmpty` 决定**值要不要输出**：还有列就说明结构在，要带出去 ——
 *     否则面板拿不到列，用户搭好的骨架（列 + 默认值）一保存就"消失"了。
 */
export function isStoredEmpty(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object' && Array.isArray(v.rows)) {
    return !v.rows.length && !(Array.isArray(v.columns) && v.columns.length);
  }
  return String(v).trim() === '';
}

/** 值 → 人读字符串（bool / tags / 数组 / 标量 / entrylist 行）。 */
export function formatValue(value) {
  if (isBlank(value)) return '';
  // 表格文档：按「列名=值 · 列名=值；下一行」压成一行（section dump 的表格放不下多行版）
  if (typeof value === 'object' && Array.isArray(value.rows)) {
    const cols = Array.isArray(value.columns) ? value.columns : [];
    const labelOf = (k) => cols.find((c) => c.key === k)?.label || k;
    return value.rows.map((row) => Object.entries(row || {})
      .filter(([, v]) => !isBlank(v))
      .map(([k, v]) => `${labelOf(k)}=${typeof v === 'boolean' ? (v ? '是' : '否') : (Array.isArray(v) ? v.join('、') : v)}`)
      .join(' · ')).filter(Boolean).join('；');
  }
  if (Array.isArray(value)) {
    // 结构清单的行：`k=v · k=v；k=v` 压成一行——section dump 的表格里放不下多行版
    if (value.length && value.every((x) => isPlainRow(x))) {
      return value.map((row) => Object.entries(row)
        .filter(([, v]) => !isBlank(v))
        .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? '是' : '否') : v}`)
        .join(' · ')).filter(Boolean).join('；');
    }
    return value.map(String).join('、');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function isPlainRow(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * 清单类字段（entrylist / table）的一行：敏感子值走与顶层敏感字段同一条 displaySensitive 边界
 * （默认原文 / mask 打码 / 有 decrypt 才解密）。非对象行（坏数据）原样放过。
 *
 * 两种字段的差别只在「列」叫什么：entrylist 用 fields，table 用 columns。
 * 密文边界是同一条，所以这里只认「哪些子字段是 sensitive」，不关心是哪种清单。
 */
function subFieldsOf(def) {
  return def?.type === 'table' ? (def.columns || []) : (def.fields || []);
}function displayRow(def, row, opts) {
  if (!isPlainRow(row)) return row;
  const subs = subFieldsOf(def).filter((s) => s.sensitive);
  if (!subs.length) return row;
  const out = { ...row };
  for (const s of subs) {
    if (out[s.key] !== undefined && out[s.key] !== null) out[s.key] = displaySensitive(out[s.key], opts);
  }
  return out;
}

/**
 * 敏感字段的展示形态。
 *
 * **默认原文**：这是本机单人工具，数据是给自己看的——默认打码等于每次都先拦自己一道。
 * 落盘仍然是密文（AES-256-GCM），所以「store.json 泄露」不等于「凭据泄露」。
 * 想看打码形态（投屏 / 截图时）显式传 `mask: true`。
 *
 * 三种输入都要处理：
 *   密文对象 → 有 decrypt 就解开，没有就标「需要密钥」
 *   明文     → 历史数据可能存的是明文，原样返回
 *   空       → null
 */
export function displaySensitive(raw, { mask = false, decrypt } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isCipherBlob(raw)) return mask ? maskValue(String(raw)) : String(raw);
  if (!decrypt) return mask ? '[已加密]' : '[需要密钥才能解密]';
  try {
    const plain = decrypt(raw);
    return mask ? maskValue(plain) : plain;
  } catch {
    return '[无法解密：密钥或密文与写入时不一致]';
  }
}

/**
 * 条目的**唯一序列化出口**（面板、`entry list`、`section dump` 共用一份）。
 * 两个出口各写一遍序列化，迟早会分叉成「CLI 看得到、面板看不到」。
 */
export function serializeEntry(section, entry, { mask = false, decrypt } = {}) {
  const c = completeness(section, entry);
  const values = {};
  for (const def of section.fields) {
    const raw = entry.values?.[def.key];
    // 这里用 isStoredEmpty 而不是 isBlank：空表（有列没行）要带出去，否则骨架丢失
    if (isStoredEmpty(raw)) { values[def.key] = null; continue; }
    if (def.type === 'entrylist' && Array.isArray(raw)) {
      values[def.key] = raw.map((row) => displayRow(def, row, { mask, decrypt }));
      continue;
    }
    // 表格读出去永远是**自描述的完整文档**：columns / rows / 可选 totals。
    // 列存在数据里，所以读的人（面板、agent、导出）不必再去查栏目字典才知道有哪些列。
    if (def.type === 'table') {
      const spec = normalizeSpec(def, raw);
      values[def.key] = {
        v: spec.v,
        columns: spec.columns.map((c) => columnToDef(c)),
        rows: spec.rows.map((row) => displayRow({ type: 'table', columns: spec.columns }, row, { mask, decrypt })),
        ...(Array.isArray(spec.totals) ? { totals: spec.totals } : {}),
        ...(spec.summary === false ? { summary: false } : {}),
      };
      continue;
    }
    values[def.key] = isSensitiveField(section, def.key)
      ? displaySensitive(raw, { mask, decrypt })
      : raw;
  }
  return {
    id: entry.id,
    section: entry.section,
    title: entry.title,
    tags: entry.tags || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completeness: {
      filled: c.filled,
      total: c.total,
      ratio: c.ratio,
      excluded: c.excluded.length,
      excludedFilled: c.excludedFilled,
    },
    missing: c.missing.map((x) => ({ key: x.key, label: x.label })),
    // 与 missing 并列：这些是**主动不填**的字段，不是「还没填」。
    // 两者混在一起会让「补全清单」和「不填清单」分不开。
    excluded: c.excluded,
    values,
  };
}

/**
 * 完整度：**只统计照常填的字段**。给「AI 帮我补全信息」当导航用。
 *
 * `optional` / `avoid` 两类字段既不计入 `total` 也不计入 `filled`——
 * 否则「还缺 N 项」会永远挂着一批用户主动决定不填的字段，导航就失效了。
 * 它们不会凭空消失：`excluded` 单独列出来，`excludedFilled` 记录其中已填了几个
 * （用户可能没改策略却还是填了值，这个数能提示策略该更新了）。
 */
export function completeness(section, entry) {
  const fields = section?.fields || [];
  const counted = fields.filter((d) => !isExcludedField(d));
  const excluded = fields.filter((d) => isExcludedField(d));
  const missing = [];
  let filled = 0;
  for (const def of counted) {
    if (isBlank(entry?.values?.[def.key])) missing.push(def);
    else filled++;
  }
  const total = counted.length;
  return {
    filled,
    total,
    ratio: total ? Math.round((filled / total) * 100) : 0,
    missing,
    excluded: excluded.map((d) => ({ key: d.key, label: d.label, fill: fillPolicy(d), fillLabel: FILL_LABELS[fillPolicy(d)] })),
    excludedFilled: excluded.filter((d) => !isBlank(entry?.values?.[d.key])).length,
  };
}

/** 栏目的纯数据视图：所有条目 + 全部字段（含未填），供 `section dump` 与面板用。 */
export function dumpSection(section, entries, { mask = false, decrypt } = {}) {
  const mine = entries.filter((e) => e.section === section.id);
  return {
    section: {
      id: section.id,
      title: section.title,
      description: section.description,
      order: section.order,
      template: section.template,
      kv: section.kv === true,
      titleField: section.titleField,
      titleLabel: section.titleLabel,
      fields: section.fields.length,
    },
    groups: section.groups,
    fields: section.fields.map((x) => ({
      key: x.key,
      label: x.label,
      type: x.type,
      group: x.group,
      hint: x.hint || '',
      options: x.options || null,
      // 结构清单的列（子字段）必须跟着字典出去，否则面板渲染不出列、agent 不知道行里该有什么键
      fields: x.fields || null,
      // 表格的列（带类型/公式）与统计行同理：不知道列定义，agent 只能瞎猜行里能写什么
      columns: x.columns || null,
      totals: x.totals || null,
      summary: x.summary === false ? false : undefined,
      maxRows: x.maxRows || null,
      kind: x.kind || '',
      sensitive: isSensitiveField(section, x.key),
      // 填写策略要跟着字段字典出去，否则面板与 agent 不知道哪个格子「不用填」
      fill: fillPolicy(x),
      fillLabel: FILL_LABELS[fillPolicy(x)],
    })),
    count: mine.length,
    entries: mine.map((e) => serializeEntry(section, e, { mask, decrypt })),
  };
}
