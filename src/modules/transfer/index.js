// 栏目级导出 / 导入（ZIP）。没有 view —— 入口在栏目页右上角「更多」里，
// 不在侧栏占一个 tab；CLI 与 HTTP 仍与其它模块同源。
import * as service from './service.js';

// 逗号分隔（中英文都认）——URL 与 CLI 都只传一个字符串，避免数组序列化两套
const splitList = (v) => String(v || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
// 口令从 flag 或环境变量取（CLI 上口令会出现在进程列表里，脚本/CI 里用 env 更稳）
const pwOf = (ctx) => (ctx.passphrase || process.env.NX_SK_TRANSFER_PASSPHRASE || undefined);

export default {
  id: 'transfer',
  title: '导出导入',
  order: 710,
  actions: [
    {
      id: 'transfer.export',
      cli: ['transfer', 'export'],
      http: ['GET', '/api/sections/:ref/export.zip'],
      summary: '把栏目（条目 + 引用附件）打成一个 ZIP；--passphrase 可整包加密',
      args: ['ref'],
      flags: {
        out: { type: 'string', hint: '保存路径（CLI）；缺省写到 ~/nx-sk/export/' },
        entries: { type: 'string', hint: '只导出这些条目：id 或标题，逗号分隔（缺省全部）' },
        passphrase: { type: 'string', hint: '加密口令（留空 = 明文包；也可用环境变量 NX_SK_TRANSFER_PASSPHRASE）' },
        'no-files': { type: 'boolean', hint: '不带附件原件（包更小；导入后引用会指向不存在的附件）' },
      },
      raw: true,
      run: (ctx) => service.exportToFile(ctx.ref, { out: ctx.out, entryIds: splitList(ctx.entries), passphrase: pwOf(ctx), includeFiles: ctx['no-files'] !== true }),
      serveRaw: (ctx, frame) => service.serveExportZip(ctx.ref, { ...frame, entryIds: splitList(ctx.entries), passphrase: pwOf(ctx), includeFiles: ctx['no-files'] !== true }),
      render: (d) => service.renderExportZip(d),
    },
    {
      id: 'transfer.import',
      cli: ['transfer', 'import'],
      http: ['POST', '/api/sections/:ref/import.zip'],
      summary: '从 ZIP 导入栏目条目（先 --dry-run 预览）；同名条目按 --on-conflict 处理，缺省跳过',
      args: ['ref'],
      flags: {
        file: { type: 'string', hint: 'ZIP 路径（CLI）；浏览器上传走原始请求体' },
        'on-conflict': { type: 'string', enum: ['skip', 'copy', 'overwrite'], hint: 'skip 跳过 / copy 另存 / overwrite 覆盖' },
        'dry-run': { type: 'boolean', hint: '只预览，不写盘' },
        passphrase: { type: 'string', hint: '加密口令（留空 = 明文包；也可用环境变量 NX_SK_TRANSFER_PASSPHRASE）' },
      },
      binaryBody: true,
      run: (ctx) => {
        const opts = { onConflict: ctx['on-conflict'] || 'skip', dryRun: ctx['dry-run'] === true, passphrase: pwOf(ctx) };
        // HTTP：body 是原始 zip（不 base64、不 JSON），fileName 由 x-file-name 头带过来
        if (ctx.__body) {
          return service.importFromBuffer(ctx.ref, ctx.__body, { ...opts, fileName: ctx.__fileName || 'upload.zip' });
        }
        return service.importFromFile(ctx.ref, { ...opts, file: ctx.file });
      },
      render: (d) => service.renderImport(d),
    },
    {
      id: 'transfer.bundleExport',
      cli: ['transfer', 'bundle-export'],
      http: ['POST', '/api/bundle/export.zip'],
      summary: '全局导出：选栏目（可选每个栏目的条目）打成一个 zip；结构与附件随包',
      flags: {
        sections: { type: 'string', hint: '栏目 id，逗号分隔（导出整个栏目）' },
        selection: { type: 'json', hint: '精确选择：[{"id":"job","entries":["条目id"]}]（面板用）' },
        out: { type: 'string', hint: '保存路径（CLI）；缺省 ~/nx-sk/export/' },
        'dry-run': { type: 'boolean', hint: '只算体积与数量，不写盘' },
        passphrase: { type: 'string', hint: '加密口令（留空 = 明文包；也可用环境变量 NX_SK_TRANSFER_PASSPHRASE）' },
        'no-files': { type: 'boolean', hint: '不带附件原件（包更小；导入后引用会指向不存在的附件）' },
      },
      raw: true,
      run: (ctx) => service.exportBundleToFile({ sections: ctx.selection ?? ctx.sections, out: ctx.out, dryRun: ctx['dry-run'] === true, passphrase: pwOf(ctx), includeFiles: ctx['no-files'] !== true }),
      serveRaw: (ctx, frame) => service.serveBundleZip({ sections: ctx.selection ?? ctx.sections, res: frame.res, passphrase: pwOf(ctx), includeFiles: ctx['no-files'] !== true }),
      render: (d) => service.renderBundleExport(d),
    },
    {
      id: 'transfer.bundleImport',
      cli: ['transfer', 'bundle-import'],
      http: ['POST', '/api/bundle/import.zip'],
      summary: '全局导入：多栏目包先 --dry-run 预览，再按冲突策略逐栏目合并/新建',
      flags: {
        file: { type: 'string', hint: 'ZIP 路径（CLI）；浏览器上传走原始请求体' },
        'on-conflict': { type: 'string', enum: ['skip', 'copy', 'overwrite'], hint: 'skip 跳过 / copy 另存 / overwrite 覆盖' },
        'dry-run': { type: 'boolean', hint: '只预览，不写盘' },
        passphrase: { type: 'string', hint: '加密口令（留空 = 明文包；也可用环境变量 NX_SK_TRANSFER_PASSPHRASE）' },
      },
      binaryBody: true,
      run: (ctx) => {
        const opts = { onConflict: ctx['on-conflict'] || 'skip', dryRun: ctx['dry-run'] === true, passphrase: pwOf(ctx) };
        if (ctx.__body) return service.importBundleFromBuffer(ctx.__body, { ...opts, fileName: ctx.__fileName || 'bundle.zip' });
        return service.importBundleFromFile({ ...opts, file: ctx.file });
      },
      render: (d) => (d.status === 'preview' ? service.renderBundlePreview(d) : service.renderBundleApply(d)),
    },
    {
      id: 'transfer.importNew',
      cli: ['transfer', 'import-new'],
      http: ['POST', '/api/import.zip'],
      summary: '零配置导入：不指定栏目，按包内结构新建（id 冲突自动加序号，不合并）',
      flags: {
        file: { type: 'string', hint: 'ZIP 路径（CLI）；浏览器上传走原始请求体' },
        'dry-run': { type: 'boolean', hint: '只预览，不写盘' },
        passphrase: { type: 'string', hint: '加密口令（留空 = 明文包；也可用环境变量 NX_SK_TRANSFER_PASSPHRASE）' },
      },
      binaryBody: true,
      run: (ctx) => {
        const opts = { dryRun: ctx['dry-run'] === true, passphrase: pwOf(ctx) };
        if (ctx.__body) {
          return service.importAuto(ctx.__body, { ...opts, fileName: ctx.__fileName || 'upload.zip' });
        }
        return service.importAuto(null, { ...opts, file: ctx.file });
      },
      render: (d) => service.renderImport(d),
    },
  ],
};
