#!/usr/bin/env node
// nx-sk 的唯一可执行入口：转发 argv、兜住未捕获的异常。
// 所有命令分发都在 dist/runtime/cli.js（那里才是命令表）——只跑构建产物，
// 不在运行时做 TypeScript 类型剥离（Node 对 node_modules 下的 .ts 直接拒绝）。
//
// 首次从源码仓库直接跑、或改了后端还没构建时，dist 不存在：给一句能照做的提示，
// 而不是把 ERR_MODULE_NOT_FOUND 的栈甩给用户。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cliUrl = new URL('../dist/runtime/cli.js', import.meta.url);

if (!existsSync(fileURLToPath(cliUrl))) {
  process.stderr.write(
    'nx-sk: 找不到构建产物 dist/runtime/cli.js。\n'
      + '源码仓库需要先构建：pnpm build（npm run build）——它会先 tsc 产出 dist，再构建面板。\n'
      + '如果你是用 npm 全局安装的，这说明包不完整，请重装：npm i -g nx-sk。\n',
  );
  process.exit(1);
}

const { runCli } = await import(cliUrl.href);

runCli(process.argv.slice(2)).catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`nx-sk: ${message}\n`);
  if (process.env.NX_SK_DEBUG) process.stderr.write(`${err && err.stack}\n`);
  process.exitCode = 1;
});
