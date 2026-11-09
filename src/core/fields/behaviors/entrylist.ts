import { badInput } from '../../errors.ts';
import { assertFieldKey } from '../../paths.ts';
import { isBlank, isPlainRow } from '../../values.ts';
import type { FieldBehavior, SubFieldDef } from '../../../shared/fields/types.ts';
import { displayRow, identityRemap, isSensitiveDef } from './common.ts';

/**
 * 结构清单的行归一：只留声明过的子字段（键写错当场报，不静默丢数据）；
 * 空格子剔除、全空行丢弃。列没声明时（写入自动登记的字段）从行键**推断**清单列——
 * 「直接写就登记」的手感在结构清单上也成立。
 */
export function normalizeRows(def: any, list: any[]): any {
  if (!def.fields || !def.fields.length) {
    const keys: string[] = [];
    for (const row of list) {
      if (!isPlainRow(row)) continue;
      for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
    }
    if (keys.length) def.fields = keys.map((k) => ({ key: k, label: k }));
  }
  const subs = def.fields || [];
  const rows: Record<string, string>[] = [];
  for (const item of list) {
    if (!isPlainRow(item)) {
      throw badInput(`字段「${def.label}」的每行都要是对象（{"子字段": "值"}），收到 ${JSON.stringify(item).slice(0, 80)}`);
    }
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(item)) {
      // 列名**key 与 label 都认**（与顶层 `--set 字段=值` 同一口径）：
      // 人写的是「密码」，清单声明的是 pass —— 不该让人先背一遍英文 key。
      const sub = subs.find((s: any) => s.key === k) || subs.find((s: any) => s.label === k);
      if (!sub) {
        throw badInput(`字段「${def.label}」没有子字段「${k}」（清单列: ${subs.map((s: any) => s.label).join('、') || '无'}）。`
          + `清单列在字段定义里，要改用 section update <栏目> --fields '<整份字段数组>'`);
      }
      const text = String(v ?? '').trim();
      // 一律归到列的 **key** 下：密文判定、面板渲染都按 key 走
      if (text !== '') row[sub.key] = text;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  if (def.maxItems && rows.length > def.maxItems) {
    throw badInput(`字段「${def.label}」最多 ${def.maxItems} 行，收到 ${rows.length} 行`);
  }
  return rows.length ? rows : null;
}

export const entrylistBehavior: FieldBehavior = {
  cell: false,
  normalizeDef(raw, def) {
    // 结构清单的列就是它自己的小字典：不声明列就没法渲染、没法校验。
    if (!Array.isArray(raw.fields) || !raw.fields.length) {
      throw badInput(`字段 ${def.key} 是 entrylist（结构清单），必须声明子字段 fields。`
        + `例如 fields:[{"key":"url","label":"链接"},{"key":"pass","label":"密码","sensitive":true}]`);
    }
    const seen = new Set<string>();
    def.fields = raw.fields.map((s: any) => {
      if (!s || typeof s !== 'object') throw badInput(`字段 ${def.key} 的子字段必须是对象，收到 ${JSON.stringify(s)}`);
      const sk = assertFieldKey(String(s.key || '').trim());
      if (seen.has(sk)) throw badInput(`字段 ${def.key} 的子字段 key 重复: ${sk}`);
      seen.add(sk);
      const out: SubFieldDef = { key: sk, label: String(s.label || sk) };
      if (s.sensitive === true) out.sensitive = true;
      if (s.hint) out.hint = String(s.hint);
      return out;
    });
  },
  coerce(def, raw) {
    // 两种入口：--data 直接给 JSON 数组；--set 给 JSON 串（解析失败就报，别静默吞）。
    let list = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) return null; // 「--set 字段=」（空值）= 清空，与其它类型同一约定
      try { list = JSON.parse(raw); } catch { list = null; }
      if (!Array.isArray(list)) {
        throw badInput(`字段「${def.label}」是结构清单（entrylist），值要是行数组的 JSON，`
          + `例如 '[{"名称":"主控台","链接":"https://…"}]'`);
      }
    }
    if (!Array.isArray(list)) {
      throw badInput(`字段「${def.label}」是结构清单（entrylist），值要是行数组（JSON），收到 ${JSON.stringify(raw).slice(0, 80)}`);
    }
    return normalizeRows(def, list);
  },
  reveal: (def, raw, opts) => (
    Array.isArray(raw) ? raw.map((row) => displayRow(def.fields || [], row, opts)) : raw
  ),
  refs: () => [],
  remap: identityRemap,
  format: (def, value, ctx) => {
    if (!(Array.isArray(value) && value.length && value.every(isPlainRow))) return null;
    const subs = ctx.entryFields?.[def.key] || [];
    const labelOf = (k: string) => subs.find((s) => s.key === k)?.label || k;
    return value.map((row, i) => Object.entries(row)
      .filter(([, x]) => !isBlank(x))
      .map(([k2, x]) => `${labelOf(k2)}=${x}`)
      .join(' · ') || `第 ${i + 1} 行（空）`);
  },
  sensitive: isSensitiveDef,
  subFields: (def) => def?.fields || [],
};
