// 栏目（section）：一组同构条目的容器 + 一份字段字典。
// 字典是**数据**不是代码分支，所以 agent 与面板看到的字段永远一致。
import { loadStore, mutateStore, snapshotStore } from '../../core/store.js';
import { assertFieldKey, assertSafeId } from '../../core/paths.js';
import { badInput, blocked, conflict, notFound } from '../../core/errors.js';
import { FILL_POLICIES, FIELD_TYPES, findSection, groupFields, instantiateTemplate, sectionNames, syncSectionGroups, templateSummaries } from '../../core/fields.js';
import { dumpSection, formatValue } from '../../core/render.js';
import { sensitiveViewer } from '../../core/vault.js';
import { nowIso } from '../../core/ids.js';

// 定位方式放宽：内部 id 与用户手上的标题都接受（实现在 core/fields.js，避免模块互依）。
export { findSection };

function mustFind(store, ref) {
  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

function countEntries(store, id) {
  return store.entries.filter((e) => e.section === id).length;
}

function summarize(store, s) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    order: s.order,
    template: s.template,
    kv: s.kv === true,
    titleLabel: s.titleLabel,
    groups: s.groups.length,
    fields: s.fields.length,
    entries: countEntries(store, s.id),
  };
}

export function validateFieldDef(raw, { allowGroup } = {}) {
  if (!raw || typeof raw !== 'object') throw badInput('字段定义必须是对象');
  const key = assertFieldKey(raw.key);
  const type = raw.type || 'text';
  if (!FIELD_TYPES.includes(type)) throw badInput(`字段 ${key} 的 type 非法: ${type}（可用: ${FIELD_TYPES.join(' / ')}）`);
  const def = {
    key,
    label: String(raw.label || key),
    type,
    group: String(raw.group || allowGroup || 'other'),
  };
  if (raw.hint) def.hint = String(raw.hint);
  if (Array.isArray(raw.options) && raw.options.length) def.options = raw.options.map(String);
  if (raw.sensitive === true) def.sensitive = true;
  if (Number.isFinite(raw.maxItems)) def.maxItems = raw.maxItems;
  // 填写策略：**必须显式放行**。这个函数是白名单，没写在这里的键会被静默丢掉，
  // 而「静默丢掉」在这里的后果是「用户设了不填、完整度照旧算它」——很难查。
  if (raw.fill !== undefined) {
    if (!FILL_POLICIES.includes(raw.fill)) {
      throw badInput(`字段 ${key} 的 fill 非法: ${JSON.stringify(raw.fill)}（可用: ${FILL_POLICIES.join(' / ')}）`);
    }
    // 只有非 normal 才落盘：normal 是缺省值，写上去只是噪音，也会让「读」多一种形态
    if (raw.fill !== 'normal') def.fill = raw.fill;
  }
  return def;
}

function validateGroupDef(raw, idx) {
  if (!raw || typeof raw !== 'object') throw badInput('分组定义必须是对象');
  const id = assertSafeId(raw.id || `g${idx + 1}`, '分组 id');
  return { id, title: String(raw.title || id) };
}

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

export async function getSection(ref) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  return {
    ...summarize(store, s),
    titleField: s.titleField,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    groupList: s.groups,
    fieldList: s.fields,
  };
}

export async function addSection({ id, title, template, description, order, fields, groups, 'dry-run': dryRun } = {}) {
  const sid = assertSafeId(id, '栏目 id');
  const store = await loadStore();
  if (findSection(store, sid)) throw conflict(`栏目已存在: ${sid}（重复创建不会静默覆盖——换个 id，或用 section update）`);

  let draft;
  if (template) {
    const t = instantiateTemplate(template, { id: sid, title, description, order });
    if (!t) {
      const avail = templateSummaries().map((x) => x.id).join(' / ');
      throw badInput(`未知模板: ${template}（可用: ${avail}）`);
    }
    draft = t;
  } else {
    draft = { id: sid, title: title || sid, description: description || '', order: Number.isFinite(order) ? order : 50, template: null, kv: false, titleField: null, titleLabel: '名称', groups: [], fields: [] };
  }
  if (Array.isArray(groups)) draft.groups = groups.map(validateGroupDef);
  if (Array.isArray(fields)) {
    const defaultGroup = draft.groups[0]?.id || 'other';
    draft.fields = fields.map((x) => validateFieldDef(x, { allowGroup: defaultGroup }));
  }
  // 与 normalize 同一条规则：--fields 引用了 --groups 没声明的分组时自动补上，
  // 否则面板按声明数组渲染会整组消失（CLI 从字段推导所以看不出来）。
  draft.groups = syncSectionGroups(draft.groups, draft.fields);
  draft.createdAt = nowIso();
  draft.updatedAt = draft.createdAt;

  if (dryRun) return { status: 'skipped', dryRun: true, wouldCreate: summarize(store, draft) };

  const snapshot = await snapshotStore('section-add');
  await mutateStore((s) => { s.sections.push(draft); s.sections.sort((a, b) => a.order - b.order); });
  return { status: 'ok', created: true, section: summarize(store, draft), snapshot };
}

export async function updateSection(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = mustFind(store, ref);

  const changes = {};
  if (patch.title !== undefined) changes.title = String(patch.title);
  if (patch.description !== undefined) changes.description = String(patch.description);
  if (patch.order !== undefined) changes.order = Number(patch.order);
  if (patch.titleLabel !== undefined) changes.titleLabel = String(patch.titleLabel);
  // 标记/取消「本栏目是一张 KV 表」。取消要显式写 `--kv=false`（boolean flag 的 `=` 形式）
  if (patch.kv !== undefined) changes.kv = patch.kv === true;
  if (patch.titleField !== undefined) changes.titleField = patch.titleField ? assertFieldKey(patch.titleField) : null;
  if (patch.groups !== undefined) changes.groups = Array.isArray(patch.groups) ? patch.groups.map(validateGroupDef) : [];
  if (patch.fields !== undefined) {
    if (!Array.isArray(patch.fields)) throw badInput('--fields 需要是字段定义数组的 JSON');
    const fallback = (changes.groups || target.groups)[0]?.id || 'other';
    changes.fields = patch.fields.map((x) => validateFieldDef(x, { allowGroup: fallback }));
  }

  const addField = patch['add-field'];
  const removeField = patch['remove-field'];
  const nextFields = [...(changes.fields || target.fields)];
  const added = [];
  const removed = [];
  if (addField !== undefined) {
    const list = Array.isArray(addField) ? addField : [addField];
    for (const raw of list) {
      const def = validateFieldDef(raw, { allowGroup: nextFields[0]?.group || 'other' });
      if (nextFields.some((x) => x.key === def.key)) throw conflict(`字段已存在: ${def.key}`);
      nextFields.push(def);
      added.push(def.key);
    }
    changes.fields = nextFields;
  }
  if (removeField !== undefined) {
    const keys = Array.isArray(removeField) ? removeField : [removeField];
    for (const k of keys) {
      const idx = nextFields.findIndex((x) => x.key === k || x.label === k);
      if (idx < 0) throw notFound(`字段不存在: ${k}`);
      removed.push(nextFields[idx].key);
      nextFields.splice(idx, 1);
    }
    changes.fields = nextFields;
  }
  // —— 填写策略：--fill 字段=normal|optional|avoid ——
  // 放在 add/remove 之后，这样同一次调用里新加的字段也能顺手设策略。
  // 注意必须**复制**再改：nextFields 里是与 store 共享同一批对象引用的，
  // 就地改 def.fill 会在 snapshotStore() **之前**污染真实数据，快照就不再是「改动前」的了。
  const fillMap = patch.fill;
  const fillChanged = [];
  if (fillMap !== undefined && fillMap !== null) {
    if (typeof fillMap !== 'object' || Array.isArray(fillMap)) {
      throw badInput('--fill 要用 字段=策略 的写法，例如 --fill 入党时间=avoid');
    }
    for (const [ref0, policyRaw] of Object.entries(fillMap)) {
      const policy = String(policyRaw);
      if (!FILL_POLICIES.includes(policy)) {
        throw badInput(`--fill ${ref0} 的策略非法: ${JSON.stringify(policyRaw)}（可用: ${FILL_POLICIES.join(' / ')}）`);
      }
      const idx = nextFields.findIndex((x) => x.key === ref0 || x.label === ref0);
      if (idx < 0) {
        throw notFound(`字段不存在: ${ref0}（用 'nx-sk entry fields --section ${target.id}' 看现有字段）`);
      }
      const def = { ...nextFields[idx] };
      if (policy === 'normal') {
        if (def.fill === undefined) continue; // 已是缺省，不制造无意义的改动
        delete def.fill;
      } else {
        if (def.fill === policy) continue;
        def.fill = policy;
      }
      nextFields[idx] = def;
      fillChanged.push(`${def.key}=${policy}`);
      changes.fields = nextFields;
    }
  }

  if (!Object.keys(changes).length) {
    throw badInput('没有要修改的内容（可改 title / description / order / fields / groups / add-field / remove-field / fill）');
  }

  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: changes, added, removed, fillChanged };

  const snapshot = await snapshotStore('section-update');
  await mutateStore((s) => {
    const t = mustFind(s, ref);
    Object.assign(t, changes);
    t.updatedAt = nowIso();
    s.sections.sort((a, b) => a.order - b.order);
  });
  const after = await loadStore();
  return { status: 'ok', id: target.id, changed: Object.keys(changes), added, removed, fillChanged, section: summarize(after, mustFind(after, target.id)), snapshot };
}

/**
 * remove 的幂等性选择：**报 NOT_FOUND**（默认推荐）——能从错别字里救用户一把。
 * 这条写进 summary，两端一致。
 */
export async function removeSection(ref, { force, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = mustFind(store, ref);
  const owned = store.entries.filter((e) => e.section === target.id);

  if (owned.length && !force) {
    throw blocked(`栏目「${target.title}」下还有 ${owned.length} 条条目，删除会一并删掉。确认就加 --force。`);
  }
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, title: target.title, entries: owned.length } };
  }

  const snapshot = await snapshotStore(`section-remove-${target.id}`);
  await mutateStore((s) => {
    s.sections = s.sections.filter((x) => x.id !== target.id);
    s.entries = s.entries.filter((e) => e.section !== target.id);
  });
  return { status: 'ok', removed: { id: target.id, title: target.title, entries: owned.length }, snapshot };
}

/** 一个栏目的**全部信息**：字段字典 + 所有条目 + 未填清单。 */
export async function dump(ref, { mask } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const mine = store.entries.filter((e) => e.section === s.id);
  const decrypt = await sensitiveViewer(s, mine);
  const data = dumpSection(s, store.entries, { mask: !!mask, decrypt });
  return {
    ...data,
    generatedAt: nowIso(),
    mask: !!mask,
    groupIndex: groupFields(s.fields).map((g) => ({
      id: g.id,
      title: s.groups.find((x) => x.id === g.id)?.title || g.id,
      fields: g.fields.map((x) => x.key),
    })),
  };
}

// —— CLI 人读渲染 ——
export function renderSectionList(d) {
  const lines = [`${d.count} 个栏目 · 共 ${d.totalEntries} 条条目`];
  for (const s of d.sections) {
    const tag = s.kv ? '[KV 表] ' : '';
    lines.push(`  ${s.id.padEnd(12)} ${s.title}　${tag}${s.entries} 条 / ${s.fields} 字段　${s.description}`);
  }
  lines.push('', '看某栏目全部信息: nx-sk section dump <id>');
  return lines.join('\n');
}

export function renderTemplates(d) {
  const lines = ['可用栏目模板：'];
  for (const t of d.templates) lines.push(`  ${t.id.padEnd(10)} ${t.label}　${t.groups} 组 / ${t.fields} 字段　${t.description}`);
  lines.push('', '用法: nx-sk section add <id> --title <标题> --template <模板id>');
  return lines.join('\n');
}

export function renderSectionGet(d) {
  const lines = [
    `栏目 ${d.id} · ${d.title}`,
    `描述:   ${d.description}`,
    `字段:   ${d.fields} 个 / ${d.groups} 组 · 条目 ${d.entries} 条`,
    `名称字段: ${d.titleField || '（未设）'}`,
  ];
  for (const g of groupFields(d.fieldList)) {
    const gtitle = d.groupList.find((x) => x.id === g.id)?.title || g.id;
    lines.push('', `${gtitle}（${g.id}）`);
    for (const x of g.fields) {
      lines.push(`  ${x.key.padEnd(24)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.hint ? `　${x.hint}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function renderSectionDump(d) {
  const groupTitle = (id) => (d.groups.find((x) => x.id === id)?.title) || id;
  const lines = [
    `栏目 ${d.section.id} · ${d.section.title}　${d.count} 条条目 · ${d.section.fields} 字段${d.mask ? ' · 已打码' : ''}`,
    d.section.description,
  ];
  for (const e of d.entries) {
    lines.push('', `── ${e.title || e.id}（${e.id}）　完整度 ${e.completeness.filled}/${e.completeness.total} = ${e.completeness.ratio}%`);
    let cur = null;
    for (const f of d.fields) {
      if (f.group !== cur) { cur = f.group; lines.push(`  ${groupTitle(cur)}`); }
      const v = e.values[f.key];
      lines.push(`    ${f.label}: ${formatValue(v) || '（未填写）'}`);
    }
  }
  lines.push('', '机器可读: 加 --json');
  return lines.join('\n');
}

export function renderSectionChange(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove)}`;
  // `removed` 在两条路径上形状不同：remove 给的是**对象** {id,title,entries}，
  // update 给的是**被删字段 key 的数组**。数组恒为真值，所以必须显式排除数组——
  // 否则 `section update` 会打印「已删除栏目 undefined」，
  // 而 `.entries` 还会取到 Array.prototype.entries 变成 `function entries() { [native code] }`。
  if (d.removed && !Array.isArray(d.removed)) {
    return `已删除栏目 ${d.removed.id}（连带 ${d.removed.entries} 条条目）\n快照: ${d.snapshot}`;
  }
  if (d.created) return `已创建栏目 ${d.section.id} · ${d.section.title}（${d.section.fields} 字段）\n快照: ${d.snapshot}`;
  const extra = [
    d.added?.length ? `新增字段 ${d.added.join(', ')}` : '',
    d.removed?.length ? `删除字段 ${d.removed.join(', ')}` : '',
    d.fillChanged?.length ? `填写策略 ${d.fillChanged.join(', ')}` : '',
  ].filter(Boolean).join('；');
  return `已更新栏目 ${d.id}：${d.changed.join(', ')}${extra ? `\n${extra}` : ''}\n快照: ${d.snapshot}`;
}
