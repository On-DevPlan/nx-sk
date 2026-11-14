// 门面：条目模块按职责拆到同目录的 shared / crud / fields / ledger / source 五个文件后，
// 这里只做 re-export，保证既有调用方（src/modules/entries/index.ts、tests/**、src/index.ts）
// 的 import 路径与导出名集合**一个不多一个不少**。
export { mustFindSection, resolveEntry } from './shared.ts';
export {
  addEntry, getEntry, listEntries, removeEntry, removeMany,
  renderEntryChange, renderEntryGet, renderEntryList, renderEntryRemoveMany, updateEntry,
} from './crud.ts';
export {
  addEntryField, fieldDictionary, getTable, removeEntryField, renderEntryAddField,
  renderEntryRemoveField, renderEntryUpdateField, renderFields, renderTable, updateEntryFieldDef,
} from './fields.ts';
export {
  keyGet, keyList, keyRemove, keySet, keysLedger,
  renderKeyGet, renderKeyList, renderKeyRemove, renderKeySet, renderKeysLedger,
} from './ledger.ts';
export {
  addSourceItem, ensureSourceFields, getSource, listSource, removeSourceItem,
  renderSourceChange, renderSourceGet, renderSourceList, updateSourceItem,
} from './source.ts';
export {
  getEntryHistory, getFieldHistory, restoreFieldVersion,
  renderEntryHistory, renderFieldHistory, renderFieldRestore,
} from './history.ts';
