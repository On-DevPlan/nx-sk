// 写入封装的**唯一注册表**。
//
// `Record<FieldType, SealHook | null>` 是编译期兜底：`FIELD_TYPES` 加一项而这里没加，
// `tsc -b` 会报「缺少属性」。`null` 是**显式决定**（这种类型没有类型级的封装逻辑），
// 不是遗漏——真正的遗漏是「键不存在」，编译期就会红。
//
// 为什么只有三个非 null：entrylist 要封每一行的敏感列，table 要封敏感列，
// secret 永远要封。其余类型若字段定义标了 `sensitive: true`，走 entries 写入路径里
// 与类型无关的那条标量分支（`sealScalar`），不需要在表里重复一遍。
import type { FieldType, SealHook } from '../../../shared/fields/types.ts';
import { sealEntryList } from './entrylist.ts';
import { sealTable } from './table.ts';
import { sealScalar } from './common.ts';

export const FIELD_SEAL: Record<FieldType, SealHook | null> = {
  text: null,
  textarea: null,
  number: null,
  date: null,
  month: null,
  bool: null,
  select: null,
  tags: null,
  entrylist: sealEntryList,
  table: sealTable,
  source: null,
  secret: sealScalar,
  file: null,
  md: null,
};

/** 取某类型的写入封装；没有类型级逻辑时返回 null（调用方再走敏感标量分支）。 */
export function sealOf(type: string): SealHook | null {
  return (FIELD_SEAL as Record<string, SealHook | null>)[type] ?? null;
}
