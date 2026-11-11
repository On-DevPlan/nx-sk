// 「原始资料」袋：内置字段/分组常量与唯一的补全规则（最底层，不依赖其它片段）。

/**
 * 「原始资料」字段：**每个栏目都自带一个**的乱入袋。
 *
 * 为什么每个栏目都要有：真实数据几乎从不是「一次填对」的——邮件、截图、PDF 摘录、
 * 一段手抄的表，全都先有个「还没整理」的阶段。没有这个袋子，用户只有两个坏选择：
 * 把乱数据硬塞进结构化字段（把结构搞脏），或者干脆不存（信息丢了）。
 * 有了它，**先乱入、后整理**就成立了：杂乱资料原样落袋，agent 或人再按字段字典整理。
 *
 * 三条设计取舍：
 *   - **只增不删**：袋里的东西是「原始证据」，整理完也留着（对齐字段后可标注已整理）。
 *   - **不计完整度**（fill: optional）：它是暂存区，不是「该填的格子」——
 *     完整度是「你真正该填什么」的导航，混进暂存区就废了。
 *   - **不放密文**：整袋加密会让「看清单」都要密钥。敏感内容另去「密钥」栏目。
 */
export const SOURCE_FIELD = Object.freeze({
  key: 'source',
  label: '原始资料',
  type: 'source',
  group: 'source',
  fill: 'optional',
  hint: '杂乱资料先原样丢进来（粘贴文字 / 拖文件），之后由 agent 或人按字段字典整理进上面的字段',
} as const);

export const SOURCE_GROUP = Object.freeze({ id: 'source', title: '原始资料' } as const);

/**
 * 「原始资料」字段的**唯一内置规则**：每个非 KV 栏目都自带 source 袋，缺了就补。
 *
 * 与 `syncSectionGroups` 同属「栏目不变量」，三处入口（instantiateTemplate /
 * addSection / normalizeSection）都只调它，内置规则不可能有第二份——
 * 这正是「每个结构自带」的含义：不是模板里的一个可选字段，而是**结构本身的一部分**。
 *
 * @param {{kv?: boolean}} [opts] KV 表不加：它的形状就是「一行一个键值对」，多一个字段就散了
 */
export function ensureSourceBuiltin<G extends { id: string; title: string }, F extends { key: string }>(
  groups: G[] | null | undefined,
  fields: F[] | null | undefined,
  { kv }: { kv?: boolean } = {},
): { groups: Array<G | { id: string; title: string }>; fields: Array<F | typeof SOURCE_FIELD> } {
  const outGroups: Array<G | { id: string; title: string }> = [...(groups || [])];
  const outFields: Array<F | typeof SOURCE_FIELD> = [...(fields || [])];
  if (kv === true) return { groups: outGroups, fields: outFields };
  if (!outGroups.some((g) => g.id === SOURCE_GROUP.id)) outGroups.push({ ...SOURCE_GROUP });
  if (!outFields.some((f) => f.key === SOURCE_FIELD.key)) outFields.push({ ...SOURCE_FIELD });
  return { groups: outGroups, fields: outFields };
}
