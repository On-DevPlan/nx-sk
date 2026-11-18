// 栏目 update（PATCH 语义）：结构、字段、分组、版式四类改动的编排。
//
// 0.42：分组不再是栏目上的 `groups[]`，而是字段字典里 type='group' 的一条字段
// （keys 引用同栏目其他字段）。所以「加/改/移/删组」与「字段换组」全部落成
// 对**同一份字段字典**的纯函数操作（见 ./structure.ts），不再有第二份结构要对账。
// 对外的 patch 键名保持原样（add-group / rename-group / set-field 的 group …）——
// 用户与 CLI 的措辞不变，变的只是底下的存储形状。
import { loadStore, mutateStore, type StoreSection } from '../../core/store.ts';
import { assertFieldKey, assertSafeId } from '../../core/paths.ts';
import { badInput, blocked, conflict, notFound } from '../../core/errors.ts';
import { FILL_POLICIES, SOURCE_GROUP_KEY, normalizeStructure } from '../../core/fields.ts';
import { groupsForLayout, reconcileLayout, sanitizeLayout, sameLayout } from '../../shared/blockLayout.ts';
import { isGroupDef } from '../../shared/fields/structure.ts';
import { nowIso } from '../../core/ids.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
import { mustFind, summarize } from './common.ts';
import { describeFieldPatch, indexOfField, validateFieldDef, validateGroupDef } from './validate.ts';
import {
  addGroupField, detachMember, fieldsFromInput, groupDefOf, groupFieldOf, membersOf, moveMemberTo, moveWithinGroup, parentGroupOf, removeGroupField, renameGroupField,
} from './structure.ts';

export async function updateSection(ref: unknown, patch: Record<string, any> = {}) {
  // TODO(P4): patch 是 CLI/HTTP 原样传入的键值集合；每个键的合法性由下方 validate* 与 errors 负责
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = mustFind(store, ref);

  const changes: Partial<StoreSection> = {};
  if (patch.title !== undefined) changes.title = String(patch.title);
  if (patch.description !== undefined) changes.description = String(patch.description);
  if (patch.order !== undefined) changes.order = Number(patch.order);
  if (patch.titleLabel !== undefined) changes.titleLabel = String(patch.titleLabel);
  // 标记/取消「本栏目是一张 KV 表」。取消要显式写 `--kv=false`（boolean flag 的 `=` 形式）
  if (patch.kv !== undefined) changes.kv = patch.kv === true;
  if (patch.titleField !== undefined) changes.titleField = patch.titleField ? assertFieldKey(patch.titleField) : null;
  // —— 版式（块布局）——
  // 「字段怎么摆」与「有哪些字段」是两件事：前者是一份独立的 JSON，可以整体读写，
  // 也可以只让面板在拖拽后回写。--clear-layout 不是「删掉这份配置」而是「回到默认编排」——
  // 删成 null 与没有配置在渲染上等价，不如直接落一份默认版式，读出来立刻可用。
  const clearLayout = patch['clear-layout'] === true;
  if (clearLayout) changes.layout = null;
  else if (patch.layout !== undefined) {
    const l = sanitizeLayout(patch.layout);
    if (!l) {
      throw badInput('--layout 需要版式 JSON 对象：{"mode":"grid|flow","panels":["分组key"],"groups":{"分组key":{"collapsed":false,"layouts":{"lg":[{"i":"字段key","x":0,"y":0,"w":6,"h":2}]}}}}');
    }
    changes.layout = l;
  }

  // ── 字段字典的起点：整体替换（--fields/--groups）优先，否则用现有字典 ──
  let nextFields: FieldDef[] = patch.fields !== undefined
    ? fieldsFromInput(Array.isArray(patch.fields) ? patch.fields : [], patch.groups, target.fields[0]?.key)
    : [...target.fields];
  if (patch.fields === undefined && patch.groups !== undefined) {
    // 只换分组声明：已有的组按 key 对齐改名/重排，其它字段归属保持不变
    const groupsIn = Array.isArray(patch.groups) ? patch.groups.map(validateGroupDef) : [];
    const oldGroups = nextFields.filter(isGroupDef).map((g) => ({ key: g.key, label: g.label, keys: membersOf(nextFields, g.key) }));
    const reordered = groupsIn.map((g) => {
      const old = oldGroups.find((x) => x.key === g.key);
      return groupDefOf(g.key, g.label, old?.keys || []);
    });
    const dropped = oldGroups.filter((g) => !groupsIn.some((x) => x.key === g.key));
    const leaves = nextFields.filter((d) => !isGroupDef(d));
    nextFields = [...reordered, ...dropped.map((g) => groupDefOf(g.key, g.label, g.keys)), ...leaves];
  }

  const added: string[] = [];
  const removed: string[] = [];
  const ops: string[] = [];

  const addField = patch['add-field'];
  if (addField !== undefined) {
    const list = Array.isArray(addField) ? addField : [addField];
    for (const raw of list) {
      const parsed = validateFieldDef(raw);
      const group = (parsed as FieldDef & { group?: string }).group
        || parentGroupOf(nextFields, String(raw?.group ?? ''))
        || nextFields.find(isGroupDef)?.key as string
        || 'root';
      const { group: _drop, ...def } = parsed as FieldDef & { group?: string };
      const found = nextFields.find((x) => x.key === (def as FieldDef).key);
      if (found) throw conflict(`字段已存在: ${(def as FieldDef).key}`);
      nextFields.push(def as FieldDef);
      const target0 = groupFieldOf(nextFields, String(group));
      if (target0) nextFields = moveMemberTo(nextFields, (def as FieldDef).key, String(group));
      added.push((def as FieldDef).key);
    }
  }
  if (patch['remove-field'] !== undefined) {
    const keys = Array.isArray(patch['remove-field']) ? patch['remove-field'] : [patch['remove-field']];
    for (const k of keys) {
      const idx = indexOfField(nextFields as Array<{ key: string; label: string }>, k);
      if (idx < 0) throw notFound(`字段不存在: ${k}`);
      const key = nextFields[idx].key;
      removed.push(key);
      nextFields.splice(idx, 1);
      nextFields = detachMember(nextFields, key);
    }
  }
  // —— 填写策略：--fill 字段=normal|optional|avoid ——
  // 放在 add/remove 之后，这样同一次调用里新加的字段也能顺手设策略。
  const fillMap = patch.fill;
  const fillChanged: string[] = [];
  if (fillMap !== undefined && fillMap !== null) {
    if (typeof fillMap !== 'object' || Array.isArray(fillMap)) {
      throw badInput('--fill 要用 字段=策略 的写法，例如 --fill 入党时间=avoid');
    }
    for (const [ref0, policyRaw] of Object.entries(fillMap)) {
      const policy = String(policyRaw);
      if (!FILL_POLICIES.includes(policy)) {
        throw badInput(`--fill ${ref0} 的策略非法: ${JSON.stringify(policyRaw)}（可用: ${FILL_POLICIES.join(' / ')}）`);
      }
      const idx = indexOfField(nextFields as Array<{ key: string; label: string }>, ref0);
      if (idx < 0) {
        throw notFound(`字段不存在: ${ref0}（用 'nx-sk entry fields --section ${target.id}' 看现有字段）`);
      }
      const def = { ...nextFields[idx] };
      if (policy === 'normal') {
        if (def.fill === undefined) continue; // 已是缺省，不制造无意义的改动
        delete def.fill;
      } else {
        if (def.fill === policy) continue;
        def.fill = policy as FieldDef['fill'];
      }
      nextFields[idx] = def;
      fillChanged.push(`${def.key}=${policy}`);
    }
  }

  // —— 字段级改动：--set-field / --move-field ——
  // 面板要能改字段的名字、类型、分组、提示（用户提过「web 里只能加不能改」）。
  // key 刻意**不能改**：条目里的值按 key 存，改 key = 已有值读不出来。
  const setField = patch['set-field'];
  if (setField !== undefined) {
    const list = Array.isArray(setField) ? setField : [setField];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') {
        throw badInput('--set-field 需要对象，例如 \'{"key":"phone","label":"手机号"}\'');
      }
      const ref0 = String(raw.key ?? '').trim();
      if (!ref0) throw badInput('--set-field 需要 key');
      const idx = indexOfField(nextFields as Array<{ key: string; label: string }>, ref0);
      if (idx < 0) throw notFound(`字段不存在: ${ref0}（用 'nx-sk section get ${target.id}' 看字段 key / 标签）`);
      const cur = nextFields[idx];
      // key 一律以**现 key** 为准：条目里的值按 key 存，改 key = 已有值读不出来。
      const merged = { ...cur, ...raw, key: cur.key };
      // 换类型时清掉「只属于清单类字段」的键：columns/fields 留在普通字段上是噪音，
      // validateFieldDef 也会因此拒绝（不是 entrylist/table 却带着 columns）。
      if (merged.type && merged.type !== cur.type) {
        for (const k of ['fields', 'columns', 'totals', 'summary', 'maxRows', 'keys']) delete (merged as Record<string, unknown>)[k];
      }
      const parsed = validateFieldDef(merged);
      const wantGroup = (parsed as FieldDef & { group?: string }).group;
      const { group: _drop, ...def } = parsed as FieldDef & { group?: string };
      nextFields[idx] = def as FieldDef;
      ops.push(`字段 ${def.key}：${describeFieldPatch(cur, def)}`);
      // 换组：先把字段从所有组摘下，再挂到目标组（目标组不存在 → 明确报错，不静默丢字段）
      if (raw.group !== undefined) {
        const gkey = String(raw.group);
        if (!groupFieldOf(nextFields, gkey)) {
          const avail = nextFields.filter(isGroupDef).map((g) => g.key).join(', ') || '（无）';
          throw notFound(`分组不存在: ${gkey}（现有: ${avail}）`);
        }
        nextFields = moveMemberTo(nextFields, cur.key, gkey);
        ops.push(`字段 ${cur.key} 归入分组「${gkey}」`);
      }
      if (wantGroup) { /* 输入里带 group 时上面已经处理，这里不再重复 */ }
    }
  }
  if (patch['move-field'] !== undefined) {
    const list = Array.isArray(patch['move-field']) ? patch['move-field'] : [patch['move-field']];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--move-field 需要对象，例如 \'{"key":"phone","dir":"up"}\'');
      const ref0 = String(raw.key ?? '').trim();
      const dir = String(raw.dir ?? '').trim();
      if (!ref0) throw badInput('--move-field 需要 key');
      if (dir !== 'up' && dir !== 'down') throw badInput(`--move-field 的 dir 只能是 up / down，收到 ${JSON.stringify(raw.dir)}`);
      const i = indexOfField(nextFields as Array<{ key: string; label: string }>, ref0);
      if (i < 0) throw notFound(`字段不存在: ${ref0}`);
      const fieldKey = nextFields[i].key;
      const gid = parentGroupOf(nextFields, fieldKey);
      if (gid) {
        const moved = moveWithinGroup(nextFields, gid, fieldKey, dir as 'up' | 'down');
        if (!moved) throw badInput(`字段 ${fieldKey} 已经是分组「${gid}」的${dir === 'up' ? '第一' : '最后一'}个`);
        nextFields = moved.fields;
        ops.push(`字段 ${fieldKey} 在分组「${gid}」里${dir === 'up' ? '上移' : '下移'}（换到 ${moved.neighbor} 的位置）`);
      } else {
        // 没有归属的字段（KV 栏目）：按字典全局顺序换位
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= nextFields.length) throw badInput(`字段 ${fieldKey} 已经是${dir === 'up' ? '第一' : '最后一'}个`);
        [nextFields[i], nextFields[j]] = [nextFields[j], nextFields[i]];
        ops.push(`字段 ${nextFields[j].key} ${dir === 'up' ? '上移' : '下移'}`);
      }
    }
  }

  // —— 分组结构：--add-group / --rename-group / --move-group / --remove-group ——
  // 栏目的骨架（分几组、谁在前、叫什么）过去只有模板和 --groups 整体替换两条路，
  // 面板连「加一个分组」都做不到。这四个操作让面板与 CLI 共用同一份规则：
  //   · key 唯一（重复 = CONFLICT，绝不静默覆盖同名分组）
  //   · **非空分组不许删**——字段上挂着每个条目的值，「删组连带删字段」比拦下来贵得多
  //   · 内置「原始资料」分组不可删（每个栏目自带，删了下回读又补回来，删了等于没删）
  const addGroup = patch['add-group'];
  if (addGroup !== undefined) {
    const list = Array.isArray(addGroup) ? addGroup : [addGroup];
    for (const raw of list) {
      const g = validateGroupDef(raw, nextFields.filter(isGroupDef).length);
      if (groupFieldOf(nextFields, g.key)) throw conflict(`分组已存在: ${g.key}（改名用 --rename-group，不要重建）`);
      nextFields = addGroupField(nextFields, { key: g.key, label: g.label }, { before: SOURCE_GROUP_KEY });
      ops.push(`新增分组 ${g.key}（${g.label}）`);
    }
  }
  const renameGroup = patch['rename-group'];
  if (renameGroup !== undefined) {
    const list = Array.isArray(renameGroup) ? renameGroup : [renameGroup];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--rename-group 需要对象，例如 \'{"id":"basic","title":"基本信息"}\'');
      const id = String(raw.id ?? raw.key ?? '').trim();
      if (!id) throw badInput('--rename-group 需要 id');
      if (!groupFieldOf(nextFields, id)) {
        throw notFound(`分组不存在: ${id}（现有: ${nextFields.filter(isGroupDef).map((g) => g.key).join(', ') || '（无）'}）`);
      }
      const label = String(raw.title ?? raw.label ?? '').trim();
      if (!label) throw badInput(`分组 ${id} 的新名字不能为空`);
      let nid = id;
      if (raw.newId !== undefined && String(raw.newId).trim() && String(raw.newId).trim() !== id) {
        nid = assertSafeId(String(raw.newId).trim(), '分组 id');
        if (groupFieldOf(nextFields, nid)) throw conflict(`分组已存在: ${nid}`);
        // 组字段的 key 也变了：引用它的父组、版式面板键要一起走（renameGroupField 管引用）
        changes.layout = renameLayoutPanels(changes.layout ?? target.layout, id, nid);
      }
      nextFields = renameGroupField(nextFields, id, { newKey: nid, label });
      ops.push(nid === id ? `分组 ${id} 改名为「${label}」` : `分组 ${id} → ${nid}（${label}，成员与版式一并跟随）`);
    }
  }
  const moveGroup = patch['move-group'];
  if (moveGroup !== undefined) {
    const list = Array.isArray(moveGroup) ? moveGroup : [moveGroup];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw badInput('--move-group 需要对象，例如 \'{"id":"basic","dir":"up"}\'');
      const id = String(raw.id ?? raw.key ?? '').trim();
      const dir = String(raw.dir ?? '').trim();
      if (!id) throw badInput('--move-group 需要 id');
      if (dir !== 'up' && dir !== 'down') throw badInput(`--move-group 的 dir 只能是 up / down，收到 ${JSON.stringify(raw.dir)}`);
      const roots = nextFields.filter(isGroupDef); // 顶层组：字典里组字段的顺序就是面板顺序
      const i = roots.findIndex((g) => g.key === id);
      if (i < 0) throw notFound(`分组不存在: ${id}`);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= roots.length) throw badInput(`分组 ${id} 已经是${dir === 'up' ? '第一' : '最后一'}个`);
      const ai = nextFields.findIndex((g) => g.key === roots[i].key);
      const aj = nextFields.findIndex((g) => g.key === roots[j].key);
      [nextFields[ai], nextFields[aj]] = [nextFields[aj], nextFields[ai]];
      ops.push(`分组 ${id} ${dir === 'up' ? '上移' : '下移'}（${roots.map((g) => g.key).join(' → ')}）`);
    }
  }
  const removeGroup = patch['remove-group'];
  if (removeGroup !== undefined) {
    const ids = Array.isArray(removeGroup) ? removeGroup : [removeGroup];
    for (const raw of ids) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      if (id === SOURCE_GROUP_KEY) {
        throw badInput(`「原始资料」是每个栏目自带的内置分组（删了下回读又会补回来），不给删。`);
      }
      if (!groupFieldOf(nextFields, id)) throw notFound(`分组不存在: ${id}`);
      const inUse = membersOf(nextFields, id);
      if (inUse.length) {
        throw blocked(`分组 ${id} 里还有 ${inUse.length} 个字段：${inUse.slice(0, 8).join(', ')}${inUse.length > 8 ? '…' : ''}。`
          + `先把它们挪走（--set-field '{"key":"…","group":"…"}'）或删掉，再删这个分组。`);
      }
      nextFields = removeGroupField(nextFields, id);
      ops.push(`删除分组 ${id}`);
    }
  }

  // 收口：结构不变量在这一处修（组声明只留存在的成员、每个普通字段恰好归属一组、
  // 孤儿入根组）。写路径与读路径（normalizeSection）调的是同一个函数。
  nextFields = normalizeStructure(nextFields as Array<FieldDef & { keys?: unknown }>, { ensureRoot: target.kv !== true }) as FieldDef[];
  if (patch.fields !== undefined || patch.groups !== undefined || addField !== undefined
    || patch['remove-field'] !== undefined || setField !== undefined || patch['move-field'] !== undefined
    || addGroup !== undefined || renameGroup !== undefined || moveGroup !== undefined || removeGroup !== undefined) {
    changes.fields = nextFields;
  }

  // 版式对齐：结构动过（增删字段 / 分组）或显式给了版式时，把版式按**最终结构**收拾一遍——
  // 删掉的字段不再留空块，新字段接到组尾，删掉的分组整块移除。幂等：没动结构也没给版式时不落键，
  // 免得「改个标题」也顺手写一份版式进 store。
  const layoutGiven = changes.layout !== undefined;
  const layoutBase = layoutGiven ? changes.layout : target.layout;
  if (layoutGiven || (layoutBase && changes.fields)) {
    const next = reconcileLayout(layoutBase, groupsForLayout({ fields: changes.fields || target.fields }));
    if (layoutGiven || !sameLayout(next, layoutBase)) changes.layout = next;
  }

  if (!Object.keys(changes).length) {
    throw badInput('没有要修改的内容（可改 title / description / order / fields / groups / add-field / set-field / move-field / remove-field / add-group / rename-group / move-group / remove-group / fill / layout / clear-layout）');
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

/** 版式里的面板键/分组键改名（组 key 改了，已存版式必须跟着改，否则那一面板的布局丢掉）。 */
function renameLayoutPanels(layout: unknown, from: string, to: string): unknown {
  const l = sanitizeLayout(layout);
  if (!l) return layout;
  const panels = l.panels.map((p) => (p === from ? to : p));
  const groups: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l.groups)) groups[k === from ? to : k] = v;
  return { ...l, panels, groups };
}
