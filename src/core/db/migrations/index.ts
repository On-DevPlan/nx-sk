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
import type { Conn } from '../driver.ts';
import { applyV3 } from './v3-apply.ts';
import { applyV4 } from './v4-apply.ts';
import { applyV6 } from './v6-apply.ts';
import { applyV7 } from './v7-apply.ts';
import { applyV9 } from './v9-apply.ts';

/** 每条直接边 = 一次版本跃迁。`apply` 与 DDL 在同一个事务里执行（纯 SQL 表达不了的数据迁移用）。 */
export interface MigrationStep {
  from: number;
  to: number;
  file: string;
  title: string;
  apply?: (db: Conn, ctx: Record<string, unknown>) => void;
}

export const DIRECT_EDGES: MigrationStep[] = [
  { from: 0, to: 1, file: 'v1.sql', title: '初始 schema（sections/groups/fields/entries/attachments/…）' },
  { from: 1, to: 2, file: 'v2.sql', title: '挂载收敛到条目字段：重建 entry_attach（去 role=source）、删 section_attach/field_attach' },
  { from: 2, to: 3, file: 'v3.sql', title: '动态结构/写时复制：entry_fields + field_data 拆行，values 列退役，边挂 entry_field_id', apply: applyV3 },
  { from: 3, to: 4, file: 'v4.sql', title: '字段类型去 DB CHECK：加新类型不再需要 schema 迁移（合法性由运行时 validateFieldDef/behaviorOf 保证）', apply: applyV4 },
  { from: 4, to: 5, file: 'v5.sql', title: '字段值历史：新增 field_history（单调 rev + 值快照 + op/source/at，无外键）' },
  { from: 5, to: 6, file: 'v6.sql', title: '分组变成字段：删 groups 表与 fields.group_id，分组折成 type=group 的字段（keys 引用成员）', apply: applyV6 },
  { from: 6, to: 7, file: 'v7.sql', title: '条目模板→模板 + 条目树：sections/fields 改名 templates/template_fields，entries 用 template_id，新增 folders 父子关系', apply: applyV7 },
  { from: 7, to: 8, file: 'v8.sql', title: 'KV 模板标记退役：删除 templates.kv；模板结构只剩字段 + 条目' },
  { from: 8, to: 9, file: 'v9.sql', title: '模板默认标签：templates.tags；模板创建条目时继承 tag，CLI 可按 tag 检索', apply: applyV9 },
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

