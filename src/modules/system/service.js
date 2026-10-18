// system 是聚合模块：它读各处的状态拼上下文，不产生业务实体，所以没有视图。
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { APP_LABEL, APP_NAME, ENV_HOME, ENV_PASSPHRASE, ENV_STORE, VERSION, appHome, displayPath, storeFile } from '../../core/paths.js';
import { loadStore, corruptNote, migrationNote, storePathInUse } from '../../core/store.js';
import { vaultStatus } from '../../core/vault.js';
import { FIELD_TYPES, FIELD_TYPE_LABELS, templateSummaries } from '../../core/fields.js';
import { blocked } from '../../core/errors.js';
import { compileRoute, usageOf } from '../../runtime/spec.js';

/**
 * 命令表在 runtime/registry.js，而分层规则说模块不能向上依赖 runtime。
 * 用**函数体内的动态 import** 破环：静态 import 会成环，动态 import 不会
 * （调用发生在启动完成之后，registry 早已求值完毕）。
 */
async function commandTable() {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  return ALL_COMMANDS.map(commandEntry);
}

export async function bootstrapInfo() {
  const store = await loadStore();
  const p = storePathInUse();
  const commands = await commandTable();
  const bySection = {};
  for (const e of store.entries) bySection[e.section] = (bySection[e.section] || 0) + 1;
  return {
    app: { name: APP_NAME, label: APP_LABEL, version: VERSION, node: process.version, platform: process.platform },
    home: displayPath(appHome()),
    storePath: displayPath(p),
    storePathRaw: p,
    envOverrides: {
      [ENV_HOME]: process.env[ENV_HOME] || null,
      [ENV_STORE]: process.env[ENV_STORE] || null,
      [ENV_PASSPHRASE]: process.env[ENV_PASSPHRASE] ? '已设置（口令模式）' : null,
    },
    settings: store.settings,
    // kv 必须带上：bootstrap 是 agent 的首选入口，它得能一眼看出「哪个栏目是 KV 表」
    // （缺这字段时 agent 只能猜 `/api/sections` 再去查，等于多一次往返）。
    sections: store.sections.map((s) => ({
      id: s.id, title: s.title, description: s.description, order: s.order, template: s.template,
      kv: s.kv === true, titleLabel: s.titleLabel, fields: s.fields.length, entries: bySection[s.id] || 0,
    })),
    counts: { sections: store.sections.length, entries: store.entries.length, commands: commands.length },
    vault: await vaultStatus(),
    templates: templateSummaries(),
    // 字段类型是**封闭枚举**（面板要按类型渲染控件，不能随便加）。这里下发唯一一份，
    // 面板的「新增字段」下拉框据此渲染 —— 面板自己再抄一份清单的话，
    // 「后端加了一种类型、下拉框里永远看不到」这种错没人会发现。
    fieldTypes: FIELD_TYPES,
    // 类型的中文名，只给面板下拉框用（渲染成「图文（可贴图）（md）」）
    fieldTypeLabels: FIELD_TYPE_LABELS,
    corrupt: corruptNote(),
    migration: migrationNote(),
    commands,
  };
}

export async function healthInfo() {
  const home = appHome();
  const checks = [];

  let dirOk = true;
  let dirError = '';
  try {
    await fsp.mkdir(home, { recursive: true });
    await fsp.access(home, constants.W_OK);
  } catch (e) {
    dirOk = false;
    dirError = String(e && e.message);
  }
  checks.push({ name: 'store-dir', path: displayPath(home), ok: dirOk, detail: dirError });

  let storeOk = true;
  let storeDetail = '';
  let sections = 0;
  let entries = 0;
  try {
    const s = await loadStore();
    sections = s.sections.length;
    entries = s.entries.length;
    storeDetail = `${sections} 栏目 / ${entries} 条目`;
  } catch (e) {
    storeOk = false;
    storeDetail = String(e && e.message);
  }
  checks.push({ name: 'store', path: displayPath(storeFile()), ok: storeOk, detail: storeDetail });

  let vault = null;
  try {
    vault = await vaultStatus();
    checks.push({ name: 'vault', path: vault.keyFile || vault.saltFile || '', ok: vault.ready, detail: vault.source });
  } catch (e) {
    checks.push({ name: 'vault', path: '', ok: false, detail: String(e && e.message) });
  }

  const failing = checks.filter((c) => !c.ok);
  if (failing.length) {
    throw blocked(
      `健康检查未通过：${failing.map((c) => `${c.name}（${c.detail}）`).join('；')}`,
      { checks },
    );
  }
  return { status: 'ok', app: APP_NAME, version: VERSION, cwd: process.cwd(), sections, entries, vault, checks };
}

export async function routesInfo({ module, http } = {}) {
  const { ALL_COMMANDS, commandEntry } = await import('../../runtime/cli.js');
  let entries = ALL_COMMANDS.map(commandEntry);
  if (module) entries = entries.filter((e) => e.module === module || e.id === module);
  if (http) {
    // 反向查找：有端点，查该敲哪条命令。复用路由编译时的正则，所以带参路由也能匹配实例。
    const raw = String(http).trim().replace(/\s+/g, ' ');
    const sp = raw.indexOf(' ');
    const method = (sp > 0 ? raw.slice(0, sp) : 'GET').toUpperCase();
    const path = (sp > 0 ? raw.slice(sp + 1) : raw).split('?')[0];
    entries = entries.filter((e) => {
      if (!e.http) return false;
      const route = compileRoute(e.http.split(' '));
      return route.method === method && route.regex.test(path);
    });
  }
  return {
    count: entries.length,
    total: (await commandTable()).length,
    entries: entries.map((e) => ({ ...e, usage: e.usage })),
  };
}

export function renderBootstrap(info) {
  const lines = [
    `${info.app.label} v${info.app.version}（node ${info.app.node} · ${info.app.platform}）`,
    `存储:   ${info.storePath}`,
    `栏目:   ${info.counts.sections} 个 · 条目 ${info.counts.entries} 条 · 命令 ${info.counts.commands} 条`,
    `密钥:   ${info.vault.source === 'env' ? '口令模式（NX_SK_PASSPHRASE）' : `本机密钥文件 ${info.vault.keyFile}`}`,
  ];
  if (info.corrupt) lines.push(`注意: 上次读取时发现损坏文件，已挪到 ${info.corrupt.to}`);
  lines.push('', '栏目一览：');
  for (const s of info.sections) lines.push(`  ${s.id.padEnd(12)} ${s.title}　${s.entries} 条 / ${s.fields} 字段`);
  lines.push('', `提示: ${APP_NAME} help 看全部命令；加 --json 得机器可读输出。`);
  return lines.join('\n');
}

export function renderHealth(h) {
  const lines = [`${h.status === 'ok' ? '正常' : '异常'} · ${h.app} v${h.version}`, `cwd: ${h.cwd}`];
  for (const c of h.checks) lines.push(`  [${c.ok ? 'ok' : '!!'}] ${c.name.padEnd(12)} ${c.detail}`);
  return lines.join('\n');
}

export function renderRoutes(r) {
  const lines = [`共 ${r.count} / ${r.total} 条命令`];
  for (const e of r.entries) {
    lines.push(`  ${e.command}${e.http ? `  <=>  ${e.http}` : ''}`);
    lines.push(`      ${e.summary}`);
  }
  lines.push('', '用法串见: nx-sk help <主题>');
  return lines.join('\n');
}

export { usageOf };
