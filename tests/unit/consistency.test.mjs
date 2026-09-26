// 一致性测试：把「跨文件的四张表」钉死。
//   模块目录 ↔ 后端注册表 ↔ 前端视图注册表 ↔ 视图里实际调用的接口
// 这些不同步的后果是「面板上有个按钮，点了 404」或「某条 CLI 命令 help 里没有」——
// 靠人维护不可能长期一致，所以写成断言。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { ACTIONS, MODULES, SELF_CHECK, selfCheckActions } = await import('../../src/runtime/registry.js');
const { ALL_COMMANDS, helpEntries, resolveCommand } = await import('../../src/runtime/cli.js');
const { ROUTES, routeTable } = await import('../../src/runtime/api.js');
const { cliPathsOf } = await import('../../src/runtime/spec.js');
const { VIEWS } = await import('../../src/web/frontend/registry.js');

const listDirs = async (rel) => (await readdir(join(ROOT, rel), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

async function readIfExists(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

test('模块目录 ↔ 后端注册表对账（双向）', async () => {
  const dirs = await listDirs('src/modules');
  const registered = MODULES.map((m) => m.id).sort();
  assert.deepEqual(dirs, registered, `src/modules 下的目录与 registry.js 的 MODULES 必须一一对应`);
});

test('带 view 的模块都在前端注册表登记，且注册表里没有孤儿', async () => {
  const needView = MODULES.filter((m) => m.view).map((m) => m.id).sort();
  const registered = VIEWS.map((v) => v.id).sort();
  assert.deepEqual(registered, needView, 'VIEWS 与「声明了 view 的模块」必须一一对应（tab:false 的也要在）');

  // 声明了 view 就必须有文件——否则 vite build 会报错，但报错信息离根因很远
  for (const m of MODULES.filter((x) => x.view)) {
    const content = await readIfExists(join(ROOT, 'src/modules', m.id, 'view.jsx'));
    assert.ok(content, `模块 ${m.id} 声明了 view 却没有 view.jsx`);
  }
  // 反过来：有 view.jsx 却忘了声明 view
  for (const id of await listDirs('src/modules')) {
    const content = await readIfExists(join(ROOT, 'src/modules', id, 'view.jsx'));
    const mod = MODULES.find((m) => m.id === id);
    assert.equal(!!content, !!mod.view, `模块 ${id} 的 view.jsx 存在性与 index.js 的 view 声明不一致`);
  }
});

const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };

test('声明了 CRUD 资源的模块，五个操作齐备且两端可调用', () => {
  const resources = MODULES.filter((m) => m.resource);
  // 没有模块声明 resource 时这条检查会静默地什么都不查 —— 必须钉住
  assert.ok(resources.length > 0, '没有任何模块声明 resource，检查形同虚设');

  const problems = [];
  for (const m of resources) {
    for (const [op, verb] of Object.entries(CRUD_VERB)) {
      const a = ACTIONS.find((x) => x.id === `${m.resource}.${verb}`);
      if (!a) { problems.push(`${m.id}: 缺 ${op}（应为 ${m.resource}.${verb}）`); continue; }
      if (!cliPathsOf(a).length) problems.push(`${m.id}: ${a.id} 缺 CLI 命令`);
      if (!a.http) problems.push(`${m.id}: ${a.id} 缺 HTTP 路由（面板调不到）`);
    }
  }
  assert.deepEqual(problems, [], `CRUD 不完备:\n${problems.join('\n')}`);
});

test('CRUD 路由的形状对得上语义', () => {
  const segs = (p) => p.split('/').filter(Boolean);
  const hasParam = (p) => segs(p).some((s) => s.startsWith(':'));

  for (const m of MODULES.filter((m) => m.resource)) {
    const http = (op) => ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`).http;
    assert.equal(hasParam(http('list')[1]), false, `${m.id}: list 路由不应含 :param`);
    for (const op of ['get', 'update', 'remove']) {
      assert.ok(hasParam(http(op)[1]), `${m.id}: ${op} 路由必须含 :param（要能定位单条）`);
    }
  }
});

test('key 系列是 entry 的语法糖，不构成第二套业务逻辑', () => {
  const keys = ACTIONS.filter((a) => a.id.startsWith('key.'));
  assert.deepEqual(keys.map((a) => a.id).sort(), ['key.get', 'key.list', 'key.remove', 'key.set']);

  for (const a of keys) {
    assert.ok(cliPathsOf(a).length, `${a.id} 缺 CLI 命令`);
    assert.ok(a.http, `${a.id} 缺 HTTP 路由（面板调不到）`);
    // 同模块 = 同一份 service 实现。搬到别的模块就等于「两个入口两条业务逻辑」，
    // 而其中一条必然先腐坏。
    assert.equal(a.module, 'entries', `${a.id} 必须和 entry 同模块`);
  }

  const http = (id) => ACTIONS.find((a) => a.id === id).http;
  const hasParam = (p) => p.split('/').filter(Boolean).some((s) => s.startsWith(':'));
  assert.equal(hasParam(http('key.list')[1]), false, 'key list 是集合路由');
  for (const id of ['key.get', 'key.set', 'key.remove']) {
    assert.ok(hasParam(http(id)[1]), `${id} 路由必须能定位到单个键`);
  }
  // PUT 而不是 POST：KV 的 SET 是幂等覆盖，方法用错会让 agent 无法从端点推断语义
  assert.equal(http('key.set')[0], 'PUT');
});

test('skill 命令必须一直在 CLI 里（撤掉面板 ≠ 撤掉功能）', () => {
  // 用户要求 skill 不呈现在面板里。这是「去掉一个视图」，不是「去掉两条命令」——
  // 而这两条是骨架的强制命令面（让 agent 学会用 / 让外部 agent 拿上下文），
  // 手滑一起删掉的话，面板上看不出任何异常。
  for (const id of ['skill.list', 'skill.install', 'skill.get']) {
    const a = ACTIONS.find((x) => x.id === id);
    assert.ok(a, `${id} 不存在`);
    assert.ok(cliPathsOf(a).length, `${id} 缺 CLI 命令`);
  }
  const skill = MODULES.find((m) => m.id === 'skill');
  assert.equal(skill.view, null, 'skill 按用户要求不呈现在 Web 面板');
  assert.equal(VIEWS.some((v) => v.id === 'skill'), false, 'VIEWS 里不该再有 skill');
});

test('非资源模块没有被硬套成 CRUD', () => {
  for (const m of MODULES.filter((x) => !x.resource)) {
    const verbs = m.actions.map((a) => a.id.split('.').slice(1).join('.'));
    const five = ['list', 'get', 'add', 'update', 'remove'].filter((v) => verbs.includes(v));
    assert.ok(five.length < 5, `${m.id} 没声明 resource 却凑齐了 CRUD 五动词——要么声明 resource，要么改动词名`);
  }
});

test('每条 action 的 CLI 路径都能被运行器解析回它自己', () => {
  const problems = [];
  for (const a of ALL_COMMANDS) {
    const path = cliPathsOf(a)[0];
    const hit = resolveCommand(path);
    if (!hit.action || hit.action.id !== a.id) problems.push(`${a.id}: "${path.join(' ')}" 解析成了 ${hit.action ? hit.action.id : '（无）'}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));

  // 别名（第二条 CLI 路径）也必须能解析回自己
  for (const a of ALL_COMMANDS) {
    for (const p of cliPathsOf(a).slice(1)) {
      assert.equal(resolveCommand(p).action?.id, a.id, `别名 ${p.join(' ')} 解析错了`);
    }
  }
});

test('每条 HTTP 路由都能由某条 CLI 命令触达；routes 与 help 覆盖同一批命令', async () => {
  assert.ok(ROUTES.length > 0);
  for (const r of ROUTES) {
    const paths = cliPathsOf(r.action);
    assert.ok(paths.length, `路由 ${r.method} ${r.path} 对应的 action 没有 CLI 命令`);
  }
  const helpIds = helpEntries().map((e) => e.id).sort();
  const routeIds = routeTable().filter((r) => r.action).map((r) => r.action).sort();
  assert.deepEqual(helpIds, [...new Set([...helpIds])].sort(), 'help 里有重复条目');
  for (const id of new Set(routeIds)) {
    assert.ok(helpIds.includes(id), `${id} 有路由但 help 里没有——两张命令表长度不同`);
  }
  assert.equal(SELF_CHECK.ids.size, ACTIONS.length);
});

test('装载期自检真的会触发（用一份故意写坏的清单反证）', () => {
  const base = { id: 'a.b', cli: ['a', 'b'], http: ['GET', '/api/a'], run: () => null };
  assert.throws(() => selfCheckActions([base, { ...base }]), /id 重复/);
  assert.throws(() => selfCheckActions([base, { id: 'c.d', cli: ['a', 'b'], http: ['POST', '/api/x'], run: () => null }]), /CLI 路径重复/);
  assert.throws(() => selfCheckActions([base, { id: 'c.d', cli: ['c', 'd'], http: ['GET', '/api/a'], run: () => null }]), /HTTP 路由重复/);
  assert.throws(() => selfCheckActions([{ id: 'x', cli: [], http: null, run: () => null }]), /没有 CLI 命令/);
  assert.throws(() => selfCheckActions([{ id: 'x', cli: ['x'], http: 'GET /api/x', run: () => null }]), /既不是数组也不是 null/);
  assert.throws(() => selfCheckActions([{ id: 'x', cli: ['x'], http: null }]), /缺少 run/);
});

// —— 视图里调用的 /api 字面量 ——
// 只看 `api(...)` 调用点的第一个实参：这样才能把 import 路径（`.../api/client.js`）排除掉，
// 而 import 路径里的 "/api/client.js" 恰好是一条**不存在**的后端路由。
// 模板变量归一成 :param，避免为了「可测」把视图写成硬编码拼接。
function literalsOf(source) {
  const out = [];
  for (const call of source.matchAll(/\bapi\(\s*(['"`])([\s\S]*?)\1/g)) {
    const url = call[2].replace(/\$\{[^}]*\}/g, ':p');
    for (const m of url.matchAll(/\/api\/[A-Za-z0-9_:\-/?.=&%]*/g)) {
      const lits = m[0].split('?')[0].split('/').filter(Boolean)
        .map((s) => s.replace(/:p.*$/, ''))
        .filter((s) => s && !s.startsWith(':'));
      if (lits.length) out.push({ raw: m[0], lits });
    }
  }
  return out;
}

function routeLiterals(routePath) {
  return routePath.split('/').filter(Boolean).filter((s) => !s.startsWith(':'));
}

function covered(lits, routePath) {
  const rl = routeLiterals(routePath);
  if (lits.length > rl.length) return false;
  let i = 0;
  for (const l of lits) {
    while (i < rl.length && rl[i] !== l) i++;
    if (i >= rl.length) return false;
    i++;
  }
  return true;
}

test('视图里调用的每个 /api/... 都有对应路由（规则本身先反证过）', async () => {
  // 反面对照：把路径写错必须被判为未覆盖，否则这条断言等于不存在
  const wrong = literalsOf("api('/api/sectoins/1/dump')").map((x) => x.lits);
  assert.ok(!ROUTES.some((r) => covered(wrong[0], r.path) && r.path === '/api/sections/:ref/dump'), '拼错路径必须被判为未覆盖');

  const files = [];
  for (const id of await listDirs('src/modules')) {
    const p = join(ROOT, 'src/modules', id, 'view.jsx');
    if (await readIfExists(p)) files.push({ id, path: p });
  }
  for (const id of await listDirs('src/web/frontend')) {
    const p = join(ROOT, 'src/web/frontend', id, 'view.jsx');
    if (await readIfExists(p)) files.push({ id, path: p });
  }
  const frontendFiles = await readdir(join(ROOT, 'src/web/frontend'), { withFileTypes: true });
  for (const f of frontendFiles.filter((x) => x.isFile() && x.name.endsWith('.jsx'))) {
    files.push({ id: f.name, path: join(ROOT, 'src/web/frontend', f.name) });
  }
  assert.ok(files.length >= 6, `应该扫到至少 6 个前端文件，实际 ${files.length}`);

  const problems = [];
  let seen = 0;
  for (const f of files) {
    const src = await readFile(f.path, 'utf8');
    for (const { raw, lits } of literalsOf(src)) {
      seen++;
      if (!ROUTES.some((r) => covered(lits, r.path))) problems.push(`${f.id}: ${raw}`);
    }
  }
  assert.ok(seen > 10, `扫到的 /api 字面量太少（${seen}），断言可能失效了`);
  assert.deepEqual(problems, [], `视图里调用了不存在的端点:\n${problems.join('\n')}`);
});

test('eslint 的模块互依禁列覆盖所有兄弟模块（settings 是唯一例外）', async () => {
  const cfg = await readFile(join(ROOT, 'eslint.config.js'), 'utf8');
  const block = /const SIBLING_MODULES = \[([\s\S]*?)\];/.exec(cfg);
  assert.ok(block, '找不到 SIBLING_MODULES 声明');
  const listed = [...block[1].matchAll(/'\.\.\/([\w-]+)\/\*'/g)].map((m) => m[1]);
  const expect = MODULES.map((m) => m.id).filter((id) => id !== 'settings').sort();
  assert.deepEqual([...listed].sort(), expect,
    '新增模块必须往 SIBLING_MODULES 里补一行——漏补是**静默**的，没有任何断言会替你发现');

  // 前端禁列的 files 必须覆盖模块下的视图文件，否则真正写视图的那个文件反而不受约束
  const frontFiles = /files: \['src\/web\/frontend\/\*\*\/\*\.\{js,jsx\}',\s*'src\/modules\/\*\*\/\*\.jsx'\]/.exec(cfg);
  assert.ok(frontFiles, '前端禁列的 files 必须用通配把 modules 下的 .jsx 也框进来（用 **/view.jsx 会被"改个文件名"绕过）');
});

test('面板无 emoji、不使用浏览器原生弹窗', async () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const files = [];
  // 递归收集。原先只 readdir 了 frontend/ 的**直接子文件**，于是
  // frontend/components/（fieldEditor.jsx、ui.jsx）、App.jsx、main.jsx、api/ 全都没被扫到
  // —— 那些正是面板的建构块，「面板规则不覆盖面板」。
  // core/ 同样漏了，而 core/render.js 决定的就是面板与 CLI 的值形态。
  const collect = async (dir, re) => {
    for (const rel of await readdir(join(ROOT, dir), { recursive: true })) {
      if (re.test(rel)) files.push(join(ROOT, dir, rel));
    }
  };
  for (const id of await listDirs('src/modules')) {
    for (const name of ['view.jsx', 'service.js', 'index.js']) {
      const p = join(ROOT, 'src/modules', id, name);
      if (await readIfExists(p)) files.push(p);
    }
  }
  await collect('src/core', /\.js$/);
  await collect('src/web/frontend', /\.(jsx|js|css)$/);
  await collect('bin', /\.mjs$/);
  await collect('scripts', /\.mjs$/);
  for (const p of files) {
    const src = await readFile(p, 'utf8');
    assert.ok(!EMOJI.test(src), `${p} 里有 emoji —— 等宽终端宽度不定、跨平台渲染不一，本项目全程不用`);
    assert.ok(!/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(src), `${p} 用了浏览器原生弹窗 —— 必须用页内 toast / dialog`);
  }
});

test('assets/<skill>/ 里的每条命令都真实存在（单向断言：防 agent 照抄不存在的命令）', async () => {
  const skillRoot = join(ROOT, 'assets', 'nx-sk');
  const known = new Set(ALL_COMMANDS.flatMap((a) => cliPathsOf(a).map((p) => p.join(' '))));
  const docFiles = [];
  const walk = async (dir) => {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) await walk(p);
      else if (f.name.endsWith('.md')) docFiles.push(p);
    }
  };
  await walk(skillRoot);
  assert.ok(docFiles.length >= 4, `assets 里的 skill 文档太少（${docFiles.length}）——skill 是产品的一部分，不是文档副产品`);

  const problems = [];
  let hits = 0;
  for (const p of docFiles) {
    const src = await readFile(p, 'utf8');
    // 只看**代码片段**（行内 code span 与围栏块）：散文里出现 "nx-sk" 的地方
    // （比如 frontmatter 的 description）不是命令引用，扫进去只会造成假阳性。
    const spans = codeSpans(src);
    for (const m of spans.matchAll(/nx-sk\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)) {
      // 命令必须出现在行首或表格单元/行内代码的开头；
      // 否则 "nx-sk skill get nx-sk references/20-secrets.md" 里的第二个 nx-sk 会被当成命令
      let k = m.index - 1;
      while (k >= 0 && spans[k] === ' ') k--;
      const prev = k < 0 ? '\n' : spans[k];
      if (!'\n|`(:>'.includes(prev)) continue;

      const one = m[1];
      const two = m[2] ? `${one} ${m[2]}` : null;
      hits++;
      const ok = (two && known.has(two)) || known.has(one)
        || [...known].some((x) => x.startsWith(`${one} `));
      if (!ok) problems.push(`${p.replace(ROOT, '')}: nx-sk ${two || one}`);
    }
  }
  assert.ok(hits > 20, `文档里扫到的命令太少（${hits}），断言可能失效`);
  assert.deepEqual(problems, [], `文档里提到了不存在的命令:\n${problems.join('\n')}`);
});

test('SKILL.md 的 ref 路由表 ↔ references/ 目录双向对账', async () => {
  // 这条是本项目实测踩出来的：一个 ref 文件在两次提交之间被删掉，
  // 而**没有任何断言会红** —— 命令漂移断言只看「文档提到的命令是否存在」，
  // 不看「文档提到的 ref 文件是否存在」。agent 会照着 SKILL.md 去取，然后拿到 NOT_FOUND。
  const skillDir = join(ROOT, 'assets', 'nx-sk');
  const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  const named = [...skillMd.matchAll(/`(\d\d-[a-z0-9-]+)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 4, `SKILL.md 的 ref 路由表只解析出 ${named.length} 条，断言可能失效`);

  const refDir = join(skillDir, 'references');
  const files = (await readdir(refDir)).filter((n) => n.endsWith('.md'));
  const onDisk = files.map((n) => n.replace(/\.md$/, ''));

  const missing = named.filter((r) => !files.includes(`${r}.md`));
  assert.deepEqual(missing, [], `SKILL.md 路由表列了不存在的 ref: ${missing.join(', ')}——agent 取它只会拿到 NOT_FOUND`);

  const orphan = onDisk.filter((n) => !named.includes(n));
  assert.deepEqual(orphan, [], `references/ 下这些 ref 没在 SKILL.md 路由表登记（agent 永远不会知道该读它）: ${orphan.join(', ')}`);
});

/**
 * 上一条断言的**已知盲区**，这条专门补它。
 *
 * 双向对账只能保证「表和目录互相一致」。真正的坑是**文档漂移**：
 * 一次编辑改了 ref 的职责边界，却没同步改动到别处的引用——两边各自自洽，
 * 合起来矛盾。
 *
 * 本项目的具体案例（同一个文件被删了两次，两次都被当成「误删」恢复）：
 * `40-extend.md` 是**开发规范**（改这个项目本身要碰哪 12 处），属于脚手架 skill
 * `server-cli-web-scaffold` 的 `references/A07-extension-loop.md`；`assets/nx-sk/`
 * 只放「怎么用 nx-sk」。这个文件被移出去两次，两次都因为没有断言拦住、
 * 又被后来的人（包括我）按「文件怎么没了」恢复回来。
 *
 * 所以这里钉的不是「某个文件必须在」——那正好会把有意的调整压回去——而是
 * 「已迁走的东西不许重新出现在随包手册里」。
 */
test('已迁走的开发规范不许重新出现在 assets/nx-sk/（文档漂移防护）', async () => {
  const refDir = join(ROOT, 'assets', 'nx-sk', 'references');
  const skillDir = join(ROOT, 'assets', 'nx-sk');
  const files = (await readdir(refDir)).filter((n) => n.endsWith('.md'));
  const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf8');

  // 「开发规范」类的 ref 已迁到脚手架 skill，随包手册里只该有「怎么用 nx-sk」。
  // 重新加回来会让两个地方各有一份、然后各改各的。
  assert.ok(!files.includes('40-extend.md'),
    '40-extend.md 已迁到 server-cli-web-scaffold 的 references/A07-extension-loop.md（开发规范不属于随包分发的 agent 手册）。'
    + '要放回来请先想清楚两个副本怎么保持同步，并同步更新本断言与 README 的 ref 表。');

  // 反向：SKILL.md 里也不该残留指向它的路由条目（条目在而文件不在 =
  // agent 照着取会拿到 NOT_FOUND）
  assert.ok(!/`40-extend`/.test(skillMd),
    'SKILL.md 路由表里还留着 40-extend —— 文件已迁走，agent 照它取只会拿到 NOT_FOUND');

  // 编号仍要连续、唯一（跳号通常意味着删了一个没重排，或复制粘贴写错序号）
  const nums = files.map((n) => Number(n.slice(0, 2)));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'ref 文件名前缀应按编号升序');
  assert.equal(new Set(nums).size, nums.length, `ref 编号有重复: ${nums.join(', ')}`);
});

/** 抠出 Markdown 里的行内 code span 与围栏代码块，忽略 frontmatter。 */
function codeSpans(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const parts = [];
  for (const m of body.matchAll(/```[\s\S]*?```/g)) parts.push(m[0]);
  for (const m of body.matchAll(/`[^`\n]+`/g)) parts.push(m[0]);
  return parts.join('\n');
}

test('反向：代码里的写命令都声明了 --dry-run，破坏性写命令留快照', async () => {
  const snapshots = [];
  const missingDryRun = [];
  for (const a of ACTIONS) {
    const isWrite = Array.isArray(a.http) && a.http[0] !== 'GET';
    if (!isWrite) continue;
    if (!(a.flags && a.flags['dry-run'])) missingDryRun.push(a.id);
    const src = await readFile(join(ROOT, 'src/modules', a.module, 'service.js'), 'utf8');
    const fnName = a.id.split('.').slice(1).join('.');
    snapshots.push({ id: a.id, module: a.module, hasSnapshot: /snapshotStore|snapshot\(/.test(src), fnName });
  }
  assert.deepEqual(missingDryRun, [], `这些写命令缺 --dry-run: ${missingDryRun.join(', ')}`);
  const destructive = snapshots.filter((s) => /remove|update|set/.test(s.id));
  for (const s of destructive) {
    const src = await readFile(join(ROOT, 'src/modules', s.module, 'service.js'), 'utf8');
    assert.match(src, /snapshotStore\(/, `${s.module} 的破坏性写操作应先留快照`);
  }
});
