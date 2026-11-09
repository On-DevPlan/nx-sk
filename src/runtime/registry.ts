// 模块注册表 + **装载期自检**：重复的 action id / CLI 路径 / HTTP 路由在启动瞬间就炸，
// 而不是等某个用户敲到那条命令才发现。
import { APP_NAME } from '../core/paths.ts';
import { cliPathsOf, usageOf } from './spec.ts';
import type { Action } from './spec.ts';
import { loadModules } from './module-registry.ts';
import type { ModuleDecl } from './module-registry.ts';

// 模块注册 = **目录即声明**：`src/modules/<id>/index.js` 的 default 就是模块本身。
// 这里不再手抄 import 清单（第二个声明点 = 漏写静默消失的入口）。
// 装载期断言在 module-registry.js：缺 index.js / id 与目录名不一致 / 缺 title·order / id 重复，
// 都会在进程启动时直接抛，而不是等用户敲到那条命令才发现。
//
// 顺序 = help 分组顺序（system 放最后，它是聚合模块）。
// 模块只声明「对外接口」（action），不声明视图——面板的 tab 由前端 registry 自己登记。
export const MODULES: ModuleDecl[] = (await loadModules()).sort((a, b) => (a.order || 50) - (b.order || 50));

export const MODULE_TITLES: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.id, m.title]));

export const ACTIONS: (Action & { module: string })[] = MODULES.flatMap((m) => (m.actions || []).map((a) => ({ ...a, module: m.id })));

export interface CommandEntry {
  id: string;
  module: string;
  command: string;
  usage: string;
  summary: string;
  http: string | null;
  aliases: string[];
}

/** 命令表的一行——`help` / `routes` / bootstrap 共用同一份，不存在「第二张命令表」。 */
export function commandEntry(a: Action & { module: string }): CommandEntry {
  const paths = cliPathsOf(a);
  return {
    id: a.id,
    module: a.module,
    command: `${APP_NAME} ${paths[0].join(' ')}`,
    usage: usageOf(a),
    summary: a.summary || '',
    http: Array.isArray(a.http) ? a.http.join(' ') : null,
    aliases: paths.slice(1).map((p) => `${APP_NAME} ${p.join(' ')}`),
  };
}

/** 装载期自检。导出成纯函数，好让测试能用一份**故意写坏的清单**验证它真的会红。 */
export function selfCheckActions(actions: (Action & { module: string })[]) {
  const ids = new Map<string, Action & { module: string }>();
  const cliKeys = new Map<string, string>();
  const httpKeys = new Map<string, string>();
  for (const a of actions) {
    if (!a.id) throw new Error(`action 缺少 id（模块 ${a.module}）`);
    if (ids.has(a.id)) throw new Error(`action id 重复: ${a.id}`);
    ids.set(a.id, a);

    const paths = cliPathsOf(a);
    if (!paths.length) throw new Error(`action 没有 CLI 命令: ${a.id}`);
    for (const p of paths) {
      const k = p.join(' ');
      if (cliKeys.has(k)) throw new Error(`CLI 路径重复: ${k}（${a.id} 与 ${cliKeys.get(k)}）`);
      cliKeys.set(k, a.id);
    }

    if (a.http !== null && a.http !== undefined) {
      if (!Array.isArray(a.http) || a.http.length !== 2) throw new Error(`http 既不是数组也不是 null: ${a.id}`);
      const k = `${a.http[0]} ${a.http[1]}`;
      if (httpKeys.has(k)) throw new Error(`HTTP 路由重复: ${k}（${a.id} 与 ${httpKeys.get(k)}）`);
      httpKeys.set(k, a.id);
    }
    if (typeof a.run !== 'function') throw new Error(`action 缺少 run: ${a.id}`);
  }
  return { ids, cliKeys, httpKeys };
}

export const SELF_CHECK = selfCheckActions(ACTIONS);



