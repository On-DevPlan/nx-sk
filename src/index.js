// 库入口：导出各模块 service，供程序化调用（别的项目可以 `import { entries } from 'nx-sk'`）。
export * as system from './modules/system/service.js';
export * as settings from './modules/settings/service.js';
export * as sections from './modules/sections/service.js';
export * as entries from './modules/entries/service.js';
export * as transfer from './modules/transfer/service.js';
export * as skill from './modules/skill/service.js';

export { CODES, AppError } from './core/errors.js';
export { APP_NAME, VERSION, appHome, storeFile } from './core/paths.js';
export { loadStore, saveStore, mutateStore, storePathInUse } from './core/store.js';
export { MODULES, ACTIONS, commandEntry } from './runtime/registry.js';
export { ALL_COMMANDS } from './runtime/cli.js';
