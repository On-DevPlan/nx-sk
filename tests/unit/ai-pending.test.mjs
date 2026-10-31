// 块级 AI（pending）的单测：状态机 + 冲突 + 隔离。
//
// 钉四件事：
//   ① diff 是**字符级**的（「资源管理器」→「知识库」要能看出改了哪几个字）；
//   ② pending 是运行态：**不进 store.json、不进导出包**（文本层 + 结构层两路都查）；
//   ③ 应用是唯一写 store 的一步，块被改过就 CONFLICT（不覆盖用户的改动）；
//   ④ 拒绝 = 真删文件，数据一个字不动。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

const home = await useTempHome();
process.env.NX_SK_STORE = join(home, 'store.json');

const { diffText, validatePending } = await import('../../src/shared/blocks.js');
const { createPending, listPending, readPending, publicPending, diffBodies } = await import('../../src/modules/entries/aiPending.js');
const entries = await import('../../src/modules/entries/service.js');
const sections = await import('../../src/modules/sections/service.js');
const transfer = await import('../../src/modules/transfer/service.js');

// ── ① diff ────────────────────────────────────────────────
test('diffText：字符级，能定位到改了哪几个字', () => {
  const segs = diffText('我在做资源管理器。', '我在做知识库。');
  assert.deepEqual(segs.map((s) => s.op), ['same', 'del', 'ins', 'same']);
  assert.equal(segs[1].text, '资源管理器');
  assert.equal(segs[2].text, '知识库');
  assert.equal(segs.map((s) => s.text).join('').startsWith('我在做'), true);
});

test('diffText：空串与相同的串都有明确形状', () => {
  assert.deepEqual(diffText('', '新'), [{ op: 'ins', text: '新' }]);
  assert.deepEqual(diffText('旧', ''), [{ op: 'del', text: '旧' }]);
  assert.deepEqual(diffText('', ''), []);
  assert.deepEqual(diffText('一样', '一样'), [{ op: 'same', text: '一样' }]);
});

test('diffText：超长文本退化成整段删+整段增（不把服务端拖死）', () => {
  const a = '甲'.repeat(2000);
  const b = '乙'.repeat(2000);
  const segs = diffText(a, b, { maxCells: 1000 });
  assert.deepEqual(segs.map((s) => s.op), ['del', 'ins']);
});

// ── ② pending 结构校验 ────────────────────────────────────
test('validatePending：缺 baseHash / op 非法都要报出来', () => {
  const bad = { id: 'p_x', entryId: 'e_1', blocks: [], diffs: [{ blockId: 'b_1', segments: [{ op: '抹掉', text: 'x' }] }] };
  const errs = validatePending(bad);
  assert.ok(errs.some((e) => e.includes('baseHash')), errs.join('; '));
  assert.ok(errs.some((e) => e.includes('op 非法')), errs.join('; '));
  assert.ok(!validatePending({ id: 'p_x', entryId: 'e_1', blocks: [], diffs: [] }).length);
});

// ── 状态机（用真实 store）──────────────────────────────────
const SEC = 's4test';
await sections.addSection({ id: SEC, title: 'S4 测试' });
const created = await entries.addEntry({ section: SEC, title: '条目甲', data: { 备注: '初始' } });
const entryId = created.id;

const bodyOf = async () => (await entries.listBlocks(entryId)).blocks;

test('suggest 只落 pending，store 的 body 一个字不动', async () => {
  const rec = await entries.aiSuggest(entryId, {
    prompt: '加两段',
    from: { blocks: [{ type: 'heading', text: '标题' }, { type: 'paragraph', text: '第一段' }] },
  });
  assert.equal(rec.status, 'pending');
  assert.equal(rec.added, 2);
  assert.equal((await bodyOf()).length, 0, 'suggest 不许写 store');

  const listed = await entries.aiList({ ref: entryId });
  assert.equal(listed.count, 1);
  assert.equal(listed.pendings[0].changes, 2);
  assert.ok(!('blocks' in listed.pendings[0]), '面板拿到的形状不许带最终正文（里面有明文）');
  assert.equal(listed.pendings[0].diffs.length, 0);
  assert.deepEqual(listed.pendings[0].newBlocks.map((b) => b.type), ['heading', 'paragraph']);
});

test('apply 才写 store，且写完 pending 就没了（运行态不是历史）', async () => {
  const pendingId = (await entries.aiList({ ref: entryId })).pendings[0].id;
  const ap = await entries.aiApply(pendingId);
  assert.equal(ap.status, 'ok');
  const body = await bodyOf();
  assert.deepEqual(body.map((b) => b.type), ['heading', 'paragraph']);
  assert.equal((await entries.aiList({ ref: entryId })).count, 0);
  assert.throws(() => readPending(pendingId), /找不到 pending/);
});

test('改一段：pending 里有字符级 segments；apply 后正文 = 提议内容', async () => {
  const body = await bodyOf();
  const paraId = body.find((b) => b.type === 'paragraph').id;
  const sug = await entries.aiSuggest(entryId, {
    prompt: '把「第一段」改成「第二段」',
    from: { blocks: body.map((b) => (b.id === paraId ? { ...b, text: '第二段' } : b)) },
  });
  assert.equal(sug.changed, 1);
  const p = (await entries.aiList({ ref: entryId })).pendings[0];
  assert.deepEqual(p.diffs[0].segments.map((s) => s.op), ['same', 'del', 'ins', 'same']);
  assert.equal(p.diffs[0].segments[1].text, '一');
  assert.equal(p.diffs[0].segments[2].text, '二');

  const ap = await entries.aiApply(sug.pendingId);
  assert.equal(ap.status, 'ok');
  assert.equal((await bodyOf()).find((b) => b.id === paraId).text, '第二段');
});

test('块在提议之后被改过 → CONFLICT，不覆盖；--force 才覆盖', async () => {
  const body = await bodyOf();
  const paraId = body.find((b) => b.type === 'paragraph').id;
  const sug = await entries.aiSuggest(entryId, {
    prompt: 'AI 想改成「AI 版」',
    from: { blocks: body.map((b) => (b.id === paraId ? { ...b, text: 'AI 版' } : b)) },
  });
  // 用户手改了同一块
  await entries.updateBlockValue(entryId, paraId, { data: { text: '用户手写版' } });

  const conflict = await entries.aiApply(sug.pendingId);
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.conflictIds, [paraId]);
  assert.equal((await bodyOf()).find((b) => b.id === paraId).text, '用户手写版', 'CONFLICT 不许写');
  assert.equal((await entries.aiList({ ref: entryId })).count, 1, 'conflict 后 pending 还在');

  const forced = await entries.aiApply(sug.pendingId, { force: true });
  assert.equal(forced.status, 'ok');
  assert.equal((await bodyOf()).find((b) => b.id === paraId).text, 'AI 版');
});

test('reject：真删 pending，数据不动；dry-run 连文件都不删', async () => {
  const body = await bodyOf();
  const paraId = body.find((b) => b.type === 'paragraph').id;
  const sug = await entries.aiSuggest(entryId, {
    prompt: '这条会被拒',
    from: { blocks: body.map((b) => (b.id === paraId ? { ...b, text: '拒绝我' } : b)) },
  });
  const dry = await entries.aiReject(sug.pendingId, { 'dry-run': true });
  assert.equal(dry.status, 'skipped');
  assert.equal((await entries.aiList({ ref: entryId })).count, 1);

  const rej = await entries.aiReject(sug.pendingId);
  assert.equal(rej.status, 'ok');
  assert.equal((await entries.aiList({ ref: entryId })).count, 0);
  assert.equal((await bodyOf()).find((b) => b.id === paraId).text, 'AI 版', '拒绝不许改数据');
});

test('提议与现状一致 → noop，不留一条「什么都没改」的待审', async () => {
  const body = await bodyOf();
  const r = await entries.aiSuggest(entryId, { prompt: '不变', from: { blocks: body } });
  assert.equal(r.status, 'noop');
  assert.equal((await entries.aiList({ ref: entryId })).count, 0);
});

test('--block：提议动了别的块就明确拒绝（不静默只改一块）', async () => {
  const body = await bodyOf();
  const paraId = body.find((b) => b.type === 'paragraph').id;
  await assert.rejects(
    () => entries.aiSuggest(entryId, {
      prompt: '乱改',
      block: paraId,
      from: { blocks: [{ type: 'paragraph', text: '全新的正文' }] },
    }),
    /只允许改/,
  );
});

test('secret 块：pending 里是明文，但面板形状与 store 都不漏', async () => {
  const sug = await entries.aiSuggest(entryId, {
    prompt: '加一个密钥块',
    from: { blocks: [...(await bodyOf()), { type: 'secret', label: 'K', value: 'sk-ai-plain-1234567890' }] },
  });
  assert.equal(sug.status, 'pending');
  const p = (await entries.aiList({ ref: entryId })).pendings[0];
  const nb = p.newBlocks.find((b) => b.type === 'secret');
  assert.equal(nb.text, '（密文块）', '新密钥块的明文不许出现在面板形状里');

  // 磁盘上的 pending 有明文（它就是这么设计的：运行态、0600、不进 store）
  const rec = readPending(sug.pendingId);
  assert.ok(JSON.stringify(rec.blocks).includes('sk-ai-plain-1234567890'));

  await entries.aiApply(sug.pendingId);
  const store = await readFile(join(home, 'store.json'), 'utf8');
  assert.ok(!store.includes('sk-ai-plain-1234567890'), 'store 里只能是密文');
  // 读回来仍是原文（与 secret 字段同一条边界）
  const back = (await bodyOf()).find((b) => b.type === 'secret');
  assert.equal(back.value, 'sk-ai-plain-1234567890');
});

// ── ③ 隔离：不进 store、不进导出包 ─────────────────────────
test('pending 的字段名不出现在 store.json（结构层，比文本层更硬）', async () => {
  await entries.aiSuggest(entryId, {
    prompt: '造一条 pending 用来查泄漏',
    from: { blocks: [...(await bodyOf()), { type: 'paragraph', text: '泄漏探针 PENDING-LEAK-TOKEN' }] },
  });
  const store = await readFile(join(home, 'store.json'), 'utf8');
  for (const k of ['baseHash', 'segments', 'removedIds', 'newBlocks', 'pendingId']) {
    assert.ok(!store.includes(k), `store.json 里出现了 pending 独有字段 ${k}`);
  }
  assert.ok(!store.includes('PENDING-LEAK-TOKEN'));
});

test('pending 不进导出面：栏目导出载荷（dump）里查不到 pending 的任何痕迹', async () => {
  // 导出包的正文就来自 section dump —— 它干净，包就干净。
  // （zip 是 deflate 压过的，直接 grep 字节没有意义，所以钉在载荷层。）
  const payload = JSON.stringify(await sections.dump(SEC, {}));
  for (const k of ['baseHash', 'segments', 'removedIds', 'newBlocks', 'pendingId', 'PENDING-LEAK-TOKEN']) {
    assert.ok(!payload.includes(k), `导出载荷里出现了 ${k}`);
  }
  // 导出产物也不该落在 pending 目录旁边（运行态与数据面分开）
  const zip = await transfer.buildSectionZip(SEC);
  assert.ok(zip.buffer && zip.buffer.length > 0, '导出应当产出非空 zip');
});

// ── ④ 形状：publicPending 不含 blocks ─────────────────────
test('publicPending 去掉 blocks 与 prompt 之外的敏感面', () => {
  const rec = createPending({
    entry: { id: 'e_1', title: 'T', section: 's', body: [] },
    section: { id: 's', title: 'S' },
    blocks: [{ type: 'paragraph', text: '一段' }],
    prompt: '指令',
    dryRun: true,
  });
  const pub = publicPending(rec);
  assert.ok(!('blocks' in pub));
  assert.equal(pub.changes, 1);
  assert.equal(pub.prompt, '指令');
  assert.deepEqual(listPending({ entryId: 'nope' }), []);
  assert.ok(diffBodies([], rec.blocks).newBlocks.length === 1);
});
