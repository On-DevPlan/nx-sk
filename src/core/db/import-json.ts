// 一次性 store.json → SQLite 导入（用户原话：**如果没有版本号就迁移 json**——
// 有 version 没 version 都接受，一律过 normalize 升到当前形状）。
//
// ── 三条不可动摇的原则（照抄 nx-kv import-json.js 的纪律）────────────
//
// 1. **全在一个事务里**。任何一步失败 → ROLLBACK → store.json 一字节不动。
//    半成品库比没有库更糟：它会看起来能用。
// 2. **成功后改名留证**（`store.json.imported-<ts>`，不删除）——沿用 corrupt
//    留证纪律：① 让「再导入一次」物理上不可能；② 用户能自己 diff；
//    ③ 一旦发现漏迁还有据可查。改名在事务提交**之后**由 bootstrap 执行
//    （rename 不是事务的一部分，放事务里会出现「库回滚了、文件挪走了」的半套现场）；
//    崩溃窗口由 meta.imported_from_json_at 挡住重复导入。
// 3. **运行时不做旧结构兼容**：v1→v2、v2→v3 的字段搬迁只在这里发生
//    （normalize 的 _migration 路径），落库后 version 恒为当前。
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { emptyStore, normalize, STORE_VERSION, type Store } from '../store-shape.ts';
import { badInput } from '../errors.ts';
import { nowIso, stamp } from '../ids.ts';
import { setMeta } from './migrator.ts';
import { writeStore } from './repo.ts';
import type { Conn } from './driver.ts';

export interface ImportOutcome {
  action: 'imported' | 'seeded' | 'corrupt-seeded';
  /** 损坏文件被挪走的记录（沿用 corruptNote 展示路径）。 */
  corrupt?: { from: string; to: string; error: string } | null;
  /** 数据迁移记录（旧版本 JSON 才有；形状与旧版 migrationNote 一致）。 */
  migration?: Record<string, unknown> | null;
  /** 待改名的 store.json（action='imported' 时有值，由 bootstrap 在提交后改名）。 */
  renameFrom?: string | null;
  /** 原始 JSON 里的版本号（迁移记录用）。 */
  fromVersion?: number;
  /** normalize 产出的迁移明细（迁移记录用）。 */
  migrationDetail?: Record<string, unknown> | null;
}

/** 改名不覆盖：目标已存在（同一秒跑过一次的极端情况）就补序号。 */
export function renameLeavingEvidence(from: string, basePrefix: string): string {
  let to = `${basePrefix}-${stamp()}`;
  for (let n = 2; existsSync(to) && n < 100; n++) to = `${basePrefix}-${stamp()}-${n}`;
  renameSync(from, to);
  return to;
}

/**
 * 导入或播种（**必须在事务内调用**；改名见 renameFrom）。
 *
 * @param conn 已建好 schema 的连接
 * @param jsonPath store.json 路径（null = 没有旧数据，直接播种）
 */
export function importOrSeed(conn: Conn, jsonPath: string | null): ImportOutcome {
  if (!jsonPath) {
    writeStore(conn, emptyStore(true));
    return { action: 'seeded' };
  }
  let rawText: string;
  try {
    rawText = readFileSync(jsonPath, 'utf8');
  } catch {
    // 读不到（权限等）：不猜，按「没有旧数据」播种；文件留在原地。
    writeStore(conn, emptyStore(true));
    return { action: 'seeded' };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    // 解析失败**降级为播种**（工具不该启动即崩），但先把损坏文件挪走留一份——
    // 直接当没有数据的话，下一次写入就把用户的旧文件永久覆盖了。
    // corrupt 改名放事务内是安全的：挪走只会让下次启动少一份可导入数据（播种），
    // 而证据文件本身已经落定，不存在「库回滚、数据消失」。
    const to = `${jsonPath}.corrupt-${stamp()}.json`;
    try { renameSync(jsonPath, to); } catch { /* 尽力 */ }
    writeStore(conn, emptyStore(true));
    return {
      action: 'corrupt-seeded',
      corrupt: { from: jsonPath, to, error: String(e && (e as Error).message) },
    };
  }

  // 有 version 没 version 都接受：normalize 认 `version || 1`，旧形状过迁移函数。
  const oldVersion = Number((parsed as { version?: number } | null)?.version || 1);
  const store: Store = normalize(parsed);
  const mig = store._migration;
  delete store._migration;

  // 预检：条目指向不存在的栏目 → entries.section_id 外键会当场拒插入，
  // 但那句报错指不出「是哪几条、指向谁」。手动改过 store.json 的人值得一条能照做的错。
  const sectionIds = new Set(store.sections.map((s) => s.id));
  const orphans = store.entries.filter((e) => !sectionIds.has(e.section));
  if (orphans.length) {
    throw badInput(
      `store.json 里有 ${orphans.length} 条条目指向不存在的栏目（外键不允许）：` +
        orphans.slice(0, 5).map((e) => `${e.id}→${e.section || '(空)'}`).join('、') +
        (orphans.length > 5 ? '…' : '') +
        '。请修正 store.json 后重试（文件不会被改动，也不会被半份导入）。',
      { orphans: orphans.map((e) => ({ id: e.id, section: e.section })) },
    );
  }

  // declared 判据来自**原始 JSON** 的 groups 数组（syncSectionGroups 自愈出来的
  // 分组不在里面 → declared=0）。
  const declaredHint: Record<string, Set<string>> = {};
  const rawSections = Array.isArray((parsed as { sections?: unknown[] } | null)?.sections)
    ? ((parsed as { sections: Array<Record<string, unknown>> }).sections)
    : [];
  for (const s of rawSections) {
    if (!s || typeof s !== 'object' || !s.id) continue;
    const gs = Array.isArray(s.groups) ? s.groups : [];
    declaredHint[String(s.id)] = new Set(gs.map((g) => String((g as { id?: unknown })?.id ?? '')));
  }

  writeStore(conn, store, { declaredHint });
  setMeta(conn, 'imported_from_json_at', nowIso());

  return {
    action: 'imported',
    renameFrom: jsonPath,
    fromVersion: oldVersion,
    migrationDetail: (mig as Record<string, unknown> | null) || null,
    migration: oldVersion < STORE_VERSION ? { from: oldVersion, to: STORE_VERSION } : null,
  };
}
