// 栏目结构的**变更算子**：0.42 起「组」就是一条 type='group' 的字段，
// 所以「加组 / 改组名 / 移组 / 删组 / 把字段挪进组 / 组内上下移」全部落成
// 对字段字典的纯函数操作——写路径（section update）与读路径共用同一套语义，
// 不再有「groups 数组 + field.group 两份数据需要对账」这种事。
import type { FieldDef } from '../../shared/fields/types.ts';
import { groupKeysOf, isGroupDef, structureOf } from '../../shared/fields/structure.ts';
import { validateFieldDef, validateGroupDef } from './validate.ts';

/** 组字段定义（写入字典的唯一造法）。 */
export const groupDefOf = (key: string, label: string, keys: string[] = []): FieldDef =>
  ({ key, label, type: 'group', keys } as unknown as FieldDef);

/**
 * 从 `--fields` / `--groups` 输入整份重建字段字典（CLI 与面板的「整体替换」入口）。
 *
 * 输入层保留历史写法（`--groups [{id,title}]` + 字段里的 `group`），落成字典时
 * 一律折成「组字段（keys=成员）+ 普通字段」，所以存储里永远只有一种结构。
 */
export function fieldsFromInput(rawFields: unknown[], rawGroups: unknown[] | null | undefined, fallbackGroup?: string): FieldDef[] {
  const groupsIn = Array.isArray(rawGroups) ? rawGroups.map(validateGroupDef) : [];
  const members = new Map<string, string[]>(groupsIn.map((g) => [g.key, [] as string[]]));
  const plain: FieldDef[] = [];
  for (const raw of rawFields) {
    const parsed = validateFieldDef(raw, { allowGroup: fallbackGroup || groupsIn[0]?.key || 'root' });
    const group = (parsed as FieldDef & { group?: string }).group;
    const { group: _drop, ...def } = parsed as FieldDef & { group?: string };
    plain.push(def as FieldDef);
    if (isGroupDef(def) || !group) continue;
    if (!members.has(group)) members.set(group, []);
    members.get(group)!.push(def.key);
  }
  const groupDefs = [...members.keys()].map((key) => {
    const known = groupsIn.find((g) => g.key === key);
    const direct = plain.find((d) => isGroupDef(d) && d.key === key) as (FieldDef & { label?: string }) | undefined;
    return groupDefOf(key, known?.label || String(direct?.label || key), members.get(key) || []);
  });
  // 输入里直接给的组字段（没有在 --groups 里声明）保留原样。
  const extraGroups = plain.filter((d) => isGroupDef(d) && !groupDefs.some((g) => g.key === d.key));
  const leaves = plain.filter((d) => !isGroupDef(d));
  return [...groupDefs, ...extraGroups, ...leaves];
}

/** 组字段在字典里的下标（不是组 = -1）。 */
export function groupIndexOf(fields: readonly FieldDef[], groupKey: string): number {
  return fields.findIndex((f) => isGroupDef(f) && String(f.key) === groupKey);
}

/** 组字段（不存在 = null）。 */
export function groupFieldOf(fields: readonly FieldDef[], groupKey: string): FieldDef | null {
  const i = groupIndexOf(fields, groupKey);
  return i < 0 ? null : fields[i];
}

/** 某组的直接成员（组字段的 keys）。 */
export function membersOf(fields: readonly FieldDef[], groupKey: string): string[] {
  const g = groupFieldOf(fields, groupKey);
  return g ? groupKeysOf(g) : [];
}

/** 把一份「组 → 成员」写回组字段（其它字段不动）。 */
function withKeys(def: FieldDef, keys: string[]): FieldDef {
  return { ...def, keys } as FieldDef;
}

/** 字段 key 当前所属的组（顶层组的 key）。 */
export function parentGroupOf(fields: readonly FieldDef[], fieldKey: string): string | undefined {
  return structureOf(fields).parentOf.get(String(fieldKey));
}

/**
 * 把某个字段**从所有组里摘下来**（不删字段本身）。
 * 用于「换组」「删组前清成员」——返回新数组。
 */
export function detachMember(fields: readonly FieldDef[], fieldKey: string): FieldDef[] {
  const out = fields.map((f) => {
    if (!isGroupDef(f)) return f;
    const keys = groupKeysOf(f);
    return keys.includes(fieldKey) ? withKeys(f, keys.filter((k) => k !== fieldKey)) : f;
  });
  return out as FieldDef[];
}

/** 把字段挪进目标组（先摘下、再追加到组尾；目标组不存在直接抛给调用方判）。 */
export function moveMemberTo(fields: readonly FieldDef[], fieldKey: string, groupKey: string): FieldDef[] {
  const detached = detachMember(fields, fieldKey);
  return detached.map((f) => {
    if (!isGroupDef(f) || String(f.key) !== groupKey) return f;
    const keys = groupKeysOf(f);
    return withKeys(f, [...keys, fieldKey]);
  }) as FieldDef[];
}

/**
 * 组内相邻移动：只改本组 keys 的顺序（不动字段字典的全局顺序）。
 * 返回 [新数组, 被交换的相邻字段 key]；没有可换的邻居 = null。
 */
export function moveWithinGroup(
  fields: readonly FieldDef[], groupKey: string, fieldKey: string, dir: 'up' | 'down',
): { fields: FieldDef[]; neighbor: string } | null {
  const keys = membersOf(fields, groupKey);
  const i = keys.indexOf(fieldKey);
  if (i < 0) return null;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= keys.length) return null;
  const next = [...keys];
  [next[i], next[j]] = [next[j], next[i]];
  const out = fields.map((f) => (isGroupDef(f) && String(f.key) === groupKey ? withKeys(f, next) : f)) as FieldDef[];
  return { fields: out, neighbor: next[i] };
}

/** 新增一个空组字段：默认插在「原始资料」袋之前（袋子是收尾用的乱入区）。 */
export function addGroupField(
  fields: readonly FieldDef[], group: { key: string; label: string }, opts: { before?: string } = {},
): FieldDef[] {
  const def = { key: group.key, label: group.label, type: 'group', keys: [] } as unknown as FieldDef;
  const out = [...fields];
  const before = opts.before ? out.findIndex((f) => String(f.key) === opts.before) : -1;
  if (before >= 0) out.splice(before, 0, def);
  else out.push(def);
  return out;
}

/** 改组：改 label；改 key 时必须把引用它的父组 keys 一起改（否则整组变成孤儿）。 */
export function renameGroupField(
  fields: readonly FieldDef[], groupKey: string, { newKey, label }: { newKey?: string; label?: string },
): FieldDef[] {
  if (!newKey || newKey === groupKey) {
    return fields.map((f) => (isGroupDef(f) && String(f.key) === groupKey && label ? { ...f, label } as FieldDef : f)) as FieldDef[];
  }
  return fields.map((f) => {
    if (!isGroupDef(f)) return f;
    if (String(f.key) === groupKey) return { ...f, key: newKey, label: label || f.label } as FieldDef;
    const keys = groupKeysOf(f);
    return keys.includes(groupKey) ? withKeys(f, keys.map((k) => (k === groupKey ? newKey : k))) : f;
  }) as FieldDef[];
}

/** 删组：只删组字段本身（调用方先确认它没有成员）。 */
export function removeGroupField(fields: readonly FieldDef[], groupKey: string): FieldDef[] {
  return fields.filter((f) => !(isGroupDef(f) && String(f.key) === groupKey));
}
