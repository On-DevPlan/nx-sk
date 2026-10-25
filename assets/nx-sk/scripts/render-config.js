#!/usr/bin/env node
// 把 nx-sk 里的凭据**渲染成配置文件**（nx-sk 的主用途：凭据 → 能直接用的东西）。
//
// 用法：
//   nx-sk entry get "prod 部署" --section deploy --json > entry.json
//   node render-config.js entry.json ./docker-compose.local.yml
//   node render-config.js entry.json ./out.yml --var DB_PASSWORD=xxx
//
// 为什么是脚本而不是一行 node -e：**多行 node -e 在 Windows 的终端里会被吃掉引号**
// （实测表现为「静默不执行、退出码 0」）——所以这段逻辑固化成文件，跑得稳。
//
// 变量从两处来：
//   1) 条目的 `creds`（凭据清单，结构清单）：行里的「名称」= 变量名，
//      值优先取密码 / 令牌 / 账号；
//   2) 条目里其它**标量**字段（`password`、`AccessKeyId`…）：字段 key = 变量名。
// 占位符：${VAR} 与 ${VAR:-默认值}；正文取 `content` 字段。
//
// 读 stdout 是**真值**：这是本机工具，渲染出来的东西本来就是给自己用的。
// 写出去之前请确认目标文件**不进 git**（见 30-credentials 第五节）。

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, ...rest] = process.argv;

if (!inPath || !outPath) {
  console.error('用法: node render-config.js <entry.json> <out-file> [--var NAME=VALUE]');
  process.exit(1);
}

const overrides = {};
for (const a of rest) {
  if (!a.startsWith('--var')) continue;
  const kv = a.slice('--var'.length).replace(/^=/, '');
  const i = kv.indexOf('=');
  if (i < 0) {
    console.error(`--var 需要 NAME=VALUE，收到: ${a}`);
    process.exit(1);
  }
  overrides[kv.slice(0, i)] = kv.slice(i + 1);
}

// —— 读条目 ——
let entry;
try {
  entry = JSON.parse(readFileSync(inPath, 'utf8'));
} catch (e) {
  console.error(`读不到或解析不了 ${inPath}: ${e.message}`);
  console.error('先跑 `nx-sk entry get <条目> --section <栏目> --json > entry.json`');
  process.exit(1);
}

const values = entry.values || {};
const content = values.content;
if (typeof content !== 'string' || !content.trim()) {
  console.error(`这个条目没有 content（文件正文）字段 —— 没有可渲染的模板。`);
  console.error(`现有字段: ${Object.keys(values).join('、')}`);
  process.exit(1);
}

// —— 收集变量 ——
const vars = { ...overrides };
const sources = {};

// 1) 结构清单类的字段（凭据清单 / 账号清单…）：行里的「名称」= 变量名
for (const [key, list] of Object.entries(values)) {
  if (!Array.isArray(list)) continue;
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const name = row.name ?? row.名称;
    if (!name) continue;
    const v = row.pass ?? row.token ?? row.user ?? row.note ?? '';
    if (v === '' || v === undefined || v === null) continue;
    vars[name] = String(v);
    sources[name] = `${key}[${name}]`;
  }
}

// 2) 其它标量字段：字段 key = 变量名（content 本身排除，它是模板）
for (const [key, v] of Object.entries(values)) {
  if (key === 'content' || key === 'source') continue;
  if (typeof v !== 'string' || v === '') continue;
  vars[key] = v;
  sources[key] = key;
}

// —— 替换 ——
const unresolved = [];
const out = content.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, dflt) => {
  if (name in vars && vars[name] !== '') return vars[name];
  if (dflt !== undefined) return dflt;
  unresolved.push(name);
  return m;
});

writeFileSync(outPath, out, 'utf8');

const used = Object.keys(sources).filter((k) => out.includes(vars[k]));
console.log(`已写出 ${outPath}`);
console.log(`替换了 ${used.length} 个变量: ${used.map((k) => `${k}←${sources[k]}`).join('、') || '（无）'}`);
if (unresolved.length) {
  console.log(`未解析（正文里留着占位符）: ${[...new Set(unresolved)].join('、')}`);
  console.log('多半是凭据清单里的「名称」与占位符名不一致 —— 对齐后再跑一次。');
}
if (/\.(ya?ml|json|toml|ini|env|conf)$/i.test(outPath)) {
  console.log('提醒：这个文件带真值，确认它不在 git 里（.gitignore / 只提交占位符版本）。');
}
