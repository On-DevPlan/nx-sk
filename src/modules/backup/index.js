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
      summary: '把整份数据用口令对称加密（AES-256-GCM）导出为单个备份文件；口令不落盘；--with-files 连附件原件一起打包',
      flags: {
        password: { type: 'string', hint: '备份口令（也可用环境变量 NX_SK_BACKUP_PASSWORD），恢复时需再次输入' },
        out: { type: 'string', hint: '输出目录，缺省 ~/nx-sk/backup' },
        'with-files': { type: 'boolean', hint: '把附件原件一并嵌进备份（体积显著变大；恢复时自动还原附件库）' },
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
      summary: '解密备份并导入：缺省合并进当前数据（只增补、不覆盖已有值，冲突列出待手动处理），--replace 才整份替换；两种方式都先留安全快照',
      flags: {
        password: { type: 'string', hint: '导出时设置的口令（也可用环境变量 NX_SK_BACKUP_PASSWORD）' },
        file: { type: 'string', hint: '备份文件路径（CLI 用）' },
        content: { type: 'string', hint: '备份文件内容（Web 上传时自动带）' },
        replace: { type: 'boolean', hint: '整份替换（旧行为）：当前数据被备份整体覆盖；缺省是合并' },
        'dry-run': { type: 'boolean', hint: '只解密校验并出合并计划，不写数据、不留快照' },
      },
      run: (ctx) => (ctx.content !== undefined
        ? service.restoreBackup({
          content: ctx.content, password: ctx.password,
          replace: ctx.replace === true, 'dry-run': ctx['dry-run'],
        })
        : service.importBackup(ctx)),
      render: (d) => service.renderRestore(d),
    },
  ],
};
