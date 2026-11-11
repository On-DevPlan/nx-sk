// 字段策略与类型推断：填写策略、布尔词表、凭据键名启发式、新键类型推断。

import { looksLikeSourceList } from '../source.ts';

/**
 * 字段的**填写策略**——回答「这个字段值不值得填」，与 type 正交。
 *
 *   normal   照常填（默认；字段定义上不写 `fill` 就是它）
 *   optional 不必填：填了不亏，但没填也不该被算成「缺失」
 *   avoid    回避不填：填了可能反而减分（应届生的「上一家公司」、群众的「入党时间」）
 *
 * 后两者都**不计入完整度的分子与分母**。理由：完整度这个数字是用来导航
 * 「还该补什么」的，如果一批自己决定不填的字段长期压着它，导航就废了。
 * 被排除的字段不会消失——`completeness()` 会单独把它们列在 `excluded` 里。
 */
export const FILL_POLICIES = ['normal', 'optional', 'avoid'];

export const FILL_LABELS = { normal: '照常填', optional: '不必填', avoid: '不填' };

/** 读取侧只看 `fill`，因此入参只声明用到的键。 */
interface FillPolicyInput {
  fill?: unknown;
}

/** 取字段的填写策略，缺省与非法值都归到 `normal`（宽松读，旧数据不用迁移）。 */
export function fillPolicy(def: FillPolicyInput | null | undefined): 'normal' | 'optional' | 'avoid' {
  const v = def && def.fill;
  return (FILL_POLICIES.includes(v as string) ? v : 'normal') as 'normal' | 'optional' | 'avoid';
}

/** 是否被排除在完整度之外（optional / avoid 都是）。 */
export function isExcludedField(def: FillPolicyInput | null | undefined): boolean {
  return fillPolicy(def) !== 'normal';
}

export const BOOL_TRUE = ['是', 'true', '1', 'yes', 'y'];
export const BOOL_FALSE = ['否', 'false', '0', 'no', 'n'];

export function isSensitiveField(
  section: { fields?: Array<{ key: unknown; sensitive?: unknown; type?: unknown }> } | null | undefined,
  key: unknown,
): boolean {
  const def = (section?.fields || []).find((x) => x.key === key);
  return !!(def && (def.sensitive || def.type === 'secret'));
}

// —— 凭据键名启发式 ——
//
// 「自动登记的新键」如果长得像凭据（密码 / 令牌 / 密钥 / 账号…），就**直接建成密文字段**：
// 落盘即 AES-256-GCM 密文。
//
// 为什么要有这条：nx-sk 的用法是「大胆写」——`--set 密码=…` 一把写进去，不必先声明 schema。
// 但如果自动登记一律建成普通文本，那把密码就会**明文躺在 store.json 里**，
// 「大胆」的前提就变成了「不安全」。所以默认值反过来：**看着像凭据就当凭据**。
//
// 判据宽松是有意的：把一个不是凭据的字段多加密一次，代价只是多几行密文；
// 反过来（该加密却没加密）的代价是凭据裸奔。
export const SECRETISH_RE = /(api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|apikey|accesskey|secretkey|privatekey|password|passwd|passphrase|credential|secret|token|pwd|密钥|口令|密码|凭据|凭证|账号|帐号|私钥|访问令牌)/i;

// 整个键就是这些词时也算（避免 'secret' / 'token' 之外的短词被漏掉，如 'key'）。
const SECRETISH_EXACT = new Set(['key', 'keys', 'pass', 'pwd', 'token', 'secret', '密码', '账号', '帐号', '密钥']);

/** 这个键名看起来像凭据吗？——决定自动登记时建成密文字段还是普通字段。 */
export function looksSecretish(key: unknown): boolean {
  const s = String(key || '').trim();
  if (!s) return false;
  if (SECRETISH_EXACT.has(s.toLowerCase())) return true;
  return SECRETISH_RE.test(s);
}

// —— 新键的类型推断（quickAdd / 导入包的回退）——
//
// 原实现在 entries/service.ts；v3 里 transfer 也要用它（包 values 里不在字典的键
// 要推断成伪 def 才能做 file 形态的 remap），所以收进 core——规则只此一份。

// 值像不像附件 id（`f_xxxx`）。用来推断「写了一个没登记过的键」该登记成什么类型：
// `--set 简历附件=f_abc` / `--set 简历附件=f_a,f_b` 应当登记成**附件字段**，
// 而不是一个普通文本字段或 tags。
const looksLikeFileId = (x: unknown) => typeof x === 'string' && /^f_[0-9a-z]+$/i.test(x.trim());
const looksLikeRow = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);

// 标量类型：值就是一个字符串/数字/布尔。能安全地改成密文字段（type: 'secret'）。
// 数组类（file / entrylist / source / tags）有自己的形状，不在自动改型的范围里。
export const SCALAR_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'month', 'bool']);

/**
 * 新字段的类型推断。**刻意不推 number**：
 * 18 位的身份证号 / 长数字 ID 超过 2^53，推成数字会**静默丢精度**。
 * 值仍是字符串，所以「直接存 kv」不会因为类型推断损坏数据。
 */
export function inferFieldType(raw: unknown): string {
  if (Array.isArray(raw)) {
    if (raw.length && raw.every(looksLikeFileId)) return 'file';
    // 一袋 source（带 kind 且有内容）→ 登记成原始资料袋；判断比 entrylist 严，
    // 因为 entrylist 的列也可能叫 kind —— 宁可登记成 entrylist 也不要错认成 source
    if (looksLikeSourceList(raw)) return 'source';
    // 行对象数组登记成结构清单——`--data '{"账号清单":[{…},{…}]}'` 自动建出能渲染的字段
    if (raw.length && raw.every(looksLikeRow)) return 'entrylist';
    return 'tags';
  }
  if (looksLikeFileId(raw)) return 'file';
  if (typeof raw === 'string') {
    const parts = raw.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length && parts.every(looksLikeFileId)) return 'file';
  }
  if (typeof raw === 'boolean') return 'bool';
  const s = String(raw).trim().toLowerCase();
  if (BOOL_TRUE.includes(s) || BOOL_FALSE.includes(s)) return 'bool';
  return 'text';
}
