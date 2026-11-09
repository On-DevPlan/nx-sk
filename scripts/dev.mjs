// dev 启动器：一条命令起 vite + serve，一个 ctrl-c 关两个。
//
// 为什么是两个进程而不是一条命令：本骨架的核心不变量是「prod 入口纯净」——
// 发布产物里没有构建工具。serve 只服务 dist/web/public/，不知道也不关心 JSX。
// 把 vite 内嵌进 serve 会让 prod 也拖着一份编译器。
// serve 跑的是 bin → dist：`pnpm dev` 会先构建，这里的 serve 才有东西可跑。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/dev.mjs 自身的 __dirname 是 scripts/，但 node_modules/ 在项目根。
const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(ROOT, '..');

// 端口从 package.json 的 nxSk 读（服务端 core/paths.js 读同一处）——别在这里再写一遍字面量
const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
const SERVE_PORT = Number(pkg.nxSk?.port ?? 7866);
const VITE_PORT = Number(pkg.nxSk?.vitePort ?? 5180);

const NODE = process.execPath;
const VITE_BIN = join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SERVE_BIN = join(PROJECT_ROOT, 'bin', 'nx-sk.mjs');

const children = [];

function pipe(prefix, child) {
  const tag = `[${prefix}] `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) process.stdout.write(tag + line + '\n');
      }
    });
  }
}

async function waitForVite(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  }
  process.exit(code);
}

// 直接 spawn node 二进制，不走 npm.cmd：Windows + Git Bash 下
// `spawn('npm', [...], { shell: true })` 的参数会被 cmd.exe 重排或截断。
const vite = spawn(NODE, [VITE_BIN, '--host', '127.0.0.1', '--port', String(VITE_PORT)], {
  cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(vite);
pipe('vite', vite);
vite.on('exit', (code) => { if (code) shutdown(code); });

const ok = await waitForVite(VITE_PORT);
if (!ok) process.stdout.write(`[dev] vite 未在 ${VITE_PORT} 就绪，仍然继续启动 serve\n`);

// serve 用显式端口，避免「vite 代理指向 A、serve 听在 B」这种只在 dev 出现的错位
const serve = spawn(NODE, [SERVE_BIN, 'serve', '--no-open', '--port', String(SERVE_PORT)], {
  cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(serve);
pipe('serve', serve);
serve.on('exit', (code) => { if (code) shutdown(code); });

process.stdout.write(
  `\n[dev] 面板(dev): http://127.0.0.1:${VITE_PORT}\n`
  + `[dev] 后端 api  : http://127.0.0.1:${SERVE_PORT}（vite 把 /api 代理到这里）\n`
  + '[dev] Ctrl-C 同时关闭 vite 与 serve\n\n',
);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}
process.stdin.on('close', () => shutdown(0));
