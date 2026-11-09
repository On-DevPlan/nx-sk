// 模块装载器：**目录即声明**。
//
// 一个模块的唯一声明是 `src/modules/<id>/index.js` 的 default 导出；
// 注册表（runtime/registry.js）不再手抄一份 import + 数组——那是第二个声明点，
// 漏写只会让模块静默消失（help 少一组、路由整片 404），没有任何断言会红。
//
// 装载期把「目录在、模块却不在」的形态直接抛出去：
//   - 目录里没有 index.js
//   - index.js 加载失败
//   - default 不是模块对象 / 缺 id / id 与目录名不一致 / 缺 title / 缺 order
//   - 两个模块声明了同一个 id
//
// 自检导出成纯函数（`assertModuleShape` / `assertModuleRegistry`），测试可以喂一份
// 故意写坏的清单，验证它真的会红，而不是只验证「正常时没报错」。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Action } from './spec.ts';

export interface ModuleDecl {
  id: string;
  title: string;
  order: number;
  actions?: Action[];
}

const DEFAULT_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** 磁盘上有哪些模块目录。排序只为让装载/报错顺序稳定（最终顺序由模块的 order 决定）。 */
export function listModuleIds(dir = DEFAULT_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** 单个模块的形状自检。`dirName` 传入时还会核对「id 必须等于目录名」。 */
export function assertModuleShape(mod: ModuleDecl | undefined, dirName?: string): asserts mod is ModuleDecl {
  const where = dirName ? `src/modules/${dirName}` : '模块';
  if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
    throw new Error(`${where} 的 default 导出必须是模块对象`);
  }
  if (!mod.id) throw new Error(`${where} 缺少 id`);
  if (dirName && mod.id !== dirName) {
    throw new Error(`模块 id 与目录名不一致: ${mod.id}（目录 ${dirName}）—— 目录是唯一声明，id 必须跟着目录走`);
  }
  if (typeof mod.title !== 'string' || !mod.title) throw new Error(`模块 ${mod.id} 缺少 title（help 分组要用）`);
  if (typeof mod.order !== 'number') throw new Error(`模块 ${mod.id} 缺少 order（help 分组顺序靠它）`);
  if (mod.actions !== undefined && !Array.isArray(mod.actions)) throw new Error(`模块 ${mod.id} 的 actions 必须是数组`);
}

/** 模块集合自检：id 不得重复。 */
export function assertModuleRegistry(modules: ModuleDecl[]): Map<string, ModuleDecl> {
  const seen = new Map<string, ModuleDecl>();
  for (const m of modules) {
    if (seen.has(m.id)) throw new Error(`模块 id 重复: ${m.id}`);
    seen.set(m.id, m);
  }
  return seen;
}

/**
 * 扫描目录并装载全部模块。
 * `dir` 参数只为测试留口：生产调用不传，始终扫 `src/modules`。
 */
export async function loadModules(dir = DEFAULT_DIR): Promise<ModuleDecl[]> {
  const modules: ModuleDecl[] = [];
  for (const id of listModuleIds(dir)) {
    // 先找 index.ts（P4 迁移目标），回退 index.js（存量）
    let file = join(dir, id, 'index.ts');
    if (!existsSync(file)) file = join(dir, id, 'index.js');
    if (!existsSync(file)) {
      throw new Error(`src/modules/${id} 缺少 index.ts / index.js——模块目录必须 default 导出模块对象，否则它不会出现在 help / 路由里`);
    }
    let mod: ModuleDecl | undefined;
    try {
      mod = (await import(pathToFileURL(file).href)).default as ModuleDecl | undefined;
    } catch (err) {
      throw new Error(`模块 ${id} 的 index 加载失败：${(err as Error).message}`);
    }
    assertModuleShape(mod, id);
    modules.push(mod);
  }
  assertModuleRegistry(modules);
  return modules;
}



