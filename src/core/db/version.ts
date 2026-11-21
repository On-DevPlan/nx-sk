// schema 版本与 Node 版本下限（唯一权威）。
//
// 两个数字都只在这里出现，其它地方一律 import，避免「一处改了、另一处没改」——
// 这类漂移的表现是「库比程序新」的误判，很难看出来。

/**
 * 当前程序认识的 schema 版本（`meta.schema_version` 的期望值）。
 *
 * v1（2026-11-11）：存储从 store.json 换成 SQLite —— templates / groups / fields /
 * entries / attachments（对齐 nx-kv v2 的统一资源表）+ 三张资源边表 +
 * settings / ui_state / meta。store.json 只在首启被导入一次，运行时不再读写。
 * v2（2026-11-11）：挂载收敛到「具体条目的具体字段」——entry_attach 去 role='source'
 * （source 只是普通字段），删结构级边表 section_attach / field_attach（附件挂在结构上没价值）。
 * v3（2026-11-11）：动态结构/写时复制——条目模板字段字典降级成模板，每个条目自带 entry_fields
 * 行（结构）+ field_data 行（值）；entries 的 "values" JSON 列退役；entry_attach 改挂
 * entry_field_id；quickAdd 不再污染字典；sync 第二阶段把字典缺行补进存量条目（只增不改）。
 * v4（2026-11-11）：字段类型去 DB CHECK——fields.type / entry_fields.type 不再被 CHECK IN
 * 枚举约束（加新字段类型不再需要 schema 迁移）；类型合法性由运行时保证：
 * validateFieldDef 在定义写入点拒绝未知类型，behaviorOf 按 FIELD_TYPES 分派行为，
 * shared/fields/types.ts 仍是类型清单的唯一权威。
 * v5（2026-11-12）：字段值历史——新增 field_history（entry_field_id + 单调 rev + 值快照 +
 * op/source/at）。不建外键（全量重写会 CASCADE 清空，见 v5.sql 注释），
 * 由 writeStore 在重建后清理真正消失字段的历史；写入侧做 diff，只记真实变化。
 * v6（2026-11-18，0.42）：分组变成字段——删 groups 表、fields 去 group_id；
 * 每个分组折成 fields 里 type='group' 的一行（spec 的 keys 引用同条目模板其他字段），
 * 条目结构行也补上组行。底层只剩 field 一种结构（见 migrations/v6-apply.ts）。
 * v7（2026-11-20，0.43）：条目模板容器退役——templates/fields 改名 templates/template_fields，
 * entries.section_id 改成 template_id（只记录创建时用过的模板）；新增 folders 表维护
 * 条目父子关系；旧条目模板各生成一个空 folder 条目，旧条目挂到它下面。
 * v8（2026-11-21，0.44）：KV 模板标记退役——删除 templates.kv 列；模板结构只剩
 * 「字段 + 条目」，密钥是普通 entrylist 字段，不再有 schema 级 KV 标记。
 * v9（2026-11-21，0.44 · 任务 #51）：模板默认标签——templates.tags；模板创建条目时
 * 把默认 tag 带进 entries.tags，agent 可用 tag 直接检索，不必记模板 id。
 */
export const CURRENT_SCHEMA_VERSION = 9;

/**
 * 运行时最低 Node 版本。
 *
 * `node:sqlite` 22.5.0 起才有，且 22.5–22.12 要加 `--experimental-sqlite` 标志，
 * **22.13.0 起免标志** —— 所以下限只能定在 22.13.0。
 */
export const REQUIRED_NODE_VERSION = '22.13.0';

/**
 * 比较两个 `x.y.z` 版本串。
 * @returns {number} a<b 返回负数，相等 0，a>b 正数
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 检查当前（或给定）Node 版本是否够用。
 *
 * 为什么要在**业务代码 import 之前**检查：否则用户看到的是
 * `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` 加一段栈，
 * 完全指不出「你的 Node 太老」这个真因。
 */
export function checkNodeVersion(version = process.versions.node): { ok: boolean; version: string; message: string } {
  const cur = String(version || '0.0.0');
  if (compareVersions(cur, REQUIRED_NODE_VERSION) >= 0) {
    return { ok: true, version: cur, message: '' };
  }
  return {
    ok: false,
    version: cur,
    message:
      `nx-sk 需要 Node >= ${REQUIRED_NODE_VERSION}（当前 ${cur}）。\n` +
      '原因：存储层使用 Node 内置 SQLite；22.13 起不再需要 --experimental-sqlite 标志。',
  };
}

