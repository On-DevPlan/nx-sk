import * as service from './service.ts';

export default {
  id: 'resources',
  title: '资源定位',
  order: 660,
  // 只读聚合出口：不是 CRUD 资源（检索/解析是「跨资源的链接性」，不是又一族实体）。
  actions: [
    {
      id: 'resource.search',
      cli: ['resource', 'search'],
      http: ['GET', '/api/resources/search'],
      summary: '跨全部内部资源搜（栏目/条目/字段/附件），每项返回 locator 与摘要——debug 引用字段与面板搜索的共用后端',
      flags: {
        q: { type: 'string', hint: '关键字（栏目/条目/字段/附件的名称类文本）' },
        kind: { type: 'string', enum: ['section', 'entry', 'field', 'file'], hint: '只看某一类' },
        section: { type: 'string', hint: '限定栏目（id 或标题）' },
      },
      run: (ctx: { q?: string; kind?: string; section?: string } = {}) => service.searchResources(ctx),
      render: (d: Parameters<typeof service.renderResourceSearch>[0]) => service.renderResourceSearch(d),
    },
    {
      id: 'resource.resolve',
      cli: ['resource', 'resolve'],
      http: ['GET', '/api/resources/resolve'],
      summary: '解析一个定位符（nx-sk://section|entry|field|file/…，兼容旧复合串 <栏目>:<key>）：返回指向资源的存在性与摘要；字段值默认打码，--reveal 出原文',
      args: ['loc'],
      flags: { reveal: { type: 'boolean', hint: '密文值解密出原文（默认打码）' } },
      run: (ctx: { loc?: string; reveal?: boolean } = {}) => service.resolveLocator(ctx.loc, ctx),
      render: (d: Parameters<typeof service.renderResourceResolve>[0]) => service.renderResourceResolve(d),
    },
  ],
};
