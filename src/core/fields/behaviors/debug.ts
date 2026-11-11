import { parseLocator, LOCATOR_SCHEME } from '../../../shared/locator.ts';
import type { FieldBehavior, RefDoc } from '../../../shared/fields/types.ts';
import { identityRemap, identityReveal, noSubFields } from './common.ts';

/**
 * debug（资源引用）：值 = 内部资源定位符（locator）数组的**自描述文档**
 * `{ v: 1, refs: string[] }`——与 entrylist / table 同一条「形状住在数据里」的纪律。
 *
 * 第四条（任务 #21 验收反馈：「debug字段引用具体的字段数据 不要引用结构」
 * 「结果至少是条目/条目-字段」）：**结构引用不收**——`nx-sk://section/…` 在
 * coerce 层就丢弃进 warnings（语法上无歧义，不用查库）；模板字段引用
 * `nx-sk://field/<栏目id>/<key>` 要查库才知道 head 是栏目还是条目，那条在
 * 写入封装 `seal/debug.ts` 里执行。引用要绑到**数据位置**（条目/条目-字段/附件），
 * 面板的格子才可能内联显示绑定位置的实时值（内联数据板）。
 *
 * 三条刻意的取舍（任务 #18 用户裁决）：
 *   - **引用本身不敏感**：sensitive 恒 false，`--mask` 不特殊处理——
 *     敏感的是被引用的内容（密文值在 resolve/预览侧打码，见 modules/resources）。
 *   - **非法引用丢弃并计入 warnings，不炸**：引用是「贴进来的文本」，
 *     脏一条不该让整次写入失败；丢掉的原文进 `warnings` 键，台账与面板都看得见。
 *   - **只收规范形态**（`nx-sk://…`）：复合串 `section:key` 是磁盘旧格式，
 *     解析层兼容读它（locator.parseLocator），但新写入一律立即可复制、可粘给 agent 的规范串。
 */
export const debugBehavior: FieldBehavior = {
  cell: false,
  normalizeDef: () => {},
  coerce(def, raw) {
    // 三种入口：数组（面板/JSON）、JSON 串（--set，行数组或整份文档）、单个 locator 串。
    let list: unknown = raw;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return { v: 1, refs: [] } satisfies RefDoc; // 「--set 字段=」（空值）= 清空
      try { list = JSON.parse(s); } catch { list = null; }
      if (list === null) list = [s]; // 不是 JSON 就当单个 locator（与 file 的逗号拆不同：locator 里没有逗号语义）
    }
    if (list && typeof list === 'object' && !Array.isArray(list) && Array.isArray((list as RefDoc).refs)) {
      list = (list as RefDoc).refs; // 文档形状（面板整体回传 / --data 给 {v,refs}）
    }
    if (!Array.isArray(list)) list = list === null || list === undefined ? [] : [list];
    const inputs: unknown[] = list as unknown[];
    const refs: string[] = [];
    const warnings: string[] = [];
    for (const item of inputs) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      // 只认规范形态：parse 认旧复合串，但写入点不收（存进库的必须能一眼认出是 locator）
      const parts = text.startsWith(LOCATOR_SCHEME) ? parseLocator(text) : null;
      if (!parts) { warnings.push(text); continue; }
      // #21：栏目引用 = 结构，不是数据位置，不收（模板字段引用在 seal 层查库拒）
      if (parts.kind === 'section') {
        warnings.push(`${text}（结构引用不支持：至少引用到条目/条目-字段/附件）`);
        continue;
      }
      const canonical = `${LOCATOR_SCHEME}${parts.kind}/${parts.kind === 'field' ? `${parts.entryId ?? parts.sectionId}/${parts.key}` : (parts.sectionId ?? parts.entryId ?? parts.fileId)}`;
      if (!refs.includes(canonical)) refs.push(canonical);
    }
    if (def?.maxItems && refs.length > def.maxItems) {
      warnings.push(`超过上限 ${def.maxItems} 条，多出的已丢弃`);
      refs.length = def.maxItems;
    }
    const doc: RefDoc = { v: 1, refs };
    if (warnings.length) doc.warnings = warnings;
    return doc;
  },
  reveal: identityReveal,
  // 引用附件库的 file locator 算附件引用（fileReferences 的探针认这条载体；
  // 栏目/条目/字段引用不是附件引用）。
  refs: (_def, value) => {
    const refs = (value && typeof value === 'object' && Array.isArray((value as RefDoc).refs))
      ? (value as RefDoc).refs
      : [];
    const out: string[] = [];
    for (const r of refs) {
      const parts = parseLocator(r);
      if (parts?.kind === 'file' && parts.fileId) out.push(parts.fileId);
    }
    return out;
  },
  remap: identityRemap,
  format: (_def, value) => {
    const refs = (value && typeof value === 'object' && Array.isArray((value as RefDoc).refs))
      ? (value as RefDoc).refs
      : (Array.isArray(value) ? value.map(String) : []);
    const warnings = (value && typeof value === 'object' && Array.isArray((value as RefDoc).warnings))
      ? (value as RefDoc).warnings!
      : [];
    // 台账只显示计数与 locator 列表，**不展开内容**（避免刷屏；内容走 resource resolve）
    const lines = [`引用 ${refs.length} 个资源`];
    for (const r of refs) lines.push(`  ${r}`);
    for (const w of warnings) lines.push(`  [引用已忽略] ${w}`);
    return lines;
  },
  // 引用本身不敏感（预览内容才敏感，那条边界在 resolve/预览出口执行）。
  sensitive: () => false,
  subFields: noSubFields,
};
