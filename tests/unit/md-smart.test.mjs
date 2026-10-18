// 裸地址识别：IP（点击复制）/ 域名（点击打开）。
//
// 这里钉的是「认错」的边界，因为认错不报错，只是正文里多一条点不开的东西：
//   - `config.json`、`README.md` 这类文件名被当成域名
//   - 已经有协议的地址被再认一次（`https://a.com` 里再套一层 `a.com`）
//   - 中文紧跟其后时被吞进路径（`…/login登录`）
//   - 非法 IP / 端口被当成可点
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { splitSmart, smartStats } = await import('../../src/web/frontend/mdSmart.js');

const kinds = (text) => (splitSmart(text) || []).map((p) => p.type);
const only = (text) => (splitSmart(text) || []).filter((p) => p.type !== 'text');

test('IP 带端口：整段成为一个「点击复制」token', () => {
  assert.deepEqual(only('125.67.197.2:7443'), [{ type: 'copy', text: '125.67.197.2:7443' }]);
  assert.deepEqual(only('10.0.0.1'), [{ type: 'copy', text: '10.0.0.1' }]);
  assert.deepEqual(only('localhost:7866'), [{ type: 'copy', text: 'localhost:7866' }]);
});

test('非法 IP / 端口不认', () => {
  assert.equal(splitSmart('999.1.1.1'), null);
  assert.equal(splitSmart('1.2.3.4:99999'), null);
  assert.equal(splitSmart('1.2.3.4:0'), null);
  assert.equal(splitSmart('版本 1.2.3.4.5'), null, '五段不是 IP');
});

test('域名（可带路径/端口）：默认补 http://，文字保持原样', () => {
  assert.deepEqual(only('qcloud.sicau.edu.cn/login'), [
    { type: 'url', text: 'qcloud.sicau.edu.cn/login', url: 'http://qcloud.sicau.edu.cn/login' },
  ]);
  assert.deepEqual(only('example.com'), [{ type: 'url', text: 'example.com', url: 'http://example.com' }]);
  assert.deepEqual(only('example.com:8080/a?b=1'), [
    { type: 'url', text: 'example.com:8080/a?b=1', url: 'http://example.com:8080/a?b=1' },
  ]);
});

test('文件名不是域名（TLD 黑名单）', () => {
  for (const s of ['config.json', 'README.md', 'package.json', 'a.min.js', 'main.css', 'app.py', 'x.tar.gz']) {
    assert.equal(splitSmart(s), null, s);
  }
});

test('已经有协议的地址、邮箱、路径里的域名都不再识别', () => {
  assert.equal(splitSmart('https://a.com'), null);
  assert.equal(splitSmart('见 http://125.67.197.2:7443'), null);
  assert.equal(splitSmart('a@b.com'), null);
  assert.equal(splitSmart('./vendor/a.com/x'), null);
});

test('中文紧跟其后：只认到地址该结束的地方', () => {
  assert.deepEqual(only('见125.67.197.2:7443，然后重启'), [{ type: 'copy', text: '125.67.197.2:7443' }]);
  const parts = splitSmart('见125.67.197.2:7443，然后重启');
  assert.equal(parts.at(-1).text, '，然后重启', '标点要回到正文里');

  assert.deepEqual(only('访问qcloud.sicau.edu.cn/login登录'), [
    { type: 'url', text: 'qcloud.sicau.edu.cn/login', url: 'http://qcloud.sicau.edu.cn/login' },
  ]);
  assert.deepEqual(only('example.com/a。'), [
    { type: 'url', text: 'example.com/a', url: 'http://example.com/a' },
  ]);
});

test('一段里多个地址按顺序切开，普通文字原样保留', () => {
  const parts = splitSmart('A 10.0.0.1 B qcloud.sicau.edu.cn/login C');
  assert.deepEqual(parts.map((p) => (p.type === 'text' ? p.text : p.type)), ['A ', 'copy', ' B ', 'url', ' C']);
  assert.deepEqual(kinds('没有地址的一段话'), []);
  assert.equal(splitSmart(''), null);
  assert.equal(splitSmart(null), null);
});

test('表格里：竖线不会被吞进路径', () => {
  assert.deepEqual(only('example.com/a|下一格'), [
    { type: 'url', text: 'example.com/a', url: 'http://example.com/a' },
  ]);
});

// 工具栏那句「链接 N 个 · IP N 个」靠它。代码块里的地址不会变成可点，
// 算进去就是虚报 —— 用户会去数，然后发现数不上。
test('smartStats：代码里的地址不计入', () => {
  const text = ['见 125.67.197.2:7443 与 example.com/a', '', '`10.0.0.1` 和', '```', '8.8.8.8', '```'].join('\n');
  assert.deepEqual(smartStats(text), { copy: 1, url: 1 });
  assert.deepEqual(smartStats('没有地址'), { copy: 0, url: 0 });
  assert.deepEqual(smartStats(null), { copy: 0, url: 0 });
});
