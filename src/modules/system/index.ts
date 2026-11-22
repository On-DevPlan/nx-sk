import * as service from './service.ts';
import { MAX_SCOPE_LIMIT } from '../../core/default-entry.ts';

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
      summary: '一次性拿齐上下文：版本 / 存储路径 / 条目模板 / 设置 / 命令表',
      flags: {},
      run: () => service.bootstrapInfo(),
      render: (d: Parameters<typeof service.renderBootstrap>[0]) => service.renderBootstrap(d),
    },
    {
      id: 'system.status',
      cli: ['status'],
      http: ['GET', '/api/status'],
      summary: '默认条目上下文（agent 首选入口）：默认条目 + 子条目（按设置截断）+ 该干什么的提示词',
      flags: {
        // 单次覆盖设置里的条数上限；不给就用 settings.entryScopeLimit
        limit: { type: 'number', hint: `本次最多带多少条（1–${MAX_SCOPE_LIMIT}；缺省读设置）` },
      },
      run: (ctx: { limit?: number } = {}) => service.statusInfo(ctx),
      render: (d: Parameters<typeof service.renderStatus>[0]) => service.renderStatus(d),
    },
    {
      id: 'system.health',
      cli: ['health'],
      http: ['GET', '/api/health'],
      summary: '存活与存储可达性检查',
      flags: {},
      run: () => service.healthInfo(),
      render: (d: Parameters<typeof service.renderHealth>[0]) => service.renderHealth(d),
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
      run: (ctx: Parameters<typeof service.routesInfo>[0]) => service.routesInfo(ctx),
      render: (d: Parameters<typeof service.renderRoutes>[0]) => service.renderRoutes(d),
    },
  ],
};

