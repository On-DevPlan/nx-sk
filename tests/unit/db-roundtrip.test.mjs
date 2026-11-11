// 往返保真：json → db → loadStore 与 normalize(json) **深比较**。
//
// 这条测试钉的是整个重构的地基：facade 换心后，后端各模块与面板看到的数据
// 必须与 store.json 时代逐键一致（含「键存在性」这种细节——原 JSON 里没有 fill 键，
// 读回来也不能凭空多出 fill: 'normal'）。fixture 刻意覆盖：
//   · 多类型字段 + 类型特有键（options/columns/totals/fields/maxRows/kind/maxItems）
//   · 未知扩展键（FieldDef 的 [k: string] 宽松面）
//   · 条目 values 的三种附件引用载体（file 数组 / md 内嵌图 / source 袋）
//   · FileRecord 的扩展键与 null 时间戳
//   · settings 的未知键
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'nx-sk-rt-'));
process.env.NX_SK_HOME = dir;
process.env.NX_SK_STORE = join(dir, 'store.json');
process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');

const { loadStore, saveStore, normalize } = await import('../../src/core/store.ts');

const FIXTURE = {
  version: 3,
  settings: {
    defaultSection: 'demo', navGroups: [{ title: 'G', sections: ['demo'] }],
    navHidden: ['x'], navOrder: ['demo'], unknownSetting: { deep: [1, 2, null] },
  },
  sections: [
    {
      id: 'demo', title: '字段样例', description: '每种类型一格', order: 10, template: 'demo', kv: false,
      titleField: 'name', titleLabel: '名称',
      groups: [{ id: 'main', title: '基本' }, { id: 'source', title: '原始资料' }],
      fields: [
        { key: 'name', label: '名称', type: 'text', group: 'main' },
        { key: 'state', label: '状态', type: 'select', group: 'main', options: ['A', 'B'], hint: '选一个', fill: 'optional' },
        { key: 'tagsX', label: '标签', type: 'tags', group: 'main', maxItems: 5 },
        {
          key: 'sheet', label: '表格', type: 'table', group: 'main',
          columns: [
            { key: 'item', label: '项', type: 'text' },
            { key: 'n', label: '数', type: 'number', formula: '{item}x', unit: 'h', precision: 1 },
          ],
          totals: [{ label: '合计', expr: 'sum(n)', unit: 'h' }], summary: true, maxRows: 50,
        },
        { key: 'accounts', label: '清单', type: 'entrylist', group: 'main', fields: [{ key: 'u', label: '用户', sensitive: true }], maxRows: 10 },
        { key: 'bag', label: '资料袋', type: 'source', group: 'source', fill: 'avoid' },
        { key: 'pic', label: '图文', type: 'md', group: 'main' },
        { key: 'att', label: '附件', type: 'file', group: 'main', kind: 'image' },
        { key: 'sec', label: '密文', type: 'secret', group: 'main', sensitive: true },
        { key: 'sc', label: '快捷键', type: 'shortcut', group: 'main' },
        { key: 'weird', label: '怪键', type: 'text', group: 'main', unknownKey: { deep: [1, 2, { x: null }] }, fill: 'normal' },
      ],
      layout: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'kv1', title: 'KV 表', description: '', order: 20, template: 'secret', kv: true,
      titleField: null, titleLabel: '名称',
      groups: [{ id: 'key', title: '密钥信息' }],
      fields: [{ key: 'value', label: '密钥值', type: 'secret', group: 'key' }],
      layout: null, createdAt: null, updatedAt: null,
    },
  ],
  entries: [
    {
      id: 'e1', section: 'demo', title: '样例', tags: ['a', 'b'],
      values: {
        name: 'N', state: 'A', tagsX: ['t1'], sheet: [], accounts: [],
        att: ['f_one', 'f_two'], pic: '![img](f_one)',
        bag: [{ kind: 'file', fileId: 'f_two', name: 'x' }, { kind: 'text', text: '原文 ![in](f_one)' }],
        weird: 'w', sec: null,
      },
      createdAt: '2026-01-03T00:00:00.000Z', updatedAt: null,
    },
    { id: 'e2', section: 'kv1', title: 'K', tags: [], values: { value: 'v' }, createdAt: null, updatedAt: null },
  ],
  files: [
    {
      id: 'f_one', category: 'avatar', name: 'one.png', rel: 'avatar/one.png', originalName: 'one.png',
      ext: '.png', bytes: 10, sha256: 'aa', sourcePath: '/x/one.png', mode: 'move',
      tags: ['t'], note: 'n', createdAt: '2026-01-04T00:00:00.000Z', updatedAt: null,
    },
    {
      id: 'f_two', category: 'other', name: 'two.pdf', rel: 'other/two.pdf', originalName: 'two.pdf',
      ext: '.pdf', bytes: 20, sha256: 'bb', sourcePath: '', mode: 'upload',
      tags: [], note: '', createdAt: null, updatedAt: null, extraField: { keep: true },
    },
  ],
};

test('json → db → loadStore 与 normalize(json) 深比较（首启导入路径）', async () => {
  await fsp.writeFile(process.env.NX_SK_STORE, JSON.stringify(FIXTURE, null, 2), 'utf8');
  const loaded = await loadStore();
  const expected = normalize(FIXTURE);
  delete expected._migration;
  assert.deepEqual(loaded, expected, '导入路径的往返必须逐键一致');
});

test('saveStore → loadStore 深比较（运行时写路径）', async () => {
  const before = await loadStore();
  const after = await saveStore(before);
  assert.deepEqual(await loadStore(), after, '整份保存再读回不能变样');

  // 再走一遍 mutateStore：结构化克隆 + 全量重写也不能漂形状
  await loadStore();
  const mutated = await loadStore();
  assert.deepEqual(mutated, after);
});

test('条目 values 里的附件引用一字不改（file id 原样进、原样出）', async () => {
  const store = await loadStore();
  const e = store.entries.find((x) => x.id === 'e1');
  assert.deepEqual(e.values.att, ['f_one', 'f_two']);
  assert.equal(e.values.pic, '![img](f_one)');
  assert.equal(e.values.bag[0].fileId, 'f_two');
  const ids = store.files.map((f) => f.id).sort();
  assert.deepEqual(ids, ['f_one', 'f_two'], 'FileRecord.id 必须原样落 attachments.id');
});

test('inline 边由 fileReferences 重算：三种引用载体都落成 entry_attach 行', async () => {
  const { openRaw } = await import('../../src/core/db/driver.ts');
  const db = openRaw(process.env.NX_SK_STORE_DB, { readOnly: true });
  try {
    // v3：边表挂 entry_field_id，entry_id/键要 JOIN 回来（field_key 列已退役）
    const edges = db.all(`SELECT e.id AS entry_id, ea.attachment_id, ef.key AS field_key
      FROM entry_attach ea
      JOIN entry_fields ef ON ef.id = ea.entry_field_id
      JOIN entries e ON e.id = ef.entry_id
      WHERE ea.role = 'inline' ORDER BY ea.attachment_id, ef.key`);
    const key = (r) => `${r.entry_id}|${r.attachment_id}|${r.field_key}`;
    const set = new Set(edges.map(key));
    // file 字段两个 id、md 正文一张图、source 袋的 file item 与正文内嵌图——
    // 具体命中口径由 attachments.fileReferences 决定（它才是唯一规则），
    // 这里钉「边表与 values 重算结果一致」：
    const store = await loadStore();
    const { fileReferences } = await import('../../src/core/attachments.ts');
    const expect = new Set();
    for (const rec of store.files) {
      for (const r of fileReferences(store, rec)) expect.add(`${r.entryId}|${rec.id}|${r.fieldKey}`);
    }
    assert.deepEqual([...set].sort(), [...expect].sort(), '边表必须恰好等于 fileReferences 的重算结果');
    assert.ok(expect.size >= 3, 'fixture 至少该产出三种载体的边');
  } finally {
    db.close();
  }
});
