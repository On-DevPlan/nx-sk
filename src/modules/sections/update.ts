// 栏目 update（PATCH 语义）：结构、字段、分组、版式四类改动的编排。
import { loadStore, mutateStore, type StoreSection } from '../../core/store.ts';
import { assertFieldKey, assertSafeId } from '../../core/paths.ts';
import { badInput, blocked, conflict, notFound } from '../../core/errors.ts';
import { FILL_POLICIES, SOURCE_GROUP, syncSectionGroups } from '../../core/fields.ts';
import { groupsForLayout, reconcileLayout, sanitizeLayout, sameLayout } from '../../shared/blockLayout.ts';
import { nowIso } from '../../core/ids.ts';
import type { FieldDef } from '../../shared/fields/types.ts';
import { mustFind, summarize } from './common.ts';
import { describeFieldPatch, indexOfField, validateFieldDef, validateGroupDef } from './validate.ts';

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
      throw badInput('--layout 需要版式 JSON 对象：{"mode":"grid|flow","panels":["分组id"],"groups":{"分组id":{"collapsed":false,"layouts":{"lg":[{"i":"字段key","x":0,"y":0,"w":6,"h":2}]}}}}');
    }
    changes.layout = l;
  }
  if (patch.groups !== undefined) changes.groups = Array.isArray(patch.groups) ? patch.groups.map(validateGroupDef) : [];
  if (patch.fields !== undefined) {
    if (!Array.isArray(patch.fields)) throw badInput('--fields 需要是字段定义数组的 JSON');
    const fallback = (changes.groups || target.groups)[0]?.id || 'other';
    changes.fields = patch.fields.map((x) => validateFieldDef(x, { allowGroup: fallback }));
  }

  const addField = patch['add-field'];
  const removeField = patch['remove-field'];
  const nextFields: FieldDef[] = [...(changes.fields || target.fields)];
  const added: string[] = [];
  const removed: string[] = [];
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
        def.fill = policy as FieldDef['fill'];
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
  const ops: string[] = [];
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

  // 版式对齐：结构动过（增删字段 / 分组）或显式给了版式时，把版式按**最终结构**收拾一遍——
  // 删掉的字段不再留空块，新字段接到组尾，删掉的分组整块移除。幂等：没动结构也没给版式时不落键，
  // 免得「改个标题」也顺手写一份版式进 store。
  const layoutGiven = changes.layout !== undefined;
  const layoutBase = layoutGiven ? changes.layout : target.layout;
  if (layoutGiven || (layoutBase && (changes.fields || changes.groups))) {
    const next = reconcileLayout(layoutBase, groupsForLayout({
      groups: changes.groups || target.groups,
      fields: changes.fields || target.fields,
    }));
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
