// 库入口：导出各模块 service，供程序化调用（别的项目可以 `import { entries } from 'nx-sk'`）。
export * as system from './modules/system/service.ts';
export * as settings from './modules/settings/service.ts';
export * as sections from './modules/sections/service.ts';
export * as entries from './modules/entries/service.ts';
export * as transfer from './modules/transfer/service.ts';
export * as skill from './modules/skill/service.ts';

export { CODES, AppError } from './core/errors.ts';
export { APP_NAME, VERSION, appHome, storeFile, dbFile } from './core/paths.ts';
export { loadStore, saveStore, mutateStore, storePathInUse } from './core/store.ts';
export { MODULES, ACTIONS, commandEntry } from './runtime/registry.ts';
export { ALL_COMMANDS } from './runtime/cli.ts';
