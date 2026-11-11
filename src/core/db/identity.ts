// attachments 的身份规则（唯一实现，仿 nx-kv core/attachmentdb.js）。
//
// 为什么收在一个模块：id 是「同一逻辑资源在库里只有一行」的全部依据。
// 散在两处（导入算一遍、运行时算一遍）迟早分叉，分叉的表现是重复行 +
// dedupe 唯一索引炸写入，而且报错离根因很远。
//
// 规则（v1.sql 的注释同一口径）：
//   file    → id = FileRecord.id **原样**（`f_...`）：条目 values 里嵌的附件 id
//             一字不改，这是「不在运行时做旧结构兼容」的边界——引用本来就稳定。
//   url     → att_url_<sha1(小写 url)[0:16]>
//   section → att_section_<sha1(id)[0:16]>
//   entry   → att_entry_<sha1(id)[0:16]>
//   field   → att_field_<sha1(section + ':' + key)[0:16]>（target_key = "<section>:<key>" 复合串）
import { createHash } from 'node:crypto';

/** 资源种类（封闭枚举，与 v1.sql 的 CHECK 同一份清单，由单测钉住漂移）。 */
export const ATTACHMENT_KINDS = ['file', 'url', 'section', 'entry', 'field'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** 内部指针种类（kind ∈ 这三个时 target_kind/target_key 有值）。 */
export const POINTER_KINDS = ['section', 'entry', 'field'] as const;

/** 边的语义（role 在边上，不在资源上——照抄 nx-kv 的纪律）。 */
export const EDGE_ROLES = ['inline', 'attach', 'source'] as const;
export type EdgeRole = (typeof EDGE_ROLES)[number];

function sha1_16(s: string): string {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/** field 的复合定位串。 */
export function fieldTargetKey(sectionId: unknown, key: unknown): string {
  return `${String(sectionId)}:${String(key)}`;
}

export function attIdForUrl(url: unknown): string {
  return 'att_url_' + sha1_16(String(url || '').toLowerCase());
}

export function attIdForSection(sectionId: unknown): string {
  return 'att_section_' + sha1_16(String(sectionId));
}

export function attIdForEntry(entryId: unknown): string {
  return 'att_entry_' + sha1_16(String(entryId));
}

export function attIdForField(sectionId: unknown, key: unknown): string {
  return 'att_field_' + sha1_16(fieldTargetKey(sectionId, key));
}

/** 按种类算内部指针的 (id, target_kind, target_key)；file/url 不走这里（id 自带）。 */
export function pointerIdentity(kind: AttachmentKind, ref: { sectionId?: string; key?: string; entryId?: string }): { id: string; targetKind: string; targetKey: string } {
  if (kind === 'section') {
    const id = String(ref.sectionId || '');
    return { id: attIdForSection(id), targetKind: 'section', targetKey: id };
  }
  if (kind === 'entry') {
    const id = String(ref.entryId || '');
    return { id: attIdForEntry(id), targetKind: 'entry', targetKey: id };
  }
  if (kind === 'field') {
    const tk = fieldTargetKey(ref.sectionId, ref.key);
    return { id: attIdForField(ref.sectionId, ref.key), targetKind: 'field', targetKey: tk };
  }
  throw new Error(`pointerIdentity 只认内部种类（section/entry/field），收到 ${kind}`);
}
