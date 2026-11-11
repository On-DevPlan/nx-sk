// 内部资源定位符（locator）的**唯一** parse / format / 等价写法规则。
//
// 为什么要有这个文件：nx-sk 里「指向一个内部资源」的文本写法以前散在好几处——
// 条目结构行的复合串 `<section>:<key>`（core/db/identity.ts）、面板的条目定位文本
// （web/frontend/entryRef.ts）、将来的引用型字段值……各写一份迟早分叉。
// 这里收成一处：**语法只定义一次**，前后端共用（本文件保持零运行时依赖，
// 与 shared/fields/types.ts 同一条打包纪律）。
//
// 语法（文本形态，可粘给 agent、可进剪贴板）：
//   nx-sk://section/<sectionId>          栏目
//   nx-sk://entry/<entryId>              条目
//   nx-sk://field/<entryId>/<key>        字段（条目自身结构行；模板字段用 <sectionId> 段，见下）
//   nx-sk://file/<fileId>                附件
//
// 旧写法（磁盘上已存的字符串，**格式一字不改**，locator 只做解析/构造层）：
//   `<sectionId>:<key>`   复合串 = 模板字段（identity.fieldTargetKey / entry_fields.template_field_id
//                         / v1 时代 attachments.target_key 同一口径）——等价于
//                         `nx-sk://field/<sectionId>/<key>`。
//   裸 id（`demo` / `e_1` / `f_1`）  各命令的参数本来就是裸 id，locator 不替换它们。
//
// 稳定性红线：parse 对**任意脏输入**返回 null，绝不抛。

/** 定位符指向的资源种类（与 attachments 的内部指针 kind 同一词汇）。 */
export type LocatorKind = 'section' | 'entry' | 'field' | 'file';

export const LOCATOR_SCHEME = 'nx-sk://';

/** kind 清单（顺序 = 文档/帮助里的展示顺序）。 */
export const LOCATOR_KINDS = ['section', 'entry', 'field', 'file'] as const;

/** 解析结果：按 kind 只填对应的段（field 可能是 entryId 段或 sectionId 段，见文件头）。 */
export interface LocatorParts {
  kind: LocatorKind;
  sectionId?: string;
  entryId?: string;
  key?: string;
  fileId?: string;
}

/** 脏输入的上限：locator 是「短定位文本」，超长的一律不是（也挡住恶意长串）。 */
const MAX_LEN = 512;

/** 段：非空、不含 `/` `\`、不含空白与控制字符（id/key 的生成规则都比这严，这里只做防御）。 */
function isSegment(s: string): boolean {
  if (!s) return false;
  if (/[\s/\\]/.test(s)) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

/**
 * 复合串要挡的「协议样前缀」：`javascript:alert(1)`、`mailto:x@y` 这类文本
 * 语法上恰好长得像 `section:key`，但它们几乎不可能是我们的栏目 id——
 * 与其让 resolve 报 NOT_FOUND，不如在解析层就不认它是 locator。
 * （规范形态 `nx-sk://…` 不受影响：scheme 是固定的，kind 段自己把关。）
 */
const SCHEME_LIKE = new Set([
  'http', 'https', 'ftp', 'ftps', 'ssh', 'git', 'ws', 'wss',
  'file', 'data', 'mailto', 'javascript', 'about', 'chrome', 'edge', 'vscode',
]);

/** 复合串 `<sectionId>:<key>`：恰好一个冒号、两段都合法、不含 `//`（排除 URL scheme）。 */
function parseComposite(s: string): LocatorParts | null {
  if (s.includes('://') || s.includes('/')) return null;
  const cut = s.indexOf(':');
  if (cut <= 0 || s.indexOf(':', cut + 1) >= 0) return null;
  const a = s.slice(0, cut);
  const b = s.slice(cut + 1);
  if (SCHEME_LIKE.has(a.toLowerCase())) return null;
  if (!isSegment(a) || !isSegment(b)) return null;
  return { kind: 'field', sectionId: a, key: b };
}

/**
 * 解析定位符文本。
 * @returns 合法返回各段；**任何**其它输入（空/脏/未知 kind/段数不对/超长/注入样串）返回 null，不抛。
 */
export function parseLocator(s: unknown): LocatorParts | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > MAX_LEN) return null;
  if (!t.startsWith(LOCATOR_SCHEME)) return parseComposite(t);
  const rest = t.slice(LOCATOR_SCHEME.length);
  const first = rest.indexOf('/');
  if (first <= 0) return null;
  const kind = rest.slice(0, first);
  const tail = rest.slice(first + 1);
  if (!(LOCATOR_KINDS as readonly string[]).includes(kind)) return null;
  const segs = tail.split('/');
  if (!segs.every(isSegment)) return null;
  switch (kind) {
    case 'section':
      return segs.length === 1 ? { kind, sectionId: segs[0] } : null;
    case 'entry':
      return segs.length === 1 ? { kind, entryId: segs[0] } : null;
    case 'field':
      // 两段：规范语义是 <entryId>/<key>；<sectionId>/<key> 是模板字段的等价写法
      // （由 locatorAliases 与复合串互转），resolve 侧按「先条目行、再字典」消歧。
      return segs.length === 2 ? { kind, entryId: segs[0], key: segs[1] } : null;
    case 'file':
      return segs.length === 1 ? { kind, fileId: segs[0] } : null;
    default:
      return null;
  }
}

/** 快速取种类（不做完整校验；完整校验用 parseLocator）。脏输入返回 null。 */
export function kindOf(s: unknown): LocatorKind | null {
  return parseLocator(s)?.kind ?? null;
}

/** 快速判定「这个字符串是不是一个定位符」（含旧复合串写法）。 */
export function isLocator(s: unknown): boolean {
  return parseLocator(s) !== null;
}

/**
 * 构造定位符文本（规范形态）。入参不合法时**抛错**——这是构造层，
 * 调用方拿到的应该是 parse/业务代码构造出的 parts，构造出坏 parts 是程序 bug，
 * 静默返回脏文本只会把问题推到磁盘上。
 */
export function formatLocator(parts: LocatorParts | null | undefined): string {
  if (!parts || typeof parts !== 'object') throw new Error('locator parts 无效');
  const { kind } = parts;
  switch (kind) {
    case 'section':
      if (!isSegment(String(parts.sectionId ?? ''))) throw new Error('locator sectionId 无效');
      return `${LOCATOR_SCHEME}section/${parts.sectionId}`;
    case 'entry':
      if (!isSegment(String(parts.entryId ?? ''))) throw new Error('locator entryId 无效');
      return `${LOCATOR_SCHEME}entry/${parts.entryId}`;
    case 'field': {
      const key = String(parts.key ?? '');
      if (!isSegment(key)) throw new Error('locator field key 无效');
      const head = String(parts.entryId ?? parts.sectionId ?? '');
      if (!isSegment(head)) throw new Error('locator field 定位段无效');
      return `${LOCATOR_SCHEME}field/${head}/${key}`;
    }
    case 'file':
      if (!isSegment(String(parts.fileId ?? ''))) throw new Error('locator fileId 无效');
      return `${LOCATOR_SCHEME}file/${parts.fileId}`;
    default:
      throw new Error(`未知 locator kind: ${String(kind)}`);
  }
}

/**
 * 模板字段复合串 `<sectionId>:<key>` 的**唯一构造规则**
 * （identity.fieldTargetKey 与 v3 template_field_id 都走这里，不可能分叉）。
 */
export function formatFieldComposite(sectionId: unknown, key: unknown): string {
  return `${String(sectionId)}:${String(key)}`;
}

/**
 * 等价旧写法：给定定位符（文本或已解析 parts），返回它在**现存数据里可能长成的其它文本**。
 * 用途：拿一个 locator 去匹配磁盘上已存的字符串（复合串、裸 id）时，两边都算命中。
 * 解析不出来的输入返回空数组（不抛）。
 */
export function locatorAliases(loc: unknown): string[] {
  const parts = typeof loc === 'string' ? parseLocator(loc) : (loc as LocatorParts | null);
  if (!parts) return [];
  switch (parts.kind) {
    case 'section':
      // 旧写法就是裸 id（sections 表主键、命令参数同一形态）
      return parts.sectionId ? [parts.sectionId] : [];
    case 'entry':
      return parts.entryId ? [parts.entryId] : [];
    case 'file':
      return parts.fileId ? [parts.fileId] : [];
    case 'field': {
      const key = parts.key ?? '';
      if (!key) return [];
      // 复合串 ↔ nx-sk://field/<head>/<key> 互转：head 是 entryId 段时没有旧写法，
      // 是 sectionId 段（模板字段）时旧写法就是复合串。
      if (parts.sectionId) {
        const composite = formatFieldComposite(parts.sectionId, key);
        const canonical = `${LOCATOR_SCHEME}field/${parts.sectionId}/${key}`;
        return [composite, canonical];
      }
      return [`${LOCATOR_SCHEME}field/${parts.entryId}/${key}`];
    }
    default:
      return [];
  }
}
