// secret 块：密文边界 —— 与敏感字段**同一条**规则，但认领方式不同。
//
// 关键差别（也是块级相对表格列的安全优势）：
//   表格的敏感列只能「按值猜 + 行号兜底」；块**按 blockId 精确认领**。
// 所以块这里能做到：面板把打码值原样回传时，认得出「这没改」→ 保留现密文；
// 认不出 → **报错**，绝不把打码值当新密码加密存进去（那会让凭据永久变成 `***`）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-block-crypto-');

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { loadStore } = await import('../../src/core/store.js');
const { isCipherBlob, maskValue } = await import('../../src/core/crypto.js');

const SECRET = 'sk-abcdefghijklmnopqrstuvwx';

let seq = 0;
/** 每个测试一条独立条目（同一个临时 home 里栏目只建一次）。 */
async function setup() {
  seq += 1;
  const store = await loadStore();
  if (!store.sections.some((x) => x.id === 'blk')) {
    await sections.addSection({
      id: 'blk',
      title: '块测试',
      fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }],
    });
  }
  const e = await entries.addEntry({ section: 'blk', title: `条目${seq}`, data: { name: `条目${seq}` } });
  return e.id;
}

test('secret 块写入后**落盘是密文**，读出来默认是明文', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'secret', data: { label: 'API Key', value: SECRET } });

  const store = await loadStore();
  const entry = store.entries.find((e) => e.id === entryId);
  const secret = entry.body.find((b) => b.type === 'secret');
  assert.ok(secret, 'secret 块没落盘');
  assert.ok(isCipherBlob(secret.value), '落盘的值必须是密文对象');
  assert.notEqual(secret.value, SECRET);

  const read = await entries.listBlocks(entryId);
  assert.equal(read.blocks[0].value, SECRET, '读出来默认是明文（与敏感字段同一条规则）');
});

test('--mask：secret 块打码展示', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'secret', data: { label: 'K', value: SECRET } });
  const masked = await entries.listBlocks(entryId, { mask: true });
  assert.equal(masked.blocks[0].value, maskValue(SECRET));
  assert.notEqual(masked.blocks[0].value, SECRET);
});

test('打码占位写回被**拒收**（掩码写回会毁凭据）', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'secret', data: { label: 'K', value: SECRET } });
  const cur = (await entries.listBlocks(entryId)).blocks[0];

  // 认领要按 blockId **精确**比：只有「打码后恰好等于现值的打码」才算「没改」。
  // 这里是**另一个**值的打码 → 认领不上 → 必须报错。
  const otherMask = maskValue('sk-a-completely-different-secret-value');
  await assert.rejects(
    () => entries.updateBlockValue(entryId, cur.id, { data: { value: otherMask } }),
    (e) => e.code === 'INVALID_INPUT' && /打码/.test(e.message),
    '打码占位必须被拒 —— 否则凭据会被写成 ******',
  );

  const after = await entries.listBlocks(entryId);
  assert.equal(after.blocks[0].value, SECRET, '被拒之后原值必须还在');
});

test('打码占位**恰好等于现值的打码** → 认领成功，原样保留（不改、不报错）', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'secret', data: { label: 'K', value: SECRET } });
  const cur = (await entries.listBlocks(entryId)).blocks[0];

  const r = await entries.updateBlockValue(entryId, cur.id, { data: { value: maskValue(SECRET) } });
  assert.equal(r.status, 'ok');

  const store = await loadStore();
  const entry = store.entries.find((e) => e.id === entryId);
  const secret = entry.body.find((b) => b.type === 'secret');
  assert.ok(isCipherBlob(secret.value), '认领成功时保留的是**原密文**，不是新的密文');
  assert.equal((await entries.listBlocks(entryId)).blocks[0].value, SECRET);
});

test('转类型：secret → paragraph 是**整块替换**（密文不残留）', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'secret', data: { label: 'K', value: SECRET } });
  const cur = (await entries.listBlocks(entryId)).blocks[0];

  const r = await entries.updateBlockValue(entryId, cur.id, { data: { type: 'paragraph', text: '改成段落' } });
  assert.equal(r.converted, true);

  const store = await loadStore();
  const entry = store.entries.find((e) => e.id === entryId);
  const b = entry.body.find((x) => x.id === cur.id);
  assert.equal(b.type, 'paragraph');
  assert.equal(b.value, undefined, '旧类型的密文不能残留');
  assert.equal(b.label, undefined, '旧类型的 label 不能残留');
});

test('校验失败整体不落盘（写入即体检）', async () => {
  const entryId = await setup();
  await entries.addBlock(entryId, { type: 'paragraph', data: { text: '好' } });
  const before = (await loadStore()).entries.find((e) => e.id === entryId).body.length;

  // 列组 widths 之和不是 100 → 校验不过
  await assert.rejects(
    () => entries.addBlock(entryId, {
      type: 'column',
      data: { widths: [60, 30], children: [{ id: 'b_x1', type: 'column' }, { id: 'b_x2', type: 'column' }] },
    }),
    (e) => e.code === 'INVALID_INPUT' && /校验失败/.test(e.message),
  );

  const after = (await loadStore()).entries.find((e) => e.id === entryId).body.length;
  assert.equal(after, before, '校验不过的块不许落盘');
});
