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
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const BASE = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off', // 浏览器/Node 全局混用，靠运行时暴露
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

// 模块互依禁列：**逐模块枚举**，不是通配。
// 漏补一个新模块 → 它悄悄变成「谁都可以依赖」，且没有任何断言会红（见 ref 07 第三节）。
// 唯一例外是 ../settings/*（基础模块，允许被单向只读依赖），"例外"的实现方式就是**不列进来**。
const SIBLING_MODULES = [
  '../system/*',
  '../sections/*',
  '../entries/*',
  '../files/*',
  '../transfer/*',
  '../skill/*',
];

export default [
  { ignores: ['src/web/public/**', 'node_modules/**', 'assets/**', 'tests/fixtures/**'] },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // 少了这一行，所有 .jsx 都会 Parsing error: Unexpected token '<'
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: BASE,
  },

  // core 是最底层
  {
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['../modules/**', '../runtime/**', '../web/**'],
          message: 'core 是最底层，不得依赖 modules / runtime / web。' },
      ] }],
    },
  },

  // 模块之间不得互相依赖。唯一例外：../settings/service.js（基础模块）。
  {
    files: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: SIBLING_MODULES,
          message: '模块之间不得互相依赖；共享逻辑下沉 core/。唯一例外：../settings/service.js（基础模块）。' },
      ] }],
    },
  },

  // 聚合模块是刻意的例外（system 读各模块状态；transfer 负责栏目导出导入的跨模块编排，
  // 依赖方向单向 transfer → entries/sections，不构成环）
  { files: ['src/modules/system/**/*.js', 'src/modules/transfer/**/*.js'], rules: { 'no-restricted-imports': 'off' } },

  // JSX 里的组件引用要算「使用」，否则每个组件都报 no-unused-vars
  {
    files: ['**/*.jsx'],
    plugins: { react },
    rules: { 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'off' },
  },

  // hooks 规则只对视图与前端壳生效（视图现在就在前端目录里，一套 files 就够了）
  {
    files: ['src/web/frontend/**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },

  // 前后端边界——价值最高的一条。视图全部住在 src/web/frontend 下，
  // 所以 files 用一条 `**/*.{js,jsx}` 就覆盖了所有前端代码；
  // 不需要再单独给 modules 下的 .jsx 开口子（那里已经没有前端文件了）。
  {
    files: ['src/web/frontend/**/*.{js,jsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: '前端不能引用 Node 内置模块。' },
        { group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/runtime/**', '**/core/**'],
          message: '前端只能 import web/frontend 下的组件与 api 客户端，以及 src/shared 的纯函数；后端模块属于另一个运行时。' },
      ] }],
    },
  },
];
