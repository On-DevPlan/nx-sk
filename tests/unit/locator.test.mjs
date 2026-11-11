// locator（内部资源定位符）的穷举测试：parse 对任意脏输入返回 null 不抛；
// 四类规范形态 + 旧复合串 ↔ locator 的等价写法（磁盘格式一字不改的红线在这里钉）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  parseLocator, formatLocator, kindOf, isLocator, locatorAliases,
  formatFieldComposite, LOCATOR_SCHEME, LOCATOR_KINDS,
} = await import('../../src/shared/locator.ts');

const GOOD = [
  ['nx-sk://section/demo', { kind: 'section', sectionId: 'demo' }],
  ['nx-sk://entry/e_9f8e7d6c', { kind: 'entry', entryId: 'e_9f8e7d6c' }],
  ['nx-sk://field/e_1/name', { kind: 'field', entryId: 'e_1', key: 'name' }],
  ['nx-sk://field/e_1/微信号', { kind: 'field', entryId: 'e_1', key: '微信号' }],
  ['nx-sk://file/f_abc123', { kind: 'file', fileId: 'f_abc123' }],
];

test('四类规范形态：parse 出各段，format 原样回去（往返恒等）', () => {
  for (const [text, parts] of GOOD) {
    assert.deepEqual(parseLocator(text), parts, text);
    assert.equal(formatLocator(parts), text, text);
    assert.equal(kindOf(text), parts.kind);
    assert.equal(isLocator(text), true);
  }
});

test('旧复合串 section:key：parse 认它（等价 field 定位），aliases 给出规范写法', () => {
  const parts = parseLocator('demo:name');
  assert.deepEqual(parts, { kind: 'field', sectionId: 'demo', key: 'name' });
  assert.equal(kindOf('demo:name'), 'field');
  assert.deepEqual(locatorAliases('demo:name'), ['demo:name', 'nx-sk://field/demo/name'], 'aliases 给出全部等价写法（含自身）');
  // 反向：规范 field locator（sectionId 段）的等价旧写法就是复合串
  assert.deepEqual(locatorAliases({ kind: 'field', sectionId: 'demo', key: 'name' }),
    ['demo:name', 'nx-sk://field/demo/name']);
  // identity.fieldTargetKey 的构造口径 = formatFieldComposite（落盘串一字不改）
  assert.equal(formatFieldComposite('demo', 'name'), 'demo:name');
});

test('脏输入一律 null 不抛：空/空白/未知 kind/段数不对/注入样串/超长/控制字符', () => {
  const BAD = [
    '', ' ', '\n', null, undefined, 123, {}, [], true,
    'nx-sk://', 'nx-sk:///', 'nx-sk://section/', 'nx-sk://section', 'nx-sk://section//',
    'nx-sk://section/a/b', 'nx-sk://entry/e_1/x', 'nx-sk://field/e_1', 'nx-sk://field/e_1/a/b',
    'nx-sk://file/f_1/x', 'nx-sk://unknown/x', 'nx-sk://FIELD/e_1/k',
    'nx-sk://section/a b', 'nx-sk://section/a\\b',
    'http://nx-sk/section/a', 'https://example.com', 'javascript:alert(1)',
    'C:\\Users\\x', '/api/entries', 'e_1', 'demo', 'f_abc',
    'nx-sk://section/ x',
    'a:b:c', ':b', 'a:', '::', '://', 'nx-sk://field//k',
    'x'.repeat(4096),
    'nx-sk://' + 'y'.repeat(600),
    // 复合串里带斜杠/双冒号 → 不是 locator
    'a/b:c', 'a:b/c',
  ];
  for (const s of BAD) {
    let out;
    assert.doesNotThrow(() => { out = parseLocator(s); }, `parse 抛了: ${JSON.stringify(String(s))}`);
    assert.equal(out, null, `应判 null: ${JSON.stringify(String(s))}`);
    assert.equal(isLocator(s), false, `isLocator 应判 false: ${JSON.stringify(String(s))}`);
  }
});

test('前后空白容忍（粘贴场景），但段内空白/斜杠仍拒绝', () => {
  assert.deepEqual(parseLocator('  nx-sk://section/demo  '), { kind: 'section', sectionId: 'demo' });
  assert.equal(parseLocator('nx-sk://section/a b'), null);
});

test('format 对坏 parts 抛错（构造层是程序 bug 的关口，不是脏输入关口）', () => {
  assert.throws(() => formatLocator(null));
  assert.throws(() => formatLocator({ kind: 'section' }));
  assert.throws(() => formatLocator({ kind: 'field', entryId: 'e_1' }));
  assert.throws(() => formatLocator({ kind: 'field', entryId: 'e 1', key: 'a' }));
  assert.throws(() => formatLocator({ kind: 'nope', sectionId: 'x' }));
});

test('aliases：section/entry/file 的旧写法就是裸 id；解析不出来的输入返回空数组', () => {
  assert.deepEqual(locatorAliases('nx-sk://section/demo'), ['demo']);
  assert.deepEqual(locatorAliases('nx-sk://entry/e_1'), ['e_1']);
  assert.deepEqual(locatorAliases('nx-sk://file/f_1'), ['f_1']);
  assert.deepEqual(locatorAliases('nx-sk://field/e_1/k'), ['nx-sk://field/e_1/k']);
  assert.deepEqual(locatorAliases('garbage'), []);
  assert.deepEqual(locatorAliases(null), []);
});

test('kind 清单封闭：LOCATOR_KINDS 与 parse 认的段一致', () => {
  assert.deepEqual([...LOCATOR_KINDS], ['section', 'entry', 'field', 'file']);
  assert.equal(LOCATOR_SCHEME, 'nx-sk://');
});
