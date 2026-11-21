// 发布产物清理：tsc 的 outDir 不会删掉已改名的模块目录，vite 只清自己的 public。
// build 前整目录删，避免旧模块（如 sections/）残留在 dist 里被 module-registry 扫到。
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
// tsc 的 incremental 缓存也一起删：否则 dist 被清掉后它会误判「已是最新」而不 emit。
rmSync(new URL('../node_modules/.tmp/tsconfig.build.tsbuildinfo', import.meta.url), { force: true });
