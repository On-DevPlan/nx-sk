// grill（Grill & Ack）字段：值是一份 JSON 表单，AI 写问题、用户写答案、面板写 ack。
//
// 这里只做「形状归一 + 读出去」；提问/回答的 UI 在 web，不在这里。
// 与 shortcut 同一条纪律：一个问题单不是一串字符串，硬当文本存会丢掉答案与确认状态。
import { badInput } from '../../errors.ts';
import { isCipherBlob } from '../../crypto.ts';
import { displaySensitive } from '../../sensitive.ts';
import {
  formatGrill, grillSummary, parseGrill,
} from '../../../shared/grill.ts';
import type { FieldBehavior, GrillDoc } from '../../../shared/fields/types.ts';
import { identityRemap, isSensitiveDef, noRefs, noSubFields } from './common.ts';

function parseForRead(raw: unknown, opts: { mask?: boolean; decrypt?: (blob: unknown) => string }): GrillDoc | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let value = raw;
  if (isCipherBlob(value)) {
    // 被标成 sensitive 的历史值可能是一整个密文 blob；先走同一条打码/解密边界。
    const plain = displaySensitive(value, opts);
    if (plain === null) return null;
    value = plain;
  }
  try {
    return parseGrill(value);
  } catch {
    return null;
  }
}

export const grillBehavior: FieldBehavior = {
  cell: false,
  // 问题、候选、标题都在**值**里，字段定义不复制一份结构；没有需要校验的定义键。
  normalizeDef: () => {},
  coerce(def, raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    try {
      const doc = parseGrill(raw);
      const hasContent = doc.questions.length > 0
        || Boolean(doc.title || doc.intro || doc.prompt || doc.freeform)
        || doc.ack.status === 'acknowledged';
      return hasContent ? doc : null;
    } catch (e) {
      throw badInput(`字段「${def.label}」的对齐单有问题：${(e as Error).message}`);
    }
  },
  reveal: (def, raw, opts) => parseForRead(raw, opts),
  refs: noRefs,
  remap: identityRemap,
  format: (_def, value) => {
    if (!value || typeof value !== 'object') return null;
    try {
      return formatGrill(parseGrill(value));
    } catch {
      return null;
    }
  },
  sensitive: isSensitiveDef,
  subFields: noSubFields,
};

/** template dump / 列表摘要用的一行：确认状态 + 必答进度。 */
export function grillBrief(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return grillSummary(parseGrill(value));
  } catch {
    return null;
  }
}
