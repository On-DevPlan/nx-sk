import { isDetachedField, type EntryFieldView, type Store, type StoreEntry, type StoreSection } from '../../core/store.ts';
import { assertFieldKey } from '../../core/paths.ts';
import { badInput, conflict, notFound } from '../../core/errors.ts';
import { SCALAR_FIELD_TYPES, findSection, inferFieldType, isSensitiveField, looksSecretish, sectionNames } from '../../core/fields.ts';
import { behaviorOf } from '../../core/fields/registry.ts';
import { sealOf } from '../../core/fields/seal/index.ts';
import { sealScalar } from '../../core/fields/seal/common.ts';
import type { FieldDef } from '../../shared/fields/types.ts';

export function mustFindSection(store: Store, ref: unknown): StoreSection {  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

/** 条目定位：id 优先，其次唯一标题；重名时报 CONFLICT 让调用方用 id 指定。 */
export function resolveEntry(store: Store, ref: unknown, sectionRef?: unknown): StoreEntry {
  const key = String(ref ?? '').trim();
  if (!key) throw badInput('缺少条目定位：给条目 id（e_...）或条目名');
  let list = store.entries;
  if (sectionRef) list = list.filter((e) => e.section === mustFindSection(store, sectionRef).id);
  const byId = list.find((e) => e.id === key);
  if (byId) return byId;
  const byTitle = list.filter((e) => e.title === key);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw conflict(`有 ${byTitle.length} 条同名条目「${key}」，请用 id 指定: ${byTitle.map((e) => e.id).join(' / ')}`);
  }
  throw notFound(`找不到条目: ${ref}`);
}

export function mergeInputs(set: unknown, data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data && typeof data === 'object') {
    // 兼容 `{values:{...}}` 与直接扁平 `{字段: 值}` 两种写法
    const d = data as Record<string, unknown>;
    Object.assign(out, d.values && typeof d.values === 'object' ? d.values : d);
  }
  if (set && typeof set === 'object') Object.assign(out, set);
  return out;
}

export function resolveFieldDef(section: StoreSection, rawKey: unknown): FieldDef | null {
  const key = String(rawKey).trim();
  return section.fields.find((x) => x.key === key || x.label === key) || null;
}

/**
 * v3：在**条目自身结构行**里解析用户敲的键。
 * key 精确优先，其次 label；模板行（出身字典）优先于扩展行。
 * 同类多命中 = 二义，报 CONFLICT 并列出行 id，让调用方用键名精确指定。
 */
export function resolveOwnRow(ownRows: EntryFieldView[] | null | undefined, rawKey: unknown): FieldDef | null {
  const rows = ownRows || [];
  const key = String(rawKey).trim();
  const byKey = rows.filter((r) => r.key === key);
  const pool = byKey.length ? byKey : rows.filter((r) => String(r.label ?? '') === key);
  if (!pool.length) return null;
  const template = pool.filter((r) => r.templateFieldId != null);
  const chosen = template.length ? template : pool;
  if (chosen.length > 1) {
    throw conflict(`字段定位「${key}」在条目自身结构里有 ${chosen.length} 行命中（${chosen.map((r) => r.id).join(', ')}），请用键名精确指定`);
  }
  return chosen[0].spec as unknown as FieldDef;
}

/**
 * 把一个既不在字典、也不在条目行里的键推断成**扩展字段** def。
 * key 直接用用户敲的那个词（中文也行）——**写什么就存什么**，不必再记一个英文别名。
 *
 * v3：不再 push 进 section.fields——扩展字段只活在条目自己的结构行上（写时复制），
 * 字典保持「模板 + 台账」的身份。def 用于封装本次值 + 写后归正行。
 */
export function inferExtensionField(section: StoreSection, rawKey: unknown, rawValue: unknown): FieldDef {
  // KV 栏目**拒绝加字段**：它的形状就是「一行一个键值对」，多一个字段就散了。
  // 这里必须报错而不是静默登记 —— 静默的后果是用户看到一堆无意义的字段名
  // （真实事故：面板那行「KV 直填」把 `3123312=xxx` 登记成了字段，而不是一个新键）。
  if (section.kv) {
    const wanted = String(rawKey).trim();
    throw badInput(
      `栏目「${section.title}」是一张 KV 表（一行一个键值对），不能加字段「${wanted}」。`
      + `你要加的应该是一个**键** —— 用 nx-sk key set ${wanted} <值>，`
      + '或在面板的 KV 表格里加一行。',
    );
  }
  const key = assertFieldKey(String(rawKey).trim());
  let type: string = inferFieldType(rawValue);
  // 键名长得像凭据（密码 / 令牌 / 密钥 / 账号…）→ **直接建成密文字段**。
  //
  // 这是「大胆写」能成立的前提：agent 可以一把 `--set 密码=…` 写进栏目，
  // 而这把密码**落盘就是密文**，不会明文躺在存储里。
  // 刻意只对标量值生效：数组类（附件 / 结构清单 / 资料袋）有自己的形状，不能改类型。
  if (looksSecretish(key) && SCALAR_FIELD_TYPES.has(type)) type = 'secret';
  return {
    key,
    label: key,
    type: type as FieldDef['type'],
    group: section.groups?.[0]?.id || section.fields?.[0]?.group || 'other',
  } as FieldDef;
}

/**
 * 写入归一的**唯一入口**：类型相关的分支都在 `core/fields/behaviors/<type>.ts`，
 * 这里只保留「空值 = 清空」这条与类型无关的约定。
 */
export function normalizeValue(def: FieldDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  return behaviorOf(def.type).coerce(def, raw);
}

export function isPlainRow(x: unknown): boolean {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

export async function prepareValue(section: StoreSection, def: FieldDef, raw: unknown, current: unknown): Promise<unknown> {
  // 类型级封装（清单行 / 表格列 / secret）查表；其余类型回到「敏感标量」那条与类型无关的分支。
  const seal = sealOf(def.type);
  if (seal) return seal({ section, def, raw, current });
  if (!isSensitiveField(section, def.key)) return normalizeValue(def, raw);
  return sealScalar({ section, def, raw, current });
}

/**
 * 趟 A：解析字段、算出要写进去的值。
 *
 * **不认识的键不再报错**——先查条目自身结构行，再查栏目字典，
 * 都没有就按值推断成扩展字段（v3：只落条目行，不进字典）。
 * 字典从「写入的关卡」降级成「模板 + 已用字段的台账」：
 * 用户想存什么键就存什么键，这才是 KV 该有的手感。
 */
export async function prepareWrite({ section, ownRows = null, currentValues = {}, incoming }: {
  section: StoreSection;
  ownRows?: EntryFieldView[] | null;
  currentValues?: Record<string, unknown>;
  incoming: Record<string, unknown>;
}): Promise<{ values: Record<string, unknown>; newFields: FieldDef[] }> {
  const draft = structuredClone(section);
  const newFields: FieldDef[] = [];
  const values: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    let def = resolveOwnRow(ownRows, rawKey) || resolveFieldDef(draft, rawKey);
    if (!def) {
      def = inferExtensionField(draft, rawKey, rawValue);
      newFields.push(def);
    }
    // prepareValue 的敏感判据读字典——保证 def 在草稿里（扩展行/扩展 def 不在；
    // 只影响本次封装值，不落盘）。
    if (!draft.fields.some((x) => x.key === def!.key)) draft.fields.push(def!);
    values[def.key] = await prepareValue(draft, def, rawValue, currentValues[def.key]);
  }
  return { values, newFields };
}

export function autoTitle(section: StoreSection, values: Record<string, unknown>): string {
  const v = section.titleField ? values[section.titleField] : undefined;
  return v === undefined || v === null || v === '' ? '' : String(v);
}

/** 条目自身行优先、字典兜底的字段定义清单（序列化/台账共用）。
 *  任务 #20：脱离行（meta.detached）不算——值已不进 values，定义也不该出现在任何读出口。 */
export function defsForEntry(sec: StoreSection, ownRows: EntryFieldView[] | null | undefined): FieldDef[] {
  return ownRows ? ownRows.filter((r) => !isDetachedField(r)).map((r) => r.spec as unknown as FieldDef) : sec.fields;
}
