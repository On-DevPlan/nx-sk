// 块正文（entry.body）：**递归**的块树 —— 容器块有 children，叶块没有。
//
// 这里钉的是语义，不是实现：
//   - 类型词汇表与设计 §十三 13.2 一致（10 种），不在代码里另发明
//   - 转类型是**整块替换**：合并会把旧类型的残留字段留在块里
//   - 容器块（column）分两层：widths 非空 = 列组，为空 = 叶子列
//   - 校验与归一**前后端同源**（shared/blocks.js）——CLI 与面板对不上比不给更糟
//   - secret 块的值是**密文对象**，明文落盘是泄露
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const B = await import('../../src/shared/blocks.js');

test('词汇表：v1 实现 9 种（toggle 推迟），容器两种', () => {
  // 设计 §十三 13.2 说「10 种」，但其中 toggle 明确「下一版再做」——
  // v1 落地的是 7 种叶块 + section + column = 9 种。少的那一种是**故意推迟**的，不是漏了。
  assert.equal(B.BLOCK_TYPES.length, 9);
  assert.ok(!B.BLOCK_TYPES.includes('toggle'), 'toggle 推迟到下一版');
  assert.deepEqual(B.CONTAINER_TYPES, ['section', 'column']);
  for (const t of B.BLOCK_TYPES) assert.ok(B.BLOCK_TYPES.includes(t));
});

test('归一：缺 id / 未知类型 / 非对象的块一律丢掉（不静默改写）', () => {
  assert.equal(B.normalizeBlock({ type: 'paragraph', text: 'x' }), null, '缺 id 要丢');
  assert.equal(B.normalizeBlock({ id: 'b_1', type: 'nope' }), null, '未知类型要丢');
  assert.equal(B.normalizeBlock(null), null);
  assert.equal(B.normalizeBlock('paragraph'), null);
  const out = B.normalizeBlocks([{ id: 'b_1', type: 'paragraph', text: '好' }, { id: 'b_2', type: 'bogus' }, null]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '好');
});

test('归一：各类型的默认形状', () => {
  assert.deepEqual(B.normalizeBlock({ id: 'b_1', type: 'paragraph' }), { id: 'b_1', type: 'paragraph', text: '' });
  assert.deepEqual(B.normalizeBlock({ id: 'b_2', type: 'heading', text: 'T' }), { id: 'b_2', type: 'heading', text: 'T', level: 2 });
  assert.deepEqual(B.normalizeBlock({ id: 'b_3', type: 'file' }), { id: 'b_3', type: 'file', files: [] });
  assert.deepEqual(B.normalizeBlock({ id: 'b_4', type: 'section' }), { id: 'b_4', type: 'section', sectionId: '' });
  const col = B.normalizeBlock({ id: 'b_5', type: 'column' });
  assert.deepEqual(col.widths, []);
  assert.deepEqual(col.children, []);
});

test('归一：heading 的 level 只认 1/2/3（别的落回 2）', () => {
  assert.equal(B.normalizeBlock({ id: 'b_1', type: 'heading', level: 9 }).level, 2);
  assert.equal(B.normalizeBlock({ id: 'b_2', type: 'heading', level: 3 }).level, 3);
});

test('校验：id 重复 / secret 存明文 / section 缺 sectionId 都要报出来', () => {
  const dup = [{ id: 'b_1', type: 'paragraph' }, { id: 'b_1', type: 'paragraph' }];
  assert.ok(B.validateBlocks(dup).some((e) => e.includes('重复')));

  const leak = [{ id: 'b_1', type: 'secret', value: 'sk-plaintext' }];
  assert.ok(B.validateBlocks(leak).some((e) => e.includes('明文')));

  const missing = [{ id: 'b_1', type: 'section' }];
  assert.ok(B.validateBlocks(missing).some((e) => e.includes('sectionId')));

  assert.deepEqual(B.validateBlocks([{ id: 'b_1', type: 'paragraph', text: '好' }]), []);
});

test('校验：secret 块的值是密文对象时**不报**（那才是正常形态）', () => {
  const ok = [{ id: 'b_1', type: 'secret', value: { alg: 'aes-256-gcm', iv: 'x', tag: 'y', ct: 'z' } }];
  assert.deepEqual(B.validateBlocks(ok), []);
});

test('校验：列组的 widths 之和要等于 100，且至少两个子列', () => {
  const bad = [{ id: 'b_1', type: 'column', widths: [60, 30], children: [
    { id: 'b_1a', type: 'column' }, { id: 'b_1b', type: 'column' },
  ] }];
  assert.ok(B.validateBlocks(bad).some((e) => e.includes('widths')));

  const one = [{ id: 'b_1', type: 'column', widths: [100], children: [{ id: 'b_1a', type: 'column' }] }];
  assert.ok(B.validateBlocks(one).some((e) => e.includes('至少')));

  const good = [{ id: 'b_1', type: 'column', widths: [60, 40], children: [
    { id: 'b_1a', type: 'column' }, { id: 'b_1b', type: 'column' },
  ] }];
  assert.deepEqual(B.validateBlocks(good), []);
});

test('校验要递归进容器块里（深处的坏块也要被看见）', () => {
  const deep = [{
    id: 'b_1', type: 'column', widths: [50, 50], children: [
      { id: 'b_1a', type: 'column', children: [{ id: 'b_1a1', type: 'secret', value: 'plain' }] },
      { id: 'b_1b', type: 'column' },
    ],
  }];
  assert.ok(B.validateBlocks(deep).some((e) => e.includes('明文')));
});

test('找块 / 找容器：深搜', () => {
  const body = [
    { id: 'b_1', type: 'paragraph' },
    { id: 'b_2', type: 'column', widths: [50, 50], children: [
      { id: 'b_2a', type: 'paragraph' },
      { id: 'b_2b', type: 'column', children: [{ id: 'b_2b1', type: 'paragraph' }] },
    ] },
  ];
  assert.equal(B.findBlock(body, 'b_2b1').id, 'b_2b1');
  assert.equal(B.findBlock(body, 'nope'), null);
  assert.equal(B.findContainer(body, 'b_2a').id, 'b_2');
  assert.equal(B.findContainer(body, 'b_1'), null, '顶层块的容器是 null');
});

test('转类型是**整块替换**：旧类型的残留字段不许留下', () => {
  const body = [{ id: 'b_1', type: 'table', columns: [{ key: 'a' }], rows: [{ a: 1 }] }];
  const next = B.replaceBlock(body, 'b_1', { type: 'paragraph', text: '改成段落' });
  assert.equal(next[0].type, 'paragraph');
  assert.equal(next[0].columns, undefined, '旧类型的 columns 不能残留');
  assert.equal(next[0].rows, undefined, '旧类型的 rows 不能残留');
  assert.equal(next[0].id, 'b_1', 'id 必须保留');
});

test('合并更新只改给定的字段（PATCH 语义）', () => {
  const body = [{ id: 'b_1', type: 'paragraph', text: '旧' }];
  const next = B.updateBlock(body, 'b_1', { text: '新' });
  assert.equal(next[0].text, '新');
  assert.equal(next[0].type, 'paragraph');
});

test('删除块连同子树一起删', () => {
  const body = [
    { id: 'b_1', type: 'paragraph' },
    { id: 'b_2', type: 'column', children: [{ id: 'b_2a', type: 'paragraph' }] },
  ];
  const next = B.removeBlock(body, 'b_2');
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'b_1');
});

test('移动：在容器内换位置；越界夹到边界', () => {
  const body = [{ id: 'b_1' }, { id: 'b_2' }, { id: 'b_3' }];
  const moved = B.moveToIndex(body, null, 'b_3', 0);
  assert.deepEqual(moved.map((b) => b.id), ['b_3', 'b_1', 'b_2']);
  const clamped = B.moveToIndex(body, null, 'b_1', 99);
  assert.deepEqual(clamped.map((b) => b.id), ['b_2', 'b_3', 'b_1']);
});

test('追加块：默认追加到尾部，after 指定就插在它后面', () => {
  const body = [{ id: 'b_1' }, { id: 'b_2' }];
  const tail = B.appendBlock(body, { id: 'b_3' });
  assert.deepEqual(tail.map((b) => b.id), ['b_1', 'b_2', 'b_3']);
  const after = B.appendBlock(body, { id: 'b_3' }, 'b_1');
  assert.deepEqual(after.map((b) => b.id), ['b_1', 'b_3', 'b_2']);
});

test('附件 id 收集：file 块的 id（含容器里的）', () => {
  const body = [
    { id: 'b_1', type: 'file', files: ['f_1'] },
    { id: 'b_2', type: 'column', children: [{ id: 'b_2a', type: 'file', files: ['f_2'] }] },
    { id: 'b_3', type: 'paragraph' },
  ];
  assert.deepEqual(B.fileIdsInBlocks(body).sort(), ['f_1', 'f_2']);
});

test('keepsText：只有文本型块转过去能保住原文', () => {
  assert.ok(B.keepsText('paragraph'));
  assert.ok(B.keepsText('heading'));
  assert.ok(B.keepsText('md'));
  assert.ok(!B.keepsText('table'));
  assert.ok(!B.keepsText('secret'));
});
