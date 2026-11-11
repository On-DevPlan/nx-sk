// 乐观并发（meta.rev）：载入记 rev，提交校验 rev——
// 修掉 serve + CLI 双进程的 lost-update：两个「读-改-写」交错时，后提交的必须撞墙，
// 而不是静默把先提交的那份覆盖掉。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-rev-');

const { loadStore, saveStore, mutateStore, storePathInUse } = await import('../../src/core/store.ts');
const { openRaw } = await import('../../src/core/db/driver.ts');
const { getRev } = await import('../../src/core/db/repo.ts');

const revFromDisk = () => {
  const db = openRaw(storePathInUse(), { readOnly: true });
  try { return getRev(db); } finally { db.close(); }
};

test('两个并发 mutate：第二个提交报 BLOCKED（rev 不匹配），数据保持第一个的成果', async () => {
  const base = await loadStore();
  await saveStore(base); // 让基线落盘

  // 模拟两个进程各自「读 → 改 → 写」：同一份基线读两次
  const p1 = await loadStore();
  const p2 = await loadStore();
  p1.sections.push({ id: 's1', title: '进程一建的', description: '', order: 60, template: null, kv: false,
    titleField: null, titleLabel: '名称', groups: [], fields: [], layout: null, createdAt: null, updatedAt: null });
  p2.sections.push({ id: 's2', title: '进程二建的', description: '', order: 70, template: null, kv: false,
    titleField: null, titleLabel: '名称', groups: [], fields: [], layout: null, createdAt: null, updatedAt: null });

  await saveStore(p1); // 先提交的赢

  const revBefore = revFromDisk();
  await assert.rejects(
    () => saveStore(p2),
    (e) => e.code === 'BLOCKED' && /请重试/.test(e.message),
    '后提交的必须撞 rev，不能静默覆盖',
  );
  assert.equal(revFromDisk(), revBefore, '撞墙的提交不能动库（rev 都没涨）');

  const after = await loadStore();
  assert.ok(after.sections.some((s) => s.id === 's1'), '先提交的数据必须在');
  assert.ok(!after.sections.some((s) => s.id === 's2'), '撞墙的提交一条都不能写进去');
});

test('mutateStore 走同一条 rev 校验；顺序 mutate 正常推进 rev', async () => {
  const r0 = revFromDisk();
  await mutateStore((s) => { s.entries.push({ id: 'e_rev', section: 'demo', title: 'R', tags: [], values: {}, createdAt: null, updatedAt: null }); });
  await mutateStore((s) => { s.entries = s.entries.filter((e) => e.id !== 'e_rev'); });
  assert.equal(revFromDisk(), r0 + 2, '每次成功提交 rev +1');
  assert.ok(!(await loadStore()).entries.some((e) => e.id === 'e_rev'));
});

test('同一个对象重复 save 不撞墙（rev 随提交前进）；外部构造的对象按旧语义整份覆盖', async () => {
  const s = await loadStore();
  await saveStore(s);
  await saveStore(s); // 同一对象第二次保存：revOf 已随第一次前进，不该报冲突
  const fresh = await loadStore();
  fresh.settings.defaultSection = 'demo';
  await saveStore(fresh); // 刚读的，正常
});
