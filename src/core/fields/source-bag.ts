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
 *
 * 0.42：袋子本身也变成一个**组字段**（type='group'）——它包着 source 一条字段，
 * 于是「原始资料」既是字段值，又是面板上的一块，不需要栏目级的分组声明。
 * 组字段的 key 不能与 source 字段的 key 重名（字段 key 全栏目唯一），故用 `sourceGroup`。
 */
export const SOURCE_FIELD = Object.freeze({
  key: 'source',
  label: '原始资料',
  type: 'source',
  fill: 'optional',
  hint: '杂乱资料先原样丢进来（粘贴文字 / 拖文件），之后由 agent 或人按字段字典整理进上面的字段',
} as const);

/** 原始资料袋的**组字段 key**（内部标识；用户看到的只有 label）。 */
export const SOURCE_GROUP_KEY = 'sourceGroup';

export const SOURCE_GROUP = Object.freeze({ key: SOURCE_GROUP_KEY, label: '原始资料', title: '原始资料' } as const);

/**
 * 「原始资料」字段的**唯一内置规则**：每个非 KV 栏目都自带 source 袋，缺了就补。
 *
 * 与 `normalizeStructure` 同属「栏目不变量」，三处入口（instantiateTemplate /
 * addSection / normalizeSection）都只调它，内置规则不可能有第二份——
 * 这正是「每个结构自带」的含义：不是模板里的一个可选字段，而是**结构本身的一部分**。
 *
 * @param {{kv?: boolean}} [opts] KV 表不加：它的形状就是「一行一个键值对」，多一个字段就散了
 */
export function ensureSourceBuiltin<F extends { key: string; type?: string; keys?: unknown; label?: string }>(
  fields: F[] | null | undefined,
  { kv }: { kv?: boolean } = {},
): F[] {
  const out: F[] = [...(fields || [])];
  if (kv === true) return out;
  const hasField = out.some((f) => String(f.key) === SOURCE_FIELD.key);
  if (!hasField) out.push({ ...SOURCE_FIELD } as unknown as F);
  // 组字段缺失就补在末尾（与历史「袋在最后」的显示顺序一致）。
  if (!out.some((f) => String(f.key) === SOURCE_GROUP_KEY)) {
    out.push({ key: SOURCE_GROUP_KEY, label: SOURCE_GROUP.label, type: 'group', keys: [SOURCE_FIELD.key] } as unknown as F);
    return out;
  }
  // 组在、但 source 字段被挪进了别的组：把它收回袋里（袋是 source 字段唯一的家）。
  return out.map((f) => {
    if (String(f.key) !== SOURCE_GROUP_KEY) {
      if (Array.isArray((f as { keys?: unknown }).keys)) {
        const keys = ((f as { keys?: string[] }).keys || []).filter((k) => k !== SOURCE_FIELD.key);
        return { ...f, keys } as F;
      }
      return f;
    }
    const keys = Array.isArray((f as { keys?: unknown }).keys) ? ((f as { keys?: string[] }).keys || []).map(String) : [];
    return { ...f, keys: keys.includes(SOURCE_FIELD.key) ? keys : [...keys, SOURCE_FIELD.key] } as F;
  });
}

