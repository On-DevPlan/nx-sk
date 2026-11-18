// 栏目字典的校验与改动摘要：字段定义 / 分组定义 / 字段定位。
import { assertFieldKey, assertSafeId } from '../../core/paths.ts';
import { badInput } from '../../core/errors.ts';
import { FILL_POLICIES, FIELD_TYPES } from '../../core/fields.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import type { FieldDef } from '../../shared/fields/types.ts';

/**
 * 字段定义校验（唯一写入点）。
 *
 * 0.42：定义里**没有 group**——归属由组字段的 keys 表达，所以这里只校验字段本身；
 * 调用方拿到 `{ def, group }`，`group` 是输入里 `group` 键声明的归属（没写 = undefined，
 * 由 normalizeStructure 归到根组）。`keys` 是组字段的成员声明，由 group 的 behavior 收口。
 */
export function validateFieldDef(raw: any, { allowGroup }: { allowGroup?: string } = {}) {
  // TODO(P4): raw 是 CLI/HTTP 传入的 JSON 字段定义，逐键收窄在 behaviorOf(type).normalizeDef 里
  if (!raw || typeof raw !== 'object') throw badInput('字段定义必须是对象');
  const key = assertFieldKey(raw.key);
  const type = raw.type || 'text';
  if (!FIELD_TYPES.includes(type)) throw badInput(`字段 ${key} 的 type 非法: ${type}（可用: ${FIELD_TYPES.join(' / ')}）`);
  const def = {
    key,
    label: String(raw.label || key),
    type,
  } as FieldDef;
  // 兼容「字段定义里写 group」的输入（CLI 的 --fields DSL 一直这么写）：
  // 读出来交给调用方落成 keys，不留在字段定义里。
  const group = raw.group === undefined ? allowGroup : (raw.group === null ? undefined : String(raw.group));
  // entrylist（结构清单）的列就是它自己的小字典：不声明列就没法渲染、没法校验。
  // 其它类型声明 fields/columns 一律拒绝——字典里不该有「定义了也用不上」的键。
  if (type !== 'entrylist' && type !== 'table' && (raw.fields !== undefined || raw.columns !== undefined)) {
    throw badInput(`字段 ${key} 不是 entrylist / table，不能声明 ${raw.columns !== undefined ? 'columns' : 'fields'}（只有清单类字段有列）`);
  }
  // 类型专属的校验在 core/fields/behaviors/<type>.ts 的 normalizeDef 里实现，这里只调注册表。
  behaviorOf(type).normalizeDef(raw, def);
  if (raw.hint) def.hint = String(raw.hint);
  if (Array.isArray(raw.options) && raw.options.length) (def as { options?: string[] }).options = raw.options.map(String);
  if (raw.sensitive === true) def.sensitive = true;
  if (Number.isFinite(raw.maxItems)) def.maxItems = raw.maxItems;
  // v3 模板默认值：sync 补行 / 新建条目没给值时落这个。
  // null / undefined 都算「没有默认值」（落盘 NULL）——「默认成空」与「没填」在存储上等价，
  // 没必要区分两种写法。
  if (raw.defaultValue !== undefined && raw.defaultValue !== null) def.defaultValue = raw.defaultValue;
  // 填写策略：**必须显式放行**。这个函数是白名单，没写在这里的键会被静默丢掉，
  // 而「静默丢掉」在这里的后果是「用户设了不填、完整度照旧算它」——很难查。
  if (raw.fill !== undefined) {
    if (!FILL_POLICIES.includes(raw.fill)) {
      throw badInput(`字段 ${key} 的 fill 非法: ${JSON.stringify(raw.fill)}（可用: ${FILL_POLICIES.join(' / ')}）`);
    }
    // 只有非 normal 才落盘：normal 是缺省值，写上去只是噪音，也会让「读」多一种形态
    if (raw.fill !== 'normal') def.fill = raw.fill;
  }
  // 归属（group）只作为**返回值**交给调用方（由它折成组字段的 keys），不写进字段定义。
  return Object.assign(def, { group }) as FieldDef & { group?: string };
}

/**
 * 分组定义的输入校验：接受 `{id,title}`（历史 CLI 写法）与 `{key,label}`（新写法）两种键名，
 * 输出统一的 `{ key, label }` —— 落进字典时它是**一条 group 字段**（key=组的 key，label=显示名）。
 */
export function validateGroupDef(raw: any, idx: number): { key: string; label: string } {
  // TODO(P4): raw 是 CLI/HTTP 传入的 JSON 分组定义，逐键收窄在下面的 assertSafeId/String 处
  if (!raw || typeof raw !== 'object') throw badInput('分组定义必须是对象');
  const key = assertSafeId(raw.key || raw.id || `g${idx + 1}`, '分组 id');
  return { key, label: String(raw.label || raw.title || key) };
}

/** 字段定位：key 优先，其次标签（CLI 里人更愿意写「求职状态」而不是 jobStatus）。 */
export function indexOfField(fields: Array<{ key: string; label: string }>, ref: unknown): number {
  const s = String(ref ?? '').trim();
  const i = fields.findIndex((x) => x.key === s);
  if (i >= 0) return i;
  return fields.findIndex((x) => String(x.label) === s);
}

// 改动摘要里说什么：只报用户看得懂的几项，且**必须报出新旧值**——
// 「已更新栏目 x：fields」这种输出等于没说，出了错没法回溯。
const FIELD_PATCH_LABELS = {
  label: '标签', type: '类型', keys: '分组成员', hint: '提示',
  options: '选项', maxItems: '最多几条', fill: '填写策略', sensitive: '密文',
};

function showPatchValue(v: unknown) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (Array.isArray(v)) return v.length ? v.join(' / ') : '（空）';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function describeFieldPatch(before: unknown, after: unknown) {
  const b = (before || {}) as Record<string, unknown>;
  const a = (after || {}) as Record<string, unknown>;
  const bits: string[] = [];
  for (const [k, name] of Object.entries(FIELD_PATCH_LABELS)) {
    if (showPatchValue(b[k]) === showPatchValue(a[k])) continue;
    bits.push(`${name} ${showPatchValue(b[k])} → ${showPatchValue(a[k])}`);
  }
  return bits.length ? bits.join('，') : '无变化';
}
