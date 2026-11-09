// 字段行为的**唯一注册表**。
//
// `Record<FieldType, FieldBehavior>` 是编译期兜底：`FIELD_TYPES` 里加一项而这里没加，
// `tsc -b` 会报「缺少属性」。运行时另有 `behaviorOf()` 兜底到 text —— 那是为了
// store.json 里出现历史脏类型时不至于整个面板/CLI 崩掉，不是漏实现的许可。
//
// 为什么要注册表而不是 if/else：同一件事（怎么强转、哪些子值是密文、引用哪些附件）
// 以前散在 entries / render / vault / attachments / transfer / sections 六个文件里，
// 加一种类型要改六处、漏一处不会报错。收成一张表之后，加类型只需要「加行为文件 + 加一行」，
// 漏了由类型系统当场拦住。
import { FIELD_TYPES } from '../../shared/fields/types.ts';
import type { FieldBehavior, FieldType } from '../../shared/fields/types.ts';
import { textBehavior } from './behaviors/text.ts';
import { textareaBehavior } from './behaviors/textarea.ts';
import { numberBehavior } from './behaviors/number.ts';
import { dateBehavior } from './behaviors/date.ts';
import { monthBehavior } from './behaviors/month.ts';
import { boolBehavior } from './behaviors/bool.ts';
import { selectBehavior } from './behaviors/select.ts';
import { tagsBehavior } from './behaviors/tags.ts';
import { entrylistBehavior } from './behaviors/entrylist.ts';
import { tableBehavior } from './behaviors/table.ts';
import { sourceBehavior } from './behaviors/source.ts';
import { secretBehavior } from './behaviors/secret.ts';
import { fileBehavior } from './behaviors/file.ts';
import { mdBehavior } from './behaviors/md.ts';

export const FIELD_BEHAVIOR: Record<FieldType, FieldBehavior> = {
  text: textBehavior,
  textarea: textareaBehavior,
  number: numberBehavior,
  date: dateBehavior,
  month: monthBehavior,
  bool: boolBehavior,
  select: selectBehavior,
  tags: tagsBehavior,
  entrylist: entrylistBehavior,
  table: tableBehavior,
  source: sourceBehavior,
  secret: secretBehavior,
  file: fileBehavior,
  md: mdBehavior,
};

/** 八个钩子 + `cell` —— 断言用的权威清单。 */
export const FIELD_BEHAVIOR_HOOKS = [
  'normalizeDef', 'coerce', 'reveal', 'refs', 'remap', 'format', 'sensitive', 'subFields',
] as const;

/**
 * 取某类型的行为。类型不在清单里（历史脏数据）时退到 text ——
 * 与 P2 之前「未知类型走通用文本分支」的可见行为一致。
 */
export function behaviorOf(type: string): FieldBehavior {
  return (FIELD_BEHAVIOR as Record<string, FieldBehavior>)[type] ?? FIELD_BEHAVIOR.text;
}

/**
 * 启动期自检：键集双向、钩子齐全、探针不抛。
 *
 * 编译期已经保证了键集，这里再查一遍是因为 `FIELD_BEHAVIOR` 可能被 `as` 断言或
 * 运行时拼装绕过；启动即报错比「某个类型默默走 text 兜底」容易查得多。
 */
export function assertFieldRegistry(): true {
  const keys = Object.keys(FIELD_BEHAVIOR).sort();
  const expected = [...FIELD_TYPES].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`字段注册表与 FIELD_TYPES 不一致：注册表 [${keys.join(', ')}]，清单 [${expected.join(', ')}]`);
  }
  for (const type of FIELD_TYPES) {
    const behavior: any = FIELD_BEHAVIOR[type];
    for (const hook of FIELD_BEHAVIOR_HOOKS) {
      if (typeof behavior[hook] !== 'function') {
        throw new Error(`字段类型 ${type} 缺钩子 ${hook}`);
      }
    }
    if (typeof behavior.cell !== 'boolean') {
      throw new Error(`字段类型 ${type} 的 cell 必须是布尔值`);
    }
    // 探针：纯查询钩子对空值也必须给出结果，不允许「读到空值就炸」
    const probe = { key: 'probe', label: '探针', type, group: 'other' } as any;
    behavior.sensitive(probe);
    behavior.subFields(probe);
    behavior.refs(probe, null);
    behavior.format(probe, null, {});
    behavior.reveal(probe, null, {});
  }
  return true;
}

assertFieldRegistry();
