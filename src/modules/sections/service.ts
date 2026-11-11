// 栏目（section）：一组同构条目的容器 + 一份字段字典。
// 字典是**数据**不是代码分支，所以 agent 与面板看到的字段永远一致。
// v3：字典降级成「模板」——存量条目按自身结构行读写，sync 负责把缺口补进去。
import { loadStore, mutateStore, entryStructures, syncEntryStructures, isDetachedField, type StoreSection } from '../../core/store.ts';
import { assertSafeId } from '../../core/paths.ts';
import { badInput, blocked, conflict, notFound } from '../../core/errors.ts';
import { ensureSourceBuiltin, findSection, getTemplate, groupFields, instantiateTemplate, mergeTemplate, sectionNames, syncSectionGroups, templateSummaries } from '../../core/fields.ts';
import { computeTable } from '../../shared/table.ts';
import { groupsForLayout, reconcileLayout } from '../../shared/blockLayout.ts';
import { completeness, dumpSection } from '../../core/render.ts';
import { sensitiveViewer } from '../../core/vault.ts';
import { nowIso } from '../../core/ids.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
import { mustFind, summarize } from './common.ts';
import { validateFieldDef, validateGroupDef } from './validate.ts';

// 定位方式放宽：内部 id 与用户手上的标题都接受（实现在 core/fields.js，避免模块互依）。
export { findSection };

export async function listSections() {
  const store = await loadStore();
  return {
    count: store.sections.length,
    totalEntries: store.entries.length,
    sections: store.sections.map((s) => summarize(store, s)),
  };
}

export async function listTemplates() {
  return { count: templateSummaries().length, templates: templateSummaries() };
}

export async function getSection(ref: unknown) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  return {
    ...summarize(store, s),
    titleField: s.titleField,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    groupList: s.groups,
    fieldList: s.fields,
    // 版式（块布局）：agent 要照着改/复制版式时读这个字段，形状见 shared/blockLayout.js
    layout: reconcileLayout(s.layout, groupsForLayout(s)),
  };
}

export async function addSection({ id, title, template, description, order, fields, groups, 'dry-run': dryRun }: {
  id?: string;
  title?: string;
  template?: string;
  description?: string;
  order?: number;
  fields?: unknown[];
  groups?: unknown[];
  'dry-run'?: boolean;
} = {}) {
  const sid = assertSafeId(id, '栏目 id');
  const store = await loadStore();
  if (findSection(store, sid)) throw conflict(`栏目已存在: ${sid}（重复创建不会静默覆盖——换个 id，或用 section update）`);

  let draft: StoreSection;
  if (template) {
    const t = instantiateTemplate(template, { id: sid, title, description, order });
    if (!t) {
      const avail = templateSummaries().map((x) => x.id).join(' / ');
      throw badInput(`未知模板: ${template}（可用: ${avail}）`);
    }
    draft = { ...t, id: sid };
  } else {
    // 自定义栏目。groups/fields 先空着——用户的 --fields/--groups 应用完，
    // 再由 ensureSourceBuiltin 统一补上自带的「原始资料」袋（见下方）。
    draft = { id: sid, title: title || sid, description: description || '', order: Number.isFinite(order) ? (order as number) : 50, template: null, kv: false, titleField: null, titleLabel: '名称', groups: [], fields: [], createdAt: null, updatedAt: null };
  }
  if (Array.isArray(groups)) draft.groups = groups.map(validateGroupDef);
  if (Array.isArray(fields)) {
    const defaultGroup = draft.groups[0]?.id || 'other';
    draft.fields = fields.map((x) => validateFieldDef(x, { allowGroup: defaultGroup }));
  }
  // 与 normalize 同一条规则：--fields 引用了 --groups 没声明的分组时自动补上，
  // 否则面板按声明数组渲染会整组消失（CLI 从字段推导所以看不出来）。
  draft.groups = syncSectionGroups(draft.groups, draft.fields);
  // 「每个结构自带」：无论模板实例还是自定义栏目（也无论是否传了 --fields/--groups），
  // 非 KV 栏目都自带「原始资料」袋——杂乱资料先原样入袋，再按字段字典整理。
  const ensured = ensureSourceBuiltin(draft.groups, draft.fields, { kv: draft.kv });
  draft.groups = ensured.groups;
  draft.fields = ensured.fields;
  draft.createdAt = nowIso();
  draft.updatedAt = draft.createdAt;

  if (dryRun) return { status: 'skipped', dryRun: true, wouldCreate: summarize(store, draft) };

  await mutateStore((s) => { s.sections.push(draft); s.sections.sort((a, b) => a.order - b.order); });
  return { status: 'ok', created: true, section: summarize(store, draft) };
}

/**
 * 同步栏目结构（v3 两阶段，都**只增不改不删**）：
 *
 *   阶段 1（代码模板 → 栏目字典）：模板里新增、而本栏目还缺的分组与字段补进字典。
 *     栏目字段字典是持久化数据，模板演进不会回溯——跑一次 sync 把缺口补上。
 *   阶段 2（栏目字典 → 存量条目结构行）：字典里条目还缺的行补进每个条目
 *     （写时复制的跟进通道；新行若字典带 defaultValue 则落默认值）。
 *
 * 非模板栏目不再报错：阶段 1 跳过，阶段 2 照做（用栏目自己的字典）——
 * 「add-field 之后让存量条目长出新行」正是这条命令在 v3 的主要用途。
 */
export async function syncSection(ref: unknown, { 'dry-run': dryRun }: { 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = mustFind(store, ref);

  // ── 阶段 1：代码模板 → 栏目字典 ──
  let groups = target.groups;
  let fields = target.fields;
  let addedGroups: string[] = [];
  let addedFields: string[] = [];
  let changedFields: Array<{ key: string; diff: string[] }> = [];
  if (target.template) {
    const tpl = getTemplate(target.template);
    if (!tpl) throw badInput(`栏目记录了模板 ${target.template}，但该模板已不存在（可能被重命名或移除）。`);
    ({ groups, fields, addedGroups, addedFields, changedFields } = mergeTemplate(target, tpl));
  }

  // ── 阶段 2：栏目字典 → 存量条目结构行 ──
  const structures = entryStructures(store);
  const dictKeys = new Set(fields.map((f) => f.key));
  const mine = store.entries.filter((e) => e.section === target.id);
  let entryFieldsToAdd = 0;
  const gapEntries = new Set<string>();
  for (const e of mine) {
    const rowKeys = new Set((structures.get(e.id) || []).map((r) => r.key));
    for (const k of dictKeys) {
      if (!rowKeys.has(k)) { entryFieldsToAdd += 1; gapEntries.add(e.id); }
    }
  }

  // 漂移只是**提示**：定义归栏目，sync 绝不覆盖用户改过的 label/hint/fill。
  // upToDate 看「两阶段都没有可补的」——否则用户改过一个标签，就会永远报「不是最新」。
  if (!addedGroups.length && !addedFields.length && !entryFieldsToAdd) {
    return {
      status: 'ok', upToDate: true, id: target.id,
      addedGroups: [], addedFields: [], changedFields,
      entriesSynced: 0, fieldsAdded: 0, defaultsFilled: 0,
      section: summarize(store, target),
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
      t.groups = groups;
      t.fields = fields;
      t.updatedAt = nowIso();
    });
  }
  const synced = await syncEntryStructures(target.id);
  const after = await loadStore();
  return {
    status: 'ok', upToDate: false, id: target.id, addedGroups, addedFields, changedFields,
    entriesSynced: synced.entries, fieldsAdded: synced.fieldsAdded, defaultsFilled: synced.defaultsFilled,
    section: summarize(after, mustFind(after, target.id)),
  };
}

/**
 * remove 的幂等性选择：**报 NOT_FOUND**（默认推荐）——能从错别字里救用户一把。
 * 这条写进 summary，两端一致。
 */
export async function removeSection(ref: unknown, { force, 'dry-run': dryRun }: { force?: boolean; 'dry-run'?: boolean } = {}) {
  const store = await loadStore();
  const target = mustFind(store, ref);
  const owned = store.entries.filter((e) => e.section === target.id);

  if (owned.length && !force) {
    throw blocked(`栏目「${target.title}」下还有 ${owned.length} 条条目，删除会一并删掉。确认就加 --force。`);
  }
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, title: target.title, entries: owned.length } };
  }

  await mutateStore((s) => {
    s.sections = s.sections.filter((x) => x.id !== target.id);
    s.entries = s.entries.filter((e) => e.section !== target.id);
  });
  return { status: 'ok', removed: { id: target.id, title: target.title, entries: owned.length } };
}

/** 一个栏目的**全部信息**：字段字典 + 所有条目 + 未填清单。 */
export async function dump(ref: unknown, { mask }: { mask?: boolean } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const mine = store.entries.filter((e) => e.section === s.id);
  const structures = entryStructures(store);
  const decrypt = await sensitiveViewer(s, mine, structures);
  // StoreSection / StoreEntry 与读取侧 SectionLike / EntryLike 是同一份归一化数据，
  // 类型收紧后直接传，不再需要 as unknown as。
  // v3：条目按**自身结构行**序列化（扩展行的值也带得出去）。
  const data = dumpSection(s, store.entries, { mask: !!mask, decrypt, structures });
  // 表格字段的**现值**：计算列与统计行都在读的时候现算（不落盘），
  // 所以 `section dump --json` 拿到的合计与面板上看到的合计是同一个数。
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
    groupIndex: groupFields(s.fields).map((g) => ({
      id: g.id,
      title: s.groups.find((x) => x.id === g.id)?.title || g.id,
      fields: ((g.fields || []) as Array<{ key: string }>).map((x) => x.key),
    })),
  };
}

/**
 * 栏目树：栏目 → 条目的一层结构，供面板的「栏目管理」用。
 *
 * 为什么不让面板逐个 `section dump` 自己拼：那样 N 个栏目就是 N 次请求，
 * 而且面板会拿到每个条目的**全部字段值**——树只需要名字和完整度，多传的都是噪音。
 * 这里一次给齐：栏目摘要 + 它的条目索引（id / 名称 / 完整度）。
 */
export async function tree() {
  const store = await loadStore();
  const structures = entryStructures(store);
  return {
    count: store.sections.length,
    totalEntries: store.entries.length,
    sections: store.sections.map((s) => {
      const mine = store.entries.filter((e) => e.section === s.id);
      return {
        ...summarize(store, s),
        // entryList 而不是 entries：summarize 里的 entries 已经是**数量**，
        // 两个字段同名会让「3 条」和「三条记录」在某处悄悄互换。
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
 * 批量删栏目 —— 语义等同「删文件夹」：连带里面的条目。
 *
 * 三条与单个删除不同的地方，都是「一批」带来的：
 *   - **要么全删要么全不动**：有任何一个栏目非空且没给 force，整批拒绝（不删一半）；
 *   - **找不到的记在 missing 里**，其余照删（status: 'partial'），因为批量删除时
 *     「另一个标签页刚删掉一个」比整批失败更常见；
 *   - 重复的引用（同时给了 id 和标题）去重，不会删第二遍。
 */
export async function removeMany(refs: unknown, { force, 'dry-run': dryRun }: { force?: boolean; 'dry-run'?: boolean } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要删的栏目（用 --ids 或位置参数给 id / 标题，逗号分隔）');

  const store = await loadStore();
  const targets: StoreSection[] = [];
  const missing: string[] = [];
  for (const ref of list) {
    const s = findSection(store, ref);
    if (!s) { missing.push(ref); continue; }
    if (!targets.some((t) => t.id === s.id)) targets.push(s);
  }
  if (!targets.length) {
    throw notFound(`这些栏目都不存在: ${list.join(', ')} —— 现有: ${sectionNames(store)}`);
  }

  const owned = (s: StoreSection) => store.entries.filter((e) => e.section === s.id);
  const totalEntries = targets.reduce((n, s) => n + owned(s).length, 0);
  const nonEmpty = targets.filter((s) => owned(s).length);
  if (nonEmpty.length && !force) {
    throw blocked(
      `这批里有 ${nonEmpty.length} 个栏目非空（共 ${totalEntries} 条条目），删除会一并删掉：`
      + `${nonEmpty.slice(0, 5).map((s) => `${s.title}(${owned(s).length})`).join('、')}`
      + `${nonEmpty.length > 5 ? ' 等' : ''}。确认就加 --force。`,
    );
  }

  const plan = targets.map((s) => ({ id: s.id, title: s.title, entries: owned(s).length }));
  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: plan, count: plan.length, missing };

  await mutateStore((st) => {
    const ids = new Set(targets.map((t) => t.id));
    st.sections = st.sections.filter((x) => !ids.has(x.id));
    st.entries = st.entries.filter((e) => !ids.has(e.section));
  });
  return {
    status: missing.length ? 'partial' : 'ok',
    removed: plan,
    count: plan.length,
    removedEntries: totalEntries,
    missing,
  };
}

// —— 门面：拆分出去的公开名字原样转出去，导出名集合与拆分前一致 ——
export { updateSection } from './update.ts';
export { validateFieldDef };
export {
  renderSectionList,
  renderTemplates,
  renderSectionGet,
  renderSectionDump,
  renderSectionTree,
  renderSectionRemoveMany,
  renderSectionChange,
} from './render.ts';
