// 字段字典：栏目的字段模板是**数据**，不是代码分支。
// agent 与面板都从同一份声明渲染，所以「CLI 能填的字段」与「面板能填的字段」不可能分叉。
//
// type 取值：text | textarea | number | date | month | bool | select | tags | secret

export const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags', 'secret'];

/**
 * 字段的**填写策略**——回答「这个字段值不值得填」，与 type 正交。
 *
 *   normal   照常填（默认；字段定义上不写 `fill` 就是它）
 *   optional 不必填：填了不亏，但没填也不该被算成「缺失」
 *   avoid    回避不填：填了可能反而减分（应届生的「上一家公司」、群众的「入党时间」）
 *
 * 后两者都**不计入完整度的分子与分母**。理由：完整度这个数字是用来导航
 * 「还该补什么」的，如果一批自己决定不填的字段长期压着它，导航就废了。
 * 被排除的字段不会消失——`completeness()` 会单独把它们列在 `excluded` 里。
 */
export const FILL_POLICIES = ['normal', 'optional', 'avoid'];

export const FILL_LABELS = { normal: '照常填', optional: '不必填', avoid: '不填' };

/** 取字段的填写策略，缺省与非法值都归到 `normal`（宽松读，旧数据不用迁移）。 */
export function fillPolicy(def) {
  const v = def && def.fill;
  return FILL_POLICIES.includes(v) ? v : 'normal';
}

/** 是否被排除在完整度之外（optional / avoid 都是）。 */
export function isExcludedField(def) {
  return fillPolicy(def) !== 'normal';
}

export const BOOL_TRUE = ['是', 'true', '1', 'yes', 'y'];
export const BOOL_FALSE = ['否', 'false', '0', 'no', 'n'];

const f = (key, label, type, group, extra = {}) => ({ key, label, type, group, ...extra });

const JOB_FIELDS = [
  // —— 基本信息 ——
  f('name', '姓名', 'text', 'basic'),
  f('namePinyin', '姓名拼音', 'text', 'basic', { hint: '姓名拼音，便于英文表单填写' }),
  f('englishName', '英文姓名', 'text', 'basic', { hint: '完整英文姓名' }),
  f('gender', '性别', 'select', 'basic', { options: ['男', '女'] }),
  f('birthDate', '出生日期', 'date', 'basic'),
  f('age', '年龄', 'number', 'basic', { hint: '可不填：留空时按出生日期推算' }),
  f('nationality', '国籍', 'text', 'basic', { hint: '默认中国' }),
  f('ethnicity', '民族', 'text', 'basic', { hint: '民族信息' }),
  f('maritalStatus', '婚姻状况', 'select', 'basic', { options: ['未婚', '已婚', '离异', '丧偶'] }),
  f('hasChildren', '有无子女', 'bool', 'basic'),
  f('politicalStatus', '政治面貌', 'select', 'basic', { options: ['群众', '共青团员', '中共预备党员', '中共党员', '民主党派', '其他'] }),
  f('partyJoinDate', '入党时间', 'date', 'basic', { hint: '加入党组织的时间' }),
  f('leagueJoinDate', '入团时间', 'date', 'basic', { hint: '加入共青团的时间' }),
  f('idType', '证件类型', 'select', 'basic', { options: ['身份证', '护照', '港澳居民来往内地通行证', '台湾居民来往大陆通行证', '其他'] }),
  f('idNumber', '身份证号', 'text', 'basic', { hint: '证件号码' }),

  // —— 联系方式 ——
  f('phone', '电话', 'text', 'contact', { hint: '手机号码' }),
  f('email', '邮箱', 'text', 'contact', { hint: '联系邮箱' }),
  f('wechat', '微信号', 'text', 'contact', { hint: '即时通讯微信号' }),
  f('qq', 'QQ号', 'text', 'contact', { hint: 'QQ 号码' }),
  f('homepage', '个人主页/作品链接', 'text', 'contact', { hint: '个人主页、作品集或代码仓库链接' }),
  f('postalCode', '邮政编码', 'text', 'contact', { hint: '通讯地址邮编（家庭/收件地址，可与现居住地不同）' }),

  // —— 教育背景 ——
  f('education', '最高学历', 'select', 'education', { options: ['大专', '本科', '硕士', '博士', '其他'] }),
  f('degree', '学位', 'select', 'education', { options: ['学士', '硕士', '博士', '无'] }),
  f('school', '毕业院校', 'text', 'education'),
  f('major', '毕业专业', 'text', 'education'),
  f('studyMode', '学习形式', 'select', 'education', { options: ['全国普通高等院校全日制', '非全日制', '成人教育', '自学考试', '其他'] }),
  f('enrollDate', '入学时间', 'month', 'education'),
  f('graduateDate', '毕业时间', 'month', 'education'),
  f('englishLevel', '英语等级', 'select', 'education', { options: ['无', 'CET-3', 'CET-4', 'CET-6', '专业四级', '专业八级', '雅思', '托福'] }),
  f('englishScore', '英语等级分数', 'number', 'education', { hint: '等级考试的具体分数，如 CET-4 492 / CET-6 425' }),
  f('gaokaoDate', '高考时间', 'month', 'education', { hint: '高考参加时间' }),
  f('gaokaoScore', '高考分数', 'number', 'education', { hint: '高考成绩' }),
  f('gaokaoSubjects', '高考科目', 'text', 'education', { hint: '高考选科组合' }),
  f('isFreshGraduate', '是否应届生', 'bool', 'education'),
  f('isBaoyan', '是否保研', 'bool', 'education', { hint: '是否推荐免试攻读研究生' }),
  f('hasOverseasStudy', '是否有留学经历', 'bool', 'education'),
  f('certificates', '技能证书', 'textarea', 'education', { hint: '每行一条证书或获奖' }),
  // 实习/项目/校内职务不再放这里——它们各自是独立栏目（projects / internships / campus），
  // 每个项目/一段经历一个条目，角色、时间、技术栈都是独立字段，不再挤 textarea。
  f('skills', '专业技能', 'textarea', 'education', { hint: '每行一条：方向——具体技术点' }),

  // —— 户籍与居住 ——
  f('hukouPlace', '户口所在地', 'text', 'household', { hint: '省市' }),
  f('hukouType', '户口性质', 'select', 'household', { options: ['农业户口', '城镇户口', '其他'] }),
  f('nativePlace', '籍贯', 'text', 'household', { hint: '籍贯（省市）' }),
  f('studentOrigin', '生源地', 'text', 'household', { hint: '毕业生生源地' }),
  f('archiveOrg', '档案存放机构', 'text', 'household'),
  f('archivePlace', '档案所在地', 'text', 'household', { hint: '人事档案所在地区' }),
  f('address', '现居住地址', 'textarea', 'household', { hint: '省市 + 详细地址' }),

  // —— 身体信息 ——
  f('height', '身高', 'number', 'body', { hint: '身高(cm)' }),
  f('weight', '体重', 'number', 'body', { hint: '体重(kg)' }),
  f('bloodType', '血型', 'select', 'body', { options: ['A', 'B', 'AB', 'O', '未知'] }),
  f('healthStatus', '健康状况', 'select', 'body', { options: ['良好', '一般', '较差'] }),
  f('hasChronic', '是否有长期病史', 'bool', 'body'),
  f('isColorWeak', '是否色弱', 'bool', 'body', { hint: '是否存在色觉弱' }),
  f('hasCriminalRecord', '是否有犯罪记录', 'bool', 'body'),

  // —— 紧急联系 ——
  f('emergencyName', '紧急联系人姓名', 'text', 'emergency'),
  f('emergencyRelation', '紧急联系人关系', 'select', 'emergency', { options: ['父亲', '母亲', '配偶', '子女', '兄弟姐妹', '朋友', '其他'] }),
  f('emergencyPhone', '紧急联系电话', 'text', 'emergency'),

  // —— 自我描述 ——
  f('selfIntro', '自我介绍', 'textarea', 'about', { hint: '个人自我介绍' }),
  f('advantages', '个人优势', 'textarea', 'about', { hint: '个人优势和特长' }),
  f('hobbies', '兴趣爱好', 'textarea', 'about'),

  // —— 求职意向 ——
  f('targetPosition', '目标岗位', 'text', 'job'),
  f('availableFrom', '预计入职时间', 'text', 'job', { hint: '预计到岗时间，如「随时到岗」「2027-07」' }),
  f('expectCities', '期望城市', 'tags', 'job', { hint: '期望工作城市，最多 5 个', maxItems: 5 }),
  f('interviewCities', '面试城市', 'tags', 'job', { hint: '可参与面试城市' }),
  f('expectSalaryMonthly', '期望薪资', 'number', 'job', { hint: '期望税前月薪（元）' }),
  f('expectSalaryYearly', '期望年薪', 'number', 'job', { hint: '期望年薪，仅填写数字' }),
  f('currentSalary', '当前薪资', 'number', 'job', { hint: '当前税前月薪（元）' }),
  f('workYears', '工作年限', 'number', 'job', { hint: '总工作年限（在读或应届写 0）' }),
  f('workStatus', '工作状态', 'select', 'job', { options: ['在读', '应届毕业生', '在职', '离职', '待业'] }),
  f('lastCompany', '上一家公司', 'text', 'job', { hint: '最近工作单位' }),
  f('techLevel', '专业技术职级', 'text', 'job', { hint: '专业技术资格等级' }),
  f('hasRelativesInCompany', '是否有亲人在当前求职公司', 'bool', 'job', { hint: '是否有亲属在当前应聘的公司任职' }),
  f('sourceChannel', '招聘信息来源', 'select', 'job', { options: ['公司招聘官网', 'BOSS直聘', '智联招聘', '前程无忧', '校园招聘', '内推', '猎头', '社交媒体', '其他'] }),
  f('acceptAdjustment', '是否接受调剂', 'bool', 'job', { hint: '是否接受岗位或城市调剂' }),
  f('jobNote', '求职备注', 'textarea', 'job', { hint: '补充说明' }),

  // —— 其他 ——
  f('religion', '宗教信仰', 'text', 'extra', { hint: '没有就写「无」' }),
  f('unionVolunteer', '是否自愿加入公司工会', 'bool', 'extra'),
];

// 密钥栏目刻意只有**一个**字段：名称（条目名）+ 值。
// 之前做过 8 个字段（服务商/接口地址/模型/用途/有效期/额度/备注），实测是负担——
// 存一个 key 不该先填一张表。要记「这个 key 干什么用」，把它写进名称里就够。
const SECRET_FIELDS = [
  f('value', '密钥值', 'secret', 'key', { hint: 'API Key 本身。落盘是密文，读出来默认是原文（--mask 才打码）' }),
];

// —— 经历类模板：一个项目 / 一段实习 / 一条职务 = 一个条目 ——
// 为什么是独立栏目而不是 job 里的 textarea：经历天然是多字段、多条目的结构化数据，
// 「每行一条」挤在一个格子里既没法填也没法按角色/时间取数。
const PROJECT_FIELDS = [
  f('name', '项目名称', 'text', 'main'),
  f('role', '担任角色', 'text', 'main'),
  f('period', '起止时间', 'text', 'main', { hint: '如 2025.05-2025.07' }),
  f('company', '所属单位', 'text', 'main', { hint: '公司/学校/个人项目，没有就不填', fill: 'optional' }),
  f('stack', '技术栈', 'textarea', 'main', { hint: '逗号分隔或每行一个' }),
  f('summary', '项目简介', 'textarea', 'main'),
  f('highlights', '职责与亮点', 'textarea', 'main', { hint: '每行一条' }),
  f('link', '项目链接', 'text', 'main', { fill: 'optional' }),
];

const INTERNSHIP_FIELDS = [
  f('company', '公司名称', 'text', 'main'),
  f('role', '岗位', 'text', 'main'),
  f('period', '起止时间', 'text', 'main', { hint: '如 2026.01-2026.04' }),
  f('summary', '工作概述', 'textarea', 'main'),
  f('duties', '工作内容', 'textarea', 'main', { hint: '每行一条' }),
  f('stack', '技术栈', 'textarea', 'main', { hint: '逗号分隔或每行一个' }),
];

const CAMPUS_FIELDS = [
  f('role', '职务名称', 'text', 'main'),
  f('org', '所属组织', 'text', 'main', { fill: 'optional' }),
  f('period', '起止时间', 'text', 'main', { fill: 'optional', hint: '如 2024.09-至今' }),
  f('duties', '职责描述', 'textarea', 'main'),
];

const TEMPLATES = {
  job: {
    id: 'job',
    label: '求职 / 个人信息',
    description: '求职用的个人信息档案：一次填好，所有网申表单都能从这里取数。',
    titleField: 'name',
    titleLabel: '档案名',
    groups: [
      { id: 'basic', title: '基本信息' },
      { id: 'contact', title: '联系方式' },
      { id: 'education', title: '教育背景' },
      { id: 'household', title: '户籍与居住' },
      { id: 'body', title: '身体信息' },
      { id: 'emergency', title: '紧急联系' },
      { id: 'about', title: '自我描述' },
      { id: 'job', title: '求职意向' },
      { id: 'extra', title: '其他' },
    ],
    fields: JOB_FIELDS,
  },
  secret: {
    id: 'secret',
    label: '密钥 / 凭据',
    description: '极简 KV：名称 → 值。值以密文落盘，读出来是原文。',
    // kv: true = 这个栏目**就是一张 KV 表**：条目名 = 键名，唯一那个字段 = 值。
    // 面板据此渲染表格（而不是「条目列表 + 表单 + 完整性」那套）；
    // key set/get/list/remove 默认作用在它上面。字段字典对它没有意义，只有一个 value。
    kv: true,
    titleField: null,
    titleLabel: '密钥名',
    groups: [{ id: 'key', title: '密钥信息' }],
    fields: SECRET_FIELDS,
  },
  projects: {
    id: 'projects',
    label: '项目经历',
    description: '每个项目一个条目：名称、角色、时间、技术栈、职责与亮点。',
    titleField: 'name',
    titleLabel: '条目名',
    groups: [{ id: 'main', title: '项目信息' }],
    fields: PROJECT_FIELDS,
  },
  internships: {
    id: 'internships',
    label: '实习/工作经历',
    description: '每段实习或工作一个条目：公司、岗位、时间、职责。',
    titleField: 'company',
    titleLabel: '条目名',
    groups: [{ id: 'main', title: '经历信息' }],
    fields: INTERNSHIP_FIELDS,
  },
  campus: {
    id: 'campus',
    label: '校内职务/实践',
    description: '每条职务或实践一个条目：职务、组织、时间、职责。',
    titleField: 'role',
    titleLabel: '条目名',
    groups: [{ id: 'main', title: '职务信息' }],
    fields: CAMPUS_FIELDS,
  },
};

export function templateIds() {
  return Object.keys(TEMPLATES);
}

export function getTemplate(id) {
  return TEMPLATES[String(id || '')] || null;
}

/** 模板摘要，给 `section templates` 与面板的「新建栏目」用。 */
export function templateSummaries() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    groups: t.groups.length,
    fields: t.fields.length,
  }));
}

/** 由模板实例化一个栏目。深拷贝 —— 栏目自己的字段集从此独立演化。 */
export function instantiateTemplate(templateId, overrides = {}) {
  const t = getTemplate(templateId);
  if (!t) return null;
  return {
    id: overrides.id,
    title: overrides.title || t.label,
    description: overrides.description || t.description,
    order: Number.isFinite(overrides.order) ? overrides.order : 50,
    template: t.id,
    kv: t.kv === true,
    titleField: overrides.titleField || t.titleField,
    titleLabel: overrides.titleLabel || t.titleLabel,
    groups: t.groups.map((g) => ({ ...g })),
    fields: t.fields.map((x) => ({ ...x })),
    createdAt: overrides.createdAt || null,
    updatedAt: overrides.updatedAt || null,
  };
}

/** 首次运行（store 文件不存在）时的默认栏目——第一个就是「求职」。 */
export function seedSections(stamp) {
  return [
    { ...instantiateTemplate('job', { id: 'job', title: '求职', order: 10 }), createdAt: stamp, updatedAt: stamp },
    { ...instantiateTemplate('projects', { id: 'projects', title: '项目经历', order: 11 }), createdAt: stamp, updatedAt: stamp },
    { ...instantiateTemplate('internships', { id: 'internships', title: '实习/工作经历', order: 12 }), createdAt: stamp, updatedAt: stamp },
    { ...instantiateTemplate('campus', { id: 'campus', title: '校内职务/实践', order: 13 }), createdAt: stamp, updatedAt: stamp },
    { ...instantiateTemplate('secret', { id: 'secret', title: '密钥', order: 20 }), createdAt: stamp, updatedAt: stamp },
  ];
}

/** 由「字段定义 + 值」推导栏目的分组结构，供 render/面板用。 */
export function groupFields(fields) {
  const order = [];
  const map = new Map();
  for (const x of fields || []) {
    const g = x.group || 'other';
    if (!map.has(g)) { map.set(g, []); order.push(g); }
    map.get(g).push(x);
  }
  return order.map((id) => ({ id, fields: map.get(id) }));
}

/**
 * 分组声明的**唯一补全规则**：字段引用了未声明的分组 → 追加 `{ id, title: id }`。
 *
 * 背景（servers 栏目事故）：CLI 的分组渲染从字段**推导**（groupFields），
 * 面板却读**声明数组**（section.groups）——`--fields` 引用了 `--groups`
 * 没声明的分组时，两端分叉，面板整个字段表单消失而 CLI 看起来一切正常。
 * 所以「分组声明 ⊇ 字段引用」必须是不变量，在 normalize（读写唯一收口）
 * 和 section add 的草稿上调用同一个函数，规则就不可能有第二份。
 */
export function syncSectionGroups(groups, fields) {
  const out = [...(groups || [])];
  const declared = new Set(out.map((g) => g.id));
  for (const f of fields || []) {
    const gid = f.group || 'other';
    if (!declared.has(gid)) { declared.add(gid); out.push({ id: gid, title: gid }); }
  }
  return out;
}

export function fieldByKey(section, key) {
  return (section?.fields || []).find((x) => x.key === key) || null;
}

export function fieldByLabel(section, label) {
  const s = String(label || '').trim();
  return (section?.fields || []).find((x) => x.label === s || x.key === s) || null;
}

export function isSensitiveField(section, key) {
  const def = fieldByKey(section, key);
  return !!(def && (def.sensitive || def.type === 'secret'));
}

/**
 * 栏目定位：**id 或标题都接受**。
 * 放宽的理由：agent 手里往往是人读的名字（「求职」），而不是内部 id。
 * 放 core 是因为每个模块都要用它，而模块之间不许互相 import。
 */
export function findSection(store, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return (store?.sections || []).find((x) => x.id === lower)
    || (store?.sections || []).find((x) => x.title === s)
    || null;
}

export function sectionNames(store) {
  const names = (store?.sections || []).map((x) => `${x.id}（${x.title}）`).join('、');
  return names || '（还没有栏目）';
}

/**
 * KV 栏目：`kv: true` 标记的栏目（密钥就是）。它是**一张表**，不是一族条目。
 * `key set/get/list/remove` 默认作用在它上面；面板也据此切换成表格布局。
 */
export function findKvSection(store, ref) {
  const all = (store?.sections || []).filter((s) => s.kv);
  if (ref) {
    const hit = findSection(store, ref);
    return hit || null;
  }
  return all[0] || null;
}

export function kvSections(store) {
  return (store?.sections || []).filter((s) => s.kv);
}
