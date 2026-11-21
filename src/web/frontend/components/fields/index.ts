// 面板侧的**唯一控件注册表**。
//
// `Record<FieldType, Control>` 是编译期兜底：`FIELD_TYPES` 里加一项而这里没加，
// `tsc -b` 会报「缺少属性」；运行时另有 `controlOf()` 兜底到 TextControl —— 那是为了
// store.json 里出现历史脏类型时不至于整个面板白屏，不是漏实现的许可。
//
// 为什么要注册表而不是 if/else：重构前 `fieldEditor.jsx` 是一串 14 个 `if (type === …)`，
// 加一种类型要顺着读到底、漏一个只会静默退化成文本框，没有任何断言会红。
// 收成一张表之后，加类型只需要「加控件文件 + 加一行」。
import type { FieldType } from '../../../../shared/fields/types.ts';
import type { Control } from './types.ts';
import { TextControl } from './text/index.tsx';
import { TextareaControl } from './textarea/index.tsx';
import { NumberControl } from './number/index.tsx';
import { DateControl } from './date/index.tsx';
import { MonthControl } from './month/index.tsx';
import { BoolControl } from './bool/index.tsx';
import { SelectControl } from './select/index.tsx';
import { TagsControl } from './tags/index.tsx';
import { EntryListControl } from './entrylist/index.tsx';
import { TableControl } from './table/index.tsx';
import { SourceControl } from './source/index.tsx';
import { ShortcutControl } from './shortcut/index.tsx';
import { SecretControl } from './secret/index.tsx';
import { FileControl } from './file/index.tsx';
import { MdControl } from './md/index.tsx';
import { GroupControl } from './group/index.tsx';
import { DebugControl } from './debug/index.tsx';
import { GrillControl } from './grill/index.tsx';

export const FIELD_CONTROLS: Record<FieldType, Control> = {
  text: TextControl,
  textarea: TextareaControl,
  number: NumberControl,
  date: DateControl,
  month: MonthControl,
  bool: BoolControl,
  select: SelectControl,
  tags: TagsControl,
  entrylist: EntryListControl,
  table: TableControl,
  source: SourceControl,
  shortcut: ShortcutControl,
  secret: SecretControl,
  file: FileControl,
  md: MdControl,
  group: GroupControl,
  debug: DebugControl,
  grill: GrillControl,
};

/**
 * 取某类型的控件。类型不在清单里（历史脏数据）时退到单行文本 ——
 * 与重构前 `fieldEditor` 最后一支 `return <input type="text">` 的可见行为一致。
 */
export function controlOf(type: string): Control {
  return (FIELD_CONTROLS as Record<string, Control>)[type] ?? TextControl;
}

