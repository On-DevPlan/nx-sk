// 栏目（section）：一组同构条目的容器 + 一份字段字典。
// 字典是**数据**不是代码分支，所以 agent 与面板看到的字段永远一致。
import { loadStore, mutateStore } from '../../core/store.js';
import { assertFieldKey, assertSafeId } from '../../core/paths.js';
import { badInput, blocked, conflict, notFound } from '../../core/errors.js';
import { FILL_POLICIES, FIELD_TYPES, SOURCE_GROUP, ensureSourceBuiltin, findSection, getTemplate, groupFields, instantiateTemplate, mergeTemplate, sectionNames, syncSectionGroups, templateSummaries } from '../../core/fields.js';
import { computeTable, sanitizeColumns, sanitizeTotals } from '../../shared/table.js';
import { VIEW_LABELS, VIEW_TYPES, effectiveDefaultViewId, effectiveViews, isViewId } from '../../shared/views.js';
import { completeness, dumpSection, formatValue } from '../../core/render.js';
import { sensitiveViewer } from '../../core/vault.js';
import { newId, nowIso } from '../../core/ids.js';

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
  // entrylist（结构清单）的列就是它自己的小字典：不声明列就没法渲染、没法校验。
  // 其它类型声明 fields/columns 一律拒绝——字典里不该有「定义了也用不上」的键。
  if (type === 'entrylist') {
    if (!Array.isArray(raw.fields) || !raw.fields.length) {
      throw badInput(`字段 ${key} 是 entrylist（结构清单），必须声明子字段 fields。`
        + `例如 fields:[{"key":"url","label":"链接"},{"key":"pass","label":"密码","sensitive":true}]`);
    }
    const seen = new Set();
    def.fields = raw.fields.map((s) => {
      if (!s || typeof s !== 'object') throw badInput(`字段 ${key} 的子字段必须是对象，收到 ${JSON.stringify(s)}`);
      const sk = assertFieldKey(String(s.key || '').trim());
      if (seen.has(sk)) throw badInput(`字段 ${key} 的子字段 key 重复: ${sk}`);
      seen.add(sk);
      const out = { key: sk, label: String(s.label || sk) };
      if (s.sensitive === true) out.sensitive = true;
      if (s.hint) out.hint = String(s.hint);
      return out;
    });
  } else if (type === 'table') {
    // 表格：**结构归数据**。字段定义里只放「初始列」（新建条目时表格长什么样），
    // 条目自己的 columns 才是权威 —— 编辑时加一列不必回去改所有条目共用的 schema。
    // 所以 columns 在这里是**可选**的；给了就要合法（key 唯一、下拉有选项、公式能编译）。
    const cols = Array.isArray(raw.columns) ? raw.columns : raw.fields;
    if (raw.fields !== undefined && raw.columns !== undefined) {
      throw badInput(`字段 ${key}：columns 与 fields 是同一个东西的两种写法，只留一个。`);
    }
    if (cols !== undefined) {
      if (!Array.isArray(cols)) throw badInput(`字段 ${key} 的 columns 必须是数组`);
      // 空数组 = 不设初始列（表格完全由数据自己定义）。不落盘，免得字典里多一个空键。
      if (cols.length) {
        try {
          def.columns = sanitizeColumns(cols, { where: `字段 ${key}` });
        } catch (e) {
          throw badInput(e.message);
        }
      }
    }
    if (raw.totals !== undefined) {
      // 没有初始列时没法核对 agg 里的列名（列在数据里）；这时先原样存下，
      // 渲染时对不上的格子会自己报「没有这一列」，不会静默算错。
      if (!Array.isArray(raw.totals)) throw badInput(`字段 ${key} 的 totals 必须是数组`);
      if (def.columns?.length) {
        try {
          def.totals = sanitizeTotals(raw.totals, def.columns, { where: `字段 ${key}` });
        } catch (e) {
          throw badInput(e.message);
        }
      } else {
        def.totals = raw.totals.map((t) => ({ ...t }));
      }
    }
    if (raw.summary === false) def.summary = false;
    if (raw.maxRows !== undefined) {
      const n = Number(raw.maxRows);
      if (!Number.isFinite(n) || n <= 0) throw badInput(`字段 ${key} 的 maxRows 要是正数`);
      def.maxRows = Math.floor(n);
    }
  } else if (raw.fields !== undefined || raw.columns !== undefined) {
    throw badInput(`字段 ${key} 不是 entrylist / table，不能声明 ${raw.columns !== undefined ? 'columns' : 'fields'}（只有清单类字段有列）`);
  }
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

/** 字段定位：key 优先，其次标签（CLI 里人更愿意写「求职状态」而不是 jobStatus）。 */
function indexOfField(fields, ref) {
  const s = String(ref ?? '').trim();
  const i = fields.findIndex((x) => x.key === s);
  if (i >= 0) return i;
  return fields.findIndex((x) => String(x.label) === s);
}

// 改动摘要里说什么：只报用户看得懂的几项，且**必须报出新旧值**——
// 「已更新栏目 x：fields」这种输出等于没说，出了错没法回溯。
const FIELD_PATCH_LABELS = {
  label: '标签', type: '类型', group: '分组', hint: '提示',
  options: '选项', maxItems: '最多几条', fill: '填写策略', sensitive: '密文',
};

function showPatchValue(v) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (Array.isArray(v)) return v.length ? v.join(' / ') : '（空）';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function describeFieldPatch(before, after) {
  const bits = [];
  for (const [k, name] of Object.entries(FIELD_PATCH_LABELS)) {
    if (showPatchValue(before?.[k]) === showPatchValue(after?.[k])) continue;
    bits.push(`${name} ${showPatchValue(before?.[k])} → ${showPatchValue(after?.[k])}`);
  }
  return bits.length ? bits.join('，') : '无变化';
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
    // 自定义栏目。groups/fields 先空着——用户的 --fields/--groups 应用完，
    // 再由 ensureSourceBuiltin 统一补上自带的「原始资料」袋（见下方）。
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

  // —— 字段级改动：--set-field / --move-field ——
  // 面板要能改字段的名字、类型、分组、提示（用户提过「web 里只能加不能改」）。
  // key 刻意**不能改**：条目里的值按 key 存，改 key = 已有值读不出来。
  // 这两个操作与 add/remove 走同一处，规则不会分叉：改完的整份定义仍过 validateFieldDef。
  const ops = [];
  const setField = patch['set-field'];
  if (setField !== undefined) {
    const list = Array.isArray(setField) ? setField : [setField];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') {
        throw badInput('--set-field 需要对象，例如 \'{"key":"phone","label":"手机号"}\'');
      }
      const ref = String(raw.key ?? '').trim();
      if (!ref) throw badInput('--set-field 需要 key');
      const idx = indexOfField(nextFields, ref);
      if (idx < 0) throw notFound(`字段不存在: ${ref}（用 'nx-sk section get ${target.id}' 看字段 key / 标签）`);
      const cur = nextFields[idx];
      // key 一律以**现 key** 为准：条目里的值按 key 存，改 key = 已有值读不出来。
      // 传了不存在的 key 早在上面 indexOfField 处就报「字段不存在」——没有「改 key」这条路。
      const merged = { ...cur, ...raw, key: cur.key };
      // 换类型时清掉「只属于清单类字段」的键：columns/fields 留在普通字段上是噪音，
      // validateFieldDef 也会因此拒绝（不是 entrylist/table 却带着 columns）。
      if (merged.type && merged.type !== cur.type) {
        for (const k of ['fields', 'columns', 'totals', 'summary', 'maxRows']) delete merged[k];
      }
      const def = validateFieldDef(merged, { allowGroup: cur.group });
      nextFields[idx] = def;
      changes.fields = nextFields;
      ops.push(`字段 ${def.key}：${describeFieldPatch(cur, def)}`);
    }
  }
  const moveField = patch['move-field'];
  if (moveField !== undefined) {
    const list = Array.isArray(moveField) ? moveField : [moveField];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--move-field 需要对象，例如 \'{"key":"phone","dir":"up"}\'');
      const ref = String(raw.key ?? '').trim();
      const dir = String(raw.dir ?? '').trim();
      if (!ref) throw badInput('--move-field 需要 key');
      if (dir !== 'up' && dir !== 'down') throw badInput(`--move-field 的 dir 只能是 up / down，收到 ${JSON.stringify(raw.dir)}`);
      const i = indexOfField(nextFields, ref);
      if (i < 0) throw notFound(`字段不存在: ${ref}`);
      const gid = nextFields[i].group || 'other';
      // 同组字段在数组里未必连续（fields 是全局顺序），所以「相邻」要**在本组内**找
      let j = -1;
      if (dir === 'up') for (let k = i - 1; k >= 0; k -= 1) if ((nextFields[k].group || 'other') === gid) { j = k; break; }
      else for (let k = i + 1; k < nextFields.length; k += 1) if ((nextFields[k].group || 'other') === gid) { j = k; break; }
      if (j < 0) {
        throw badInput(`字段 ${nextFields[i].key} 已经是分组「${gid}」的${dir === 'up' ? '第一' : '最后一'}个`);
      }
      [nextFields[i], nextFields[j]] = [nextFields[j], nextFields[i]];
      changes.fields = nextFields;
      ops.push(`字段 ${nextFields[j].key} 在分组「${gid}」里${dir === 'up' ? '上移' : '下移'}`);
    }
  }

  // —— 分组结构：--add-group / --rename-group / --move-group / --remove-group ——
  // 栏目的骨架（分几组、谁在前、叫什么）过去只有模板和 --groups 整体替换两条路，
  // 面板连「加一个分组」都做不到。这四个操作让面板与 CLI 共用同一份规则：
  //   · id 唯一（重复 = CONFLICT，绝不静默覆盖同名分组）
  //   · **非空分组不许删**——字段上挂着每个条目的值，「删组连带删字段」比拦下来贵得多
  //   · 内置「原始资料」分组不可删（每个栏目自带，删了下回读又补回来，删了等于没删）
  const nextGroups = [...(changes.groups || target.groups)];
  const addGroup = patch['add-group'];
  if (addGroup !== undefined) {
    const list = Array.isArray(addGroup) ? addGroup : [addGroup];
    for (const raw of list) {
      const g = validateGroupDef(raw, nextGroups.length);
      if (nextGroups.some((x) => x.id === g.id)) throw conflict(`分组已存在: ${g.id}（改名用 --rename-group，不要重建）`);
      // 新分组建在末尾；但若末尾是内置的「原始资料」袋，插到它前面——
      // 那个袋子是收尾用的乱入区，不该把正经分组压在它后面（建栏目时它本来就在最后）。
      const at = nextGroups.length && nextGroups[nextGroups.length - 1].id === SOURCE_GROUP.id
        ? nextGroups.length - 1
        : nextGroups.length;
      nextGroups.splice(at, 0, g);
      changes.groups = nextGroups;
      ops.push(`新增分组 ${g.id}（${g.title}）`);
    }
  }
  const renameGroup = patch['rename-group'];
  if (renameGroup !== undefined) {
    const list = Array.isArray(renameGroup) ? renameGroup : [renameGroup];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--rename-group 需要对象，例如 \'{"id":"basic","title":"基本信息"}\'');
      const id = String(raw.id ?? '').trim();
      if (!id) throw badInput('--rename-group 需要 id');
      const i = nextGroups.findIndex((g) => g.id === id);
      if (i < 0) throw notFound(`分组不存在: ${id}（现有: ${nextGroups.map((g) => g.id).join(', ') || '（无）'}）`);
      const title = String(raw.title ?? '').trim();
      if (!title) throw badInput(`分组 ${id} 的新名字不能为空`);
      // id 也可以改：字段上的 group 引用要跟着走，否则整组字段会从表单里消失
      let nid = id;
      let moved = 0;
      if (raw.newId !== undefined && String(raw.newId).trim() && String(raw.newId).trim() !== id) {
        nid = assertSafeId(String(raw.newId).trim(), '分组 id');
        if (nextGroups.some((g) => g.id === nid)) throw conflict(`分组已存在: ${nid}`);
        for (let k = 0; k < nextFields.length; k += 1) {
          if ((nextFields[k].group || 'other') !== id) continue;
          nextFields[k] = { ...nextFields[k], group: nid };
          moved += 1;
        }
        if (moved) changes.fields = nextFields;
      }
      nextGroups[i] = { id: nid, title };
      changes.groups = nextGroups;
      ops.push(nid === id ? `分组 ${id} 改名为「${title}」` : `分组 ${id} → ${nid}（${title}，${moved} 个字段跟着改）`);
    }
  }
  const moveGroup = patch['move-group'];
  if (moveGroup !== undefined) {
    const list = Array.isArray(moveGroup) ? moveGroup : [moveGroup];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--move-group 需要对象，例如 \'{"id":"basic","dir":"up"}\'');
      const id = String(raw.id ?? '').trim();
      const dir = String(raw.dir ?? '').trim();
      if (!id) throw badInput('--move-group 需要 id');
      if (dir !== 'up' && dir !== 'down') throw badInput(`--move-group 的 dir 只能是 up / down，收到 ${JSON.stringify(raw.dir)}`);
      const i = nextGroups.findIndex((g) => g.id === id);
      if (i < 0) throw notFound(`分组不存在: ${id}`);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= nextGroups.length) throw badInput(`分组 ${id} 已经是${dir === 'up' ? '第一' : '最后一'}个`);
      [nextGroups[i], nextGroups[j]] = [nextGroups[j], nextGroups[i]];
      changes.groups = nextGroups;
      ops.push(`分组 ${id} ${dir === 'up' ? '上移' : '下移'}（${nextGroups.map((g) => g.id).join(' → ')}）`);
    }
  }
  const removeGroup = patch['remove-group'];
  if (removeGroup !== undefined) {
    const ids = Array.isArray(removeGroup) ? removeGroup : [removeGroup];
    for (const raw of ids) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      if (id === SOURCE_GROUP.id) {
        throw badInput(`「${SOURCE_GROUP.title}」是每个栏目自带的内置分组（删了下回读又会补回来），不给删。`);
      }
      const i = nextGroups.findIndex((g) => g.id === id);
      if (i < 0) throw notFound(`分组不存在: ${id}`);
      const inUse = nextFields.filter((f) => (f.group || 'other') === id).map((f) => f.key);
      if (inUse.length) {
        throw blocked(`分组 ${id} 里还有 ${inUse.length} 个字段：${inUse.slice(0, 8).join(', ')}${inUse.length > 8 ? '…' : ''}。`
          + `先把它们挪走（--set-field '{"key":"…","group":"…"}'）或删掉，再删这个分组。`);
      }
      nextGroups.splice(i, 1);
      changes.groups = nextGroups;
      ops.push(`删除分组 ${id}`);
    }
  }

  // 不变量：分组声明 ⊇ 字段引用。add-field / rename-group 若引用或产生了未声明的分组，
  // 必须在这里补上声明——否则面板读声明数组渲染，整组字段会静默消失
  // （CLI 从字段推导所以看不出来，这个坑在 servers 栏目踩过一次）。
  if (changes.fields) {
    const base = changes.groups || target.groups;
    const synced = syncSectionGroups(base, changes.fields);
    if (synced.length !== base.length) changes.groups = synced;
  }

  if (!Object.keys(changes).length) {
    throw badInput('没有要修改的内容（可改 title / description / order / fields / groups / add-field / set-field / move-field / remove-field / add-group / rename-group / move-group / remove-group / fill）');
  }

  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: changes, added, removed, fillChanged, ops };

  await mutateStore((s) => {
    const t = mustFind(s, ref);
    Object.assign(t, changes);
    t.updatedAt = nowIso();
    s.sections.sort((a, b) => a.order - b.order);
  });
  const after = await loadStore();
  return {
    status: 'ok', id: target.id, changed: Object.keys(changes),
    added, removed, fillChanged, ops,
    section: summarize(after, mustFind(after, target.id)),
  };
}

/**
 * 按模板补齐栏目字段：把模板里新增、而本栏目还缺的分组与字段补进来（只增不改不删）。
 *
 * 用途：栏目字段字典是持久化数据，模板演进不会回溯。用户在模板里加了字段
 * （例如给求职加了 `file` 类型的「附件资料」组），但**已经建好的栏目**看不到——
 * 跑一次 `section sync` 就能把缺口补上，且不动用户已有的定义与数据。
 */
export async function syncSection(ref, { 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = mustFind(store, ref);
  if (!target.template) {
    throw badInput(`栏目「${target.title}」不是由模板创建的（template 为空），没有可同步的模板；加字段请用 section update --add-field。`);
  }
  const tpl = getTemplate(target.template);
  if (!tpl) throw badInput(`栏目记录了模板 ${target.template}，但该模板已不存在（可能被重命名或移除）。`);

  const { groups, fields, addedGroups, addedFields, changedFields } = mergeTemplate(target, tpl);
  // 漂移只是**提示**：定义归栏目，sync 绝不覆盖用户改过的 label/hint/fill。
  // upToDate 仍只看「有没有可补的」——否则用户改过一个标签，就会永远报「不是最新」。
  if (!addedGroups.length && !addedFields.length) {
    return {
      status: 'ok', upToDate: true, id: target.id,
      addedGroups: [], addedFields: [], changedFields,
      section: summarize(store, target),
    };
  }
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldSync: { groups: addedGroups, fields: addedFields }, changedFields };
  }

  await mutateStore((s) => {
    const t = mustFind(s, ref);
    t.groups = groups;
    t.fields = fields;
    t.updatedAt = nowIso();
  });
  const after = await loadStore();
  return {
    status: 'ok', id: target.id, addedGroups, addedFields, changedFields,
    section: summarize(after, mustFind(after, target.id)),
  };
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

  await mutateStore((s) => {
    s.sections = s.sections.filter((x) => x.id !== target.id);
    s.entries = s.entries.filter((e) => e.section !== target.id);
  });
  return { status: 'ok', removed: { id: target.id, title: target.title, entries: owned.length } };
}

/** 一个栏目的**全部信息**：字段字典 + 所有条目 + 未填清单。 */
export async function dump(ref, { mask } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const mine = store.entries.filter((e) => e.section === s.id);
  const decrypt = await sensitiveViewer(s, mine);
  const data = dumpSection(s, store.entries, { mask: !!mask, decrypt });
  // 表格字段的**现值**：计算列与统计行都在读的时候现算（不落盘），
  // 所以 `section dump --json` 拿到的合计与面板上看到的合计是同一个数。
  for (const e of data.entries) {
    const tables = {};
    for (const f of s.fields) {
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
      fields: g.fields.map((x) => x.key),
    })),
  };
}

// —— 数据库视图（section.views，S2）——
//
// 三条纪律（设计 §19 / §八 8.2）：
//   ① **缺省视图只在读路径推断**（shared/views.js），用户第一次改视图才落盘；
//   ② 投影只存 key / width / hidden —— 标签、类型、候选值一律回查字段字典（单一事实源）；
//   ③ 「视图配置」是数据（section.views），「当前选中哪个视图」是视图态（settings.ui）。

/** 字段引用索引：key 与 label 都能定位（CLI 里人更愿意写「求职状态」而不是 jobStatus）。 */
function fieldIndex(section) {
  const byRef = new Map();
  for (const f of section.fields || []) {
    byRef.set(f.key, f);
    if (f.label) byRef.set(String(f.label), f);
  }
  return byRef;
}

function resolveFieldRef(section, ref, { where }) {
  const hit = fieldIndex(section).get(String(ref));
  if (!hit) {
    throw badInput(`${where} 引用了不存在的字段: ${ref}（用 'nx-sk section get ${section.id}' 看字段 key / 标签）`);
  }
  return hit.key;
}

function resolveViewId(raw) {
  const id = String(raw ?? '').trim();
  if (!isViewId(id)) {
    throw badInput(`视图 id 非法: ${JSON.stringify(raw)}（只收字母数字与 _ . : -，最长 64；建议 v_xxx）`);
  }
  return id;
}

/** columns 收三种写法：['姓名'] / [{key:'姓名'}] / [{key,width,hidden}]。 */
function validateViewColumns(section, raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const byRef = fieldIndex(section);
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const refRaw = typeof c === 'string' || typeof c === 'number' ? c : (c && (c.key ?? c.ref));
    const ref = String(refRaw ?? '').trim();
    if (!ref) continue;
    const def = byRef.get(ref);
    if (!def) {
      throw badInput(`columns 里没有这个字段: ${ref}（投影只认字段字典里的 key 或标签）`);
    }
    if (seen.has(def.key)) continue;
    seen.add(def.key);
    const col = { key: def.key };
    const width = Number(c && c.width);
    if (c && c.width !== undefined && c.width !== null && c.width !== '' && Number.isFinite(width)) {
      col.width = Math.round(Math.min(800, Math.max(40, width)));
    }
    if (c && c.hidden === true) col.hidden = true;
    out.push(col);
  }
  if (!out.length) throw badInput('columns 不能是空数组（空 = 没有列；要「全部列」就别传 --columns）');
  return out;
}

function validateSort(section, raw) {
  if (raw === null || raw === '') return null;
  // CLI 惯用 `字段:desc`；也收 JSON {key,dir}
  if (typeof raw === 'string') {
    const i = raw.lastIndexOf(':');
    const ref = i > 0 ? raw.slice(0, i) : raw;
    const dir = i > 0 ? raw.slice(i + 1) : 'asc';
    if (dir !== 'asc' && dir !== 'desc') throw badInput(`--sort 的方向只能是 asc / desc，收到 ${dir}`);
    return { key: resolveFieldRef(section, ref, { where: '--sort' }), dir };
  }
  if (!raw || typeof raw !== 'object' || !raw.key) throw badInput('--sort 要用 字段[:asc|desc] 或 {"key":"…","dir":"asc"}');
  return {
    key: resolveFieldRef(section, raw.key, { where: '--sort' }),
    dir: raw.dir === 'desc' ? 'desc' : 'asc',
  };
}

function validateViewType(section, raw) {
  const type = String(raw || 'table');
  if (!VIEW_TYPES.includes(type)) throw badInput(`视图类型非法: ${type}（可用: ${VIEW_TYPES.join(' / ')}）`);
  if (section.kv === true && type !== 'kv') {
    throw badInput('KV 栏目的视图只能是 kv 类型（D1：KV 栏目就是一张表，没有别的读法）');
  }
  if (section.kv !== true && type === 'kv') {
    throw badInput('只有 KV 栏目能建 kv 视图；普通栏目用 table / board');
  }
  return type;
}

/**
 * 把「当前实际生效的视图」固化成显式配置 —— 第一次改视图时调用。
 *
 * 为什么不是「只把用户新建的那一个写进去」：用户改之前看到的是推断出来的
 * 表格 / 精简 / 看板；只写一条会让其余 chips **凭空消失**，看起来像丢了配置。
 * 固化 = 把他正在看的这一套变成他的，之后字典加字段也不会再自动进列（视图是显式选择）。
 */
function materializeViews(section) {
  return effectiveViews(section).views.map(({ provisional: _provisional, ...v }) => v);
}

export async function listViews(ref) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const { views, provisional } = effectiveViews(s);
  const def = effectiveDefaultViewId(s, views);
  return {
    status: 'ok',
    section: { id: s.id, title: s.title, kv: s.kv === true },
    count: views.length,
    // 推断结果也列出来，并明确标 provisional —— 让调用方知道「这套是系统给的、没落盘」
    provisional,
    default: def,
    views,
  };
}

export async function addView(ref, { id, type, title, columns, groupby, sort, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const t = validateViewType(s, type);
  const viewId = id ? resolveViewId(id) : newId('v');
  const current = materializeViews(s);
  if (current.some((v) => v.id === viewId)) {
    throw conflict(`视图已存在: ${viewId}（改它用 section view update；重复创建不会静默覆盖）`);
  }

  const view = { id: viewId, type: t, title: String(title || VIEW_LABELS[t]) };
  if (columns !== undefined) view.columns = validateViewColumns(s, columns);
  if (groupby !== undefined) {
    if (t !== 'board') throw badInput('--groupby 只对看板视图有意义（表格/精简是同一批数据的列投影）');
    view.groupBy = resolveFieldRef(s, groupby, { where: '--groupby' });
  }
  if (t === 'board' && !view.groupBy) {
    throw badInput('看板视图必须给 --groupby <字段>（按哪个 select 字段分组）');
  }
  if (sort !== undefined) {
    const parsed = validateSort(s, sort);
    if (parsed) view.sort = parsed;
  }

  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: view };

  const next = [...current, view];
  await mutateStore((st) => {
    const target = mustFind(st, ref);
    target.views = next;
    target.updatedAt = nowIso();
  });
  return { status: 'ok', added: true, view, views: next.length };
}

export async function updateView(ref, viewId, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const s = mustFind(store, ref);
  const wantId = resolveViewId(viewId);
  const current = materializeViews(s);
  const idx = current.findIndex((v) => v.id === wantId);
  if (idx < 0) {
    throw notFound(`视图不存在: ${wantId}（现有: ${current.map((v) => v.id).join(', ') || '无'}）`);
  }
  const view = { ...current[idx] };
  const changed = [];

  if (patch.type !== undefined && String(patch.type) !== view.type) {
    throw badInput('视图类型不能原地改（table / board / kv 的语义不同）——删掉重建一个更清楚');
  }
  if (patch.title !== undefined) { view.title = String(patch.title); changed.push('title'); }
  if (patch.columns !== undefined) { view.columns = validateViewColumns(s, patch.columns); changed.push('columns'); }
  if (patch.groupby !== undefined) {
    if (view.type !== 'board') throw badInput('--groupby 只对看板视图有意义');
    view.groupBy = resolveFieldRef(s, patch.groupby, { where: '--groupby' });
    changed.push('groupBy');
  }
  if (patch.sort !== undefined) {
    const parsed = validateSort(s, patch.sort);
    if (parsed) view.sort = parsed; else delete view.sort;
    changed.push('sort');
  }
  // `--set col.字段.width=120`：列宽拖拽结束 = 一次 update（拖动中是本地 state，listW 先例）
  if (patch.set !== undefined) {
    if (!patch.set || typeof patch.set !== 'object' || Array.isArray(patch.set)) {
      throw badInput('--set 要用 col.字段.属性=值的写法，例如 --set col.姓名.width=120');
    }
    const cols = [...(view.columns || [])];
    for (const [k, v] of Object.entries(patch.set)) {
      const m = /^col\.(.+)\.(width|hidden)$/.exec(String(k));
      if (!m) throw badInput(`--set 只支持 col.<字段>.width / col.<字段>.hidden，收到 ${k}`);
      const key = resolveFieldRef(s, m[1], { where: '--set' });
      const at = cols.findIndex((c) => c.key === key);
      if (at < 0) throw badInput(`列 ${m[1]} 不在这个视图的投影里（先 --columns 把它加进来）`);
      const col = { ...cols[at] };
      if (m[2] === 'width') {
        const n = Number(v);
        if (!Number.isFinite(n)) throw badInput(`col.${m[1]}.width 要是数字，收到 ${JSON.stringify(v)}`);
        col.width = Math.round(Math.min(800, Math.max(40, n)));
      } else {
        if (v === true || String(v) === 'true') col.hidden = true; else delete col.hidden;
      }
      cols[at] = col;
    }
    view.columns = cols;
    changed.push('columns');
  }

  if (!changed.length) throw badInput('没有要修改的内容（可改 title / columns / sort / groupby / set）');
  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: view, changed };

  const next = current.map((v, i) => (i === idx ? view : v));
  await mutateStore((st) => {
    const target = mustFind(st, ref);
    target.views = next;
    target.updatedAt = nowIso();
  });
  return { status: 'ok', id: wantId, changed: [...new Set(changed)], view };
}

export async function removeView(ref, viewId, { 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const wantId = resolveViewId(viewId);
  const current = materializeViews(s);
  const hit = current.find((v) => v.id === wantId);
  if (!hit) throw notFound(`视图不存在: ${wantId}（现有: ${current.map((v) => v.id).join(', ') || '无'}）`);

  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: hit };

  const next = current.filter((v) => v.id !== wantId);
  await mutateStore((st) => {
    const target = mustFind(st, ref);
    if (next.length) target.views = next; else delete target.views;
    // 删光 = 回到缺省推断态：defaultView 必须跟着清，否则它会指向一个不存在的 id
    if (!next.length || target.defaultView === wantId) delete target.defaultView;
    target.updatedAt = nowIso();
  });
  return { status: 'ok', removed: hit, remaining: next.length, backToProvisional: next.length === 0 };
}

export async function setDefaultView(ref, viewId, { 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const s = mustFind(store, ref);
  const wantId = resolveViewId(viewId);
  const { views } = effectiveViews(s);
  if (!views.some((v) => v.id === wantId)) {
    throw notFound(`视图不存在: ${wantId}（现有: ${views.map((v) => v.id).join(', ')}）`);
  }
  if (dryRun) return { status: 'skipped', dryRun: true, wouldSetDefault: wantId };

  const current = materializeViews(s);
  await mutateStore((st) => {
    const target = mustFind(st, ref);
    target.views = current;
    target.defaultView = wantId;
    target.updatedAt = nowIso();
  });
  return { status: 'ok', default: wantId };
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

/** 模板漂移提示：只在**真的存在差异**时追加，且明确写清「没有自动改」。 */
function driftNote(changed, { indent = '' } = {}) {
  if (!Array.isArray(changed) || !changed.length) return '';
  const shown = changed.slice(0, 8).map((c) => `${indent}  ${c.key}: ${c.diff.join(', ')}`);
  if (changed.length > 8) shown.push(`${indent}  …另有 ${changed.length - 8} 个`);
  return (
    `\n${indent}注意：${changed.length} 个字段的模板定义已变，本栏目保留原值（sync 只增不改）：\n` +
    `${shown.join('\n')}\n` +
    `${indent}要换成模板的新定义：section update <栏目> --fields '<整份字段数组>'（或先 --remove-field 再 --add-field）。`
  );
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
          const c = completeness(s, e);
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
export async function removeMany(refs, { force, 'dry-run': dryRun } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要删的栏目（用 --ids 或位置参数给 id / 标题，逗号分隔）');

  const store = await loadStore();
  const targets = [];
  const missing = [];
  for (const ref of list) {
    const s = findSection(store, ref);
    if (!s) { missing.push(ref); continue; }
    if (!targets.some((t) => t.id === s.id)) targets.push(s);
  }
  if (!targets.length) {
    throw notFound(`这些栏目都不存在: ${list.join(', ')} —— 现有: ${sectionNames(store)}`);
  }

  const owned = (s) => store.entries.filter((e) => e.section === s.id);
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

export function renderSectionTree(d) {
  const lines = [`${d.count} 个栏目 · 共 ${d.totalEntries} 条条目`];
  for (const s of d.sections) {
    const tag = s.kv ? '[KV] ' : '';
    lines.push(`  ${tag}${s.title}（${s.id}）　${s.fields} 字段 · ${s.entries} 条目`);
    for (const e of s.entryList) lines.push(`      - ${e.title || '（无名）'}  ${e.ratio}%  ${e.id}`);
  }
  return lines.join('\n');
}

export function renderSectionRemoveMany(d) {
  const head = d.status === 'skipped'
    ? `试运行（未落盘）：将删除 ${d.count} 个栏目`
    : `已删除 ${d.count} 个栏目${d.removedEntries ? `（连带 ${d.removedEntries} 条条目）` : ''}`;
  const lines = [head];
  for (const s of d.removed || d.wouldRemove || []) lines.push(`  ${s.title}（${s.id}）　${s.entries} 条目`);
  if (d.missing?.length) lines.push(`未找到（已跳过）: ${d.missing.join('、')}`);
  return lines.join('\n');
}

export function renderSectionChange(d) {
  if (d.status === 'skipped') {
    const body = JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove || d.wouldSync);
    // 试运行也要报漂移：否则「先 --dry-run 看一眼」这条最该用它的路径反而看不到差异
    return `试运行（未落盘）：${body}${driftNote(d.changedFields)}`;
  }
  // `removed` 在两条路径上形状不同：remove 给的是**对象** {id,title,entries}，
  // update 给的是**被删字段 key 的数组**。数组恒为真值，所以必须显式排除数组——
  // 否则 `section update` 会打印「已删除栏目 undefined」，
  // 而 `.entries` 还会取到 Array.prototype.entries 变成 `function entries() { [native code] }`。
  if (d.removed && !Array.isArray(d.removed)) {
    return `已删除栏目 ${d.removed.id}（连带 ${d.removed.entries} 条条目）`;
  }
  if (d.upToDate) {
    return `栏目 ${d.id} 已是最新：模板里没有需要补的分组或字段。${driftNote(d.changedFields)}`;
  }
  if (d.created) return `已创建栏目 ${d.section.id} · ${d.section.title}（${d.section.fields} 字段）`;
  // sync：只增不改——把模板新增、栏目还缺的分组/字段补进来
  if (d.addedFields || d.addedGroups) {
    const bits = [
      d.addedGroups?.length ? `新增分组 ${d.addedGroups.join(', ')}` : '',
      d.addedFields?.length ? `新增字段 ${d.addedFields.join(', ')}` : '',
    ].filter(Boolean).join('；');
    return `已同步栏目 ${d.id} 的模板字段：${bits}${driftNote(d.changedFields)}`;
  }
  const extra = [
    d.added?.length ? `新增字段 ${d.added.join(', ')}` : '',
    d.removed?.length ? `删除字段 ${d.removed.join(', ')}` : '',
    d.fillChanged?.length ? `填写策略 ${d.fillChanged.join(', ')}` : '',
    // 结构改动（分组增删改名换序 / 字段改名换组）是**一句话一条**的摘要：
    // 「changed: groups, fields」这种输出等于没说，改错了没法回溯。
    ...(d.ops || []),
  ].filter(Boolean).join('\n');
  return `已更新栏目 ${d.id}：${d.changed.join(', ')}${extra ? `\n${extra}` : ''}`;
}

export function renderViewList(d) {
  const head = `栏目 ${d.section.id} · ${d.section.title}　${d.count} 个视图`
    + (d.provisional ? '（缺省推断，未落盘 —— 改一次视图才会写进 section.views）' : '');
  const lines = [head];
  for (const v of d.views) {
    const mark = v.id === d.default ? '　← 缺省' : '';
    const cols = v.type === 'board'
      ? `按「${v.groupBy || '未分组'}」分`
      : (Array.isArray(v.columns) && v.columns.length ? `${v.columns.length} 列` : '全部列');
    lines.push(`  ${v.id.padEnd(18)} ${VIEW_LABELS[v.type]}　${v.title}　${cols}${mark}`);
  }
  lines.push('', '切换视图是面板的事；CLI 只改配置：section view add / update / remove / set-default');
  return lines.join('\n');
}

export function renderViewChange(d) {
  if (d.status === 'skipped') {
    return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldChange || d.wouldRemove || d.wouldSetDefault)}`;
  }
  if (d.added) return `已新增视图 ${d.view.id}（${VIEW_LABELS[d.view.type]} · ${d.view.title}）　现有 ${d.views} 个`;
  if (d.removed) {
    const tail = d.backToProvisional ? '；视图已删光，回到缺省推断态' : `；剩余 ${d.remaining} 个`;
    return `已删除视图 ${d.removed.id}（${d.removed.title}）${tail}`;
  }
  if (d.default) return `已把 ${d.default} 设为缺省视图`;
  if (d.changed) return `已更新视图 ${d.id}：${d.changed.join(', ')}`;
  return '未做任何修改';
}
