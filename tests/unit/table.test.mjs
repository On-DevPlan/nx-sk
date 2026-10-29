// 表格字段（type: 'table'）：**结构在数据里**的表格 —— 列、行、公式、统计配置都是数据。
//
// 这里钉的是语义，不是实现：
//   - 列 / 行 / 公式都存在条目值里，字段字典只是「初始列」模板
//   - 勾选框 / 数字 / 下拉在写入时就强转（不然合计会悄悄少一截）
//   - 计算列与统计行**不落盘**，读的时候现算（否则「存下来的合计」会过期）
//   - 公式是 JS 表达式，结构映射到列（key 与中文列名都能当变量）
//   - 公式写错要报**能照着改**的错，不能只吐 NaN / undefined
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useTempHome } from '../helpers.mjs';

await useTempHome();

const sections = await import('../../src/modules/sections/service.js');
const entries = await import('../../src/modules/entries/service.js');
const { loadStore } = await import('../../src/core/store.js');
const { isCipherBlob, maskValue } = await import('../../src/core/crypto.js');
const T = await import('../../src/shared/table.js');

const COLS = [
  { key: 'task', label: '任务', type: 'text' },
  { key: 'done', label: '已办', type: 'bool' },
  { key: 'hours', label: '工时', type: 'number' },
  { key: 'rate', label: '单价', type: 'number' },
  { key: 'cost', label: '费用', formula: 'hours * rate', unit: '元' },
];

const DEF = { key: 'tasks', label: '任务表', type: 'table', group: 'main', columns: COLS };

// —— 字段定义：表格字段本身很轻，列只是「初始列」——

test('validateFieldDef：table 不强制声明列；给了列才校验（key 唯一 / 下拉有选项 / 公式能编译）', () => {
  const bare = sections.validateFieldDef({ key: 't', type: 'table' });
  assert.equal(bare.type, 'table');
  assert.equal(bare.columns, undefined, '列可以不写在字段定义里 —— 结构归数据');

  assert.throws(
    () => sections.validateFieldDef({ key: 't', type: 'table', columns: [{ key: 'a' }, { key: 'a' }] }),
    /重复/,
  );
  assert.throws(
    () => sections.validateFieldDef({ key: 't', type: 'table', columns: [{ key: 'a', type: 'select' }] }),
    /options/,
  );
  assert.throws(
    () => sections.validateFieldDef({ key: 't', type: 'table', columns: [{ key: 'a', formula: 'b *' }] }),
    /公式/,
  );
  // 非表格声明 columns 一律拒绝（字典里不该有定义了也用不上的键）
  assert.throws(() => sections.validateFieldDef({ key: 't', type: 'text', columns: [{ key: 'a' }] }), /table/);

  const ok = sections.validateFieldDef(DEF);
  assert.equal(ok.columns.length, 5);
  assert.equal(ok.columns[4].formula, 'hours * rate');
  assert.equal(ok.columns[0].label, '任务');
});

test('validateFieldDef：统计行只认已声明的列与已知函数', () => {
  const base = { key: 't', type: 'table', columns: [{ key: 'a', type: 'number' }] };
  assert.throws(() => sections.validateFieldDef({ ...base, totals: [{ label: '合计', agg: { zzz: 'sum' } }] }), /不存在的列/);
  assert.throws(() => sections.validateFieldDef({ ...base, totals: [{ label: '合计', agg: { a: 'sum2' } }] }), /未知统计函数/);
  assert.throws(() => sections.validateFieldDef({ ...base, totals: [{ label: '空行' }] }), /agg|expr/);
  const ok = sections.validateFieldDef({ ...base, totals: [{ label: '合计', agg: { a: 'sum' } }, { label: '均', expr: 'avg(col("a"))' }] });
  assert.equal(ok.totals.length, 2);
  assert.deepEqual(ok.totals[0].agg, { a: 'sum' });
});

// —— 计算内核：三种输入形态 ——

test('computeTable：认「行数组」「自描述文档」「字段默认列」三种输入', () => {
  // 行数组 + 字段默认列
  const a = T.computeTable({ columns: COLS }, [{ task: 'x', hours: 2, rate: 10 }]);
  assert.equal(a.columns.length, 5);
  assert.equal(a.rows[0].values.cost, 20);

  // 自描述文档（列在数据里）—— 字段定义可以完全没有列
  const doc = { v: 1, columns: [{ key: 'n', label: '数', type: 'number' }], rows: [{ n: 1 }, { n: 2 }] };
  const b = T.computeTable({}, doc);
  assert.equal(b.columns.length, 1);
  assert.equal(b.totals[0].values.n, 3);

  // 什么都没有：从行把列推断出来（类型按第一个非空值猜）
  const c = T.computeTable({}, [{ a: 1, b: true, c: '字' }]);
  assert.deepEqual(c.columns.map((x) => `${x.key}:${x.type}`), ['a:number', 'b:bool', 'c:text']);
});

test('computeTable：文档里的列**优先于**字段默认列（数据是权威）', () => {
  const t = T.computeTable({ columns: [{ key: 'a', label: '甲', type: 'text' }] }, {
    columns: [{ key: 'b', label: '乙', type: 'number' }],
    rows: [{ b: 2 }],
  });
  assert.deepEqual(t.columns.map((c) => c.key), ['b'], '字段里的初始列不该覆盖这条数据自己的列');

  // 显式的空数组也是权威：删掉最后一列要真的生效，不能退回字段默认列
  const empty = T.computeTable({ columns: [{ key: 'a', label: '甲' }] }, { columns: [], rows: [] });
  assert.equal(empty.columns.length, 0);
});

test('computeTable：强转 + 自动合计（数值求和、勾选计是）', () => {
  const def = { columns: [{ key: 'name', label: '名称' }, { key: 'n', label: '数量', type: 'number' }, { key: 'ok', label: '已核', type: 'bool' }] };
  const t = T.computeTable(def, [{ name: 'a', n: '2', ok: '是' }, { name: 'b', n: 3, ok: false }]);
  assert.equal(t.rows[0].values.n, 2, '数字串要变成数字');
  assert.equal(t.rows[0].values.ok, true, '「是」要变成 true');
  assert.equal(t.rows[1].values.ok, false);
  assert.equal(t.totals.length, 1, '没配统计时自动给一行合计');
  assert.equal(t.totals[0].values.n, 5);
  assert.equal(t.totals[0].texts.ok, '1/2', '勾选列显示「是 / 总数」');
  assert.equal(t.errorCount, 0);
});

test('每列的统计方式：sum / avg / none 分组成多行表尾', () => {
  const t = T.computeTable({}, {
    columns: [
      { key: 'n', label: '数', type: 'number' },
      { key: 'm', label: '数2', type: 'number', total: 'avg' },
      { key: 'f', label: '不统计', type: 'number', total: 'none' },
    ],
    rows: [{ n: 1, m: 10, f: 100 }, { n: 3, m: 20, f: 100 }],
  });
  assert.deepEqual(t.totals.map((x) => x.label), ['合计', '平均']);
  assert.equal(t.totals[0].values.n, 4);
  assert.equal(t.totals[1].values.m, 15);
  assert.equal(t.totals[0].values.f, undefined, 'total:none 的列不进表尾');
});

test('computeTable：计算列按声明顺序算，能引用中文列名与前面的计算列', () => {
  const def = {
    columns: [
      { key: 'qty', label: '数量', type: 'number' },
      { key: 'price', label: '单价', type: 'number' },
      { key: 'amount', label: '金额', formula: 'qty * price' },
      { key: 'tax', label: '含税', formula: '金额 * 1.13' },
    ],
  };
  const t = T.computeTable(def, [{ qty: 2, price: 10 }]);
  assert.equal(t.rows[0].values.amount, 20);
  assert.ok(Math.abs(t.rows[0].values.tax - 22.6) < 1e-9);
});

test('computeTable：空格子当成 0 / false，不会把整列算成 NaN', () => {
  const def = { columns: [{ key: 'a', label: '甲', type: 'number' }, { key: 'b', label: '乙', formula: 'a * 2' }] };
  const t = T.computeTable(def, [{ a: null }]);
  assert.equal(t.rows[0].values.b, 0);
  assert.equal(t.errorCount, 0);
});

test('computeTable：公式报错要能照着改（不存在的名字 / 后面的计算列 / 语法 / 除零 / 对象结果）', () => {
  const unknown = T.computeTable({ columns: [{ key: 'a', type: 'number' }, { key: 'b', formula: 'a * qty' }] }, [{ a: 1 }]);
  assert.match(unknown.rows[0].errors.b, /不存在的名字「qty」/);
  assert.match(unknown.rows[0].errors.b, /可用的名字：a/);

  const late = T.computeTable({ columns: [{ key: 'a', formula: 'c + 1' }, { key: 'c', formula: '1' }] }, [{}]);
  assert.match(late.rows[0].errors.a, /计算列/);

  const syntax = T.computeTable({ columns: [{ key: 'a', formula: '1 +' }] }, [{}]);
  assert.match(syntax.rows[0].errors.a, /语法错误/);

  const div = T.computeTable({ columns: [{ key: 'a', formula: '1 / 0' }] }, [{}]);
  assert.match(div.rows[0].errors.a, /有限数字/);

  const obj = T.computeTable({ columns: [{ key: 'a', formula: '[1, 2]' }] }, [{}]);
  assert.match(obj.rows[0].errors.a, /单值/);
});

test('公式作用域：全局对象不可达，常用 JS 与内建函数可用', () => {
  const def = {
    columns: [
      { key: 'a', label: '甲', type: 'number' },
      {
        key: 'b',
        label: '乙',
        type: 'text',
        formula: '[1, 2, 3].map(x => x * a).filter(x => x > 2).join("-") + "/" + Math.max(1, 5) + "/" + JSON.stringify({ k: 1 }).length',
      },
    ],
  };
  const t = T.computeTable(def, [{ a: 2 }]);
  assert.equal(t.rows[0].values.b, '4-6/5/7');

  for (const bad of ['window', 'document', 'process', 'globalThis', 'require', 'fetch', 'localStorage']) {
    const r = T.computeTable({ columns: [{ key: 'a', formula: bad }] }, [{}]);
    assert.match(r.rows[0].errors.a, /不存在的名字/, `${bad} 不该可达`);
  }
  // 语句写不进来：只接受表达式
  const stmt = T.computeTable({ columns: [{ key: 'a', formula: 'var x = 1; x' }] }, [{}]);
  assert.match(stmt.rows[0].errors.a, /语法错误/);
});

test('统计行：agg 逐列统计，expr 用整表 + col() 算，unit 参与显示', () => {
  const def = {
    columns: COLS,
    totals: [
      { label: '合计', agg: { hours: 'sum', cost: 'sum', done: 'countTrue' } },
      { label: '平均', agg: { hours: 'avg' } },
      { label: '完成率', expr: 'pct(countTrue(col("done")), n)', unit: '%' },
    ],
  };
  const t = T.computeTable(def, [
    { task: 'a', done: true, hours: 2, rate: 100 },
    { task: 'b', done: false, hours: 3, rate: 100 },
  ]);
  assert.equal(t.totals[0].values.hours, 5);
  assert.equal(t.totals[0].values.cost, 500);
  assert.equal(t.totals[0].texts.done, '1/2');
  assert.equal(t.totals[1].values.hours, 2.5);
  assert.equal(t.totals[2].value, 50);
  assert.equal(t.totals[2].text, '50%', 'unit 要参与显示，否则只剩一个裸数字');
});

test('统计行的开关：文档里 totals: [] 或 summary:false 都是「不要表尾」', () => {
  const cols = [{ key: 'n', label: '数量', type: 'number' }];
  assert.equal(T.computeTable({}, { columns: cols, rows: [{ n: 1 }], totals: [] }).totals.length, 0);
  assert.equal(T.computeTable({}, { columns: cols, rows: [{ n: 1 }], summary: false }).totals.length, 0);
  assert.equal(T.computeTable({}, { columns: cols, rows: [{ n: 1 }] }).totals.length, 1);
});

test('行公式能用 rows / col() 做跨行判断（如「占全表比重」）', () => {
  const def = {
    columns: [
      { key: 'n', label: '数量', type: 'number' },
      { key: 'share', label: '占比', formula: 'pct(n, sum(col("n")))' },
    ],
  };
  const t = T.computeTable(def, [{ n: 1 }, { n: 3 }]);
  assert.equal(t.rows[0].values.share, 25);
  assert.equal(t.rows[1].values.share, 75);
});

// —— 落盘 / 读回（service 层）——

async function setupSection(id = 'work') {
  await sections.addSection({ id, title: '工作', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection(id, { 'add-field': DEF });
}

test('写入读回：值是一份自描述文档（columns + rows），计算列不落盘', async () => {
  await setupSection();
  await entries.addEntry({
    section: 'work',
    title: '周报',
    data: {
      tasks: [
        { 任务: '写文档', 已办: '是', 工时: '2.5', 单价: 100, 费用: 999 },
        { task: 'review', done: false, hours: 1, rate: 100 },
        { task: '' },
      ],
    },
  });
  const got = await entries.getEntry('周报', { section: 'work' });
  const doc = got.values.tasks;
  assert.ok(Array.isArray(doc.columns), '列必须跟着数据走');
  assert.deepEqual(doc.columns.map((c) => c.key), ['task', 'done', 'hours', 'rate', 'cost']);
  assert.deepEqual(doc.rows, [
    { task: '写文档', done: true, hours: 2.5, rate: 100 },
    { task: 'review', done: false, hours: 1, rate: 100 },
  ], '中文列名可写；空行剔除；计算列的值不落盘（传进来也丢掉）');

  const t = got.tables.tasks;
  assert.equal(t.rows[0].values.cost, 250, '费用 = 工时 * 单价，读的时候算');
  assert.equal(t.totals[0].values.cost, 350);

  const store = await loadStore();
  const raw = store.entries.find((e) => e.title === '周报').values.tasks;
  assert.equal(raw.rows[0].cost, undefined, '计算列绝不能落盘');
});

test('写入：列写在数据里就能加列，不必动字段字典', async () => {
  await setupSection('work4');
  await entries.addEntry({
    section: 'work4',
    title: '样例',
    data: {
      tasks: {
        columns: [...COLS, { key: 'note', label: '备注', type: 'text' }],
        rows: [{ task: 'a', hours: 1, rate: 10, note: '临时加的列' }],
      },
    },
  });
  const got = await entries.getEntry('样例', { section: 'work4' });
  assert.equal(got.values.tasks.columns.length, 6);
  assert.equal(got.values.tasks.rows[0].note, '临时加的列');

  // 字段字典没被改（只有初始的 5 列）
  const sec = await sections.getSection('work4');
  const field = sec.fieldList.find((f) => f.key === 'tasks');
  assert.equal(field.columns.length, 5, '数据里加列不该改到栏目 schema');
});

test('写入：类型不对 / 列名写错 / 下拉值不在候选里，都要报错而不是静默存 null', async () => {
  await setupSection('work2');
  await entries.addEntry({ section: 'work2', title: '样例', data: { tasks: [{ task: 'x' }] } });

  await assert.rejects(
    () => entries.updateEntry('样例', { section: 'work2', set: { tasks: [{ task: 'x', hours: '两小时' }] } }),
    /需要数字/,
  );
  await assert.rejects(
    () => entries.updateEntry('样例', { section: 'work2', set: { tasks: [{ 不存在的列: 1 }] } }),
    /没有列/,
  );

  await sections.updateSection('work2', { 'add-field': { key: 'pick', label: '选一', type: 'table', group: 'main', columns: [{ key: 's', label: '状态', type: 'select', options: ['甲', '乙'] }] } });
  await assert.rejects(
    () => entries.updateEntry('样例', { section: 'work2', set: { pick: [{ s: '丙' }] } }),
    /不在候选里/,
  );
});

test('表格的密文列：密文落盘、默认读原文、--mask 打码、占位回传保留原密文', async () => {
  await sections.addSection({ id: 'acc', title: '账号', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('acc', {
    'add-field': {
      key: 'list', label: '账号表', type: 'table', group: 'main',
      columns: [
        { key: 'site', label: '站点', type: 'text' },
        { key: 'pass', label: '密码', type: 'text', sensitive: true },
      ],
    },
  });
  await entries.addEntry({ section: 'acc', title: '我的', data: { list: [{ site: 'a', pass: 'p@ss-1' }, { site: 'b', pass: 'p@ss-2' }] } });

  const store = await loadStore();
  const raw = store.entries.find((e) => e.title === '我的').values.list;
  assert.ok(isCipherBlob(raw.rows[0].pass), '敏感列必须密文落盘');
  assert.equal(raw.rows[0].site, 'a');

  const plain = await entries.getEntry('我的', { section: 'acc' });
  assert.equal(plain.values.list.rows[1].pass, 'p@ss-2', '默认读原文');

  const masked = await entries.getEntry('我的', { section: 'acc', mask: true });
  assert.equal(masked.values.list.rows[0].pass, maskValue('p@ss-1'));

  // 面板「打码显示」时保存别的格子：打码占位原样回传 = 不修改
  const doc = {
    ...masked.values.list,
    rows: [{ site: 'a-改', pass: masked.values.list.rows[0].pass }, { site: 'b', pass: masked.values.list.rows[1].pass }],
  };
  await entries.updateEntry('我的', { section: 'acc', set: { list: doc } });
  const after = await loadStore();
  const raw2 = after.entries.find((e) => e.title === '我的').values.list;
  assert.ok(isCipherBlob(raw2.rows[0].pass), '仍是密文');
  assert.equal(raw2.rows[0].site, 'a-改');
  const again = await entries.getEntry('我的', { section: 'acc' });
  assert.equal(again.values.list.rows[0].pass, 'p@ss-1', '打码占位不能把掩码存成新密码');
});

test('表格的密文列：行被移动过，打码占位仍能按列认回自己的密文', async () => {
  await sections.addSection({ id: 'acc2', title: '账号2', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('acc2', {
    'add-field': {
      key: 'list', label: '账号表', type: 'table', group: 'main',
      columns: [{ key: 'site', label: '站点' }, { key: 'pass', label: '密码', sensitive: true }],
    },
  });
  await entries.addEntry({ section: 'acc2', title: '我的', data: { list: [{ site: 'a', pass: 'aaa111' }, { site: 'b', pass: 'bbbb2222' }] } });
  const masked = await entries.getEntry('我的', { section: 'acc2', mask: true });

  // 把两行**换序**后原样回传：只按行号对齐的话，密码会认到别人头上
  const swapped = {
    ...masked.values.list,
    rows: [{ site: 'b', pass: masked.values.list.rows[1].pass }, { site: 'a', pass: masked.values.list.rows[0].pass }],
  };
  await entries.updateEntry('我的', { section: 'acc2', set: { list: swapped } });
  const after = await entries.getEntry('我的', { section: 'acc2' });
  assert.deepEqual(after.values.list.rows, [{ site: 'b', pass: 'bbbb2222' }, { site: 'a', pass: 'aaa111' }]);
});

test('表格的密文列：打码值一模一样又挪过行时按行号兜底（已知限制，文档写明）', async () => {
  await sections.addSection({ id: 'acc3', title: '账号3', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('acc3', {
    'add-field': {
      key: 'list', label: '账号表', type: 'table', group: 'main',
      columns: [{ key: 'site', label: '站点' }, { key: 'pass', label: '密码', sensitive: true }],
    },
  });
  // 两个等长密码 → 打码后都是 ******，没有身份信息
  await entries.addEntry({ section: 'acc3', title: '我的', data: { list: [{ site: 'a', pass: 'aaa111' }, { site: 'b', pass: 'bbb222' }] } });
  const masked = await entries.getEntry('我的', { section: 'acc3', mask: true });
  assert.equal(masked.values.list.rows[0].pass, masked.values.list.rows[1].pass);

  // 没挪行：按行认回，正确
  await entries.updateEntry('我的', { section: 'acc3', set: { list: masked.values.list } });
  const same = await entries.getEntry('我的', { section: 'acc3' });
  assert.deepEqual(same.values.list.rows.map((r) => r.pass), ['aaa111', 'bbb222']);

  // 挪了行：打码值相同无法区分，按行号兜底 —— 两格都是密文、都还能解开，
  // 只是「哪一行是谁的」在这一刻无从判断。这条限制写进文档，别指望它magic。
  const swapped = {
    ...masked.values.list,
    rows: [{ site: 'b', pass: masked.values.list.rows[1].pass }, { site: 'a', pass: masked.values.list.rows[0].pass }],
  };
  await entries.updateEntry('我的', { section: 'acc3', set: { list: swapped } });
  const moved = await entries.getEntry('我的', { section: 'acc3' });
  assert.ok(moved.values.list.rows.every((r) => ['aaa111', 'bbb222'].includes(r.pass)));
});

// —— 只读查询命令 ——

test('entry table：给定条目与字段，返回算好的表；文本渲染带合计', async () => {
  await setupSection('work3');
  await entries.addEntry({ section: 'work3', title: '周报', data: { tasks: [{ task: 'a', hours: 2, rate: 50 }, { task: 'b', hours: 1, rate: 50 }] } });

  const d = await entries.getTable('周报', { section: 'work3', field: '任务表' });
  assert.equal(d.field, 'tasks');
  assert.equal(d.table.count, 2);
  assert.equal(d.table.totals[0].values.cost, 150);

  const text = entries.renderTable(d);
  assert.match(text, /任务表/);
  assert.match(text, /合计/);
  assert.match(text, /150/);

  await assert.rejects(() => entries.getTable('周报', { section: 'work3', field: '没有这个' }), /没有叫/);
});

test('section dump 与 entry get 都带上算好的表：合计与面板同源', async () => {
  const d = await sections.dump('work3');
  const e = d.entries.find((x) => x.title === '周报');
  assert.ok(e.tables?.tasks, 'dump 里要有 tables');
  assert.equal(e.tables.tasks.totals[0].values.cost, 150);
});

// —— 写入即体检：公式跑不起来就不许保存 ——

test('写入即体检：列名打错 / 引用后面的计算列 / 语法错 / 返回数组，一律拦在保存之前', async () => {
  await sections.addSection({ id: 'chk', title: '体检', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });

  // 列名打错
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't1', label: '表1', type: 'table', group: 'main', columns: [{ key: 'a', type: 'number' }, { key: 'b', formula: 'a * qty' }] },
  }), /不存在的名字「qty」/);

  // 引用排在后面的计算列
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't2', label: '表2', type: 'table', group: 'main', columns: [{ key: 'a', formula: 'c + 1' }, { key: 'c', formula: '1' }] },
  }), /后面.*计算列/);

  // 语法错
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't3', label: '表3', type: 'table', group: 'main', columns: [{ key: 'a', formula: 'b *' }] },
  }), /语法错误/);

  // 结果不是单值
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't4', label: '表4', type: 'table', group: 'main', columns: [{ key: 'a', formula: '[1, 2]' }] },
  }), /单值/);

  // 统计行引用不存在的列 / 用了统计行没有的 i
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't5', label: '表5', type: 'table', group: 'main', columns: [{ key: 'a', type: 'number' }], totals: [{ label: '率', expr: 'col("nope")' }] },
  }), /没有叫「nope」的列/);
  await assert.rejects(() => sections.updateSection('chk', {
    'add-field': { key: 't6', label: '表6', type: 'table', group: 'main', columns: [{ key: 'a', type: 'number' }], totals: [{ label: '率', expr: 'i' }] },
  }), /不存在的名字「i」/);
});

test('写入即体检：好公式放行（前面的列 / 中文列名 / 内建 / col）', async () => {
  await sections.addSection({ id: 'chk2', title: '体检2', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('chk2', {
    'add-field': {
      key: 't', label: '表', type: 'table', group: 'main',
      columns: [
        { key: 'qty', label: '数量', type: 'number' },
        { key: 'price', label: '单价', type: 'number' },
        { key: 'amount', label: '金额', formula: 'qty * price' },
        { key: 'tax', label: '含税', formula: 'round(金额 * 1.13, 2)' },
        { key: 'share', label: '占比', formula: 'pct(qty, sum(col("数量")))', type: 'number' },
      ],
      totals: [{ label: '完成率', expr: 'pct(countTrue(rows.map(r => r.qty > 0)), n)', unit: '%' }],
    },
  });
  const sec = await sections.getSection('chk2');
  assert.equal(sec.fieldList.find((f) => f.key === 't').columns.length, 5);
});

test('空表合法：--set 表= / [] / {} 都能清空，有行的骨架也留得住', async () => {
  // 没有初始列的栏目：空值就该真的是空
  await sections.addSection({ id: 'blank', title: '空表', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('blank', { 'add-field': { key: 't', label: '表', type: 'table', group: 'main' } });
  await entries.addEntry({ section: 'blank', title: 'x', data: { t: [{ a: 1 }] }, set: undefined });
  // 上面这行会从行推断出列 a，先确认能存
  let got = await entries.getEntry('x', { section: 'blank' });
  assert.equal(got.values.t.columns.length, 1, '没给列时从行推断');

  for (const blank of ['', '[]', '{}', '{"columns":[],"rows":[]}']) {
    await entries.updateEntry('x', { section: 'blank', set: { t: blank } });
    got = await entries.getEntry('x', { section: 'blank' });
    assert.equal(got.values.t, null, `「${blank}」应当把表清成空`);
  }

  // 有列没行 = 骨架，留着（下一步就能往里填）
  await entries.updateEntry('x', { section: 'blank', set: { t: { columns: [{ key: 'a', label: '甲', type: 'number' }], rows: [] } } });
  got = await entries.getEntry('x', { section: 'blank' });
  assert.deepEqual(got.values.t.columns.map((c) => c.key), ['a']);
  assert.deepEqual(got.values.t.rows, []);

  // 有数据没列 = 真错（结构缺了，没法强转）
  await assert.rejects(
    () => entries.updateEntry('x', { section: 'blank', set: { t: { columns: [], rows: [{ a: 1 }] } } }),
    /没有任何列/,
  );
});

test('默认值：按列类型强转后落盘，新增行时用它当初值', async () => {
  await sections.addSection({ id: 'def1', title: '默认值', fields: [{ key: 'name', label: '名称', type: 'text', group: 'main' }] });
  await sections.updateSection('def1', {
    'add-field': {
      key: 't', label: '表', type: 'table', group: 'main',
      columns: [
        { key: 'task', label: '任务' },
        { key: 'state', label: '状态', type: 'select', options: ['未开始', '完成'], default: '未开始' },
        { key: 'done', label: '已办', type: 'bool', default: false },
        { key: 'hours', label: '工时', type: 'number', default: 0 },
      ],
    },
  });
  // 类型不对的默认值要拦下来（"false" 存成字符串就会变成「看着像布尔其实不是」）
  await assert.rejects(() => sections.updateSection('def1', {
    'add-field': { key: 't2', label: '表2', type: 'table', group: 'main', columns: [{ key: 'h', type: 'number', default: '两小时' }] },
  }), /默认值不对/);

  await entries.addEntry({ section: 'def1', title: 'x', data: { t: [{ task: 'a' }] } });
  const got = await entries.getEntry('x', { section: 'def1' });
  const byKey = Object.fromEntries(got.values.t.columns.map((c) => [c.key, c]));
  assert.equal(byKey.state.default, '未开始');
  assert.equal(byKey.done.default, false, 'false 也要能当默认值（别被真值判断吃掉）');
  assert.equal(byKey.hours.default, 0, '0 也要能当默认值');
  assert.equal(byKey.task.default, undefined);
});

test('entry keys：表格里的密码列也进台账（行被展开，值默认打码）', async () => {
  const d = await entries.keysLedger({});
  const hit = d.items.filter((x) => x.sectionId === 'acc' && x.key === 'list.pass');
  assert.equal(hit.length, 2, '两行都要展开进台账');
  assert.ok(hit.every((x) => x.sensitive), '密码列必须标成敏感');
  assert.ok(hit.every((x) => x.value.includes('*')), '默认打码，--reveal 才出原文');
});

test('空表算「未填」：完整度不该被一张没有行的表撑满', async () => {
  const { isBlank } = await import('../../src/core/render.js');
  assert.equal(isBlank({ v: 1, columns: [{ key: 'a' }], rows: [] }), true);
  assert.equal(isBlank({ v: 1, columns: [{ key: 'a' }], rows: [{ a: 1 }] }), false);
});
