// 模块注册表 + **装载期自检**：重复的 action id / CLI 路径 / HTTP 路由在启动瞬间就炸，
// 而不是等某个用户敲到那条命令才发现。
import { APP_NAME } from '../core/paths.js';
import { cliPathsOf, usageOf } from './spec.js';

import sections from '../modules/sections/index.js';
import entries from '../modules/entries/index.js';
import files from '../modules/files/index.js';
import exportModule from '../modules/export/index.js';
import backup from '../modules/backup/index.js';
import skill from '../modules/skill/index.js';
import settings from '../modules/settings/index.js';
import system from '../modules/system/index.js';

// 顺序 = 面板 tab 顺序与 help 分组顺序（system 放最后，它是聚合模块）
export const MODULES = [sections, entries, files, exportModule, backup, skill, settings, system]
  .slice()
  .sort((a, b) => (a.order || 50) - (b.order || 50));

export const MODULE_TITLES = Object.fromEntries(MODULES.map((m) => [m.id, m.title]));

export const ACTIONS = MODULES.flatMap((m) => (m.actions || []).map((a) => ({ ...a, module: m.id })));

/** 命令表的一行——`help` / `routes` / bootstrap 共用同一份，不存在「第二张命令表」。 */
export function commandEntry(a) {
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
export function selfCheckActions(actions) {
  const ids = new Map();
  const cliKeys = new Map();
  const httpKeys = new Map();
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
