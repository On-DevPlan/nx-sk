// 树与模板边界（0.43）：
//   - 条目是唯一内容节点，folder 只是「有子条目」的条目
//   - 移动拒绝成环；删条目删整棵子树
//   - 条目可快速保存成模板；删除条目模板不删条目
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome('nx-sk-tree-');

const templates = await import('../../src/modules/templates/service.ts');
const entries = await import('../../src/modules/entries/service.ts');
const tree = await import('../../src/modules/tree/service.ts');
const { saveEntryAsTemplate } = await import('../../src/core/template-from-entry.ts');
const { loadStore } = await import('../../src/core/store.ts');

const FIELDS = [
  { key: 'name', label: '名称', type: 'text', group: 'main' },
  { key: 'memo', label: '备注', type: 'text', group: 'main' },
];

test('树：根/子条目索引、祖先链、移动与成环保护', async () => {
  await templates.addTemplate({ id: 'tree-tpl', title: '树模板', groups: [{ id: 'main', title: '基本' }], fields: FIELDS });
  const root = await entries.addEntry({ template: 'tree-tpl', title: '根A', data: { name: '根' } });
  const child = await entries.addEntry({ template: 'tree-tpl', title: '子B', parent: root.id, data: { name: '子' } });
  const other = await entries.addEntry({ template: 'tree-tpl', title: '根C', data: { name: '另一个根' } });

  const view = await tree.treeView();
  const rootNode = view.nodes.find((n) => n.id === root.id);
  assert.equal(rootNode.hasChildren, true);
  assert.equal(rootNode.childCount, 1);
  assert.equal(rootNode.parent, null);

  const childNode = view.nodes.find((n) => n.id === child.id);
  assert.equal(childNode.parent, root.id);
  assert.equal(childNode.hasChildren, false);

  const ctx = await tree.entryContext(child.id);
  assert.deepEqual(ctx.ancestors.map((x) => x.title), ['根A']);
  assert.deepEqual(ctx.children, []);

  // 移到自己下面会成环
  await assert.rejects(() => tree.moveEntry(root.id, { parent: child.id }), /成环|子条目/);
  // 把另一个根移到根A下
  const moved = await tree.moveEntry(other.id, { parent: root.id });
  assert.equal(moved.status, 'ok');
  const afterMove = await tree.entryContext(root.id);
  assert.deepEqual(afterMove.children.map((x) => x.title).sort(), ['子B', '根C'].sort());

  // 删根A = 删整棵子树
  const removed = await entries.removeEntry(root.id);
  assert.equal(removed.removed.entries, 3, '根 + 两个子条目一起删');
  const left = await loadStore();
  for (const id of [root.id, child.id, other.id]) {
    assert.equal(left.entries.some((e) => e.id === id), false, `子树上 ${id} 应被删掉`);
  }
});

test('拖动落位：before / after 精确插到兄弟前/后，sort 重新编号', async () => {
  await templates.addTemplate({ id: 'drag-tpl', title: '拖动模板', groups: [{ id: 'main', title: '基本' }], fields: FIELDS });
  const a = await entries.addEntry({ template: 'drag-tpl', title: '拖动A', data: { name: 'A' } });
  const b = await entries.addEntry({ template: 'drag-tpl', title: '拖动B', data: { name: 'B' } });
  const c = await entries.addEntry({ template: 'drag-tpl', title: '拖动C', data: { name: 'C' } });

  const rootTitles = async () => (await tree.treeView({ parent: 'root' })).nodes
    .filter((n) => n.parent === null && n.template === 'drag-tpl')
    .map((n) => n.title);

  // C 拖到 A 上缘：同父级，插到 A 前面
  await tree.moveEntry(c.id, { before: a.id });
  assert.deepEqual(await rootTitles(), ['拖动C', '拖动A', '拖动B']);
  const st = await loadStore();
  const dragSorts = st.entries
    .filter((e) => e.title.startsWith('拖动'))
    .sort((x, y) => x.sort - y.sort)
    .map((e) => e.sort);
  assert.deepEqual(
    dragSorts.map((v, i) => (i === 0 ? 'first' : v - dragSorts[i - 1])),
    ['first', 10, 10],
    '相对落位要把兄弟 sort 按 10 的间隔连续重编号，不能留下空洞',
  );

  // C 再拖到 B 下缘：插到 B 后面
  await tree.moveEntry(c.id, { after: b.id });
  assert.deepEqual(await rootTitles(), ['拖动A', '拖动B', '拖动C']);

  // A 拖进 C 里：成为子条目
  await tree.moveEntry(a.id, { parent: c.id });
  const ctx = await tree.entryContext(c.id);
  assert.deepEqual(ctx.children.map((x) => x.title), ['拖动A']);
  // 目标在自己的子树里 → 成环保护
  await assert.rejects(() => tree.moveEntry(c.id, { parent: a.id }), /成环|子条目/);
});

test('模板：条目保存为模板只抄结构，删除条目模板不删条目', async () => {
  await templates.addTemplate({ id: 'save-src', title: '来源模板', groups: [{ id: 'main', title: '基本' }], fields: FIELDS });
  const source = await entries.addEntry({ template: 'save-src', title: '样板条目', data: { name: '样例值', memo: '会被抄结构但不抄值' } });

  const saved = await saveEntryAsTemplate(source.id, { id: 'saved-tpl', title: '条目另存模板' });
  assert.equal(saved.status, 'ok');
  assert.equal(saved.fromEntry, source.id);
  assert.equal(saved.template.fields >= 2, true);

  const st = await loadStore();
  const tpl = st.templates.find((s) => s.id === 'saved-tpl');
  assert.ok(tpl, '模板要落库');
  assert.ok(tpl.fields.some((f) => f.key === 'name'));
  assert.deepEqual(tpl.tags, ['save-src', '来源模板', 'saved-tpl', '条目另存模板'], '新模板 tags = 旧模板 + 条目 tags + 新 id + 新标题');
  assert.equal(tpl.fields.some((f) => f.key === 'memo'), true, '结构来自条目自身行');

  // 用这个模板新建一条条目，再删模板：新建条目仍在，模板回落空白
  const cloned = await entries.addEntry({ template: 'saved-tpl', title: '从模板初始化', data: { name: '新值' } });
  assert.equal(cloned.template, 'saved-tpl');

  await templates.removeTemplate('saved-tpl');
  const after = await loadStore();
  assert.equal(after.templates.some((s) => s.id === 'saved-tpl'), false);
  assert.ok(after.entries.some((e) => e.id === cloned.id), '删模板不删条目');
  assert.equal(after.entries.find((e) => e.id === cloned.id).template, '__blank__');
  assert.ok(after.entries.some((e) => e.id === source.id), '来源条目也不受影响');

  // 空白条目模板是底座，拒绝删除
  await assert.rejects(() => templates.removeTemplate('__blank__'), /空白条目模板/);
});
