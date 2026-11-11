import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const gitLines = (args) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(out.split('\n').filter(Boolean)) : reject(new Error(`git ${args.join(' ')} 退出码 ${code}`))));
});

/**
 * 用 git **自己**判，而不是读 .gitignore 的文本：
 * 规则写成哪种形式都算数（目录前缀、通配层级都可能变），只要 git 认就行。
 * `check-ignore` 对**不存在**的路径也照判，所以不必真造文件。
 *
 * 退出码是唯一判据：0 = 被忽略，1 = 没匹配到规则。
 * 别用 promisify(execFile) —— 它在成功时不给 `code`，只有 stdout/stderr，
 * 那样 `code === 0` 恒为 false，守卫会「永远通过」。
 */
const isIgnored = (p) => new Promise((resolve) => {
  const child = spawn('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' });
  child.on('error', () => resolve(false));
  child.on('close', (code) => resolve(code === 0));
});

// 2026-09-24 的教训：一次 `git add -A` 把用户放在项目目录里的简历 PDF 与面板截图
// 扫进了提交，最后靠 reset --soft + 重写历史才清掉。这类东西一旦 push 到公开仓库
// 就收不回来，所以必须有断言兜底，不能只靠「写在 .gitignore 里的君子协定」。
const MUST_BE_IGNORED = [
  'store.json',                    // 旧版整库数据：档案 + 密文凭据（首启导入后改名留证，同样不许入库）
  'store.json.pre-kv-backup',      // 迁移/备份副本（容易漏：它不匹配 `store.json`）
  'store.json.imported-20261111-112955', // 导入留证副本
  'nxsk.db',                       // 0.36 起的整库数据（SQLite 主库）
  'nxsk.db-wal',                   // WAL 附属（里面同样有未 checkpoint 的数据）
  'nxsk.db-shm',
  'nxsk.db.imported-x',            // 库级留证副本
  '.vaultkey',                     // 加密密钥本体
  '.vaultsalt',                    // 口令派生的盐
  '张三-个人信息.txt',
  '张三的简历.pdf',
  'nx-sk-panel.png',
  'seed/job.json',
];

test('.gitignore 挡得住 PII 与本机数据', async () => {
  for (const p of MUST_BE_IGNORED) {
    assert.ok(await isIgnored(p), `git check-ignore 没有挡住 ${p} —— 这类文件一旦进仓库就收不回来`);
  }
});

test('仓库里当前没有任何被跟踪的 PII / 本机数据文件', async () => {
  const tracked = await gitLines(['ls-files']);
  const BAD = /(^|\/)(store\.json(\..*)?|nxsk\.db(-wal|-shm|-journal|\..*)?|\.vaultkey|\.vaultsalt)$|个人信息|简历/;
  const hits = tracked.filter((f) => BAD.test(f));
  assert.deepEqual(hits, [], `这些文件不该被 git 跟踪（要用 'git rm --cached' 摘掉）: ${hits.join(', ')}`);
});

test('仓库里没有 store.json / nxsk.db —— 真实数据在 ~/nx-sk/，在仓库之外', async () => {
  const found = (await gitLines(['ls-files'])).filter((f) => /(^|\/)(store\.json|nxsk\.db)$/.test(f));
  assert.deepEqual(found, [], `仓库里出现了本机数据文件，数据应在 ~/nx-sk/: ${found.join(', ')}`);
});
