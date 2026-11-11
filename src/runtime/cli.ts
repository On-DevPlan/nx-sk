// 通用 CLI 运行器：解析 → 匹配 → 校验 → 渲染 → help。
// 命令表由 action 声明派生，所以「Web 上能做的 CLI 都能做」是结构保证，不靠人记。
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Server } from 'node:http';
import { APP_NAME, DEFAULT_PORT, ENV_STORE_DB, VERSION } from '../core/paths.ts';
import { badInput, external, toErrorShape } from '../core/errors.ts';
import { parseDataArg, parseStdinValue } from '../core/argsafe.ts';
import { clearPanelPortfile, discoverPanelPort, isPidAlive, readPanelPortfile, writePanelPortfile } from '../core/panel-port.ts';
import { isEnvTruthy } from '../core/serve-port.ts';
import { PROXY_DEBUG_ENV, proxyRun } from './cli-proxy.ts';
import { ACTIONS, MODULES, MODULE_TITLES, commandEntry, type CommandEntry } from './registry.ts';
import { applySpec, argSpecsOf, cliPathsOf, flagSpecsOf, usageOf } from './spec.ts';
import type { Action, Ctx, ResolvedFlag } from './spec.ts';

// `--json` 需要被 serve 这类长驻命令看到，所以用一个模块级开关而不是往 meta 里塞字段
// （meta 的契约只有 { transport }，别把两端形态差异以外的东西塞进去）。
let OUTPUT_JSON = false;

async function cmdServe(ctx: Ctx) {
  const { startServer } = await import('./server.ts');
  const { openBrowser } = await import('../core/open.ts');
  const { loadStore, storePathInUse } = await import('../core/store.ts');
  const { appHome, displayPath } = await import('../core/paths.ts');
  const { autoOpenEnabled, resolvePortConflict, describeOccupant } = await import('../core/serve-port.ts');

  await loadStore(); // 触发首次播种：面板一打开就该有「求职」栏目
  const host = '127.0.0.1';
  // --port 0 = 让 OS 挑一个空闲端口（测试用），所以这里不能用 DEFAULT_PORT 兜底
  const desiredPort = ctx.port;
  // --no-open 与 NX_SERVE_NO_OPEN 走同一个开关：任一为真就不开浏览器
  const canOpen = autoOpenEnabled(ctx['no-open']);
  // --json 分支的字段形状：正常启动与复用旧实例共用一份，避免两条路径漂移
  const jsonLine = (u: string, p: number) => JSON.stringify({
    url: u, port: p, host, pid: process.pid,
    storePath: displayPath(storePathInUse()), storePathRaw: storePathInUse(), home: displayPath(appHome()),
  }) + '\n';
  // --json 模式下 stdout 只能有 JSON，人类可读的行改走 stderr
  const say = (s: string) => (OUTPUT_JSON ? process.stderr : process.stdout).write(s + '\n');

  let server: Server;
  try {
    server = await startServer({ port: desiredPort });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (!err || err.code !== 'EADDRINUSE') throw external(`启动服务失败: ${err && err.message ? err.message : String(err)}`);
    // 端口被占：先问一句「上面跑的是不是我」。
    const decision = await resolvePortConflict(desiredPort, APP_NAME, host);
    if (decision.action === 'reuse') {
      // 自己的面板已经在跑：不重复启动，直接把浏览器指过去。
      const runningUrl = `http://${host}:${desiredPort}`;
      // 复用也要有端口档案（#22）：只在档案缺失/指向死进程/端口不对时补写（pid 拿不到记 null，
      // 发现侧靠探测兜底）；活实例自己写的档案**不能覆盖**，否则 pid 校验就名存实亡了。
      const cur = readPanelPortfile();
      if (!cur || cur.port !== desiredPort || (cur.pid !== null && !isPidAlive(cur.pid))) {
        writePanelPortfile(desiredPort, null);
      }
      say(APP_NAME + ' 已在运行：' + runningUrl);
      say('直接打开浏览器（不重复启动）；如需重启请先停掉旧实例');
      if (OUTPUT_JSON) process.stdout.write(jsonLine(runningUrl, desiredPort));
      if (canOpen) await openBrowser(runningUrl);
      return { status: 'reused', url: runningUrl, port: desiredPort, host, pid: process.pid };
    }
    // 别人占的：顺延到下一个空闲端口，再起自己的面板。
    say(`端口 ${desiredPort} 已被占用（占用者: ${describeOccupant(decision.occupant)}），改用 ${decision.port}`);
    server = await startServer({ port: decision.port });
  }
  // --port 0 = 让 OS 挑一个空闲端口（测试用），所以真实端口要回读，不能信入参
  const addr = server.address();
  const realPort = addr && typeof addr === 'object' ? addr.port : desiredPort;
  // #22：记下真实端口——CLI 代理与后续 serve 复用都先读这份档案，
  // 顺延过端口（7866 被占→7867…）时才不会「探不到面板就退回直连开库」。
  writePanelPortfile(realPort, process.pid);
  const url = `http://127.0.0.1:${realPort}`;
  if (OUTPUT_JSON) {
    process.stdout.write(jsonLine(url, realPort));
  } else {
    process.stdout.write([
      `面板:   ${url}`,
      `存储:   ${displayPath(storePathInUse())}`,
      '退出:   Ctrl-C',
      '机器可读: nx-sk serve --json（先打一行 JSON，再继续常驻）',
    ].join('\n') + '\n');
  }
  if (canOpen) await openBrowser(url);

  await new Promise<void>((done) => {
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearPanelPortfile(); // #22：档案随实例走；被 taskkill 硬杀留下的陈旧档案由发现侧的 pid 校验兜底
      server.close(() => done());
      setTimeout(done, 800).unref?.();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { status: 'ok', stopped: true, url };
}

const BUILTINS: (Action & { module: string })[] = [
  {
    id: 'serve',
    module: 'system',
    cli: ['serve'],
    http: null,
    summary: '启动 Web 面板（默认 :7866；--port N 改端口；--no-open 不开浏览器；端口上已有本面板则直接打开它；NX_SERVE_NO_OPEN=1 全局不开浏览器）',
    flags: { port: { type: 'number', default: DEFAULT_PORT }, 'no-open': { type: 'boolean' } },
    run: (ctx) => cmdServe(ctx),
    render: () => '',
  },
  {
    id: 'help',
    module: 'system',
    cli: ['help'],
    http: null,
    summary: '命令表；可带主题（模块 id / 命令组 / action id）',
    args: [{ name: 'topic', required: false }],
    run: (ctx) => helpEntries(ctx.topic),
    render: (d, ctx) => renderHelp(d as CommandEntry[], ctx.topic),
  },
  {
    id: 'version',
    module: 'system',
    cli: ['version'],
    http: null,
    summary: '输出版本号（裸输出，便于 V=$(nx-sk version)）',
    run: () => VERSION,
    render: (v) => v,
  },
];

export const ALL_COMMANDS = [...BUILTINS, ...ACTIONS];

// 转出去给 system 模块用：它必须在**函数体内**动态 import 这里（静态 import registry 会成环）。
// 不转这一行，system 就得去静态 import registry —— 那正是分层规则要禁止的环。
export { commandEntry };

export function helpEntries(topic?: unknown): CommandEntry[] {
  const all = ALL_COMMANDS.map(commandEntry);
  if (!topic) return all;
  const t = String(topic);
  if (MODULES.some((m) => m.id === t)) return all.filter((e) => e.module === t);
  const byRoot = all.filter((e) => e.command.split(' ')[1] === t);
  if (byRoot.length) return byRoot;
  const byId = all.filter((e) => e.id === t);
  if (byId.length) return byId;
  throw badInput(`未知帮助主题: ${t}（可用模块: ${MODULES.map((m) => m.id).join(' / ')}；或命令组如 section / entry）`);
}

export function renderHelp(entries: CommandEntry[], topic?: unknown): string {
  const lines = [`${APP_NAME} v${VERSION} · 本机个人资源管理器`, ''];
  if (topic) lines.push(`主题: ${topic}`, '');
  lines.push('用法: nx-sk <命令组> <子命令> [参数] [--flags]　　任何命令都支持 --json', '');
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.module)) groups.set(e.module, []);
    groups.get(e.module).push(e);
  }
  for (const [mod, list] of groups) {
    lines.push(`【${MODULE_TITLES[mod] || mod}】`);
    for (const e of list) {
      lines.push(`  ${e.command}`);
      lines.push(`      ${e.summary}`);
      if (e.usage !== e.command) lines.push(`      用法: ${e.usage}`);
      if (e.http) lines.push(`      接口: ${e.http}`);
    }
    lines.push('');
  }
  lines.push('常用姿势：');
  lines.push('  nx-sk bootstrap --json                          一次拿齐上下文（agent 首选入口）');
  lines.push('  nx-sk section dump job --json                   一个栏目的全部信息（字段 + 全部条目 + 未填清单）');
  lines.push('  nx-sk entry fields --section job                字段字典：填之前先看，别猜字段名');
  lines.push('  nx-sk entry update 张三 --set 微信=zhangsan 改一个字段（PATCH 语义）');
  lines.push('  nx-sk export run --format both                  整体导出到 ~/nx-sk/export');
  lines.push('  nx-sk serve                                     打开 Web 面板');
  return lines.join('\n');
}

/**
 * 最长前缀匹配：命令路径里可以含 flag（那是一条命令路径，不是「带 flag 的命令」）。
 * 导出是为了让一致性测试能「只走匹配、零副作用」地验证每条 action 都能被解析回自己。
 */
export function resolveCommand(tokens: string[], commands: Action[] = ALL_COMMANDS) {
  let best: Action | null = null;
  let bestLen = -1;
  for (const action of commands) {
    for (const path of cliPathsOf(action)) {
      if (path.length <= bestLen || path.length > tokens.length) continue;
      if (path.every((seg, i) => tokens[i] === seg)) { best = action; bestLen = path.length; }
    }
  }
  if (!best) return { action: null, rest: [], tried: tokens.slice(0, 2) };
  return { action: best, rest: tokens.slice(bestLen), tried: tokens.slice(0, bestLen) };
}

function pushFlag(raw: Record<string, unknown>, name: string, value: unknown, spec: ResolvedFlag) {
  if (spec.type === 'array' || spec.type === 'kv') {
    raw[name] = raw[name] === undefined ? [value] : ([] as unknown[]).concat(raw[name], value);
  } else {
    raw[name] = value;
  }
}

// 导出让单测能直接钉「多键 --data 别被 KV 逻辑误伤」这类边界：
// 它们只在解析层出错，跑业务测试反而绕开了真正的发生点。
export function parseArgs(action: Action, tokens: string[]): Record<string, unknown> {
  const flagSpecs = new Map(flagSpecsOf(action).map((s) => [s.name, s]));
  const argSpecs = argSpecsOf(action);
  const flags: Record<string, unknown> = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const spec = flagSpecs.get(name);
      if (!spec) throw badInput(`用法: ${usageOf(action)} —— 未知参数 --${name}`);
      if (eq >= 0) { pushFlag(flags, name, t.slice(eq + 1), spec); continue; }
      if (spec.type === 'boolean') { pushFlag(flags, name, true, spec); continue; }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('--')) {
        // 注意：`--depth` 无值时报错，不要静默转换——Number(true) 会变成「深度 1」这种另一个合法值
        throw badInput(`用法: ${usageOf(action)} —— 参数 --${name} 缺少取值`);
      }
      i++;
      pushFlag(flags, name, next, spec);
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      throw badInput(`用法: ${usageOf(action)} —— 未知参数 ${t}（本 CLI 只使用 --长参数）`);
    }
    positional.push(t);
  }

  if (positional.length > argSpecs.length) {
    throw badInput(`用法: ${usageOf(action)} —— 多余的位置参数: ${positional.slice(argSpecs.length).join(' ')}`);
  }
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < positional.length; i++) raw[argSpecs[i].name] = positional[i];
  // 显式 flag 覆盖位置参数：`key set K --value=<值>` 与 `key set K <值>` 必须等价，
  // 而后者在值以 `-` 开头时会被当成 flag（那时只能走前者）。
  // 位置参数与 flag 一起交给展开函数：`key set K -` 的 `-` 是位置参数，
  // 不能因为它「看起来像 flag」就漏掉。
  return expandSafeArgs({ ...raw, ...flags }, { hasValueArg: argSpecs.some((s) => s.name === 'value') });
}

/**
 * 安全通道展开 —— CLI 独有的「通道知识」全部集中在这一个函数里。
 *
 * Windows 上值经命令行参数进来时，启动器 shim（Volta / npm 的 .cmd）会把换行
 * 当命令分隔符截断，而命令**报成功**——一次性凭据就这么静默丢掉大半（真实事故）。
 * 文件与 stdin 不受影响，所以这里把 `--data @文件` / `-` 在进 applySpec 之前
 * 换成真正的值。放这里而不是 spec.js：那边的 coerce() 是 CLI 与 HTTP 共用的
 * 纯净解码器，而 HTTP 没有「命令行通道」这回事。
 */
function expandSafeArgs(raw: Record<string, unknown>, { hasValueArg = false }: { hasValueArg?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  let stdinUsed = false;
  // stdin 只能被消费一次：两个参数都写 `-` 的话第二个读到的是空，
  // 静默读空比报错危险，所以显式拒绝。
  const takeStdin = () => {
    if (stdinUsed) throw badInput('stdin 只能被一个参数使用（已经有一个参数用 - 读过了）');
    stdinUsed = true;
    return readFileSync(0, 'utf8');
  };

  // --data 统一在这里解析成对象：spec.coerce 的 json 分支对「已是对象」的值直接返回，
  // 所以两处不会各解析一遍，`-`（stdin）这条新通道也自然被 coerce 认作合法输入。
  //
  // 注意顺序：**先**解析 --data，再处理 `-`。反过来的话 `--data -` 会在 data 还没读 stdin
  // 时就被判定成「value 也是 stdin」，把两次消费搅在一起（真实踩到的顺序 bug）。
  if (typeof out.data === 'string') out.data = parseDataArg(out.data, takeStdin);

  // `--data` 是位置参数 value 的替代给法（KV 表格只有一个值字段，语义确定），
  // 所以给了 data 就不该再因为缺 value 而报用法错。
  // 取 value 键；没有 value 键时取对象里唯一那个键。
  //
  // **只有声明了 value 参数的 action 才做这条推导**（目前只有 `key set <name> <value>`）。
  // 其他 action 的 `--data` 是「整份值对象」（entry add/update），多键才是常态 ——
  // 这里曾无差别执行，于是 `entry add --data @item.json`（5 个字段）直接报
  // 「--data 需要含 value 键，或只含一个键」：文档写着「整份 JSON」，实际只收单键。
  //
  // 位置参数 `-` 要**先于**这里的提取被认出来，否则 `key set K -` 的 `-` 会被
  // 当成字面值 `-`。所以 stdin 判定放在 data 提取之后、用「value 是否还等于 -」判断。
  if (hasValueArg && out.value === undefined && out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    const data = out.data as Record<string, unknown>;
    const keys = Object.keys(data);
    if (data.value !== undefined) out.value = data.value;
    else if (keys.length === 1) out.value = data[keys[0]];
    else throw badInput(`--data 需要含 value 键，或只含一个键（收到 ${keys.length} 个: ${keys.join(', ')}）`);
  }

  if (typeof out.value === 'string' && parseStdinValue(out.value)) out.value = takeStdin();

  // 注意：这里**没有**「值含换行就报错」的检测，因为做不到。
  // 实测（Windows 11 / Volta）：损坏后的值里 CR 是被**删掉**而不是保留，
  // 所以「含 CR」既抓不到损坏（零真阳性），又会拦住用 --data 写入的合法
  // CRLF 多行值（高假阳性）。而 LF 截断后与合法单行值完全不可区分。
  // 能做的只有：① 给出可靠通道（--data / stdin，本函数）；② 让通道本身不再损坏
  // （scripts/link-local.mjs 的转发器直连 node.exe）。
  return out;
}

const STATUS_NOTE = {
  skipped: '（未做改动——目标已是期望状态，或用 --dry-run 试运行）',
  conflict: '（需要你决策后才能继续，不要自动重试）',
  blocked: '（被业务规则挡住：先去满足前置条件）',
};

async function emit(action: { render?: (data: unknown, ctx: Ctx) => unknown }, data: unknown, ctx: Ctx) {
  if (OUTPUT_JSON) {
    process.stdout.write(JSON.stringify(data === undefined ? null : data) + '\n');
    return;
  }
  let text: unknown;
  if (typeof action.render === 'function') text = await action.render(data, ctx);
  else text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text === undefined || text === null || text === '') return;
  const status = data && typeof data === 'object' ? (data as Record<string, unknown>).status : undefined;
  if (status && status !== 'ok') text = `${text}\n状态: ${status} ${STATUS_NOTE[status as keyof typeof STATUS_NOTE] || ''}`.trimEnd();
  process.stdout.write(`${text}\n`);
}

export async function runCli(argv: string[]) {
  const opts: { json: boolean; store: string | null; direct: boolean } = { json: false, store: null, direct: false };
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') { opts.json = true; continue; }
    if (t === '--direct') { opts.direct = true; continue; } // #22 逃生口：跳过面板代理，本进程直跑
    if (t === '--store') {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write('nx-sk: --store 缺少取值\n'); process.exitCode = 1; return; }
      opts.store = v;
      continue;
    }
    if (t.startsWith('--store=')) { opts.store = t.slice('--store='.length); continue; }
    tokens.push(t);
  }
  // 全局 flag 先摘掉再匹配命令；--store 通过环境变量下传，服务层就不必到处接一个路径参数。
  // 0.36 起存储是 SQLite：--store 指向 nxsk.db 的路径（旧 store.json 的导入来源仍走 NX_SK_STORE）。
  if (opts.store) process.env[ENV_STORE_DB] = resolvePath(opts.store);
  OUTPUT_JSON = opts.json;

  let lastAction: Action | null = null;
  try {
    if (!tokens.length) {
      await emit({ render: (d, c) => renderHelp(d as CommandEntry[], c) }, helpEntries(), {});
      return;
    }
    const { action, rest, tried } = resolveCommand(tokens);
    if (!action) throw badInput(`未知命令: ${tried.join(' ')} —— 用 nx-sk help 看全部命令`);
    lastAction = action;
    const ctx = applySpec(action, parseArgs(action, rest));
    // #22：面板（serve）活着且认的是**同一个库**时，凡有 http 声明的 action 改走 HTTP 代理执行——
    // 本进程不再打开 SQLite，根治 Windows 双进程开库冲突。
    // 不代理：--direct / --store 指库 / 无 http 声明（help/version/serve）/ raw 下载口（直跑落盘）。
    // 面板在跑但代理失败 → 报错，**不静默回退直连**（那等于把撞库藏进重试）。
    let data: unknown;
    const proxyable = Array.isArray(action.http) && action.raw !== true && !opts.direct && !opts.store;
    const port = proxyable ? await discoverPanelPort() : null;
    if (port !== null) {
      if (isEnvTruthy(process.env[PROXY_DEBUG_ENV])) {
        process.stderr.write(`${APP_NAME}: 经面板代理 :${port} ${action.id}\n`);
      }
      data = await proxyRun(action, ctx, port);
    } else {
      data = await action.run(ctx, { transport: 'cli' });
    }
    await emit(action, data, ctx);
  } catch (err) {
    const e = toErrorShape(err);
    // 参数/用法类错误必须带完整用法串——agent 靠「用法:」这个锚点判断「该改参数而不是重试」。
    // 放在运行器里统一补，比要求每个 service 自己记得写更可靠。
    if (e.code === 'INVALID_INPUT' && !e.message.includes('用法:') && lastAction) {
      e.message += `\n用法: ${usageOf(lastAction)}`;
    }
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code }) + '\n');
    else process.stderr.write(`${APP_NAME}: ${e.message}\n`);
    process.exitCode = 1;
  }
}



