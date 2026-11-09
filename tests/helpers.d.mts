// tests/helpers.mjs 的最小类型声明。
// P5 从 tsconfig.base 移除了 allowJs（后端与 shared 已无 .js），但 .ts 测试仍会
// import 这个 .mjs 工具；没有声明时 tsc 会报 TS7016（隐式 any）。
export function useTempHome(prefix?: string): Promise<string>;
export function projectRoot(): URL;
