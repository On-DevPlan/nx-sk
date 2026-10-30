/* 原型演示数据 —— 与源码同源
 *
 * 规则（见 prototype/README.md 制作规则 7）：
 *   字段清单、打码长度、类型语义都对齐 src/core/fields.js 与 src/core/crypto.js，
 *   不在原型里另造一套「看着像」的数据。
 *   · demo 栏目的字段 = DEMO_FIELDS（DEMO_TABLE_COLUMNS 同步）
 *   · 打码规则 = maskValue：长度 ≤ 10 → 同长度全星；否则首 4 + 星 + 尾 4
 */

/** 打码：与 src/core/crypto.js maskValue 同规则 */
export function maskValue(text) {
  const s = String(text ?? '');
  if (!s) return '';
  if (s.length <= 10) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(6)}${s.slice(-4)}`;
}

const DEMO_TABLE_COLUMNS = [
  { key: 'item', label: '事项', type: 'text' },
  { key: 'state', label: '状态', type: 'select', options: ['未开始', '进行中', '已完成'], default: '未开始' },
  { key: 'done', label: '已办', type: 'bool' },
  { key: 'hours', label: '工时', type: 'number' },
  { key: 'rate', label: '单价', type: 'number', total: 'avg' },
  { key: 'cost', label: '费用', formula: 'hours * rate', unit: '元' },
];

const DEMO_FIELDS = [
  { key: 'name', label: '名称', type: 'text', group: 'basic' },
  { key: 'desc', label: '描述', type: 'textarea', group: 'basic' },
  { key: 'count', label: '数量', type: 'number', group: 'basic' },
  { key: 'ok', label: '完成', type: 'bool', group: 'basic' },
  { key: 'state', label: '状态', type: 'select', group: 'basic', options: ['未开始', '进行中', '已完成'] },
  { key: 'day', label: '日期', type: 'date', group: 'basic' },
  { key: 'month', label: '月份', type: 'month', group: 'basic' },
  { key: 'tags', label: '标签', type: 'tags', group: 'basic' },

  { key: 'accounts', label: '凭据清单', type: 'entrylist', group: 'combo',
    fields: [{ key: 'name', label: '名称' }, { key: 'user', label: '账号' }, { key: 'pass', label: '密码', sensitive: true }] },
  { key: 'sheet', label: '样例表格', type: 'table', group: 'combo', columns: DEMO_TABLE_COLUMNS },

  { key: 'note', label: '图文笔记', type: 'md', group: 'rich' },
  { key: 'docs', label: '附件', type: 'file', group: 'rich' },
  { key: 'apikey', label: '密钥', type: 'secret', group: 'rich' },
];

const DEMO_GROUPS = [
  { id: 'basic', title: '基本字段（标量）' },
  { id: 'combo', title: '组合字段（值有形状）' },
  { id: 'rich', title: '富内容' },
];

/** 演示条目：一半用真实播种值，一半补两条对照数据 */
const DEMO_ENTRIES = [
  {
    id: 'e-demo-1',
    title: '示例条目',
    values: {
      name: '示例条目',
      desc: '这是一条示例条目：左（或上）边选中的就是它。直接改任何一格，保存后就成了你自己的数据。',
      count: 3, ok: true, state: '进行中',
      day: '2026-10-30', month: '2026-10',
      tags: ['样例', '能力边界'],
      accounts: [{ name: '示例：主控台', user: 'ops@example.com', pass: 'sk-1234567890abcdef' }],
      sheet: [
        { item: '设计', state: '已完成', done: true, hours: 2, rate: 200 },
        { item: '开发', state: '进行中', done: false, hours: 5, rate: 200 },
      ],
      note: '# 图文字段\n\n- 支持 **markdown**：标题、列表、`行内代码`、表格都能渲染\n- [ ] 截图直接 Ctrl+V 粘进来（自动进附件库，正文里插入引用）',
      apikey: 'sk-abcdefghijklmnopqrstuvwx',
    },
  },
  {
    id: 'e-demo-2',
    title: '对照条目',
    values: {
      name: '对照条目', desc: '第二条：用来演示表格视图的排序与合计。', count: 7, ok: false, state: '未开始',
      day: '2026-10-31', month: '2026-11', tags: ['样例'],
      sheet: [
        { item: '评审', state: '进行中', done: false, hours: 1, rate: 300 },
        { item: '复盘', state: '未开始', done: false, hours: 3, rate: 300 },
      ],
      apikey: 'shortkey',
    },
  },
];

const JOB_FIELDS = [
  { key: 'name', label: '档案名', type: 'text', group: 'basic' },
  { key: 'state', label: '求职状态', type: 'select', group: 'basic', options: ['在职', '应届毕业生', '离职'] },
  { key: 'phone', label: '电话', type: 'text', group: 'contact' },
  { key: 'email', label: '邮箱', type: 'text', group: 'contact' },
  { key: 'salary', label: '期望薪资', type: 'number', group: 'job' },
  { key: 'city', label: '意向城市', type: 'text', group: 'job' },
  { key: 'resume', label: '简历', type: 'file', group: 'files' },
];

const JOB_GROUPS = [
  { id: 'basic', title: '基本信息' },
  { id: 'contact', title: '联系方式' },
  { id: 'job', title: '求职意向' },
  { id: 'files', title: '附件资料' },
];

const JOB_ENTRIES = [
  { id: 'e-job-1', title: '张三', values: { name: '张三', state: '在职', phone: '13800000000', email: 'zhangsan@example.com', salary: 35000, city: '杭州' } },
  { id: 'e-job-2', title: '李四', values: { name: '李四', state: '应届毕业生', phone: '13900000000', email: 'lisi@example.com', salary: 18000, city: '上海' } },
  { id: 'e-job-3', title: '王五', values: { name: '王五', state: '离职', phone: '13700000000', email: 'wangwu@example.com', salary: 45000, city: '深圳' } },
];

const PROJECT_FIELDS = [
  { key: 'name', label: '项目名', type: 'text', group: 'basic' },
  { key: 'state', label: '状态', type: 'select', group: 'basic', options: ['未开始', '进行中', '已完成'] },
  { key: 'stack', label: '技术栈', type: 'tags', group: 'basic' },
  { key: 'intro', label: '简介', type: 'textarea', group: 'basic' },
];

const SECRET_FIELDS = [
  { key: 'name', label: '名称', type: 'text', group: 'basic' },
  { key: 'apikey', label: '密钥', type: 'secret', group: 'basic' },
  { key: 'owner', label: '归属', type: 'text', group: 'basic' },
];

export const SECTIONS = {
  demo: {
    id: 'demo', title: '字段样例', template: 'demo',
    titleField: 'name', titleLabel: '条目名',
    groups: DEMO_GROUPS, fields: DEMO_FIELDS, entries: DEMO_ENTRIES,
    // 这个栏目**配了 views**（于是不再走缺省推断）：四个视图 + 一个「自定义」。
    // 「自定义」这一列引用了一个**已被删除的字段** ghost_note —— 用来演示「投影降级」
    // （设计 §八 8.2）：列还在，渲染成「已删字段」弱占位，不炸、不静默消失。
    // （没配 views 的栏目走 `src/views.js` 的缺省推断——「求职」栏目就是那条路径。）
    views: [
      { id: 'v_table', type: 'table', title: '表格', columns: [
        { key: 'name' }, { key: 'desc' }, { key: 'count' }, { key: 'ok' }, { key: 'state' }, { key: 'day' }, { key: 'tags' },
      ] },
      { id: 'v_compact', type: 'table', title: '精简', columns: [{ key: 'name' }, { key: 'state' }] },
      { id: 'v_board', type: 'board', title: '看板', groupBy: 'state' },
      { id: 'v_custom', type: 'table', title: '自定义', columns: [{ key: 'name' }, { key: 'count' }, { key: 'ghost_note' }] },
    ],
  },
  job: {
    id: 'job', title: '求职', template: 'job',
    titleField: 'name', titleLabel: '档案名',
    groups: JOB_GROUPS, fields: JOB_FIELDS, entries: JOB_ENTRIES,
  },
  projects: {
    id: 'projects', title: '项目', template: 'projects',
    titleField: 'name', titleLabel: '项目名',
    groups: [{ id: 'basic', title: '基本信息' }], fields: PROJECT_FIELDS,
    entries: [{ id: 'e-proj-1', title: 'nx-sk 本体', values: { name: 'nx-sk 本体', state: '进行中', stack: ['Node', 'React'], intro: '本机个人资源管理器' } }],
  },
  internships: {
    id: 'internships', title: '项目经历', template: 'projects',
    titleField: 'name', titleLabel: '项目名',
    groups: [{ id: 'basic', title: '基本信息' }], fields: PROJECT_FIELDS, entries: [],
  },
  secret: {
    id: 'secret', title: '密钥', template: 'secret', kv: true,
    titleField: 'name', titleLabel: '名称',
    groups: [{ id: 'basic', title: '基本信息' }], fields: SECRET_FIELDS,
    entries: [
      { id: 'e-sec-1', title: 'OPENAI_KEY', values: { name: 'OPENAI_KEY', apikey: 'sk-abcdefghijklmnopqrstuvwx', owner: '主控台' } },
      { id: 'e-sec-2', title: 'ANTHROPIC_KEY', values: { name: 'ANTHROPIC_KEY', apikey: 'sk-ant-0123456789abcdef', owner: 'CLI' } },
      { id: 'e-sec-3', title: 'DB_PASSWORD', values: { name: 'DB_PASSWORD', apikey: 'shortpw', owner: '本地库' } },
      { id: 'e-sec-4', title: 'NPM_TOKEN', values: { name: 'NPM_TOKEN', apikey: 'npm_abcdefghijklmnopqrstuv', owner: '发布' } },
    ],
  },
};

/**
 * 老 store 的显示配置（老三套）—— **原型故意用这个，而不是 navTree**，
 * 好让「从老三套推断出一棵树」这条兼容路径**真的被跑到**（设计 §十五 15.2）。
 *
 *   navGroups = [{ title, sections:[栏目id…] }]   数组顺序 = 显示顺序
 *   navHidden = [栏目id]                            入口不显示
 *   navOrder  = [栏目id]                            平铺区顺序；没列的按栏目自身顺序跟在后面
 *
 * 推断结果：平铺 [字段样例, 项目, 密钥] + 分组「求职档案」[求职]；项目经历被隐藏。
 * 用户在侧边栏里**第一次动树**（拖拽重排/嵌套）→ 落成显式 navTree（推断到此为止）。
 */
export const LEGACY_SETTINGS = {
  navGroups: [{ title: '求职档案', sections: ['job'] }],
  navHidden: ['internships'],
  navOrder: ['demo', 'projects', 'secret'],
};

/**
 * 附件库（**只做库存**：谁在引用它，由块里的附件 id 列表算出来）。
 * file 块 / file 字段的值 = **附件 id 的列表**（不是路径、不是文件名）——
 * 同一个原件可以被多条条目挂上，两边指的是同一条记录（40-files.md）。
 */
export const FILES = [
  { id: 'f1', name: '张三-简历-后端.pdf', size: '312 KB', tags: ['简历'] },
  { id: 'f2', name: '成绩单.pdf', size: '180 KB', tags: ['证明'] },
  { id: 'f3', name: '头像.jpg', size: '64 KB', tags: ['照片'] },
  { id: 'f4', name: '项目说明.pdf', size: '96 KB', tags: ['说明'] },
  { id: 'f5', name: '密钥清单.csv', size: '12 KB', tags: ['清单'] },
];

/** 附件的引用计数：扫全部条目的 file 块与 file 字段 */
export function countFileRefs(sections, blocksByEntry) {
  const count = new Map();
  const bump = (id) => { if (id) count.set(id, (count.get(id) || 0) + 1); };

  // ① 块
  for (const blocks of Object.values(blocksByEntry || {})) {
    const walk = (list) => {
      for (const b of list || []) {
        if (b.type === 'file' && Array.isArray(b.files)) b.files.forEach(bump);
        if (b.children) walk(b.children);
      }
    };
    walk(blocks);
  }
  // ② file **字段**（值也是 id 列表）
  for (const sec of Object.values(sections || {})) {
    const fileKeys = (sec.fields || []).filter((f) => f.type === 'file').map((f) => f.key);
    if (!fileKeys.length) continue;
    for (const e of sec.entries || []) {
      for (const k of fileKeys) {
        const v = e.values?.[k];
        if (Array.isArray(v)) v.forEach(bump);
      }
    }
  }
  return count;
}

/** 块正文（详细页）：7 种叶块 + 2 种容器块（§十三 13.2 / §八 8.1）
 *
 * 类型名**对齐设计文档的词汇表**，不另发明：
 *   叶块：paragraph / heading / md / table / entrylist / file / secret
 *   容器：section（内嵌另一个栏目的数据库视图）/ column（列组，widths 与 children 平行）
 * 块 id 用 `b_` 前缀（复用 src/core/ids.js 的 id 族）。
 */
export const BLOCKS = [
  { id: 'b_1', type: 'paragraph', text: '投了两个月，目前面了 3 家。这段是普通段落块。' },
  { id: 'b_2', type: 'heading', level: 2, text: '9 月复盘' },
  { id: 'b_3', type: 'paragraph', text: '这行下面接的是表格块——列定义在数据里，面板可直接加列。' },
  {
    id: 'b_4',
    type: 'table',
    columns: DEMO_TABLE_COLUMNS,
    rows: [
      { item: '设计', state: '已完成', done: true, hours: 2, rate: 200 },
      { item: '开发', state: '进行中', done: false, hours: 5, rate: 200 },
    ],
  },
  { id: 'b_5', type: 'file', files: ['f1'] },
  { id: 'b_6', type: 'secret', label: '密钥', value: 'sk-abcdefghijklmnopqrstuvwx' },
  {
    id: 'b_7',
    type: 'md',
    text: [
      '# 图文块',
      '',
      '- 支持 **markdown**：标题、列表、`行内代码`',
      '- [ ] 待办勾选就是改正文本身',
    ].join('\n'),
  },
  {
    id: 'b_8',
    type: 'entrylist',
    // 块不是字段，没有栏目字典可查子列定义 → entrylist 块**自带**子列定义（R13 修订）
    fields: [
      { key: 'name', label: '名称' },
      { key: 'user', label: '账号' },
      { key: 'pass', label: '密码', sensitive: true },
    ],
    value: [{ name: '示例：主控台', user: 'ops@example.com', pass: 'sk-1234567890abcdef' }],
  },
  { id: 'b_9', type: 'section', sectionId: 'job', viewId: 'table' },
  {
    id: 'b_10',
    type: 'column',
    widths: [62, 38],
    children: [
      {
        id: 'b_10a',
        type: 'column',
        widths: [],
        children: [
          { id: 'b_10a1', type: 'paragraph', text: '左列：列容器的第一个子列。' },
          { id: 'b_10a2', type: 'paragraph', text: '拖中间的竖线改列宽——改的是 widths，不是像素。' },
        ],
      },
      {
        id: 'b_10b',
        type: 'column',
        widths: [],
        children: [
          { id: 'b_10b1', type: 'heading', level: 3, text: '右列' },
          { id: 'b_10b2', type: 'paragraph', text: '子列里的内容也是块，可以再拖动排序。' },
        ],
      },
    ],
  },
];

/** 块类型清单：与设计文档的词汇表一一对应（10 种，toggle 下一版） */
export const BLOCK_TYPES = [
  { type: 'paragraph', label: '段落', container: false },
  { type: 'heading', label: '标题', container: false },
  { type: 'md', label: '图文', container: false },
  { type: 'table', label: '表格', container: false },
  { type: 'entrylist', label: '结构清单', container: false },
  { type: 'file', label: '附件', container: false },
  { type: 'secret', label: '密文', container: false },
  { type: 'section', label: '栏目（内嵌）', container: true },
  { type: 'column', label: '列', container: true },
];

export const AI_PENDING = [
  { id: 'p1', blockId: 'b_1', kind: 'edit', segments: [
    { t: '投了两个月，目前面了 3 家。', op: 'keep' },
    { t: '感觉讲得太散，', op: 'del' },
    { t: '下周约三家公司做模拟面试。', op: 'add' },
  ] },
  { id: 'p2', blockId: 'b_3', kind: 'new', text: '简历里的期望薪资与字段不一致，要一起改吗？' },
  { id: 'p3', blockId: 'b_10', kind: 'del', text: '（去年秋招那段，先删）' },
];
