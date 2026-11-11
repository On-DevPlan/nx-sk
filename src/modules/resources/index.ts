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
        scope: { type: 'string', enum: ['debug'], hint: 'debug 引用面板口径：只出条目/条目-字段/附件（结构类命中不出现）' },
      },
      run: (ctx: { q?: string; kind?: string; section?: string; scope?: string } = {}) => service.searchResources(ctx),
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
    {
      id: 'resource.resolveBatch',
      cli: ['resource', 'resolve-batch'],
      http: ['POST', '/api/resources/resolve-batch'],
      // 批量入参（locator 串可以很长）塞不进 query，走 POST；语义仍是只读。
      readOnly: true,
      summary: '批量解析定位符（面板内联数据板一次取回全部实时值）：每项 {locator, ok, info|error}，坏链不抛；值一律打码口径（无 --reveal）',
      flags: { refs: { type: 'json', hint: 'locator 数组（JSON，如 --refs \'["nx-sk://entry/e_1"]\'）' } },
      run: (ctx: { refs?: unknown } = {}) => service.resolveBatch(ctx),
      render: (d: Awaited<ReturnType<typeof service.resolveBatch>>) => {
        if (!d.count) return '没有可解析的引用（refs 为空）';
        const lines: string[] = [`批量解析：${d.count} 项`];
        for (const x of d.items) {
          lines.push('', x.ok && x.info ? service.renderResourceResolve(x.info) : `${x.locator}\n  × ${x.error}`);
        }
        return lines.join('\n');
      },
    },
  ],
};
