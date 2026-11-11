// 真实形状 store.json → db 的「防丢」保真测试：
// 升级/导入不该丢任何一类数据——栏目/分组/字段/条目/版式/设置/附件记录/密文 blob/引用边，
// 逐项与源 JSON 对照。附件上 db（attachments kind='file'）与 inline 边是重点。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fsp from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function freshHome(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  process.env.NX_SK_HOME = dir;
  process.env.NX_SK_STORE = join(dir, 'store.json');
  process.env.NX_SK_STORE_DB = join(dir, 'nxsk.db');
  return dir;
}

const { loadStore } = await import('../../src/core/store.ts');
const { sanitizeLayout } = await import('../../src/shared/blockLayout.ts');

// 假密文 blob（形状与 core/crypto 的 CipherBlob 一致；导入层不碰内容，只保证逐字节搬运）
const CIPHER_1 = { v: 1, alg: 'aes-256-gcm', kid: 'aabbccddeeff', iv: '0123456789abcdef', tag: 'fedcba9876543210', ct: 'ZmFrZS1jdA==' };
const CIPHER_2 = { v: 1, alg: 'aes-256-gcm', kid: 'aabbccddeeff', iv: '1122334455667788', tag: '99aabbccddeeff00', ct: 'bw1jZW4tY3Q=' };

const LAYOUT = {
  mode: 'grid',
  panels: ['g1', 'g2'],
  groups: {
    g1: { collapsed: false, layouts: { lg: [{ i: 'name', x: 0, y: 0, w: 6, h: 2 }, { i: 'pass', x: 6, y: 0, w: 6, h: 2 }] } },
    g2: { collapsed: true, layouts: { lg: [{ i: 'note', x: 0, y: 0, w: 12, h: 3 }] } },
  },
};

function fixture() {
  return {
    version: 3,
    settings: { defaultSection: 'demo', navGroups: [{ title: '主组', sections: ['demo'] }], navHidden: ['kvsec'], navOrder: ['demo', 'kvsec'] },
    sections: [
      {
        id: 'demo', title: '样例', description: 'd', order: 10, template: null, kv: false,
        titleField: 'name', titleLabel: '名称',
        groups: [{ id: 'g1', title: '基本' }, { id: 'g2', title: '附件区' }],
        fields: [
          { key: 'name', label: '名称', type: 'text', group: 'g1' },
          { key: 'pass', label: '口令', type: 'secret', group: 'g1', sensitive: true },
          { key: 'sheet', label: '表格', type: 'table', group: 'g1', columns: [{ key: 'item', label: '事项', type: 'text' }] },
          { key: 'note', label: '图文', type: 'md', group: 'g2' },
          { key: 'docs', label: '文件', type: 'file', group: 'g2' },
        ],
        layout: LAYOUT,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'kvsec', title: '密钥', description: '', order: 20, template: 'secret', kv: true,
        titleField: null, titleLabel: '名称',
        groups: [{ id: 'key', title: '密钥信息' }],
        fields: [{ key: 'value', label: '值', type: 'secret', group: 'key', sensitive: true }],
        layout: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    entries: [
      { id: 'e1', section: 'demo', title: '一条', tags: ['x'], createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z',
        values: { name: 'N', pass: CIPHER_1, note: '看图 ![说明](f_bbb)', docs: 'f_aaa', sheet: { rows: [{ item: 'a' }], totals: [] } } },
      { id: 'e2', section: 'kvsec', title: 'OpenAI', tags: [], createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
        values: { value: CIPHER_2 } },
    ],
    files: [
      { id: 'f_aaa', category: 'image', name: 'a.png', rel: 'files/f_aaa/a.png', ext: 'png', bytes: 111, sha256: 'a'.repeat(64), mode: 'copy', tags: [], note: '', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'f_bbb', category: 'image', name: 'b.png', rel: 'files/f_bbb/b.png', ext: 'png', bytes: 222, sha256: 'b'.repeat(64), mode: 'copy', tags: [], note: '截图', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    ],
  };
}

test('导入防丢：栏目/分组/字段/条目/版式/设置逐项在库里一个不少', async () => {
  const dir = await freshHome('nx-sk-fid-');
  const json = fixture();
  await fsp.writeFile(process.env.NX_SK_STORE, JSON.stringify(json), 'utf8');

  const store = await loadStore();
  const db = new DatabaseSync(join(dir, 'nxsk.db'), { readOnly: true });
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  // ① 实体零丢失：json 里每个 id/key 都能在库里点到
  for (const s of json.sections) assert.ok(one('SELECT 1 FROM sections WHERE id=?', s.id), `栏目 ${s.id} 丢失`);
  for (const e of json.entries) assert.ok(one('SELECT 1 FROM entries WHERE id=?', e.id), `条目 ${e.id} 丢失`);
  for (const s of json.sections) {
    for (const g of s.groups) assert.ok(one('SELECT 1 FROM groups WHERE section_id=? AND id=?', s.id, g.id), `分组 ${s.id}/${g.id} 丢失`);
    for (const f of s.fields) assert.ok(one('SELECT 1 FROM fields WHERE section_id=? AND key=?', s.id, f.key), `字段 ${s.id}/${f.key} 丢失`);
  }

  // ② 版式整份保真：入库的是 sanitizeLayout 收口后的形状（与 JSON 时代同一条规则），
  //    对照基准必须是 sanitize 后的版式——补默认高度、加 v 号，一个字段都不许漂。
  const wantLayout = sanitizeLayout(LAYOUT);
  assert.deepEqual(JSON.parse(one("SELECT layout FROM sections WHERE id='demo'").layout), wantLayout, 'layout 必须原样（sanitize 后）');

  // ③ 密文 blob 逐字节保真（导入层只搬运，不重新加密）
  //    v3：values 列退役——值逐键在 field_data（JOIN entry_fields 定位键）
  const dataOf = (entryId, key) => one(
    `SELECT fd.value v FROM entries e
     JOIN entry_fields ef ON ef.entry_id = e.id
     JOIN field_data fd ON fd.entry_field_id = ef.id
     WHERE e.id = ? AND ef.key = ?`, entryId, key);
  assert.deepEqual(JSON.parse(dataOf('e1', 'pass').v), CIPHER_1);
  assert.deepEqual(JSON.parse(dataOf('e2', 'value').v), CIPHER_2);

  // ④ 附件上 db：FileRecord → attachments kind='file'，id 原样（values 一字不改）
  assert.equal(one("SELECT COUNT(*) c FROM attachments WHERE kind='file'").c, 2);
  assert.deepEqual(all("SELECT id FROM attachments WHERE kind='file' ORDER BY id").map((r) => r.id), ['f_aaa', 'f_bbb']);
  const fAaa = one("SELECT * FROM attachments WHERE id='f_bbb'");
  assert.equal(fAaa.name, 'b.png');
  assert.equal(fAaa.size, 222);

  // ⑤ inline 边从 values 自动重建：file 字段 + md 内联两种载体都要认
  //    （v3：边挂 entry_field_id，entry_id/键 JOIN 回来）
  const edges = all(`SELECT e.id AS entry_id, ef.key AS field_key, ea.attachment_id
    FROM entry_attach ea
    JOIN entry_fields ef ON ef.id = ea.entry_field_id
    JOIN entries e ON e.id = ef.entry_id
    WHERE ea.role='inline' ORDER BY e.id, ef.key`);
  assert.deepEqual(edges.map((e) => `${e.entry_id}:${e.field_key}->${e.attachment_id}`),
    ['e1:docs->f_aaa', 'e1:note->f_bbb'], '两条 inline 引用边必须建出来');

  // ⑥ settings 全量入表
  const set = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(JSON.parse(set.defaultSection), 'demo');
  assert.deepEqual(JSON.parse(set.navHidden), ['kvsec']);

  // ⑦ facade 读回与源 JSON 形状一致（normalize 允许补 source 袋，其余不许漂）
  const demo = store.sections.find((s) => s.id === 'demo');
  assert.equal(demo.title, '样例');
  assert.equal(demo.titleField, 'name');
  assert.deepEqual(demo.layout, wantLayout);
  assert.deepEqual(store.entries.find((e) => e.id === 'e1').values.pass, CIPHER_1);
  db.close();
});
