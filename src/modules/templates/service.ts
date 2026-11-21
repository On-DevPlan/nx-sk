// 条目模板（template）：一组同构条目的容器 + 一份字段字典。
// 字典是**数据**不是代码分支，所以 agent 与面板看到的字段永远一致。
// v3：字典降级成「模板」——存量条目按自身结构行读写，sync 负责把缺口补进去。
import { loadStore, mutateStore, entryStructures, syncEntryStructures, isDetachedField, type StoreTemplate } from '../../core/store.ts';
import { assertSafeId } from '../../core/paths.ts';
import { badInput, blocked, conflict, notFound } from '../../core/errors.ts';
import { ensureSourceBuiltin, findTemplate, getTemplate as getPreset, instantiateTemplate, mergeTemplate, normalizeStructure, templateNames, templateSummaries } from '../../core/fields.ts';
import { boardGroupsOf } from '../../shared/fields/structure.ts';
import { fieldsFromInput } from './structure.ts';
import { computeTable } from '../../shared/table.ts';
import { groupsForLayout, reconcileLayout } from '../../shared/blockLayout.ts';
import { completeness, dumpTemplate } from '../../core/render.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { nowIso } from '../../core/ids.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
import { BLANK_TEMPLATE_ID } from '../../shared/tree.ts';
import { fieldListOf, mustFind, summarize } from './common.ts';
import { validateFieldDef } from './validate.ts';

// 定位方式放宽：内部 id 与用户手上的标题都接受（实现在 core/fields.js，避免模块互依）。
export { findTemplate };

export async function listTemplates() {
  const store = await loadStore();
  // 空白模板是内部底座，不是可选的「模板」；模板库入口不该看到它。
  // 顺序 = 用户拖动后的 order；API 自己也排，CLI / 第三方调用不必再抄一遍。
  const templates = store.templates
    .filter((s) => !(s.blank || s.id === BLANK_TEMPLATE_ID))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  return {
    count: templates.length,
    totalEntries: store.entries.length,
    templates: templates.map((s) => summarize(store, s)),
  };
}

export async function listPresets() {
  return { count: templateSummaries().length, presets: templateSummaries() };
}

/**
 * 按给定顺序重排条目模板（拖动排序的落盘入口）。
 *
 * `ids` 是用户可见模板的完整顺序；没列出来的（隐藏模板 / 新建的）排在后面，
 * 避免 CLI 只传一部分时把它们插进已排好的序列中间。
 * order 统一写成 10,20,30…，下次插入永远有间隙，不会因为反复拖动把数字挤成一片。
 */
export async function reorderTemplates(refs: unknown, { 'dry-run': dryRun }: { 'dry-run'?: boolean } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要排序的条目模板（用 --ids 给 id，逗号分隔）');

  const store = await loadStore();
  const visible = store.templates.filter((s) => !(s.blank || s.id === BLANK_TEMPLATE_ID));
  const picked: StoreTemplate[] = [];
  for (const ref of list) {
    const s = findTemplate(store, ref);
    if (!s) throw notFound(`找不到条目模板: ${ref} —— 现有: ${templateNames(store)}`);
    if (s.blank || s.id === BLANK_TEMPLATE_ID) throw blocked('空白条目模板是内置底座，不参与排序。');
    if (!picked.some((x) => x.id === s.id)) picked.push(s);
  }
  const rest = visible
    .filter((s) => !picked.some((x) => x.id === s.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const ordered = [...picked, ...rest];
  if (dryRun) return { status: 'skipped', dryRun: true, wouldReorder: ordered.map((s) => s.id), count: ordered.length };

  await mutateStore((s) => {
    ordered.forEach((t, i) => {
      const row = s.templates.find((x) => x.id === t.id);
      if (row) row.order = (i + 1) * 10;
    });
  });
  const after = await loadStore();
  const next = after.templates
    .filter((s) => !(s.blank || s.id === BLANK_TEMPLATE_ID))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  return {
    status: 'ok',
    count: next.length,
    ids: next.map((s) => s.id),
    templates: next.map((s) => summarize(after, s)),
  };
}

export async function getTemplate(ref: unknown) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  return {
    ...summarize(store, s),
    titleField: s.titleField,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    // 分组清单是**推导**出来的（组=字段），对外仍按 {id,title} 给，CLI/面板的措辞不变
    groupList: boardGroupsOf(s.fields as any).map((g) => ({ id: g.id, title: g.title })),
    fieldList: fieldListOf(s.fields as any),
    // 版式（块布局）：agent 要照着改/复制版式时读这个字段，形状见 shared/blockLayout.js
    layout: reconcileLayout(s.layout, groupsForLayout(s)),
  };
}

/** 新条目模板默认排在最后：拖动排序才是用户可见的顺序，表单里不再让用户填数字。 */
function nextTemplateOrder(store: Awaited<ReturnType<typeof loadStore>>): number {
  const orders = store.templates
    .filter((s) => !(s.blank || s.id === BLANK_TEMPLATE_ID))
    .map((s) => Number(s.order) || 0);
  return orders.length ? Math.max(...orders) + 10 : 10;
}

export async function addTemplate({ id, title, preset, description, order, fields, groups, tags, 'dry-run': dryRun }: {
  id?: string;
  title?: string;
  preset?: string;
  description?: string;
  order?: number;
  fields?: unknown[];
  groups?: unknown[];
  tags?: unknown;
  'dry-run'?: boolean;
} = {}) {
  const sid = assertSafeId(id, '条目模板 id');
  const store = await loadStore();
  if (findTemplate(store, sid)) throw conflict(`条目模板已存在: ${sid}（重复创建不会静默覆盖——换个 id，或用 template update）`);
  const orderNum = Number.isFinite(order) ? Number(order) : nextTemplateOrder(store);
  const tagList = Array.isArray(tags) ? tags.map(String).map((x) => x.trim()).filter(Boolean) : [];

  let draft: StoreTemplate;
  if (preset) {
    const t = instantiateTemplate(preset, { id: sid, title, description, order: orderNum });
    if (!t) {
      const avail = templateSummaries().map((x) => x.id).join(' / ');
      throw badInput(`未知预置: ${preset}（可用: ${avail}）`);
    }
    draft = { ...t, id: sid, tags: [] };
  } else {
    // 自定义条目模板。字段字典先空着——用户的 --fields/--groups 应用完，
    // 再由 normalizeStructure + ensureSourceBuiltin 统一收口（结构不变量只此一处）。
    draft = { id: sid, title: title || sid, description: description || '', order: orderNum, template: null, blank: false, titleField: null, titleLabel: '名称', tags: [], fields: [], createdAt: null, updatedAt: null };
  }
  // 模板默认 tag：显式 --tags 优先；没给就自带「模板 id + 标题」，从模板创建的条目继承。
  if (tagList.length) draft.tags = [...new Set(tagList)];
  else draft.tags = [...new Set([sid, draft.title].filter(Boolean).map(String))];
  // --groups / --fields 是**输入层**的历史写法，落成字典时折成组字段（fieldsFromInput 唯一折算点）。
  if (Array.isArray(groups) || Array.isArray(fields)) {
    draft.fields = fieldsFromInput(Array.isArray(fields) ? fields : draft.fields, Array.isArray(groups) ? groups : null);
  }
  // 结构不变量（每个普通字段恰好归属一组；组声明只留存在的成员）+ 「每个结构自带」的
  // 「原始资料」袋（每个非空白条目模板都自带：杂乱资料先原样入袋，再按字段字典整理）。
  draft.fields = normalizeStructure(draft.fields as any, { ensureRoot: true }) as typeof draft.fields;
  draft.fields = ensureSourceBuiltin(draft.fields as any) as typeof draft.fields;
  draft.fields = normalizeStructure(draft.fields as any, { ensureRoot: true }) as typeof draft.fields;
  draft.createdAt = nowIso();
  draft.updatedAt = draft.createdAt;

  if (dryRun) return { status: 'skipped', dryRun: true, wouldCreate: summarize(store, draft) };

  await mutateStore((s) => { s.templates.push(draft); s.templates.sort((a, b) => a.order - b.order); });
  return { status: 'ok', created: true, template: summarize(store, draft) };
}

/**
 * 同步条目模板结构（v3 两阶段，都**只增不改不删**）：
 *
 *   阶段 1（代码模板 → 条目模板字典）：模板里新增、而本条目模板还缺的分组与字段补进字典。
 *     条目模板字段字典是持久化数据，模板演进不会回溯——跑一次 sync 把缺口补上。
 *   阶段 2（条目模板字典 → 存量条目结构行）：字典里条目还缺的行补进每个条目
 *     （写时复制的跟进通道；新行若字典带 defaultValue 则落默认值）。
 *
 * 非模板条目模板不再报错：阶段 1 跳过，阶段 2 照做（用条目模板自己的字典）——
 * 「add-field 之后让存量条目长出新行」正是这条命令在 v3 的主要用途。
 */
export async function syncTemplate(ref: unknown, { 'dry-run': dryRun }: { 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = mustFind(store, ref);

  // ── 阶段 1：代码模板 → 条目模板字典 ──
  let fields = target.fields;
  let addedGroups: string[] = [];
  let addedFields: string[] = [];
  let changedFields: Array<{ key: string; diff: string[] }> = [];
  if (target.template) {
    const tpl = getPreset(target.template);
    if (!tpl) throw badInput(`条目模板记录了预置来源 ${target.template}，但该预置已不存在（可能被重命名或移除）。`);
    ({ fields, addedGroups, addedFields, changedFields } = mergeTemplate(target, tpl));
    // 合并完再收口一次：模板新加的字段要落进合适的组（组是字段，归一化会补 keys）
    fields = normalizeStructure(fields as any, { ensureRoot: true }) as typeof fields;
  }

  // ── 阶段 2：条目模板字典 → 存量条目结构行 ──
  const structures = entryStructures(store);
  const dictKeys = new Set(fields.map((f) => f.key));
  const mine = store.entries.filter((e) => e.template === target.id);
  let entryFieldsToAdd = 0;
  const gapEntries = new Set<string>();
  for (const e of mine) {
    const rowKeys = new Set((structures.get(e.id) || []).map((r) => r.key));
    for (const k of dictKeys) {
      if (!rowKeys.has(k)) { entryFieldsToAdd += 1; gapEntries.add(e.id); }
    }
  }

  // 漂移只是**提示**：定义归条目模板，sync 绝不覆盖用户改过的 label/hint/fill。
  // upToDate 看「两阶段都没有可补的」——否则用户改过一个标签，就会永远报「不是最新」。
  if (!addedGroups.length && !addedFields.length && !entryFieldsToAdd) {
    return {
      status: 'ok', upToDate: true, id: target.id,
      addedGroups: [], addedFields: [], changedFields,
      entriesSynced: 0, fieldsAdded: 0, defaultsFilled: 0,
      template: summarize(store, target),
    };
  }
  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldSync: { groups: addedGroups, fields: addedFields, entries: gapEntries.size, entryFields: entryFieldsToAdd },
      changedFields,
    };
  }

  if (addedGroups.length || addedFields.length) {
    await mutateStore((s) => {
      const t = mustFind(s, ref);
      t.fields = fields;
      t.updatedAt = nowIso();
    });
  }
  const synced = await syncEntryStructures(target.id);
  const after = await loadStore();
  return {
    status: 'ok', upToDate: false, id: target.id, addedGroups, addedFields, changedFields,
    entriesSynced: synced.entries, fieldsAdded: synced.fieldsAdded, defaultsFilled: synced.defaultsFilled,
    template: summarize(after, mustFind(after, target.id)),
  };
}

/**
 * 模板只参与初始化（0.43）：删模板**不删条目**——所有引用它的条目落到空白模板，
 * 条目自己的结构行（entry_fields）原样保留，内容一个字节都不动。
 * 这是真正的删除（模板行从库里移除），不是「隐藏」；`force` 保留参数只为 CLI 兼容。
 */
export async function removeTemplate(ref: unknown, { force, 'dry-run': dryRun }: { force?: boolean; 'dry-run'?: boolean } = {}) {
  void force;
  const store = await loadStore();
  const target = mustFind(store, ref);
  if (target.blank || target.id === BLANK_TEMPLATE_ID) throw blocked('空白条目模板是内置底座，不能删除。');
  const bound = store.entries.filter((e) => e.template === target.id);

  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldRemove: { id: target.id, title: target.title, entries: bound.length },
      wouldUnbind: bound.map((e) => e.id),
    };
  }

  await mutateStore((s) => {
    s.templates = s.templates.filter((x) => x.id !== target.id);
    for (const e of s.entries) if (e.template === target.id) e.template = BLANK_TEMPLATE_ID;
  });
  return { status: 'ok', removed: { id: target.id, title: target.title, entries: bound.length }, unbound: bound.length };
}

/** 一个条目模板的**全部信息**：字段字典 + 所有条目 + 未填清单。 */
export async function dump(ref: unknown, { mask }: { mask?: boolean } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const mine = store.entries.filter((e) => e.template === s.id);
  const structures = entryStructures(store);
  const decrypt = await sensitiveViewer(s, mine, structures);
  // StoreTemplate / StoreEntry 与读取侧 TemplateLike / EntryLike 是同一份归一化数据，
  // 类型收紧后直接传，不再需要 as unknown as。
  // v3：条目按**自身结构行**序列化（扩展行的值也带得出去）。
  const data = dumpTemplate(s, store.entries, { mask: !!mask, decrypt, structures });
  // 表格字段的**现值**：计算列与统计行都在读的时候现算（不落盘），
  // 所以 `template dump --json` 拿到的合计与面板上看到的合计是同一个数。
  for (const e of data.entries) {
    const ownRows = structures.get(e.id) || null;
    // 任务 #20：脱离行不序列化现值（与 serializeEntry/defsForEntry 同一读边界）。
    const defs = ownRows ? ownRows.filter((r) => !isDetachedField(r)).map((r) => r.spec as unknown as FieldDef) : s.fields;
    const tables: Record<string, unknown> = {};
    for (const f of defs) {
      if (f.type === 'table') tables[f.key] = computeTable(f, e.values?.[f.key]);
    }
    if (Object.keys(tables).length) e.tables = tables;
  }
  return {
    ...data,
    generatedAt: nowIso(),
    mask: !!mask,
    groupIndex: boardGroupsOf(s.fields as any).map((g) => ({
      id: g.id,
      title: String(g.title),
      fields: (g.fields as Array<{ key: string }>).map((x) => x.key),
    })),
  };
}

/**
 * 模板视图（原「条目模板管理」页）：模板 → 用它初始化过的条目索引。
 * 这是**管理视角**，不是导航：左侧目录只认 entry tree；这里保留管理页的旧读法。
 */
export async function templateTree() {
  const store = await loadStore();
  const structures = entryStructures(store);
  const templates = store.templates
    .filter((s) => !(s.blank || s.id === BLANK_TEMPLATE_ID))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  return {
    count: templates.length,
    totalEntries: store.entries.length,
    templates: templates.map((s) => {
      const mine = store.entries.filter((e) => e.template === s.id);
      return {
        ...summarize(store, s),
        entryList: mine.map((e) => {
          const c = completeness(s, e, structures.get(e.id));
          return {
            id: e.id,
            title: e.title,
            ratio: c.ratio,
            filled: c.filled,
            total: c.total,
            updatedAt: e.updatedAt || null,
          };
        }),
      };
    }),
  };
}

/**
 * 兼容旧「条目模板树」读法：管理页仍要「模板 + 条目索引」。
 * 导航树（folders）在 modules/tree；这里不再输出条目父子结构。
 */
export async function tree() {
  return templateTree();
}

/**
 * 批量删模板（0.43）：同样只删模板、不删条目。
 * - 找不到的记 missing，其余照删（status: 'partial'）；
 * - 空白模板在选集中的，整批拒绝（它是所有无模板条目的底座）。
 */
export async function removeMany(refs: unknown, { force, 'dry-run': dryRun }: { force?: boolean; 'dry-run'?: boolean } = {}) {
  void force;
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要删除的条目模板（用 --ids 或位置参数给 id / 标题，逗号分隔）');

  const store = await loadStore();
  const targets: StoreTemplate[] = [];
  const missing: string[] = [];
  for (const ref of list) {
    const s = findTemplate(store, ref);
    if (!s) { missing.push(ref); continue; }
      if (s.blank || s.id === BLANK_TEMPLATE_ID) throw blocked('空白条目模板是内置底座，不能删除。');
    if (!targets.some((t) => t.id === s.id)) targets.push(s);
  }
  if (!targets.length) {
    throw notFound(`这些条目模板都不存在: ${list.join(', ')} —— 现有: ${templateNames(store)}`);
  }

  const bound = (s: StoreTemplate) => store.entries.filter((e) => e.template === s.id).length;
  const plan = targets.map((s) => ({ id: s.id, title: s.title, entries: bound(s) }));
  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: plan, count: plan.length, missing };

  await mutateStore((st) => {
    const ids = new Set(targets.map((t) => t.id));
    st.templates = st.templates.filter((x) => !ids.has(x.id));
    for (const e of st.entries) if (ids.has(e.template)) e.template = BLANK_TEMPLATE_ID;
  });
  return {
    status: missing.length ? 'partial' : 'ok',
    removed: plan,
    count: plan.length,
    unboundEntries: plan.reduce((n, p) => n + p.entries, 0),
    missing,
  };
}

// —— 门面：拆分出去的公开名字原样转出去，导出名集合与拆分前一致 ——
export { updateTemplate } from './update.ts';
export { validateFieldDef };
export {
  renderTemplateList,
  renderPresets,
  renderTemplateGet,
  renderTemplateDump,
  renderTemplateTree,
  renderTemplateReorder,
  renderTemplateRemoveMany,
  renderTemplateChange,
} from './render.ts';

