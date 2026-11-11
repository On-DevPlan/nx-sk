// 存储版本迁移区：每个版本一份**不可变** DDL 快照，一条边一个跃迁。
// （机制与 nx-kv src/core/db/migrations/index.js 同源）
//
// 目录约定：
//   v1.sql  = 版本 1 的完整 schema（历史快照，永不修改）
//   v2.sql  = 1 → 2 的跃迁脚本（**将来加版本时新建**，只写增量 DDL）
//   index.js= 边映射表 + 路径规划（本文件）
//
// 规则：
//   · 只升不降，禁止跨版本回写旧结构；
//   · 启动时按 EDGE_MAP 规划路径，缺边直接报错，不静默跳过；
//   · 组合边（如 0→2）不写脚本，由直接边串联，EDGE_MAP 里显式登记；
//   · 升级 = 在 DIRECT_EDGES 追加 `{ from: N, to: N+1, file: 'v(N+1).sql' }`
//     + 新脚本 + version.ts 的 CURRENT_SCHEMA_VERSION 改成 N+1，**绝不改已发布的 vN.sql**。
import { readFileSync } from 'node:fs';
import { CURRENT_SCHEMA_VERSION } from '../version.ts';

/** 每条直接边 = 一次版本跃迁。`apply` 与 DDL 在同一个事务里执行（纯 SQL 表达不了的数据迁移用）。 */
export interface MigrationStep {
  from: number;
  to: number;
  file: string;
  title: string;
  apply?: (db: unknown, ctx: Record<string, unknown>) => void;
}

export const DIRECT_EDGES: MigrationStep[] = [
  { from: 0, to: 1, file: 'v1.sql', title: '初始 schema（sections/groups/fields/entries/attachments/…）' },
  { from: 1, to: 2, file: 'v2.sql', title: '挂载收敛到条目字段：重建 entry_attach（去 role=source）、删 section_attach/field_attach' },
];

const keyOf = (from: number, to: number) => `${from}->${to}`;

/**
 * 显式登记所有可用边：直接边 + 由直接边串联出的组合边。
 * 组合边记录 via（中间经过的版本），启动时按它逐步执行。
 */
export function buildEdgeMap(): Map<string, { from: number; to: number; kind: 'direct' | 'composed'; steps: MigrationStep[]; via: number[] }> {
  const map = new Map<string, { from: number; to: number; kind: 'direct' | 'composed'; steps: MigrationStep[]; via: number[] }>();
  for (const e of DIRECT_EDGES) {
    map.set(keyOf(e.from, e.to), { from: e.from, to: e.to, kind: 'direct', steps: [e], via: [e.to] });
  }
  // 递增版本的组合边（0..CURRENT 只有个位数，串联足够）。
  const points = [0, ...DIRECT_EDGES.flatMap((e) => [e.from, e.to])];
  for (const start of points) {
    for (const target of points) {
      if (start >= target) continue;
      if (map.has(keyOf(start, target))) continue;
      const steps = [];
      let cur = start;
      const via = [start];
      while (cur < target) {
        const next = DIRECT_EDGES.find((e) => e.from === cur && e.to <= target);
        if (!next) break;
        steps.push(next);
        cur = next.to;
        via.push(cur);
      }
      if (cur === target) {
        map.set(keyOf(start, target), { from: start, to: target, kind: 'composed', steps, via });
      }
    }
  }
  return map;
}

export const EDGE_MAP = buildEdgeMap();

/** 人读的边清单（诊断用）：直接边与组合边各一行。 */
export function describeEdges(): string[] {
  return [...EDGE_MAP.values()].map((e) =>
    `${e.from}→${e.to}${e.kind === 'composed' ? `（经 ${e.via.join('→')}）` : ''}`);
}

/**
 * 规划 from → to 的迁移路径。
 * @throws 缺边时明确报错，列出当前已登记的边。
 */
export function planMigrationPath(from: number, to: number = CURRENT_SCHEMA_VERSION): MigrationStep[] {
  const a = Math.trunc(Number(from) || 0);
  const b = Math.trunc(Number(to) || 0);
  if (b < a) {
    throw new Error(`存储版本不支持降级：${a} → ${b}（只允许单向升级）`);
  }
  if (a === b) return [];
  const edge = EDGE_MAP.get(keyOf(a, b));
  if (!edge) {
    throw new Error(
      `缺少迁移边 ${a} → ${b}；当前可用: ${describeEdges().join('、') || '无'}。` +
        '请先在 migrations/index.js 登记一条直接边。',
    );
  }
  return edge.steps;
}

/** 读一份版本快照 / 跃迁脚本（随包发布，运行时按 URL 取，保持 SQL 可独立 review）。 */
export function readMigrationSql(file: string): string {
  return readFileSync(new URL('./' + file, import.meta.url), 'utf8');
}

/** 所有直接边按目标版本排序（供 pendingSteps 使用）。 */
export const MIGRATION_STEPS = [...DIRECT_EDGES].sort((x, y) => x.to - y.to);
