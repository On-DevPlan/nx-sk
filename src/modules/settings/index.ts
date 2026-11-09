import * as service from './service.ts';

export default {
  id: 'settings',
  title: '设置',
  order: 900,
  // 单例配置：全局只有一份，读出来改回去 → 退化为 get / set，不硬凑 CRUD 五操作
  actions: [
    {
      id: 'setting.get',
      cli: ['setting', 'get'],
      http: ['GET', '/api/settings'],
      summary: '读取全部设置项',
      flags: {},
      run: () => service.getSettings(),
      render: (d: Parameters<typeof service.renderSettings>[0]) => service.renderSettings(d),
    },
    {
      id: 'setting.set',
      cli: ['setting', 'set'],
      http: ['PATCH', '/api/settings'],
      summary: '修改设置（PATCH 语义，只改传入项）',
      flags: {
        key: { type: 'string', hint: '设置项名' },
        value: { type: 'string', hint: '取值' },
        set: { type: 'kv', hint: 'k=v，可重复' },
        'dry-run': { type: 'boolean' },
      },
      run: (ctx: Parameters<typeof service.updateSettings>[0]) => service.updateSettings(ctx),
      render: (d: Parameters<typeof service.renderSettingSet>[0]) => service.renderSettingSet(d),
    },
  ],
};
