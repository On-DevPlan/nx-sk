// 首次运行的播种：字段样例条目模板与示例条目。

import { newId } from '../ids.ts';
import type { StoreTemplate, StoreEntry } from '../store.ts';
import { DEMO_TPL, instantiateTemplate } from './templates.ts';

export { SOURCE_FIELD, SOURCE_GROUP, SOURCE_GROUP_KEY, ensureSourceBuiltin } from './source-bag.ts';

/**
 * 首次运行（store 文件不存在）时播种的东西：**只有一个**「字段样例」条目模板。
 *
 * 为什么不再播种求职 / 密钥 / 项目那一堆：那些是「某个具体场景」的条目模板，
 * 用户的第一栏多半不是它们；而「这个工具能存什么」是每个新用户都要问的问题。
 * 把答案直接摆出来（每种字段一格、连示例数据一起），比让他们先建条目模板再填一遍快得多。
 * 其它模板仍是模板——`template presets` 看得到，`template add --preset` 随取随用。
 */
/** 空白模板是内置底座，时间戳固定——它在任何库里都该是同一行，不能让归一化结果随时钟漂。 */
export const BLANK_TEMPLATE_AT = '1970-01-01T00:00:00.000Z';

export function blankTemplate(_at?: string): StoreTemplate {
  return {
    id: '__blank__', title: '无模板', description: '', order: -1, template: 'blank',
    blank: true, titleField: null, titleLabel: '名称', tags: [], fields: [],
    layout: null, createdAt: BLANK_TEMPLATE_AT, updatedAt: BLANK_TEMPLATE_AT,
  };
}

export function seedTemplates(at: string): StoreTemplate[] {
  // 覆盖项里必给 id（见 seedTemplates 调用点），模板字面量本身不带 id
  return [{ ...instantiateTemplate(DEMO_TPL.id, { id: DEMO_TPL.id, title: '字段样例', order: 10 })!, tags: [DEMO_TPL.id, '字段样例'], createdAt: at, updatedAt: at } as StoreTemplate];
}

/**
 * 播种的那条**示例条目**：每种字段都有内容可看（附件与密文除外——
 * 附件要有真实文件、密文要有密钥，这两样播种时给不了，留空并在 hint 里说明）。
 *
 * 注意：播种直接写 store，不走写入校验——所以这里的形状必须与
 * `normalizeSpec` / `serializeEntry` 认的一致（表格给行数组，列取字段定义里的）。
 */
export function seedEntries(at: string): StoreEntry[] {
  const entryId = newId('e');
  const values = {
    name: '示例条目',
    desc: '这是一条示例条目：左（或上）边选中的就是它。直接改任何一格，保存后就成了你自己的数据。',
    count: 3,
    ok: true,
    state: '进行中',
    day: String(at).slice(0, 10),
    month: String(at).slice(0, 7),
    tags: ['样例', '能力边界'],
    accounts: [{ name: '示例：主控台', user: 'ops@example.com' }],
    sheet: [
      { item: '设计', state: '已完成', done: true, hours: 2, rate: 200 },
      { item: '开发', state: '进行中', done: false, hours: 5, rate: 200 },
    ],
    note: [
      '# 图文字段',
      '',
      '- 支持 **markdown**：标题、列表、`行内代码`、表格都能渲染',
      '- 裸网址会变成可点链接：https://github.com/ZHLX2005/nx-sk',
      '- [ ] 截图直接 Ctrl+V 粘进来（自动进附件库，正文里插入引用）',
      '- [ ] 勾选待办就是改正文本身，没有第二份勾选状态',
    ].join('\n'),
    keys: [
      {
        id: 'g1',
        name: '全局',
        shortcuts: [
          {
            id: 's1-1',
            combo: [{ code: 'ControlLeft', label: 'Ctrl', isModifier: true }, { code: 'KeyK', label: 'K' }],
            description: '打开命令面板',
          },
          {
            id: 's1-2',
            combo: [
              { code: 'ControlLeft', label: 'Ctrl', isModifier: true },
              { code: 'ShiftLeft', label: 'Shift', isModifier: true },
              { code: 'KeyF', label: 'F' },
            ],
            description: '全库搜索',
            condition: '工作台',
          },
        ],
      },
      {
        id: 'g2',
        name: '列表',
        shortcuts: [
          { id: 's2-1', combo: [{ code: 'KeyJ', label: 'J' }], description: '下一条' },
          { id: 's2-2', combo: [{ code: 'KeyK', label: 'K' }], description: '上一条' },
          { id: 's2-3', combo: [{ code: 'Enter', label: 'Enter' }], description: '打开当前条目' },
        ],
      },
    ],
    // 资源引用（debug）：#21「结果至少是条目/条目-字段」——绑到**这条示例条目自身**
    // 与它的「名称」字段（数据位置，内联数据板解得出实时值；结构引用写入点会被拒）。
    refs: { v: 1, refs: [`nx-sk://entry/${entryId}`, `nx-sk://field/${entryId}/name`] },
    // 对齐确认（grill）：AI 写问题、用户逐条答；示例故意留一题未答，必答进度是 2/3。
    grill: {
      v: 1,
      schema: 'nx-sk/grill@1',
      title: '示例对齐单',
      intro: '这是我替你做的假设。保留、否定，或者在每条备注里写清理由；全部必答后才算确认。',
      prompt: '做一个能让我逐条确认、而不是只能回「可以」的对齐表单。',
      questions: [
        {
          id: 'shape',
          kind: 'single',
          title: '对齐单是独立工作流，还是服务里的测试组？',
          detail: '当前实现把它放在服务的流水线 Tab，没有独立名字。',
          required: true,
          options: [
            { value: 'inside', label: '留在服务里', detail: '配置仍由服务页管' },
            { value: 'workflow', label: '独立工作流', detail: '可命名、可复用', recommended: true },
          ],
          answer: 'inside',
          note: '先保留服务内，等第二个服务复用时再拆。',
        },
        {
          id: 'inputs',
          kind: 'multi',
          title: '哪些输入必须让用户填？',
          detail: '勾选你认为不能由 AI 替答的项。',
          required: true,
          options: [
            { value: 'assumption', label: '我替你做的假设' },
            { value: 'scope', label: '范围与不做的事' },
            { value: 'evidence', label: '验收证据' },
          ],
          answer: null,
          note: '',
        },
        {
          id: 'ack',
          kind: 'confirm',
          title: '确认后，agent 可以按这份 JSON 继续执行吗？',
          detail: '确认按钮会把 ack 写成 acknowledged；之后任何修改都会退回 pending。',
          required: true,
          options: [],
          answer: true,
          note: '',
        },
        {
          id: 'missing',
          kind: 'text',
          title: '还有什么我没问到、但必须一起确认的？',
          required: false,
          options: [],
          placeholder: '例如：日志保留多久、失败是否阻断、谁来验收……',
          answer: null,
          note: '',
        },
      ],
      freeform: '',
      ack: { status: 'pending' },
    },
  };
  return [{
    id: entryId,
    template: DEMO_TPL.id,
    title: values.name,
    desc: '示例条目：每种字段都填了一点，照着改就是你的数据',
    tags: ['样例'],
    values,
    createdAt: at,
    updatedAt: at,
  }];
}

