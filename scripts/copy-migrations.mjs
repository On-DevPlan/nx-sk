// 把 src/core/db/migrations/*.sql 原样拷进 dist/core/db/migrations/。
//
// 为什么需要：tsc 只 emit .ts；迁移 runner 运行时按 `new URL('./vN.sql', import.meta.url)`
// 读脚本（保持 SQL 可独立 review，与 nx-kv 同一做法），发布产物里没有这些文件就起不来。
// 只拷 .sql——迁移区里的 .js/.ts 由 tsc 负责。
import { cpSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC_DIR = join(ROOT, 'src', 'core', 'db', 'migrations');
const DST_DIR = join(ROOT, 'dist', 'core', 'db', 'migrations');

if (!existsSync(SRC_DIR)) {
  console.error(`copy-migrations: 找不到 ${SRC_DIR}`);
  process.exit(1);
}
mkdirSync(DST_DIR, { recursive: true });
const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.sql'));
for (const f of files) cpSync(join(SRC_DIR, f), join(DST_DIR, f));
console.log(`copy-migrations: 已拷贝 ${files.length} 份迁移脚本 → dist/core/db/migrations/`);
