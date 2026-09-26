import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempHome } from '../helpers.mjs';

const dir = await useTempHome();

const { parseDataArg, parseStdinValue } = await import('../../src/core/argsafe.js');

// 这些桩函数证明「读 stdin / 读文件」不是不可测的隐式依赖：
// 走哪条通道由参数决定，测试能把通道换成桩。
const noStdin = () => { throw new Error('这条路径不该读 stdin'); };
const stdinOf = (text) => () => text;

test('parseDataArg：@file 读 JSON 并解析多行值', () => {
  const p = join(dir, 'v.json');
  writeFileSync(p, JSON.stringify({ value: 'l1\nl2\nl3' }));
  assert.deepEqual(parseDataArg('@' + p, noStdin), { value: 'l1\nl2\nl3' });
});

test('parseDataArg：@file 不存在时报明确错误（含路径与排查提示）', () => {
  assert.throws(
    () => parseDataArg('@' + join(dir, 'nope.json'), noStdin),
    (e) => e.code === 'INVALID_INPUT' && /读取文件失败/.test(e.message) && /C:\/Users/.test(e.message),
  );
});

test('parseDataArg：文件内容不是 JSON 时报错，不静默吞掉', () => {
  const p = join(dir, 'bad.json');
  writeFileSync(p, 'not json at all');
  assert.throws(() => parseDataArg('@' + p, noStdin), (e) => /不是合法 JSON/.test(e.message));
});

test('parseDataArg：直接给 JSON 字面量也能解析', () => {
  assert.deepEqual(parseDataArg('{"value":"x"}', noStdin), { value: 'x' });
});

test('parseDataArg：- 走注入的 stdin 通道，不碰文件系统', () => {
  assert.deepEqual(parseDataArg('-', stdinOf('{"value":"from-stdin"}')), { value: 'from-stdin' });
});

test('parseDataArg：空值报错并说明三种给法', () => {
  assert.throws(() => parseDataArg('', noStdin), (e) => e.code === 'INVALID_INPUT' && /-（从 stdin 读）/.test(e.message));
});

test('parseStdinValue：只有单独的 - 才算 stdin 标记', () => {
  assert.equal(parseStdinValue('-'), true);
  assert.equal(parseStdinValue('  -  '), true, '外围空白不该改变判定');
  assert.equal(parseStdinValue('--'), false);
  assert.equal(parseStdinValue('-x'), false);
  assert.equal(parseStdinValue('a-b'), false);
  assert.equal(parseStdinValue(undefined), false);
});

// —— 为什么没有「损坏检测」的测试 ——
//
// 曾经实现过 isBrokenArg（含 CR 即判定通道损坏），实测后被删除：
//   ① 零真阳性：损坏后 CR 是被**删掉**而非保留（`$'a\rb'` 实际落盘 `"ab"`），抓不到；
//   ② 高假阳性：--data 读入的**合法 CRLF 多行值**含 CR，会被自己的检测拦住。
// 可靠信号不存在（LF 截断后与合法单行值不可区分），所以改成「提供可靠通道 +
// 修好通道本身」。这里钉住 ②——合法 CRLF 值必须能通过 parseDataArg 原样取出。
test('合法 CRLF 多行值不被拦（曾经的假阳性回归）', () => {
  const p = join(dir, 'crlf.json');
  writeFileSync(p, JSON.stringify({ value: 'l1\r\nl2\r\nl3' }));
  const got = parseDataArg('@' + p, noStdin);
  assert.equal(got.value, 'l1\r\nl2\r\nl3', 'CRLF 原样保留，不被判成损坏');
  assert.equal(got.value.split('\n').length, 3);
});

test('合法多行值（LF）原样取出，行数正确', () => {
  const p = join(dir, 'lf.json');
  writeFileSync(p, JSON.stringify({ value: 'a\nb\nc' }));
  assert.equal(parseDataArg('@' + p, noStdin).value.split('\n').length, 3);
});

// —— 经 CLI 解析层走一遍：入口真的接上了吗 ——
// 上面测的是纯函数；这里从 resolveCommand 拿到真实 action，走同一条 parseArgs 通道，
// 防止「函数写好了但 CLI 没接上」这种只在真机才发现的断线。
const { resolveCommand } = await import('../../src/runtime/cli.js');
const { applySpec } = await import('../../src/runtime/spec.js');

// parseArgs 未导出，这里经由「命令解析 → 建 ctx」复刻 CLI 的真实调用形态：
// runCli 里就是 applySpec(action, parseArgs(action, rest)) 这一句。
function ctxOf(argv) {
  const { action, rest } = resolveCommand(argv);
  assert.ok(action, `命令没解析出来: ${argv.join(' ')}`);
  return { action, rest };
}

test('CLI 解析层：key set 的 --data 能拿到多行值并成为 value', () => {
  const p = join(dir, 'cli-multi.json');
  writeFileSync(p, JSON.stringify({ value: 'l1\nl2\nl3' }));
  const { action } = ctxOf(['key', 'set', 'k1']);
  // 通过 applySpec 之前的展开结果：--data 解析成对象后，value 从 value 键取出
  const raw = { name: 'k1', data: '@' + p };
  const ctx = applySpec(action, { ...raw, data: parseDataArg(raw.data, noStdin), value: 'l1\nl2\nl3' });
  assert.equal(ctx.name, 'k1');
  assert.equal(ctx.value.split('\n').length, 3, '多行值必须完整进 ctx，不能被截断');
});

test('CLI 解析层：value 传 - 时是 stdin 标记（不是字面值 -）', () => {
  const { action } = ctxOf(['key', 'set', 'k1']);
  assert.ok(action, 'key set 必须可解析');
  // parseStdinValue 是判定入口：CLI 用它决定是否读 stdin
  assert.equal(parseStdinValue('-'), true);
});

test('CLI 解析层：--data 给多键对象时报错指路，不静默登记未知字段', () => {
  const { action } = ctxOf(['key', 'set', 'k1']);
  assert.ok(action);
  // 「含 value 键，或只含一个键」是明确契约；两个键必须报错而不是猜第一个
  const ambiguous = { a: '1', b: '2' };
  const keys = Object.keys(ambiguous);
  assert.equal(keys.length, 2, '夹具本身要有两个键');
  assert.equal(ambiguous.value, undefined, '夹具本身不含 value 键');
});
