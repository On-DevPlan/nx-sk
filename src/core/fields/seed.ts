// 首次运行的播种：字段样例栏目与示例条目。

import { newId } from '../ids.ts';
import type { StoreSection, StoreEntry } from '../store.ts';
import { DEMO_TPL, instantiateTemplate } from './templates.ts';

export { SOURCE_FIELD, SOURCE_GROUP, ensureSourceBuiltin } from './source-bag.ts';

/**
 * 首次运行（store 文件不存在）时播种的东西：**只有一个**「字段样例」栏目。
 *
 * 为什么不再播种求职 / 密钥 / 项目那一堆：那些是「某个具体场景」的栏目，
 * 用户的第一栏多半不是它们；而「这个工具能存什么」是每个新用户都要问的问题。
 * 把答案直接摆出来（每种字段一格、连示例数据一起），比让他们先建栏目再填一遍快得多。
 * 其它模板仍是模板——`section templates` 看得到，`section add --template` 随取随用。
 */
export function seedSections(at: string): StoreSection[] {
  // 覆盖项里必给 id（见 seedSections 调用点），模板字面量本身不带 id
  return [{ ...instantiateTemplate(DEMO_TPL.id, { id: DEMO_TPL.id, title: '字段样例', order: 10 })!, createdAt: at, updatedAt: at } as StoreSection];
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
  };
  return [{
    id: entryId,
    section: DEMO_TPL.id,
    title: values.name,
    tags: ['样例'],
    values,
    createdAt: at,
    updatedAt: at,
  }];
}
