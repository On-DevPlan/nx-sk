// 字段模板数据：`section add --template` 与面板「新建栏目」共用同一份字段/分组声明。

import type { FieldDef, FieldType } from '../../shared/fields/types.ts';
import type { SectionGroup } from '../store.ts';
import { ensureSourceBuiltin } from './source-bag.ts';

const f = (key: string, label: string, type: FieldType, group: string, extra: Record<string, unknown> = {}): FieldDef =>
  // 模板是数据：这里只做形状声明，类型在编译期收口（extra 的键随字段类型而变，不建议逐个枚举）
  ({ key, label, type, group, ...extra }) as unknown as FieldDef;

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

  // —— 附件资料（统一附件库；值 = 附件 id 的**列表**，一个字段可挂多个，直接在字段里上传或从附件库选） ——
  f('resumeFile', '简历附件', 'file', 'files', { kind: 'doc', hint: '简历 PDF/Word 原件；可传多个（不同版本/岗位），在本字段直接上传或从附件库选' }),
  f('avatar', '头像图片', 'file', 'files', { kind: 'image', hint: '证件照/头像图片原件；可传多张' }),
  f('transcript', '成绩单', 'file', 'files', { kind: 'doc', hint: '在校成绩单原件；可传多个学期' }),
  f('certificateScan', '证书扫描件', 'file', 'files', { kind: 'doc', fill: 'optional', hint: '获奖/资格证书扫描件；可传多份（不必填）' }),

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

// —— 部署配置（Docker / K8s）——
//
// 一个条目 = **一份可复用的配置文件**。设计目标不是"存文件"（附件就能存），
// 而是"下次能在别的项目里照着用"：所以除了正文，还要有「放哪」「哪些值要替换」
// 「什么场景用」。缺了后三项，正文就只是一段没有上下文的 YAML。
//
// 密钥分两层，各有各的位置：
//   - **模板层**（`content`）：正文会被复制进别人的项目（进 git），所以只写 `${VAR}` 占位。
//   - **场景层**（`creds` 凭据清单）：这个场景**自己的**账号/密码/令牌，密文落盘。
//     agent 要出配置文件时从这里取真值直接渲染 —— 不必再绕回「密钥」栏目。
const DEPLOY_FIELDS = [
  f('name', '资源名', 'text', 'main', { hint: '一眼能看出是什么，如「node-web 多阶段 Dockerfile」' }),
  f('kind', '资源类型', 'select', 'main', {
    options: [
      'Dockerfile', 'docker-compose', 'dockerignore',
      'k8s-deployment', 'k8s-service', 'k8s-ingress', 'k8s-configmap', 'k8s-secret', 'k8s-kustomization',
      'helm', '其他',
    ],
  }),
  f('stack', '适用技术栈', 'text', 'main', { fill: 'optional', hint: 'node / go / python / 任意' }),
  f('path', '建议落盘路径', 'text', 'main', { fill: 'optional', hint: '如 deploy/Dockerfile、deploy/k8s/base/deployment.yaml' }),
  f('tags', '标签', 'tags', 'main', { fill: 'optional', hint: '如 prod、多阶段、健康检查、SSE' }),
  f('content', '文件正文', 'textarea', 'body', {
    hint: '整份文件原文。**模板**里的密钥写 ${VAR} 占位（这份正文会进 git）；真值写进下面的「凭据清单」',
  }),
  f('vars', '需替换的变量', 'textarea', 'body', {
    fill: 'optional',
    hint: '每行一个「变量 = 说明」。复用前先替换这些，别指望正文里的值直接能用',
  }),
  f('creds', '凭据清单', 'entrylist', 'cred', {
    hint: '这个场景自己的账号 / 密码 / 令牌 —— 直接写这里，密码与令牌列**密文落盘**。出配置文件时从这里取真值',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'user', label: '账号' },
      { key: 'pass', label: '密码', sensitive: true },
      { key: 'token', label: '令牌', sensitive: true },
      { key: 'note', label: '备注' },
    ],
  }),
  f('usage', '何时用 / 关键取舍', 'textarea', 'use', {
    fill: 'optional',
    hint: '为什么这么写、坑在哪（例如 ingress 关 buffering 才能保住 SSE）',
  }),
  f('sop', '操作步骤（图文）', 'md', 'use', {
    fill: 'optional',
    hint: '截屏 + 说明混排：直接 Ctrl+V 粘图，图片会统一列在下方，点开可放大看细节',
  }),
  f('files', '原件附件', 'file', 'use', { fill: 'optional', hint: '要连真实文件一起留档时挂这里（可选）' }),
];

// —— 容器平台模板：一个平台（KubeSphere / Rancher / 自建 k8s…）一个条目 ——
// 链接、账号、密码、镜像统一落一个条目，配合 `entry keys` 台账做跨栏目统一列表。
// 密码用 secret 类型（密文落盘）；链接/账号是关键定位信息，进 key 台账。
const PLATFORM_FIELDS = [
  f('platformName', '平台名称', 'text', 'basic', { hint: '如 川农容器平台(KubeSphere)' }),
  f('provider', '提供方', 'text', 'basic', { fill: 'optional', hint: '学校/厂商/自建' }),
  f('env', '环境', 'select', 'basic', { options: ['生产', '测试', '开发', '其他'] }),
  f('consoleUrl', '控制台链接', 'text', 'access', { hint: '平台入口 URL，点击即达' }),
  f('account', '账号', 'text', 'access'),
  f('password', '密码', 'secret', 'access', { hint: '密文落盘，读出默认原文' }),
  f('projectNamespace', '项目 / 命名空间', 'text', 'deploy', { fill: 'optional' }),
  f('registry', '镜像仓库地址', 'text', 'deploy', { fill: 'optional', hint: 'registry 或 仓库/项目 前缀' }),
  f('image', '镜像名', 'text', 'deploy', { fill: 'optional', hint: '如 repo/app:1.2.0（不带仓库前缀时看 registry）' }),
  f('deployYaml', '部署清单附件', 'file', 'deploy', { fill: 'optional', hint: 'Deployment/Service YAML 等原件' }),
  f('ingressUrl', '应用入口链接', 'text', 'network', { fill: 'optional', hint: '部署后对外访问的 URL' }),
  f('note', '备注', 'textarea', 'extra', { fill: 'optional' }),
];

// —— 毕业论文（信息工程学院 2022 版规范 · 设计开发类）——
//
// 这个栏目不是「写论文」，是**把格式规范变成可查的字段**：每条硬指标都在这里有一条，
// 写的时候开着面板对照，交稿前跑一遍「交稿自检」。
// 之所以按字段而不是按条目拆：规范是一份整体，拆成条目反而要在几十条里翻。
//
// 字段值 = 规范原文的硬指标（cm / pt / 字），不是「待办」。改规范时改模板再 section sync。
const THESIS_GROUPS = [
  { id: 'meta', title: '论文档案' },
  { id: 'format', title: '页面与字体（硬指标）' },
  { id: 'structure', title: '结构与字数' },
  { id: 'figures', title: '图表规范' },
  { id: 'code', title: '代码与算法' },
  { id: 'refs', title: '参考文献' },
  { id: 'submit', title: '打印、装订与时间' },
  { id: 'check', title: '交稿自检' },
  { id: 'attach', title: '附件' },
];

const THESIS_FIELDS = [
  // —— 论文档案：封面与标题页要用的信息 ——
  f('thesisTitle', '论文题目', 'text', 'meta', { hint: '原则上不超过 20 字；超了加副标题，别硬塞' }),
  f('thesisTitleEn', '英文题目', 'text', 'meta', { hint: '与中文对应；实词首字母大写，介词除外' }),
  f('thesisType', '论文类型', 'select', 'meta', { options: ['设计开发类', '管理类', '算法理论类'] }),
  f('college', '学院', 'text', 'meta'),
  f('major', '专业', 'text', 'meta'),
  f('studentName', '姓名', 'text', 'meta'),
  f('studentId', '学号', 'text', 'meta'),
  f('cohort', '年级', 'text', 'meta', { hint: '如 2023 级' }),
  f('graduationYear', '毕业年份', 'text', 'meta', { hint: '封面「（20XX届）」填这个，不是入学年份' }),
  f('advisor', '导师', 'text', 'meta'),
  f('advisorTitle', '职称', 'text', 'meta'),
  f('selectionType', '选题类型', 'text', 'meta', { fill: 'optional', hint: '基础型 / 应用基础型 / 应用型 / 调研型' }),
  f('topicSource', '课题来源', 'text', 'meta', { fill: 'optional', hint: '国家级 / 省部级 / 横向合作 / 校级 / 自选' }),
  f('finishDate', '完成日期', 'date', 'meta', { hint: '应晚于答辩委员会日期' }),

  // —— 页面与字体：全篇最容易扣分的部分 ——
  f('pageSetup', '页面设置', 'text', 'format', { hint: 'A4；上 2.5cm、下 2cm、左 2.5cm、右 2cm；单面打印' }),
  f('lineRule', '行距与字距', 'text', 'format', { hint: '1.5 倍行距；段前段后 0；标准字距' }),
  f('bodyFont', '正文字体', 'text', 'format', { hint: '中文宋体小四（12pt）；西文与数字 Times New Roman 小四' }),
  f('titleFont', '论文题目字体', 'text', 'format', { hint: '黑体三号（16pt），居中' }),
  f('h1Font', '一级标题', 'text', 'format', { hint: '黑体四号（14pt）不加粗；顶格；序号后空一格' }),
  f('h2Font', '二级标题', 'text', 'format', { hint: '黑体小四（12pt）不加粗；顶格' }),
  f('h3Font', '三级标题', 'text', 'format', { hint: '宋体小四（12pt）不加粗；顶格' }),
  f('h4Rule', '四级标题', 'text', 'format', { hint: '不单独占行：用（1）（2）接排，按正文格式，首行缩进 2 字符' }),
  f('paraIndent', '正文缩进', 'text', 'format', { hint: '首行缩进 2 字符' }),
  f('numberRule', '标题编号', 'text', 'format', { hint: '1 / 1.1 / 1.1.1，半角点号；原则上不超过 4 级；标题末尾不加标点' }),
  f('headerRule', '页眉', 'text', 'format', { hint: '一律不加页眉；页眉处不得有横线' }),
  f('pageNumRule', '页码', 'text', 'format', { hint: '页脚底端 1.5cm、居中、小五 Times New Roman；封面与目录不编页码，标题页起为 1' }),

  // —— 结构：正文该有哪几章、每部分写什么 ——
  f('frontMatter', '前置部分', 'textarea', 'structure', { hint: '内页封面 → 目录（只到三级）→ 标题页（中英文题目、作者、摘要、关键词）' }),
  f('chapterPlan', '正文章节', 'textarea', 'structure', { hint: '设计开发类：背景 → 相关技术 → 需求与总体设计 → 重点模块实现 → 测试 → 结论' }),
  f('bodyOutline', '各章要写什么', 'textarea', 'structure', { hint: '评审看的是「做了什么、怎么做、凭什么说做成了」' }),
  f('abstractRule', '中文摘要', 'text', 'structure', { hint: '250–300 字，不分段，按【目的】【方法】【结果】【结论】组织；无公式图表、不标引用' }),
  f('keywordsRule', '关键词', 'text', 'structure', { hint: '3–5 个；分号分隔；按外延由大到小' }),
  f('englishRule', '英文摘要', 'text', 'structure', { hint: '题目/作者/摘要/关键词与中文一一对应' }),
  f('wordRule', '字数与页数', 'text', 'structure', { hint: '一般不少于 8000 字，尽量 25 页以上' }),
  f('thanksRule', '致谢', 'text', 'structure', { hint: '另起一页；「致谢」黑体四号居中；内容按正文格式，200 字以上' }),
  f('appendixRule', '附录', 'text', 'structure', { hint: '另起一页；格式参照正文；原始数据、数据库表结构、大段代码放这里' }),

  // —— 图表：三线表与图题位置是最常见的扣分点 ——
  f('figureRule', '图', 'textarea', 'figures', { hint: '图题在图下方；「图1 名称」；黑体五号；居中' }),
  f('tableRule', '表', 'textarea', 'figures', { hint: '表题在表上方；「表1 名称」；黑体五号；表内五号' }),
  f('threeLineRule', '三线表', 'text', 'figures', { hint: '无左右边线；上下底 1.5 磅粗实线，表头下 1 磅细实线' }),
  f('chartSpacing', '图表间距', 'text', 'figures', { hint: '图、表与正文上下各空一行；表格尽量不跨页' }),
  f('chartNumber', '图表编号', 'text', 'figures', { hint: '全文连续编号；不要写成 图1-1 / 图1.1' }),
  f('tableNote', '表注', 'text', 'figures', { fill: 'optional', hint: '写在表底线下方左侧，宋体小五' }),

  // —— 代码：设计开发类的重灾区 ——
  f('codeRule', '代码取舍', 'textarea', 'code', { hint: '不出自动生成的代码；正文代码不超过 3/4 页；只留核心、难以言表的部分' }),
  f('codeFormat', '代码排版', 'textarea', 'code', { hint: '按正文字体字号；缩进 2 或 4 空格；同级起止同列；行内注释对齐' }),
  f('codeExplain', '代码讲解', 'text', 'code', { hint: '以思想与流程为主，夹叙夹议；参数变量须有说明' }),

  // —— 参考文献：数量、格式、标注三件事 ——
  f('refCount', '数量与时效', 'text', 'refs', { hint: '≥15 篇，其中外文 ≥2 篇；以近 5 年期刊为主；必须亲自读过' }),
  f('refStyle', '著录标准', 'text', 'refs', { hint: 'GB/T 7714-2015，顺序编码制' }),
  f('citeRule', '正文标注', 'text', 'refs', { hint: '引用处右上角上标 [X]；按出现先后编号；同一文献只用一个编号' }),
  f('refFormat', '参考文献表', 'text', 'refs', { hint: '小四，1.5 倍行距，悬挂缩进 2 字符；标点半角、后空一格；每条以实心点结束' }),
  f('refSample', '著录示例', 'textarea', 'refs', { hint: '期刊 [J] / 专著 [M] / 学位论文 [D] / 会议 [C] / 标准 [S] / 电子资源 [EB/OL]' }),

  // —— 提交：打印装订与日期红线 ——
  f('printRule', '打印与装订', 'text', 'submit', { hint: 'A4 单面打印；左侧装订；统一发放的硬皮封面' }),
  f('bindingOrder', '装订顺序', 'textarea', 'submit', { hint: '成绩评定表 → 导师评分表 → 答辩评分表 → 开题答辩记录 → 开题报告 → 改题申请表 → 新开题报告 → 封面/目录/正文' }),
  f('proposalRule', '开题报告', 'text', 'submit', { hint: '≥3500 字；文献 15 篇（外文 2 篇）；标题字号与论文不同：H1 黑体小四、H2 宋体小四' }),
  f('deadlineRule', '日期红线', 'textarea', 'submit', { hint: '导师意见签署日期须早于答辩日期；封面完成日期须晚于答辩委员会日期' }),

  // —— 自检：交稿前逐条打勾 ——
  f('checklist', '交稿自检清单', 'md', 'check', { hint: '每交一稿跑一遍；md 里用 - [ ] 勾选' }),

  // —— 附件：论文与相关材料 ——
  f('thesisDoc', '论文正文', 'file', 'attach', { fill: 'optional', hint: '当前版本的 docx/pdf' }),
  f('proposalDoc', '开题报告', 'file', 'attach', { fill: 'optional' }),
  f('templateDoc', '格式模板', 'file', 'attach', { fill: 'optional', hint: 'assets/sk-thesis/templates/ 下的模板' }),
  f('specDoc', '规范原文（本类）', 'file', 'attach', { fill: 'optional', hint: '设计开发类那份（带批注）' }),
  f('specDocFull', '规范全文', 'file', 'attach', { fill: 'optional', hint: '含管理类 / 设计开发类 / 算法理论类的完整版' }),
  f('coverScan', '封面与签字页', 'file', 'attach', { fill: 'optional', hint: '导师签字、答辩记录等扫描件' }),
];

const PLATFORM_GROUPS = [
  { id: 'basic', title: '基本信息' },
  { id: 'access', title: '访问凭据' },
  { id: 'deploy', title: '镜像与部署' },
  { id: 'network', title: '网络入口' },
  { id: 'extra', title: '其他' },
];

// —— 字段样例（demo）：播种用的**唯一**栏目 ——
//
// 为什么单独做一个：新用户第一个问题不是「帮我建一个求职栏目」，而是
// 「这个工具到底能存什么、能算到哪」。把答案直接摆出来——每种字段类型一格、
// 连示例数据一起给——比让他们先建栏目再自己填一遍快得多。
// 其它模板（job / secret / projects…）仍是模板，`section add --template` 随取随用，
// 只是**不再播种**：第一屏是说明书，不是别人的表格。
const DEMO_TABLE_COLUMNS = [
  { key: 'item', label: '事项', type: 'text' },
  { key: 'state', label: '状态', type: 'select', options: ['未开始', '进行中', '已完成'], default: '未开始' },
  { key: 'done', label: '已办', type: 'bool' },
  { key: 'hours', label: '工时', type: 'number' },
  { key: 'rate', label: '单价', type: 'number', total: 'avg' },
  { key: 'cost', label: '费用', formula: 'hours * rate', unit: '元' },
];

const DEMO_FIELDS = [
  // —— 基本字段（每个都是标量）——
  f('name', '名称', 'text', 'basic', { hint: '单行文本：所有字段的地基。这个字段被设为「条目名」，列表里显示的就是它' }),
  f('desc', '描述', 'textarea', 'basic', { hint: '多行文本：换行原样保留' }),
  f('count', '数量', 'number', 'basic', { hint: '数字。写「1,200」这种带千分位的也认' }),
  f('ok', '完成', 'bool', 'basic', { hint: '是 / 否 勾选框' }),
  f('state', '状态', 'select', 'basic', { options: ['未开始', '进行中', '已完成'], hint: '下拉框：值必须在候选里，写错会被拦下而不是悄悄存进去' }),
  f('day', '日期', 'date', 'basic', { hint: '日期，形如 2026-10-30' }),
  f('month', '月份', 'month', 'basic', { hint: '月份，形如 2026-10' }),
  f('tags', '标签', 'tags', 'basic', { hint: '多值标签：顿号或逗号分隔' }),

  // —— 组合字段（值有自己的形状）——
  f('accounts', '凭据清单', 'entrylist', 'combo', {
    hint: '结构清单：变长的行，一列一列填。密码列与顶层敏感字段同一条边界（密文落盘、--mask 打码）。示例行只是形状，密码自己填',
    fields: [
      { key: 'name', label: '名称' },
      { key: 'user', label: '账号' },
      { key: 'pass', label: '密码', sensitive: true },
    ],
  }),
  f('sheet', '样例表格', 'table', 'combo', {
    hint: '表格：列定义就在**这条数据里**（不在栏目字典），面板「列设置」可以直接加列。'
      + '「费用」是计算列（公式 hours * rate，不落盘、读时现算）；表尾自动合计——数字求和、勾选计是',
    columns: DEMO_TABLE_COLUMNS,
    totals: [
      { label: '合计', agg: { hours: 'sum', cost: 'sum', done: 'countTrue' } },
      { label: '完成率', expr: 'pct(countTrue(col("done")), n)', unit: '%' },
    ],
  }),

  // —— 富内容 ——
  f('note', '图文笔记', 'md', 'rich', { hint: 'markdown 正文：标题 / 列表 / 代码块都能渲染；直接 Ctrl+V 贴截图（自动进附件库）；待办勾选就是改正文本身' }),
  f('keys', '快捷键', 'shortcut', 'rich', { hint: '快捷键：按组整理（组 → 条目 → 按键）。折叠条只报组数/条数，点「详细」打开键位面板；录入时直接按组合键，键位图会点亮' }),
  f('docs', '附件', 'file', 'rich', { kind: 'doc', hint: '附件字段：值是附件 id 的列表（不是路径）。在这里直接上传，或从附件库选' }),
  f('apikey', '密钥', 'secret', 'rich', { hint: '密文字段：值以 AES-256-GCM 落盘，读出来默认原文，--mask 才打码' }),
  // —— 引用型（值 = 内部资源定位符）——
  f('refs', '资源引用', 'debug', 'combo', {
    fill: 'optional',
    hint: '引用型字段：值 = 内部资源定位符（nx-sk://栏目|条目|字段|附件）。面板里每个格子悬浮即可预览被引用内容；'
      + '检索用 nx-sk resource search --q <关键字>，看内容用 nx-sk resource resolve <定位符>',
  }),
];

const DEMO_GROUPS = [
  { id: 'basic', title: '基本字段（标量）' },
  { id: 'combo', title: '组合字段（值有形状）' },
  { id: 'rich', title: '富内容' },
];

/** 字段模板（数据）：`section add --template` 与面板「新建栏目」共用同一份声明。 */
export interface FieldTemplateDef {
  id: string;
  label: string;
  description: string;
  titleLabel: string;
  groups: SectionGroup[];
  fields: FieldDef[];
  titleField: string | null;
  kv?: boolean;
}

export const DEMO_TPL: FieldTemplateDef = {
  id: 'demo',
  label: '字段样例 / 能力边界',
  description:
    '每种字段类型各来一份，连示例数据一起给：单行文本到表格、公式与统计。'
    + '看完（或直接改）就知道 nx-sk 能存什么、算到哪一步。看完可以整栏删掉。',
  titleField: 'name',
  titleLabel: '条目名',
  groups: DEMO_GROUPS,
  fields: DEMO_FIELDS,
};

const TEMPLATES: Record<string, FieldTemplateDef> = {
  demo: DEMO_TPL,
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
      { id: 'files', title: '附件资料' },
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
  deploy: {
    id: 'deploy',
    label: '部署配置（Docker / K8s）',
    description:
      '一份配置文件一个条目：正文即文件原文，配「放哪」「哪些值要替换」「什么场景用」，' +
      '好让它在别的项目里能照着用。这个场景自己的账号密码写在条目自己的「凭据清单」里（密文落盘）。',
    titleField: 'name',
    titleLabel: '资源名',
    groups: [
      { id: 'main', title: '基本信息' },
      { id: 'body', title: '文件内容' },
      { id: 'cred', title: '凭据' },
      { id: 'use', title: '使用说明' },
    ],
    fields: DEPLOY_FIELDS,
  },
  platform: {
    id: 'platform',
    label: '容器平台（链接/账号/密码/镜像）',
    description: '一个平台一个条目：控制台链接、账号密码（密文）、镜像与命名空间。配合 `nx-sk entry keys` 台账做跨平台统一列表。',
    titleField: 'platformName',
    titleLabel: '平台名',
    groups: PLATFORM_GROUPS,
    fields: PLATFORM_FIELDS,
  },
  thesis: {
    id: 'thesis',
    label: '毕业论文',
    description:
      '按信息工程学院 2022 版规范（设计开发类）整理的论文档案：页面 / 字体 / 图表 / 参考文献等'
      + '硬指标逐条可查，另带交稿自检清单。模板 docx 见 assets/sk-thesis/。',
    titleField: 'thesisTitle',
    titleLabel: '论文题目',
    groups: THESIS_GROUPS,
    fields: THESIS_FIELDS,
  },
};

export function templateIds(): string[] {
  return Object.keys(TEMPLATES);
}

export function getTemplate(id: unknown): FieldTemplateDef | null {
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
/** instantiateTemplate 的覆盖项。 */
interface TemplateOverrides {
  id?: string;
  title?: string;
  description?: string;
  order?: unknown;
  titleField?: string;
  titleLabel?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function instantiateTemplate(templateId: unknown, overrides: TemplateOverrides = {}) {
  const t = getTemplate(templateId);
  if (!t) return null;
  const baseGroups = t.groups.map((g) => ({ ...g }));
  const baseFields = t.fields.map((x) => ({ ...x }));
  // 每个非 KV 栏目都自带「原始资料」袋（规则只此一份，见 ensureSourceBuiltin）
  const { groups, fields } = ensureSourceBuiltin(baseGroups, baseFields, { kv: t.kv });
  return {
    id: overrides.id,
    title: overrides.title || t.label,
    description: overrides.description || t.description,
    order: Number.isFinite(overrides.order) ? (overrides.order as number) : 50,
    template: t.id,
    kv: t.kv === true,
    titleField: overrides.titleField || t.titleField,
    titleLabel: overrides.titleLabel || t.titleLabel,
    groups,
    fields,
    createdAt: overrides.createdAt || null,
    updatedAt: overrides.updatedAt || null,
  };
}
