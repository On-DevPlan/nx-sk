// 条目模板（template）的 CLI 人读渲染：只把 service 的读侧结果排成文本，不碰存储。
import { groupFields } from '../../core/fields.ts';
import { formatValue } from '../../core/render.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
// 只借返回类型（Parameters/ReturnType 的读侧形状），类型导入在运行时被擦除，
// 因此与 service.ts 之间不构成运行时循环。
import type { dump, getTemplate, listTemplates, listPresets, templateTree } from './service.ts';

export function renderTemplateList(d: Awaited<ReturnType<typeof listTemplates>>) {
  const lines = [`${d.count} 个条目模板 · 共 ${d.totalEntries} 条条目`];
  for (const s of d.templates) {
    lines.push(`  ${s.id.padEnd(12)} ${s.title}　${s.entries} 条引用 / ${s.fields} 字段`
      + `${s.tags?.length ? `　#${s.tags.join(' #')}` : ''}　${s.description}`);
  }
  lines.push('', '看某个条目模板的全部信息: nx-sk template dump <id>');
  return lines.join('\n');
}

export function renderPresets(d: Awaited<ReturnType<typeof listPresets>>) {
  const lines = ['可用预置：'];
  for (const t of d.presets) lines.push(`  ${t.id.padEnd(10)} ${t.label}　${t.groups} 组 / ${t.fields} 字段　${t.description}`);
  lines.push('', '用法: nx-sk template add <id> --title <标题> --preset <预置id>');
  return lines.join('\n');
}

/** renderTemplateReorder 的入参：落盘 / 试运行两种结果共用的读侧形状。 */
export interface TemplateReorderView {
  status?: string;
  count?: number;
  wouldReorder?: string[];
  ids?: string[];
}

export function renderTemplateReorder(d: TemplateReorderView) {
  if (d.status === 'skipped') {
    return `试运行（未落盘）：将重排 ${d.count} 个条目模板 → ${(d.wouldReorder || []).join(' → ')}`;
  }
  return `已重排 ${d.count} 个条目模板：${(d.ids || []).join(' → ')}`;
}

export function renderTemplateGet(d: Awaited<ReturnType<typeof getTemplate>>) {
  const lines = [
    `条目模板 ${d.id} · ${d.title}`,
    `描述:   ${d.description}`,
    `字段:   ${d.fields} 个 / ${d.groups} 组 · 条目 ${d.entries} 条`,
    `标签:   ${d.tags?.length ? d.tags.join('、') : '（无）'}`,
    `名称字段: ${d.titleField || '（未设）'}`,
  ];
  for (const g of groupFields(d.fieldList as unknown as FieldDef[])) {
    const gtitle = d.groupList.find((x) => x.id === g.id)?.title || g.id;
    lines.push('', `${gtitle}（${g.id}）`);
    for (const x of ((g.fields || []) as Array<{ key: string; label: string; sensitive?: boolean; hint?: string }>)) {
      lines.push(`  ${x.key.padEnd(24)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.hint ? `　${x.hint}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function renderTemplateDump(d: Awaited<ReturnType<typeof dump>>) {
  // dumpTemplate 把分组原样透传（unknown），读侧在这里收窄成标题查找需要的形状
  const groups = (Array.isArray(d.groups) ? d.groups : []) as Array<{ id: string; title?: string }>;
  const groupTitle = (id: string | null | undefined) => groups.find((x) => x.id === id)?.title || id;
  const lines = [
    `条目模板 ${d.template.id} · ${d.template.title}　${d.count} 条条目 · ${d.template.fields} 字段${d.mask ? ' · 已打码' : ''}`,
    d.template.description,
  ];
  for (const e of d.entries) {
    lines.push('', `── ${e.title || e.id}（${e.id}）　完整度 ${e.completeness.filled}/${e.completeness.total} = ${e.completeness.ratio}%`);
    let cur: string | null | undefined = null;
    for (const f of d.fields) {
      if (f.group !== cur) { cur = f.group; lines.push(`  ${groupTitle(cur)}`); }
      const v = e.values[f.key];
      lines.push(`    ${f.label}: ${formatValue(v) || '（未填写）'}`);
    }
  }
  lines.push('', '机器可读: 加 --json');
  return lines.join('\n');
}

/** 模板漂移提示：只在**真的存在差异**时追加，且明确写清「没有自动改」。 */
function driftNote(changed: Array<{ key: string; diff: string[] }> | null | undefined, { indent = '' }: { indent?: string } = {}) {
  if (!Array.isArray(changed) || !changed.length) return '';
  const shown = changed.slice(0, 8).map((c) => `${indent}  ${c.key}: ${c.diff.join(', ')}`);
  if (changed.length > 8) shown.push(`${indent}  …另有 ${changed.length - 8} 个`);
  return (
    `\n${indent}注意：${changed.length} 个字段的预置定义已变，本条目模板保留原值（sync 只增不改）：\n` +
    `${shown.join('\n')}\n` +
    `${indent}要换成预置的新定义：template update <条目模板> --fields '<整份字段数组>'（或先 --remove-field 再 --add-field）。`
  );
}

export function renderTemplateTree(d: Awaited<ReturnType<typeof templateTree>>) {
  const lines = [`${d.count} 个条目模板 · 共 ${d.totalEntries} 条条目`];
  for (const s of d.templates) {
    lines.push(`  ${s.title}（${s.id}）　${s.fields} 字段 · ${s.entries} 条引用`);
    for (const e of s.entryList) lines.push(`      - ${e.title || '（无名）'}  ${e.ratio}%  ${e.id}`);
  }
  return lines.join('\n');
}

/** renderTemplateRemoveMany 的入参：remove-many 的两种结果（落盘 / 试运行）共用的读侧形状。 */
export interface TemplateRemoveManyView {
  status: string;
  count?: number;
  removedEntries?: number;
  unboundEntries?: number;
  removed?: Array<{ id: string; title: string; entries: number }>;
  wouldRemove?: Array<{ id: string; title: string; entries: number }>;
  missing?: string[];
}

export function renderTemplateRemoveMany(d: TemplateRemoveManyView) {
  const head = d.status === 'skipped'
    ? `试运行（未落盘）：将删除 ${d.count} 个条目模板`
    : `已删除 ${d.count} 个条目模板${d.unboundEntries ? `（${d.unboundEntries} 条条目已落到空白模板，内容未动）` : ''}`;
  const lines = [head];
  for (const s of d.removed || d.wouldRemove || []) lines.push(`  ${s.title}（${s.id}）　${s.entries} 条引用`);
  if (d.missing?.length) lines.push(`未找到（已跳过）: ${d.missing.join('、')}`);
  return lines.join('\n');
}

/** renderTemplateChange 的入参：add / update / sync / remove 四种结果共用的读侧形状。 */
export interface TemplateChangeView {
  status?: string;
  dryRun?: boolean;
  wouldCreate?: unknown;
  wouldChange?: unknown;
  wouldRemove?: unknown;
  wouldSync?: unknown;
  changedFields?: Array<{ key: string; diff: string[] }>;
  id?: string;
  changed?: string[];
  added?: string[];
  removed?: string[] | { id: string; title: string; entries: number };
  fillChanged?: string[];
  ops?: string[];
  upToDate?: boolean;
  created?: boolean;
  template?: { id: string; title: string; fields: number };
  addedFields?: string[];
  addedGroups?: string[];
  // v3 sync 第二阶段（条目结构行）
  fieldsAdded?: number;
  entriesSynced?: number;
  defaultsFilled?: number;
}

export function renderTemplateChange(d: TemplateChangeView) {
  if (d.status === 'skipped') {
    const body = JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove || d.wouldSync);
    // 试运行也要报漂移：否则「先 --dry-run 看一眼」这条最该用它的路径反而看不到差异
    return `试运行（未落盘）：${body}${driftNote(d.changedFields)}`;
  }
  // `removed` 在两条路径上形状不同：remove 给的是**对象** {id,title,entries}，
  // update 给的是**被删字段 key 的数组**。数组恒为真值，所以必须显式排除数组——
  // 否则 `template update` 会打印「已删除条目模板 undefined」，
  // 而 `.entries` 还会取到 Array.prototype.entries 变成 `function entries() { [native code] }`。
  if (d.removed && !Array.isArray(d.removed)) {
    return `已删除条目模板 ${d.removed.id}${d.removed.entries ? `（${d.removed.entries} 条条目落到空白模板，内容未动）` : ''}`;
  }
  if (d.upToDate) {
    return `条目模板 ${d.id} 已是最新：模板里没有需要补的分组或字段。${driftNote(d.changedFields)}`;
  }
  if (d.created) return `已创建条目模板 ${d.template!.id} · ${d.template!.title}（${d.template!.fields} 字段）`;
  // sync：只增不改——阶段 1 补字典（模板新增的分组/字段），阶段 2 补存量条目的结构行
  if (d.addedFields || d.addedGroups || d.fieldsAdded || d.entriesSynced) {
    const bits = [
      d.addedGroups?.length ? `新增分组 ${d.addedGroups.join(', ')}` : '',
      d.addedFields?.length ? `新增字段 ${d.addedFields.join(', ')}` : '',
      d.fieldsAdded ? `补条目结构行 ${d.fieldsAdded}（${d.entriesSynced || 0} 条目${d.defaultsFilled ? `，默认值 ${d.defaultsFilled} 项` : ''}）` : '',
    ].filter(Boolean).join('；');
    return `已同步条目模板 ${d.id}：${bits}${driftNote(d.changedFields)}`;
  }
  const extra = [
    d.added?.length ? `新增字段 ${d.added.join(', ')}` : '',
    d.removed?.length ? `删除字段 ${d.removed.join(', ')}` : '',
    d.fillChanged?.length ? `填写策略 ${d.fillChanged.join(', ')}` : '',
    // 结构改动（分组增删改名换序 / 字段改名换组）是**一句话一条**的摘要：
    // 「changed: groups, fields」这种输出等于没说，改错了没法回溯。
    ...(d.ops || []),
  ].filter(Boolean).join('\n');
  return `已更新条目模板 ${d.id}：${(d.changed || []).join(', ')}${extra ? `\n${extra}` : ''}`;
}

