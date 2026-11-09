import * as service from './service.js';

export default {
  id: 'system',
  title: '系统',
  order: 100,
  // 聚合模块：只读聚合，没有面板（面板里没有「系统」这个 tab）
  actions: [
    {
      id: 'system.bootstrap',
      cli: ['bootstrap'],
      http: ['GET', '/api/bootstrap'],
      summary: '一次性拿齐上下文：版本 / 存储路径 / 栏目 / 设置 / 命令表',
      flags: {},
      run: () => service.bootstrapInfo(),
      render: (d) => service.renderBootstrap(d),
    },
    {
      id: 'system.health',
      cli: ['health'],
      http: ['GET', '/api/health'],
      summary: '存活与存储可达性检查',
      flags: {},
      run: () => service.healthInfo(),
      render: (d) => service.renderHealth(d),
    },
    {
      id: 'system.routes',
      cli: ['routes'],
      http: ['GET', '/api/routes'],
      summary: '命令与 HTTP 路由的双向对照表',
      flags: {
        // 读命令的过滤 flag 一律不带 default：「不传」本身代表「全部」
        module: { type: 'string', hint: '模块 id 或命令组' },
        http: { type: 'string', hint: '"POST /api/entries" 形式的路由' },
      },
      run: (ctx) => service.routesInfo(ctx),
      render: (d) => service.renderRoutes(d),
    },
  ],
};
