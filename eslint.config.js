// 分层约束在这里落地——写在 README 里的分层规则活不过三次提交。
//
// 说明：骨架 ref [[00-design-and-verify]] 用 `defineConfig`（eslint >= 9.22 的
// `eslint/config` 子路径）。这里改成等价的裸数组导出，任何 flat-config 版本的
// eslint 9 都能跑——语义完全相同，只是不依赖那个新子路径。
//
// 多出来的两个插件是必需的，不是装饰：
//   eslint-plugin-react 的 jsx-uses-vars 让 `<Foo />` 算「使用」Foo，否则每个组件都会被
//     报成 no-unused-vars；
//   eslint-plugin-react-hooks 提供 rules-of-hooks / exhaustive-deps —— 没有它，
//     源码里写 `// eslint-disable-next-line react-hooks/exhaustive-deps` 会直接报
//     「Definition for rule was not found」（eslint 9 对未知规则 id 是 error）。
//
// TS 重构（见 docs/design-intent.md）后，**所有 files 通配必须同时覆盖 js/ts**：
// 只写 .js 会让新落地的 .tsx 悄悄掉出前后端边界规则，且没有任何断言会红。
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { readdirSync, readFileSync } from 'node:fs';
import { lineBudgetWarn, lineBudgetError } from './eslint-rules/line-budget.js';

// 白名单用 readFileSync 读，不用 `import ... with { type: 'json' }`——
// 后者要 Node 20.10+，而 package.json 声明的 engines 是 >=18.17。
// `_comment` 只给人看，不进规则 options（schema 是 additionalProperties: false）。
const lineBudgetConfig = JSON.parse(
  readFileSync(new URL('./eslint-line-budget.json', import.meta.url), 'utf8'),
);
const lineBudgetOptions = {
  warn: lineBudgetConfig.warn,
  approve: lineBudgetConfig.approve,
  hard: lineBudgetConfig.hard,
  registry: lineBudgetConfig.registry,
};

const SOURCE_FILES = ['**/*.{js,mjs,cjs,jsx,ts,tsx}'];

const BASE = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off', // 浏览器/Node 全局混用，靠运行时暴露
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

// 模块互依禁列：**从 src/modules 目录派生**，不再手写。
// 手写清单是第二个声明点——漏补一行是静默的，只能靠测试事后发现；目录派生没有这个口子。
// 唯一例外是 ../settings/*（基础模块，允许被单向只读依赖），"例外"的实现方式就是**不列进来**。
// system / transfer 是聚合模块，在下面整体放宽。
const SIBLING_MODULES = readdirSync(new URL('./src/modules/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'settings')
  .map((d) => `../${d.name}/*`);

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'assets/**',
      'tests/fixtures/**',
      // 只读的 JS 基线快照与本地草稿目录：不是本仓库源码，禁扫（见 docs/refactor-plan.md P0）。
      '.claude/**',
      '.tmp/**',
      '.tool/**',
    ],
  },
  {
    files: SOURCE_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // 少了这一行，所有 .jsx 都会 Parsing error: Unexpected token '<'
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: BASE,
  },

  // TS 文件换 parser，并把 no-unused-vars 交给 TS 版（基规则不理解类型位置）
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // core 是最底层
  {
    files: ['src/core/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['../modules/**', '../runtime/**', '../web/**'],
          message: 'core 是最底层，不得依赖 modules / runtime / web。' },
      ] }],
    },
  },

  // 模块之间不得互相依赖。唯一例外：../settings/service.js（基础模块）。
  {
    files: ['src/modules/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: SIBLING_MODULES,
          message: '模块之间不得互相依赖；共享逻辑下沉 core/。唯一例外：../settings/service.js（基础模块）。' },
      ] }],
    },
  },

  // 聚合模块是刻意的例外（system 读各模块状态；transfer 负责栏目导出导入的跨模块编排，
  // 依赖方向单向 transfer → entries/sections，不构成环）
  {
    files: ['src/modules/system/**/*.{js,ts}', 'src/modules/transfer/**/*.{js,ts}'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // JSX 里的组件引用要算「使用」，否则每个组件都报 no-unused-vars
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { react },
    rules: { 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'off' },
  },

  // hooks 规则只对视图与前端壳生效（视图现在就在前端目录里，一套 files 就够了）
  {
    files: ['src/web/frontend/**/*.{jsx,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },

  // 前后端边界——价值最高的一条。视图全部住在 src/web/frontend 下（P6 起全是 ts/tsx），
  // 所以下面这条 files 覆盖所有前端代码；后端的 .ts 入口也要一起拦住。
  {
    files: ['src/web/frontend/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: '前端不能引用 Node 内置模块。' },
        {
          group: [
            '**/modules/*/index.{js,ts}',
            '**/modules/*/service.{js,ts}',
            '**/runtime/**',
            '**/core/**',
          ],
          message: '前端只能 import web/frontend 下的组件与 api 客户端，以及 src/shared 的纯函数；后端模块属于另一个运行时。',
        },
      ] }],
    },
  },

  // 单文件行数预算——三档（提醒 / 必须登记 / 硬禁止），实现见 eslint-rules/line-budget.js。
  //
  // 为什么是本地规则而不是内置 max-lines：内置那条一个文件只报一条消息、只认一个 max，
  // 表达不了分段语义；而且 ESLint 的严重级别是按规则配置定的，所以提醒档与禁止档
  // 必须拆成两个规则 ID。
  //
  // 登记表在 eslint-line-budget.json（可 code review），不在代码里写死。
  //
  // 生效目录：src/**、tests/**、scripts/**。三个 >1000 行的存量文件已经拆完，
  // 现在 src 一起接上；800~999 的存量文件在 eslint-line-budget.json 的 registry 里登记，
  // 拆完一个删一条。
  {
    files: [
      'src/**/*.{js,mjs,cjs,jsx,ts,tsx}',
      'tests/**/*.{js,mjs,cjs,jsx,ts,tsx}',
      'scripts/**/*.{js,mjs,cjs,jsx,ts,tsx}',
    ],
    plugins: {
      local: {
        rules: {
          'line-budget-warn': lineBudgetWarn,
          'line-budget-error': lineBudgetError,
        },
      },
    },
    rules: {
      'local/line-budget-warn': ['warn', lineBudgetOptions],
      'local/line-budget-error': ['error', lineBudgetOptions],
    },
  },
];
