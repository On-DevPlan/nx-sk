// CLI 参数安全：把「命令行传不了的东西」换成可传的形式。
//
// 为什么不放 runtime/spec.js：那里的 coerce() 是 CLI 与 HTTP **共用**的纯净解码器，
// 而 HTTP 没有「命令行通道」这回事。CLI 专属的通道问题集中在 CLI 适配层解决。
//
// 背景（真实事故，见 ref 20-secrets）：Windows 上值经命令行参数传递时，启动器 shim
// （Volta shim / npm 生成的 .cmd）会把换行当命令分隔符截断、把 < > 当重定向符，
// 而命令**报成功**——一次性凭据就这么静默丢掉大半。文件与管道是可靠通道。
//
// 为什么不在这里做「检测损坏就报错」：实测做不到（详见 cli.js 的 expandSafeArgs）。
// 损坏后的值里 CR 是被**删掉**而非保留，所以「含 CR」既抓不到损坏（零真阳性）、
// 又会拦住用 --data 写入的合法 CRLF 多行值（高假阳性）；LF 截断后则与合法单行值
// 完全不可区分。可靠的信号不存在，因此只能提供可靠通道 + 修好通道本身。
import { readFileSync } from 'node:fs';
import { badInput } from './errors.js';

/**
 * `--data` 的值：JSON 字面量 / `@文件路径` / `-`（stdin）。
 *
 * takeStdin 由调用方注入——CLI 传 readFileSync(0)，测试能换桩。
 * 「读 stdin」因此不是一个无法测试的隐式依赖，也让本模块保持纯函数（不自己碰 fd 0）。
 */
export function parseDataArg(raw, takeStdin) {
  const s = String(raw ?? '').trim();
  if (!s) throw badInput('--data 需要一个 JSON 字面量、@文件路径，或 -（从 stdin 读）');
  if (s === '-' || s === '@-') return parseJson(takeStdin(), '-');
  if (s.startsWith('@')) return parseJson(readText(s.slice(1)), s.slice(1));
  return parseJson(s, '--data'); // 直接给的字面 JSON
}

/** 值本身走 stdin 的入口（`key set NAME -`）。true 表示「这个值来自 stdin」。 */
export function parseStdinValue(raw) {
  return String(raw ?? '').trim() === '-';
}

function parseJson(text, src) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw badInput(`--data 不是合法 JSON（${src}）: ${e.message}`);
  }
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    // 路径写法是最常见的坑：Git Bash 的 /tmp 在 node 侧看不到（真实事故 ENOENT），
    // 所以错误里直接把 Windows 路径形式写出来，省掉一轮排查。
    throw badInput(`读取文件失败: ${p}（${e.message}）—— Windows 上请用 C:/Users/... 形式的路径`);
  }
}

