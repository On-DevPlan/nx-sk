import * as service from './service.js';

export default {
  id: 'backup',
  title: '加密备份',
  order: 750,
  view: () => import('./view.jsx'),
  actions: [
    {
      id: 'backup.export',
      cli: ['backup', 'export'],
      http: ['POST', '/api/backup'],
      summary: '把整份数据用口令对称加密（AES-256-GCM）导出为单个备份文件；口令不落盘',
      flags: {
        password: { type: 'string', hint: '备份口令（也可用环境变量 NX_SK_BACKUP_PASSWORD），恢复时需再次输入' },
        out: { type: 'string', hint: '输出目录，缺省 ~/nx-sk/backup' },
        'dry-run': { type: 'boolean', hint: '只演练：生成密文但不写文件、不下载' },
      },
      run: (ctx, meta) => (meta?.transport === 'http'
        ? service.buildBackup(ctx)
        : service.exportBackup(ctx)),
      render: (d) => service.renderBackup(d),
    },
    {
      id: 'backup.import',
      cli: ['backup', 'import'],
      http: ['POST', '/api/backup/restore'],
      summary: '选择加密备份文件并输入口令，解密后整份恢复；恢复前自动给当前数据留安全快照',
      flags: {
        password: { type: 'string', hint: '导出时设置的口令（也可用环境变量 NX_SK_BACKUP_PASSWORD）' },
        file: { type: 'string', hint: '备份文件路径（CLI 用）' },
        content: { type: 'string', hint: '备份文件内容（Web 上传时自动带）' },
        'dry-run': { type: 'boolean', hint: '只解密校验，不替换数据、不留快照' },
      },
      run: (ctx) => (ctx.content !== undefined
        ? service.restoreBackup({ content: ctx.content, password: ctx.password, 'dry-run': ctx['dry-run'] })
        : service.importBackup(ctx)),
      render: (d) => service.renderRestore(d),
    },
  ],
};
