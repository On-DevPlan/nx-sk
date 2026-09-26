import * as service from './service.js';

export default {
  id: 'entries',
  title: '条目',
  order: 600,
  // 有视图，但**不是独立 tab**——它由「栏目」动态挂载（每个栏目一个 tab，共用这个视图）
  view: () => import('./view.jsx'),
  tab: false,
  // 一组同级实体，每条有标识，用户会想改其中一条或删其中一条 → 集合资源
  resource: 'entry',
  actions: [
    {
      id: 'entry.list',
      cli: ['entry', 'list'],
      http: ['GET', '/api/entries'],
      summary: '列条目（可按栏目过滤、按关键字搜索）；返回完整度与未填清单',
      flags: {
        // 读命令的过滤 flag 不带 default：「不传」代表「全部栏目」
        section: { type: 'string', hint: '栏目 id 或标题' },
        q: { type: 'string', hint: '关键字' },
      },
      run: (ctx) => service.listEntries(ctx),
      render: (d) => service.renderEntryList(d),
    },
    {
      id: 'entry.fields',
      cli: ['entry', 'fields'],
      http: ['GET', '/api/entries/fields'],
      summary: '已知字段的台账：模板给的建议字段 + 你实际写过的字段（写入不受它限制，没见过的键会自动登记）',
      flags: { section: { type: 'string' } },
      run: (ctx) => service.fieldDictionary(ctx),
      render: (d) => service.renderFields(d),
    },
    {
      id: 'entry.get',
      cli: ['entry', 'get'],
      http: ['GET', '/api/entries/:ref'],
      summary: '读单条（id 或条目名都接受）；密文字段默认原文，--mask 才打码',
      args: ['ref'],
      flags: {
        mask: { type: 'boolean', hint: '密文字段打码显示（投屏/截图时用）' },
        section: { type: 'string', hint: '限定栏目，解决同名歧义' },
      },
      run: (ctx) => service.getEntry(ctx.ref, ctx),
      render: (d) => service.renderEntryGet(d),
    },
    {
      id: 'entry.add',
      cli: ['entry', 'add'],
      http: ['POST', '/api/entries'],
      summary: '新增条目。同栏目同名报 CONFLICT（不静默 upsert）；字段值用 --set 字段=值 或 --data @file.json，没见过的键会自动登记',
      flags: {
        section: { type: 'string', required: true, hint: '栏目 id 或标题' },
        title: { type: 'string', hint: '条目名，缺省取栏目的名称字段' },
        set: { type: 'kv', hint: '字段=值，可重复；键可用 key 或中文标签' },
        data: { type: 'json', hint: '整份 JSON，或 @文件路径' },
        tags: { type: 'array' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.addEntry(ctx),
      render: (d) => service.renderEntryChange(d),
    },
    {
      id: 'entry.update',
      cli: ['entry', 'update'],
      http: ['PATCH', '/api/entries/:ref'],
      summary: '改条目（PATCH 语义：只改传入字段）。字典里没有的字段会自动登记，直接写就行',
      args: ['ref'],
      flags: {
        set: { type: 'kv', hint: '字段=值，可重复；键可以用 key 或中文标签，没见过的键会自动登记' },
        data: { type: 'json', hint: '整份 JSON，或 @文件路径' },
        unset: { type: 'array', hint: '要清空的字段 key，逗号分隔' },
        title: { type: 'string' },
        tags: { type: 'array' },
        section: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.updateEntry(ctx.ref, ctx),
      render: (d) => service.renderEntryChange(d),
    },
    {
      id: 'entry.remove',
      cli: ['entry', 'remove'],
      http: ['DELETE', '/api/entries/:ref'],
      summary: '删条目。目标不存在报 NOT_FOUND（不静默成功）。写前自动留快照',
      args: ['ref'],
      flags: {
        section: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.removeEntry(ctx.ref, ctx),
      render: (d) => service.renderEntryChange(d),
    },

    // —— 密钥 KV 直通命令 ——
    // 作用在**标了 kv 的栏目**（密钥模板自带 kv: true）上，可以用 --section 指定别的。
    // 它们是同一套 service 函数的语法糖，不是第二份业务逻辑。
    {
      id: 'key.list',
      cli: ['key', 'list'],
      http: ['GET', '/api/keys'],
      summary: '列出全部密钥（值默认原文，要打码加 --mask）',
      flags: {
        mask: { type: 'boolean' },
        section: { type: 'string', hint: '指定 KV 栏目，缺省用标了 kv 的那个' },
      },
      run: (ctx) => service.keyList(ctx),
      render: (d) => service.renderKeyList(d),
    },
    {
      id: 'key.get',
      cli: ['key', 'get'],
      http: ['GET', '/api/keys/:name'],
      summary: '取一个密钥的值（默认原文；投屏/截图时加 --mask 打码）',
      args: ['name'],
      flags: {
        mask: { type: 'boolean' },
        section: { type: 'string' },
      },
      run: (ctx) => service.keyGet(ctx.name, ctx),
      render: (d) => service.renderKeyGet(d),
    },
    {
      id: 'key.set',
      cli: ['key', 'set'],
      http: ['PUT', '/api/keys/:name'],
      summary: '写入密钥：不存在则新建，存在则覆盖（KV 的 SET 语义，返回值里带 created）。值以密文落盘',
      args: ['name', 'value'],
      flags: {
        value: { type: 'string', hint: '值的另一种给法（值以 - 开头时用 --value=<值>）' },
        // 多行值经命令行会被 Windows 启动器 shim 截断成首行且不报错（见 ref 20-secrets），
        // 文件与 stdin 是可靠通道。取 value 键；没有则取对象里唯一那个键。
        data: { type: 'string', hint: '@文件.json（含 value 键），或 -（从 stdin 读原文）' },
        section: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.keySet(ctx.name, ctx.value, ctx),
      render: (d) => service.renderKeySet(d),
    },
    {
      id: 'key.remove',
      cli: ['key', 'remove'],
      http: ['DELETE', '/api/keys/:name'],
      summary: '删一个密钥。目标不存在报 NOT_FOUND；写前自动留快照',
      args: ['name'],
      flags: {
        section: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx) => service.keyRemove(ctx.name, ctx),
      render: (d) => service.renderKeyRemove(d),
    },
  ],
};
