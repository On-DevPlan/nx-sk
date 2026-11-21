// 字段字典：条目模板的字段模板是**数据**，不是代码分支。
// agent 与面板都从同一份声明渲染，所以「CLI 能填的字段」与「面板能填的字段」不可能分叉。
//
// type 取值：text | textarea | number | date | month | bool | select | tags | entrylist | table | source | secret | file | md
//
// 实现按职责拆在 ./fields/ 下（templates / policy / diff / lookup / seed / source-bag），
// 这里只做转出，对外 API 与老的 `from '../core/fields.ts'` 导入点完全不变。

// 类型清单与标签的**唯一来源**在 src/shared/fields/types.ts（前后端共用）。
// 这里只做转出，保证老的 `from '../core/fields.ts'` 导入点不用改。
export { FIELD_TYPES, FIELD_TYPE_LABELS } from '../shared/fields/types.ts';

export {
  FILL_POLICIES,
  FILL_LABELS,
  fillPolicy,
  isExcludedField,
  BOOL_TRUE,
  BOOL_FALSE,
  SECRETISH_RE,
  looksSecretish,
  isSensitiveField,
  SCALAR_FIELD_TYPES,
  inferFieldType,
} from './fields/policy.ts';

export type { FieldTemplateDef } from './fields/templates.ts';

export {
  templateIds,
  getTemplate,
  templateSummaries,
  instantiateTemplate,
} from './fields/templates.ts';

export {
  SOURCE_GROUP_KEY,
  SOURCE_FIELD,
  SOURCE_GROUP,
  ensureSourceBuiltin,
  seedTemplates,
  seedEntries,
  blankTemplate,
} from './fields/seed.ts';

export {
  groupFields,
  fieldDrift,
  mergeTemplate,
  fieldByKey,
  fieldByLabel,
} from './fields/diff.ts';

// 层级（组 = 字段）的唯一实现：后端与面板共用同一份（面板从 shared 直接 import）。
export { normalizeStructure, structureOf, boardGroupsOf, isGroupDef, groupKeysOf } from '../shared/fields/structure.ts';

export {
  findTemplate,
  templateNames,
} from './fields/lookup.ts';

