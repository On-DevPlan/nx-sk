import * as service from './service.ts';

const json = (d: unknown) => JSON.stringify(d, null, 2);

export default {
  id: 'tree',
  title: '目录',
  order: 610,
  actions: [
    {
      id: 'entry.tree',
      cli: ['entry', 'tree'],
      http: ['GET', '/api/tree'],
      summary: '左侧目录树（条目父子关系；有子条目就是文件夹）。扁平节点列表，按 parent/sort 深度优先',
      flags: {
        parent: { type: 'string', hint: '只看某个父条目的子树（root = 根）' },
        depth: { type: 'number', hint: '最多下钻几层（缺省全部）' },
      },
      run: (ctx: { parent?: string; depth?: number } = {}) => service.treeView(ctx),
      render: (d: unknown) => json(d),
    },
    {
      id: 'entry.context',
      cli: ['entry', 'context'],
      http: ['GET', '/api/entries/:ref/context'],
      summary: '一条条目的树上下文：祖先链 + 直接子条目（agent 读层级关系用；省略 ref = 默认条目）',
      args: [{ name: 'ref', required: false }],
      flags: { template: { type: 'string' } },
      run: (ctx: { ref?: string; template?: string } = {}) => service.entryContext(ctx.ref, ctx),
      render: (d: unknown) => json(d),
    },
    {
      id: 'entry.move',
      cli: ['entry', 'move'],
      http: ['POST', '/api/entries/:ref/move'],
      summary: '移动条目：--parent 目标父条目（root = 根）；拒绝成环。--before / --after 指定插到哪个兄弟前/后（拖拽落点），否则移到末尾或 --sort 指定序号',
      args: ['ref'],
      flags: {
        parent: { type: 'string', hint: '目标父条目 id（root / 空 = 根）' },
        sort: { type: 'number', hint: '在兄弟节点中的顺序（缺省末尾）' },
        before: { type: 'string', hint: '插到这个兄弟的前面（与 --after 二选一）' },
        after: { type: 'string', hint: '插到这个兄弟的后面（与 --before 二选一）' },
        template: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { ref?: string; parent?: string; sort?: number; before?: string; after?: string; template?: string; 'dry-run'?: boolean } = {}) => service.moveEntry(ctx.ref, ctx),
      render: (d: unknown) => json(d),
    },
    {
      id: 'entry.move-many',
      cli: ['entry', 'move-many'],
      http: ['POST', '/api/entries/move-many'],
      summary: '批量移动条目到同一父级（多选拖拽）。ids 逗号分隔；拒绝成环',
      args: ['ids'],
      flags: { parent: { type: 'string' }, template: { type: 'string' }, 'dry-run': { type: 'boolean' } },
      run: (ctx: { ids?: unknown; parent?: string; template?: string; 'dry-run'?: boolean } = {}) => service.moveMany(ctx.ids, ctx),
      render: (d: unknown) => json(d),
    },
  ],
};
