import * as service from './service.ts';
import { saveEntryAsTemplate } from '../../core/template-from-entry.ts';

const json = (d: unknown) => JSON.stringify(d, null, 2);

export default {
  id: 'entries',
  title: '条目',
  order: 600,
  // 一组同级实体，每条有标识，用户会想改其中一条或删其中一条 → 集合资源
  resource: 'entry',
  actions: [
    {
      id: 'entry.keys',
      cli: ['entry', 'keys'],
      http: ['GET', '/api/entries/keys'],
      summary: '关键 key 台账（跨条目模板聚合 链接/账号/密码/镜像 类字段；值默认打码，--reveal 看原文）',
      flags: {
        template: { type: 'string', hint: '限定条目模板（id 或标题）' },
        q: { type: 'string', hint: '关键字过滤（条目模板/条目/字段/值）' },
        reveal: { type: 'boolean', hint: '显示明文（密文字段会解密）' },
      },
      run: (ctx: { template?: string; q?: string; reveal?: boolean } = {}) => service.keysLedger(ctx),
      render: (d: Parameters<typeof service.renderKeysLedger>[0]) => service.renderKeysLedger(d),
    },
    {
      id: 'entry.list',
      cli: ['entry', 'list'],
      http: ['GET', '/api/entries'],
      summary: '列条目（可按条目模板过滤、按关键字搜索）；返回完整度与未填清单',
      flags: {
        // 读命令的过滤 flag 不带 default：「不传」代表「全部条目模板」
        template: { type: 'string', hint: '条目模板 id 或标题（按出身过滤）' },
        parent: { type: 'string', hint: '只看某个父条目的直接子条目（root = 根）' },
        q: { type: 'string', hint: '关键字' },
        tag: { type: 'array', hint: '按 tag 精确过滤，可重复；默认任一命中' },
        'tag-mode': { type: 'string', default: 'any', hint: 'any（默认）或 all' },
        'missing-desc': { type: 'boolean', hint: '只列还没写 desc（一句话说明）的条目' },
      },
      run: (ctx: { template?: string; parent?: string; q?: string; tag?: string[]; 'tag-mode'?: string; 'missing-desc'?: boolean } = {}) => service.listEntries(ctx),
      render: (d: Parameters<typeof service.renderEntryList>[0]) => service.renderEntryList(d),
    },
    {
      id: 'entry.search',
      cli: ['entry', 'search'],
      http: ['GET', '/api/entries/search'],
      summary: '轻量搜索条目：标题 / 模板标题 / tag / 字段标签 / 非敏感字段值，返回定位用 hit（id、模板、tag）',
      flags: {
        q: { type: 'string', hint: '关键字；不给 q 时按 tag/template/parent 过滤' },
        tag: { type: 'array', hint: '按 tag 精确过滤，可重复；多个 tag 默认任一命中' },
        'tag-mode': { type: 'string', default: 'any', hint: 'any（默认）或 all（多个 tag 全部命中）' },
        template: { type: 'string', hint: '条目模板 id 或标题' },
        parent: { type: 'string', hint: '父条目 id 或标题；root = 根' },
        limit: { type: 'number', default: 50, hint: '最多返回多少条（1–200，默认 50）' },
      },
      run: (ctx: { q?: string; tag?: string[]; 'tag-mode'?: string; template?: string; parent?: string; limit?: number } = {}) => service.searchEntries(ctx),
      render: (d: Parameters<typeof service.renderEntrySearch>[0]) => service.renderEntrySearch(d),
    },
    {
      id: 'entry.fields',
      cli: ['entry', 'fields'],
      http: ['GET', '/api/entries/fields'],
      summary: '已知字段的台账：条目模板给的建议字段 + 你实际写过的字段（写入不受它限制，没见过的键会自动登记）',
      flags: { template: { type: 'string' } },
      run: (ctx: { template?: string } = {}) => service.fieldDictionary(ctx),
      render: (d: Parameters<typeof service.renderFields>[0]) => service.renderFields(d),
    },
    {
      id: 'entry.get',
      cli: ['entry', 'get'],
      http: ['GET', '/api/entries/:ref'],
      summary: '读单条（id 或条目名都接受；省略 = 默认条目）；密文字段默认原文，--mask 才打码',
      args: [{ name: 'ref', required: false }],
      flags: {
        mask: { type: 'boolean', hint: '密文字段打码显示（投屏/截图时用）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
      },
      run: (ctx: { ref?: string; mask?: boolean; template?: string } = {}) => service.getEntry(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryGet>[0]) => service.renderEntryGet(d),
    },
    {
      id: 'entry.add',
      cli: ['entry', 'add'],
      http: ['POST', '/api/entries'],
      summary: '新增条目。条目是唯一内容节点：可给条目模板初始化字段，也可不给（空白模板）；同父级同名报 CONFLICT。字段值用 --set 字段=值 或 --data @file.json，没见过的键会自动登记',
      flags: {
        template: { type: 'string', hint: '条目模板 id 或标题（按它的字段结构初始化；缺省空白模板）' },
        parent: { type: 'string', hint: '父条目 id（建成它的子条目；缺省 = 根）' },
        title: { type: 'string', hint: '条目名，缺省取条目模板的名称字段' },
        desc: { type: 'string', hint: '一句话说明（给 agent / 人认条目用，不是字段）' },
        set: { type: 'kv', hint: '字段=值，可重复；键可用 key 或中文标签' },
        data: { type: 'json', hint: '整份 JSON，或 @文件路径' },
        tags: { type: 'array' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: Parameters<typeof service.addEntry>[0] = {}) => service.addEntry(ctx),
      render: (d: Parameters<typeof service.renderEntryChange>[0]) => service.renderEntryChange(d),
    },
    {
      id: 'entry.update',
      cli: ['entry', 'update'],
      http: ['PATCH', '/api/entries/:ref'],
      summary: '改条目（PATCH 语义：只改传入字段；省略 ref = 默认条目）。字典里没有的字段会自动登记，直接写就行',
      args: [{ name: 'ref', required: false }],
      flags: {
        set: { type: 'kv', hint: '字段=值，可重复；键可以用 key 或中文标签，没见过的键会自动登记' },
        data: { type: 'json', hint: '整份 JSON，或 @文件路径' },
        unset: { type: 'array', hint: '要清空的字段 key，逗号分隔' },
        title: { type: 'string' },
        desc: { type: 'string', hint: '一句话说明（空串 = 清空）' },
        tags: { type: 'array' },
        template: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: Parameters<typeof service.updateEntry>[1] = {}) => service.updateEntry(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryChange>[0]) => service.renderEntryChange(d),
    },
    {
      id: 'entry.add-field',
      cli: ['entry', 'add-field'],
      http: ['POST', '/api/entries/:ref/fields'],
      summary: '在条目内添加扩展字段（指定类型/分组；写时复制，不动条目模板字典）；--value 顺手给初值',
      args: [{ name: 'ref', required: false }],
      flags: {
        key: { type: 'string', required: true, hint: '字段 key（英文字母开头）' },
        label: { type: 'string', hint: '中文名（缺省同 key）' },
        type: { type: 'string', default: 'text', hint: '字段类型（nx-sk entry fields 可看清单）' },
        group: { type: 'string', hint: '放进哪个分组（条目模板分组 id；缺省首个分组）' },
        value: { type: 'string', hint: '初值（可留空；凭据样键落盘即密文）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; key?: unknown; label?: unknown; type?: unknown; group?: unknown;
        value?: unknown; template?: string; 'dry-run'?: boolean;
      } = {}) => service.addEntryField(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryAddField>[0]) => service.renderEntryAddField(d),
    },
    {
      id: 'entry.field-update',
      cli: ['entry', 'field-update'],
      http: ['PATCH', '/api/entries/:ref/fields/:key'],
      summary: '改条目内一个字段的属性（显示名 / 描述）：只写本条目的结构行（写时复制），不动条目模板字典与值；改整条目模板字典用 template update --set-field',
      args: [{ name: 'ref', required: false }],
      flags: {
        key: { type: 'string', required: true, hint: '字段 key（或中文标签）' },
        label: { type: 'string', hint: '新的显示名（中文名）' },
        hint: { type: 'string', hint: '新的描述（空串 = 清空）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; key?: unknown; label?: unknown; hint?: unknown; template?: string; 'dry-run'?: boolean;
      } = {}) => service.updateEntryFieldDef(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryUpdateField>[0]) => service.renderEntryUpdateField(d),
    },
    {
      id: 'entry.history',
      cli: ['entry', 'history'],
      http: ['GET', '/api/entries/:ref/history'],
      summary: '一个条目的全字段变化时间线（按时间倒序，含旧值 → 新值与版本号）',
      args: [{ name: 'ref', required: false }],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        limit: { type: 'number', hint: '最多列多少条（默认 100，上限 500）' },
      },
      run: (ctx: { ref?: string; template?: string; limit?: unknown } = {}) => service.getEntryHistory(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryHistory>[0]) => service.renderEntryHistory(d),
    },
    {
      id: 'entry.field-history',
      cli: ['entry', 'field-history'],
      http: ['GET', '/api/entries/:ref/fields/:key/history'],
      summary: '单个字段的历史版本（rev 倒序）与当前值；版本号用于 field-restore',
      args: [{ name: 'ref', required: false }],
      flags: {
        key: { type: 'string', required: true, hint: '字段 key（或中文标签）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        limit: { type: 'number', hint: '最多列多少版（默认 50，上限 500）' },
      },
      run: (ctx: { ref?: string; key?: unknown; template?: string; limit?: unknown } = {}) => service.getFieldHistory(ctx.ref, ctx.key, ctx),
      render: (d: Parameters<typeof service.renderFieldHistory>[0]) => service.renderFieldHistory(d),
    },
    {
      id: 'entry.field-restore',
      cli: ['entry', 'field-restore'],
      http: ['POST', '/api/entries/:ref/fields/:key/restore'],
      summary: '把字段恢复到某个历史版本：写回旧值并记一条 restore 历史（恢复也能再撤销）',
      args: ['ref'],
      flags: {
        key: { type: 'string', required: true, hint: '字段 key（或中文标签）' },
        rev: { type: 'number', required: true, hint: '目标版本号（entry field-history 里看）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; key?: unknown; rev?: unknown; template?: string; 'dry-run'?: boolean;
      } = {}) => service.restoreFieldVersion(ctx.ref, ctx.key, ctx),
      render: (d: Parameters<typeof service.renderFieldRestore>[0]) => service.renderFieldRestore(d),
    },
    {
      id: 'entry.remove-field',
      cli: ['entry', 'remove-field'],
      http: ['DELETE', '/api/entries/:ref/fields/:key'],
      summary: '从单条条目移除字段：条目模板字段=脱离（值保留，--restore 找回，不影响条目模板字典与其他条目）；扩展字段=硬删（值一并删，不可恢复）；内置「原始资料」不给删',
      args: ['ref'],
      flags: {
        key: { type: 'string', required: true, hint: '字段 key（或中文标签）' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        restore: { type: 'boolean', hint: '把已脱离的条目模板字段恢复到本条目（值原样回来）' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; key?: unknown; template?: string; restore?: boolean; 'dry-run'?: boolean;
      } = {}) => service.removeEntryField(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryRemoveField>[0]) => service.renderEntryRemoveField(d),
    },
    {
      id: 'entry.table',
      cli: ['entry', 'table'],
      http: ['GET', '/api/tables/:ref'],
      summary: '看一个表格字段的现值：表头、数据、计算列与统计行（合计/平均/计数）。只读，公式现算',
      args: [{ name: 'ref', required: false }],
      flags: {
        field: { type: 'string', hint: '表格字段（key 或中文标签）；条目模板里只有一个表格时可不填' },
        mask: { type: 'boolean', hint: '密文列打码显示' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
      },
      run: (ctx: { ref?: string; field?: string; mask?: boolean; template?: string } = {}) => service.getTable(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderTable>[0]) => service.renderTable(d),
    },
    {
      id: 'entry.save-as-template',
      cli: ['entry', 'save-as-template'],
      http: ['POST', '/api/entries/:ref/save-as-template'],
      summary: '把条目的字段结构存成条目模板（只复制结构，不复制值；条目模板只用于未来初始化）',
      args: ['ref'],
      flags: {
        id: { type: 'string', hint: '条目模板 id（缺省由条目 id 派生）' },
        title: { type: 'string', hint: '条目模板名（缺省用条目标题）' },
        description: { type: 'string' },
        order: { type: 'number' },
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { ref?: string; id?: string; title?: string; description?: string; order?: number; template?: string; 'dry-run'?: boolean } = {}) => saveEntryAsTemplate(ctx.ref, ctx),
      render: (d: unknown) => json(d),
    },
    {
      id: 'entry.remove-many',
      cli: ['entry', 'remove-many'],
      http: ['POST', '/api/entries/remove-many'],
      summary: '批量删条目（ids 用逗号分隔）。找不到的跳过并报告；一个都找不到才报 NOT_FOUND',
      args: ['ids'],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { ids?: unknown; template?: string; 'dry-run'?: boolean } = {}) => service.removeMany(ctx.ids, ctx),
      render: (d: Parameters<typeof service.renderEntryRemoveMany>[0]) => service.renderEntryRemoveMany(d),
    },
    {
      id: 'entry.remove',
      cli: ['entry', 'remove'],
      http: ['DELETE', '/api/entries/:ref'],
      summary: '删条目。目标不存在报 NOT_FOUND（不静默成功）。写前自动留快照',
      args: ['ref'],
      flags: {
        template: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { ref?: string; template?: string; 'dry-run'?: boolean } = {}) => service.removeEntry(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderEntryChange>[0]) => service.renderEntryChange(d),
    },

    // —— 密钥直通命令 ——
    // 作用在普通模板的 `keys` 结构清单字段上（密钥模板自带：名称 + 密文值）。
    // 它们是同一套 service 函数的语法糖，不是第二份业务逻辑。
    {
      id: 'key.list',
      cli: ['key', 'list'],
      http: ['GET', '/api/keys'],
      summary: '列出全部密钥（值默认原文，要打码加 --mask）',
      flags: {
        mask: { type: 'boolean' },
        template: { type: 'string', hint: '指定带密钥字段的条目模板，缺省用 secret' },
        entry: { type: 'string', hint: '指定承载密钥列表的条目（id 或标题），缺省自动选' },
      },
      run: (ctx: { mask?: boolean; template?: string; entry?: string } = {}) => service.keyList(ctx),
      render: (d: Parameters<typeof service.renderKeyList>[0]) => service.renderKeyList(d),
    },
    {
      id: 'key.get',
      cli: ['key', 'get'],
      http: ['GET', '/api/keys/:name'],
      summary: '取一个密钥的值（默认原文；投屏/截图时加 --mask 打码）',
      args: ['name'],
      flags: {
        mask: { type: 'boolean' },
        template: { type: 'string' },
        entry: { type: 'string' },
      },
      run: (ctx: { name?: string; mask?: boolean; template?: string; entry?: string } = {}) => service.keyGet(ctx.name, ctx),
      render: (d: Parameters<typeof service.renderKeyGet>[0]) => service.renderKeyGet(d),
    },
    {
      id: 'key.set',
      cli: ['key', 'set'],
      http: ['PUT', '/api/keys/:name'],
      summary: '写入密钥：不存在则新建，存在则覆盖（返回值里带 created）。值以密文落盘',
      args: ['name', 'value'],
      flags: {
        value: { type: 'string', hint: '值的另一种给法（值以 - 开头时用 --value=<值>）' },
        // 多行值经命令行会被 Windows 启动器 shim 截断成首行且不报错（见 A04（密钥）），
        // 文件与 stdin 是可靠通道。取 value 键；没有则取对象里唯一那个键。
        data: { type: 'string', hint: '@文件.json（含 value 键），或 -（从 stdin 读原文）' },
        template: { type: 'string' },
        entry: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { name?: string; value?: string; data?: string; template?: string; entry?: string; 'dry-run'?: boolean } = {}) => service.keySet(ctx.name, ctx.value, ctx),
      render: (d: Parameters<typeof service.renderKeySet>[0]) => service.renderKeySet(d),
    },
    {
      id: 'key.remove',
      cli: ['key', 'remove'],
      http: ['DELETE', '/api/keys/:name'],
      summary: '删一个密钥（只删清单里的一行，不删承载它的条目）',
      args: ['name'],
      flags: {
        template: { type: 'string' },
        entry: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { name?: string; template?: string; entry?: string; 'dry-run'?: boolean } = {}) => service.keyRemove(ctx.name, ctx),
      render: (d: Parameters<typeof service.renderKeyRemove>[0]) => service.renderKeyRemove(d),
    },
    {
      id: 'key.consolidate',
      cli: ['key', 'consolidate'],
      http: ['POST', '/api/keys/consolidate'],
      summary: '把旧的「一个密钥一个条目」合并进一个 keys 清单条目（幂等；先备份再跑）',
      flags: {
        template: { type: 'string', hint: '指定密钥模板，缺省用 secret' },
        entry: { type: 'string', hint: '显式指定承载条目（id 或标题），缺省自动选公共容器' },
        'dry-run': { type: 'boolean', hint: '只算不落盘，显示将要合并的数量' },
      },
      run: (ctx: { template?: string; entry?: string; 'dry-run'?: boolean } = {}) => service.keyConsolidate(ctx),
      render: (d: Parameters<typeof service.renderKeyConsolidate>[0]) => service.renderKeyConsolidate(d),
    },

    // —— 原始资料袋（source 字段）——
    // 袋是**乱入区**：杂乱资料先原样收下，之后由 agent 或人按条目模板字段字典整理成结构化字段。
    {
      id: 'source.list',
      cli: ['source', 'list'],
      http: ['GET', '/api/sources'],
      summary: '各条目模板的原始资料袋概况：多少条目有袋、袋里多少条资料',
      flags: {
        template: { type: 'string', hint: '只看某个条目模板' },
      },
      run: (ctx: { template?: string } = {}) => service.listSource(ctx),
      render: (d: Parameters<typeof service.renderSourceList>[0]) => service.renderSourceList(d),
    },
    {
      id: 'source.get',
      cli: ['source', 'get'],
      http: ['GET', '/api/sources/:ref'],
      summary: '看某条目的资料袋明细（原始资料长什么样、附件在哪）',
      args: [{ name: 'ref', required: false }],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
      },
      run: (ctx: { ref?: string; template?: string } = {}) => service.getSource(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderSourceGet>[0]) => service.renderSourceGet(d),
    },
    {
      id: 'source.add',
      cli: ['source', 'add'],
      http: ['POST', '/api/sources/:ref'],
      summary: '往资料袋里加一条：--text 文字 | --file 本机文件 | --url 网址（原样存，不改写）',
      args: [{ name: 'ref', required: false }],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        text: { type: 'string', hint: '粘贴进来的文字（原样落袋）' },
        file: { type: 'string', hint: '本机文件路径：先进附件库再入袋（原件保留，不搬走）' },
        url: { type: 'string', hint: '一个网址' },
        name: { type: 'string', hint: '这条资料的名字（缺省按内容推断）' },
        note: { type: 'string', hint: '备注（如「整理到哪个字段」）' },
        mapped: { type: 'array', hint: '这条资料已被同步到哪些字段 key（逗号分隔）' },
        at: { type: 'string', hint: '资料自身的时间（如邮件时间，ISO 或 2026-10-19）；缺省用入袋时间' },
        supersedes: { type: 'string', hint: '这条取代了哪条（资料 id）——旧的那条留痕并标为已取代' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; template?: string; text?: string; file?: string; url?: string;
        name?: string; note?: string; mapped?: unknown; at?: string; supersedes?: string;
        'dry-run'?: boolean;
      } = {}) => service.addSourceItem(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderSourceChange>[0]) => service.renderSourceChange(d),
    },
    {
      id: 'source.update',
      cli: ['source', 'update'],
      http: ['PATCH', '/api/sources/:ref'],
      summary: '改袋里某一条的元信息（--name / --note / --mapped 整理去向）。正文不改写——改内容 = 删掉重加',
      args: [{ name: 'ref', required: false }],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        id: { type: 'string', required: true, hint: '要改的那条资料的 id' },
        name: { type: 'string', hint: '新名字' },
        note: { type: 'string', hint: '备注' },
        mapped: { type: 'array', hint: '这条资料已被同步到哪些字段 key（逗号分隔）' },
        at: { type: 'string', hint: '资料自身的时间（改这个会改变「以新的为准」的判定）' },
        superseded: { type: 'boolean', hint: '标记为已被取代（留痕，不删）' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: {
        ref?: string; template?: string; id?: string; name?: string; note?: string;
        mapped?: unknown; at?: string; superseded?: boolean; 'dry-run'?: boolean;
      } = {}) => service.updateSourceItem(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderSourceChange>[0]) => service.renderSourceChange(d),
    },
    {
      id: 'source.remove',
      cli: ['source', 'remove'],
      http: ['DELETE', '/api/sources/:ref'],
      summary: '从资料袋里删掉一条（--id）。要删的 id 用 source get 看',
      args: ['ref'],
      flags: {
        template: { type: 'string', hint: '限定条目模板，解决同名歧义' },
        id: { type: 'string', required: true, hint: '要删的那条资料的 id' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { ref?: string; template?: string; id?: string; 'dry-run'?: boolean } = {}) => service.removeSourceItem(ctx.ref, ctx),
      render: (d: Parameters<typeof service.renderSourceChange>[0]) => service.renderSourceChange(d),
    },
    {
      id: 'source.ensure',
      cli: ['source', 'ensure'],
      http: ['POST', '/api/sources/ensure'],
      summary: '给所有缺「原始资料」字段的条目模板补上——每个条目模板都该有乱入的地方',
      flags: {
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: { 'dry-run'?: boolean } = {}) => service.ensureSourceFields(ctx),
      render: (d: Parameters<typeof service.renderSourceChange>[0]) => service.renderSourceChange(d),
    },
  ],
};


