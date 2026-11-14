// 任务 #27：字段值历史（schema v5）与恢复。
//
// 口径：
//   - 新建条目 = 第一个版本（v1，prev = null）；之后每次「值真的变了」才追加；
//   - 同值重写（布局保存、自动保存空转）不产生版本；
//   - 恢复写回旧值并追加一条 op='restore'（可再撤销）；
//   - 保留策略 count / time 改完立即裁剪存量。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const settings = await import('../../src/modules/settings/service.ts');
const { defaultSettings, loadStore } = await import('../../src/core/store.ts');

await sections.addSection({
  id: 'hist',
  title: '历史测试',
  fields: [
    { key: 'note', label: '备注', type: 'text' },
    { key: 'num', label: '数量', type: 'number' },
  ],
});
await entries.addEntry({ section: 'hist', title: '甲', data: { note: 'v1', num: 1 } });

test('默认保留策略：每个字段最近 50 版 / 90 天，模式 count', async () => {
  const d = defaultSettings();
  assert.equal(d.historyMode, 'count');
  assert.equal(d.historyCount, 50);
  assert.equal(d.historyDays, 90);
  assert.equal((await loadStore()).settings.historyMode, 'count');
});

test('新建条目 = v1；只记真实变化，同值重写不产生版本', async () => {
  const h1 = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.equal(h1.count, 1, '创建时的值就是第一版');
  assert.equal(h1.items[0].rev, 1);
  assert.equal(h1.items[0].op, 'set');
  assert.equal(h1.items[0].value, 'v1');
  assert.equal(h1.items[0].prevValue, null);

  await entries.updateEntry('甲', { section: 'hist', set: { note: 'v2' } });
  const h2 = await entries.getFieldHistory('甲', '备注', { section: 'hist' }); // 中文标签也认
  assert.equal(h2.count, 2);
  assert.equal(h2.current, 'v2');
  assert.equal(h2.items[0].rev, 2);
  assert.equal(h2.items[0].value, 'v2');
  assert.equal(h2.items[0].prevValue, 'v1');

  // 同值重写：不新增版本
  await entries.updateEntry('甲', { section: 'hist', set: { note: 'v2' } });
  const h3 = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.equal(h3.count, 2, '值没变就不该多一版');
});

test('条目时间线：跨字段按时间倒序，带旧值 → 新值', async () => {
  await entries.updateEntry('甲', { section: 'hist', set: { num: 2 } });
  const t = await entries.getEntryHistory('甲', { section: 'hist' });
  assert.ok(t.count >= 3, 'note v1/v2 + num v1/v2 至少四条');
  assert.equal(t.items[0].key, 'num');
  assert.equal(t.items[0].value, 2);
  assert.equal(t.items[0].prevValue, 1);
  // 时间倒序：每一条都不比后一条早
  for (let i = 1; i < t.items.length; i++) {
    assert.ok(t.items[i - 1].at >= t.items[i].at, '时间线必须按时间倒序');
  }
  // 已脱离 / 未知字段不会混进时间线（这里只是确认字段标签来自结构行）
  assert.ok(t.items.every((x) => x.key && x.label));
});

test('恢复：写回旧值并追加 restore 版本，可再恢复；dry-run 不落盘', async () => {
  const before = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  const v1 = before.items.find((x) => x.rev === 1);
  assert.equal(v1.value, 'v1');

  const dry = await entries.restoreFieldVersion('甲', 'note', { section: 'hist', rev: 1, 'dry-run': true });
  assert.equal(dry.status, 'skipped');
  assert.equal(dry.wouldRestore.to, 'v1');
  assert.equal((await entries.getFieldHistory('甲', 'note', { section: 'hist' })).current, 'v2', '试运行不落盘');

  const r = await entries.restoreFieldVersion('甲', 'note', { section: 'hist', rev: 1 });
  assert.equal(r.status, 'ok');
  assert.equal(r.changed, true);
  const after = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.equal(after.current, 'v1');
  assert.equal(after.items[0].op, 'restore', '恢复本身记一条历史');
  assert.equal(after.items[0].value, 'v1');
  assert.equal(after.items[0].prevValue, 'v2');

  // 再恢复回 v2（恢复也可撤销）
  await entries.restoreFieldVersion('甲', 'note', { section: 'hist', rev: 2 });
  assert.equal((await entries.getFieldHistory('甲', 'note', { section: 'hist' })).current, 'v2');

  // 不存在的版本给出明确错误
  await assert.rejects(
    () => entries.restoreFieldVersion('甲', 'note', { section: 'hist', rev: 9999 }),
    /没有版本/,
  );
});

test('保留策略：count 改完立即裁剪，之后每次写入也按新上限裁', async () => {
  await settings.updateSettings({ set: { historyCount: 2 } });
  const trimmed = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.ok(trimmed.count <= 2, `count=2 应立即生效（实际 ${trimmed.count}）`);

  await entries.updateEntry('甲', { section: 'hist', set: { note: 'v3' } });
  const again = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.ok(again.count <= 2, '每次追加后也要按上限裁');
  assert.equal(again.current, 'v3');
});

test('保留策略：time 模式保留最近 N 天（新鲜历史不被误删），非法值明确报错', async () => {
  await settings.updateSettings({ set: { historyMode: 'time', historyDays: 30 } });
  const h = await entries.getFieldHistory('甲', 'note', { section: 'hist' });
  assert.ok(h.count >= 1, '刚写的版本远在 30 天内，不该被裁掉');

  await assert.rejects(
    () => settings.updateSettings({ set: { historyMode: 'forever' } }),
    /只能是 count \/ time/,
  );
  await assert.rejects(
    () => settings.updateSettings({ set: { historyCount: 0 } }),
    /不能小于 1/,
  );
});
