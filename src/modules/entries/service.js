// 条目（entry）：栏目下的一条记录。
// 写敏感字段时加密、读时**默认原文**（只有显式 --mask 才打码）——
// 这条边界只在这里实现一次，两端共用。
//
// 写入分两趟：趟 A（异步，在草稿 section 上跑）解析字段、加密敏感值；
// 趟 B（同步，在 mutateStore 事务里）只做赋值。这样加密只发生在事务外，
// 事务里没有 await，也就没有「改了一半又抛错」的中间态。
import { loadStore, mutateStore } from '../../core/store.js';
import { assertFieldKey } from '../../core/paths.js';
import { badInput, conflict, notFound } from '../../core/errors.js';
import { BOOL_FALSE, BOOL_TRUE, SOURCE_FIELD, SOURCE_GROUP, findKvSection, findSection, instantiateTemplate, isSensitiveField, looksSecretish, sectionNames } from '../../core/fields.js';
import { completeness, displaySensitive, isBlank, serializeEntry } from '../../core/render.js';
import { newId, nowIso } from '../../core/ids.js';
import { decryptValue, encryptValue, isCipherBlob, maskValue } from '../../core/crypto.js';
import { resolveVaultKey, sensitiveViewer } from '../../core/vault.js';
import * as att from '../../core/attachments.js';
import { mdImageIds, rewriteMdImages } from '../../core/mdimages.js';
import { looksLikeSourceList, normalizeSourceItem, normalizeSourceItems, resolveSourceConflicts, sourceItemSummary, sourceItemTimeLabel } from '../../core/source.js';
import { displayPath } from '../../core/paths.js';
import { coerceCell, columnToDef, computeTable, normalizeSpec, renderTableText, sanitizeColumns, sanitizeTotals } from '../../shared/table.js';
import {
  BLOCK_LABELS, BLOCK_TYPES, appendBlock, findBlock, findContainer, moveToIndex, normalizeBlock,
  removeBlock as removeBlockIn, replaceBlock, updateBlock, validateBlocks,
} from '../../shared/blocks.js';

/**
 * 「这一格拿到的是打码占位吗」。
 *
 * maskValue 对**短值**（≤10 字符）返回全星，对长值返回「前 4 + 6 个星 + 后 4」——
 * 只认「连续 6 个星」会把短密码的打码值（3 位密码 → `***`）当成新密码加密存进去，
 * 下一次读就是 `***`，而且没有任何报错。
 */
const looksMasked = (text) => /^\*{3,}$/.test(String(text ?? '')) || String(text ?? '').includes('******');

export function mustFindSection(store, ref) {  const s = findSection(store, ref);
  if (!s) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
  return s;
}

/** 条目定位：id 优先，其次唯一标题；重名时报 CONFLICT 让调用方用 id 指定。 */
export function resolveEntry(store, ref, sectionRef) {
  const key = String(ref ?? '').trim();
  if (!key) throw badInput('缺少条目定位：给条目 id（e_...）或条目名');
  let list = store.entries;
  if (sectionRef) list = list.filter((e) => e.section === mustFindSection(store, sectionRef).id);
  const byId = list.find((e) => e.id === key);
  if (byId) return byId;
  const byTitle = list.filter((e) => e.title === key);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw conflict(`有 ${byTitle.length} 条同名条目「${key}」，请用 id 指定: ${byTitle.map((e) => e.id).join(' / ')}`);
  }
  throw notFound(`找不到条目: ${ref}`);
}

function mergeInputs(set, data) {
  const out = {};
  if (data && typeof data === 'object') {
    // 兼容 `{values:{...}}` 与直接扁平 `{字段: 值}` 两种写法
    Object.assign(out, data.values && typeof data.values === 'object' ? data.values : data);
  }
  if (set && typeof set === 'object') Object.assign(out, set);
  return out;
}

function resolveFieldDef(section, rawKey) {
  const key = String(rawKey).trim();
  return (section.fields || []).find((x) => x.key === key || x.label === key) || null;
}

/**
 * 把一个没见过的键登记进草稿字典。
 * key 直接用用户敲的那个词（中文也行）——**写什么就存什么**，不必再记一个英文别名。
 */
function registerField(section, rawKey, rawValue) {
  // KV 栏目**拒绝加字段**：它的形状就是「一行一个键值对」，多一个字段就散了。
  // 这里必须报错而不是静默登记 —— 静默的后果是用户看到一堆无意义的字段名
  // （真实事故：面板那行「KV 直填」把 `3123312=xxx` 登记成了字段，而不是一个新键）。
  if (section.kv) {
    const wanted = String(rawKey).trim();
    throw badInput(
      `栏目「${section.title}」是一张 KV 表（一行一个键值对），不能加字段「${wanted}」。`
      + `你要加的应该是一个**键** —— 用 nx-sk key set ${wanted} <值>，`
      + '或在面板的 KV 表格里加一行。',
    );
  }
  const key = assertFieldKey(String(rawKey).trim());
  let type = inferFieldType(rawValue);
  // 键名长得像凭据（密码 / 令牌 / 密钥 / 账号…）→ **直接建成密文字段**。
  //
  // 这是「大胆写」能成立的前提：agent 可以一把 `--set 密码=…` 写进栏目，
  // 而这把密码**落盘就是密文**，不会明文躺在 store.json 里。
  // 刻意只对标量值生效：数组类（附件 / 结构清单 / 资料袋）有自己的形状，不能改类型。
  if (looksSecretish(key) && SCALAR_FIELD_TYPES.has(type)) type = 'secret';
  const def = {
    key,
    label: key,
    type,
    group: section.groups?.[0]?.id || section.fields?.[0]?.group || 'other',
  };
  section.fields.push(def);
  return def;
}

function normalizeValue(def, raw) {
  if (raw === null || raw === undefined) return null;
  const type = def.type;
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (BOOL_TRUE.includes(s)) return true;
    if (BOOL_FALSE.includes(s)) return false;
    throw badInput(`字段「${def.label}」需要是/否，收到 ${JSON.stringify(raw)}`);
  }
  if (type === 'number') {
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) throw badInput(`字段「${def.label}」需要数字，收到 ${JSON.stringify(raw)}`);
    return n;
  }
  if (type === 'tags') {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,，、;；\s]+/)).map((x) => x.trim()).filter(Boolean);
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list;
  }
  if (type === 'entrylist') {
    // 结构清单：值 = 行对象的数组，列在字段定义的 fields 里声明。
    // CLI 两种入口：--data 直接给 JSON 数组；--set 给 JSON 串（解析失败就报，别静默吞）。
    let list = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) return null; // 「--set 字段=」（空值）= 清空，与其它类型同一约定
      try { list = JSON.parse(raw); } catch { list = null; }
      if (!Array.isArray(list)) {
        throw badInput(`字段「${def.label}」是结构清单（entrylist），值要是行数组的 JSON，`
          + `例如 '[{"名称":"主控台","链接":"https://…"}]'`);
      }
    }
    if (!Array.isArray(list)) {
      throw badInput(`字段「${def.label}」是结构清单（entrylist），值要是行数组（JSON），收到 ${JSON.stringify(raw).slice(0, 80)}`);
    }
    return normalizeRows(def, list);
  }
  if (type === 'table') {
    // 表格：形状与 entrylist 一样是「行对象数组」，区别在列有类型、还能有计算列。
    // 入口也一致：--data 给数组，--set 给 JSON 串。
    let list = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) return null;
      try { list = JSON.parse(raw); } catch { list = null; }
      if (!Array.isArray(list)) {
        throw badInput(`字段「${def.label}」是表格（table），值要是行数组的 JSON，`
          + `例如 '[{"任务":"写文档","已办":true,"工时":2}]'`);
      }
    }
    if (!Array.isArray(list)) {
      throw badInput(`字段「${def.label}」是表格（table），值要是行数组（JSON），收到 ${JSON.stringify(raw).slice(0, 80)}`);
    }
    return normalizeTable(def, list);
  }
  if (type === 'source') {
    // 原始资料袋：值 = 一组 item（文字/附件/网址）。形状与归一规则见 core/source.js。
    // 三种入口都认：数组（面板/JSON）、JSON 串（--set）、一段普通文字（--set 随手记）。
    try {
      return normalizeSourceItems(raw);
    } catch (e) {
      throw badInput(`字段「${def.label}」的原始资料有问题：${e.message}`);
    }
  }
  if (type === 'file') {
    // 值 = 附件 id（或唯一文件名）的**列表**：一个字段可以挂多个附件（简历传多个版本、
    // 头像多张）。id 全局唯一，天然做到「各条目附件互不串台」；同一份原件被多条条目引用
    // 也没问题（sha256 去重后是同一个 id）。
    // **新写入统一存数组**（哪怕只有一个）——形状一致，下游不必到处判「是串还是表」；
    // 历史数据里的字符串单值读时由 fileIdsOf 按单元素处理，不做迁移。
    // 不校验存在性——附件可能被还原/删掉，前端按「引用的附件不存在」展示。
    const list = att.fileIdsOf(Array.isArray(raw) ? raw : String(raw).split(/[,，、;；]+/));
    if (def.maxItems && list.length > def.maxItems) {
      throw badInput(`字段「${def.label}」最多 ${def.maxItems} 项，收到 ${list.length} 项`);
    }
    return list.length ? list : null;
  }
  const s = String(raw);
  return s.trim() === '' ? null : s;
}

/**
 * 结构清单的行归一：只留声明过的子字段（键写错当场报，不静默丢数据）；
 * 空格子剔除、全空行丢弃。列没声明时（写入自动登记的字段）从行键**推断**清单列——
 * 「直接写就登记」的手感在结构清单上也成立。
 */
function normalizeRows(def, list) {
  if (!def.fields || !def.fields.length) {
    const keys = [];
    for (const row of list) {
      if (!isPlainRow(row)) continue;
      for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
    }
    if (keys.length) def.fields = keys.map((k) => ({ key: k, label: k }));
  }
  const subs = def.fields || [];
  const rows = [];
  for (const item of list) {
    if (!isPlainRow(item)) {
      throw badInput(`字段「${def.label}」的每行都要是对象（{"子字段": "值"}），收到 ${JSON.stringify(item).slice(0, 80)}`);
    }
    const row = {};
    for (const [k, v] of Object.entries(item)) {
      // 列名**key 与 label 都认**（与顶层 `--set 字段=值` 同一口径）：
      // 人写的是「密码」，清单声明的是 pass —— 不该让人先背一遍英文 key。
      const sub = subs.find((s) => s.key === k) || subs.find((s) => s.label === k);
      if (!sub) {
        throw badInput(`字段「${def.label}」没有子字段「${k}」（清单列: ${subs.map((s) => s.label).join('、') || '无'}）。`
          + `清单列在字段定义里，要改用 section update <栏目> --fields '<整份字段数组>'`);
      }
      const text = String(v ?? '').trim();
      // 一律归到列的 **key** 下：密文判定、面板渲染都按 key 走
      if (text !== '') row[sub.key] = text;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  if (def.maxItems && rows.length > def.maxItems) {
    throw badInput(`字段「${def.label}」最多 ${def.maxItems} 行，收到 ${rows.length} 行`);
  }
  return rows.length ? rows : null;
}

function isPlainRow(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * 表格的写入归一：把「字段定义 + 传进来的值」合成一份**自描述的表格文档**：
 *
 *   { v: 1, columns: [...], rows: [...], totals?: [...], summary?: false }
 *
 * 三种输入都认（都落成上面那一份）：
 *   - 行数组 `[{...}, {...}]`     ← CLI / 手写最省事，列取字段默认列或从行推断
 *   - 文档 `{columns, rows, …}`   ← 面板保存的形状，列以**数据里的**为准
 *   - 上面两者的 JSON 串          ← `--set 表='…'`
 *
 * 为什么列一定要落进数据：栏目的字段字典是**所有条目共用**的，而一张表的列常常
 * 只对这一条有意义。「编辑时加一列」不该等于「改 schema，影响所有条目」。
 *
 * 强转失败**不许静默兜底**：`工时: "两小时"` 存成 null 的话，合计会悄悄少一截。
 * 收集完所有格子的问题再一次性报，比逐条报更容易一次改对。
 */
function normalizeTable(def, input) {
  const spec = normalizeSpec(def, input);
  let columns;
  try {
    columns = sanitizeColumns(spec.columns, { where: `字段「${def.label}」` });
  } catch (e) {
    throw badInput(e.message);
  }
  if (!columns.length) {
    // **空表是合法的**：没列也没数据就是「还没开始」。存成 null（= 这个字段空着），
    // 让 `--set 表=`、`[]`、`{}` 这几条「清空」的路都走得通，而不是被「必须给列」挡回来。
    if (!spec.rows.length) return null;
    throw badInput(`字段「${def.label}」有 ${spec.rows.length} 行数据却没有任何列 —— `
      + '把 columns 一起写进值里，或在面板的「列设置」里加列');
  }

  const given = Array.isArray(input) ? null : (input && typeof input === 'object' ? input : null);
  const problems = [];
  const rows = [];
  spec.rows.forEach((item, i) => {
    const row = {};
    for (const [k, v] of Object.entries(item)) {
      const col = columns.find((c) => c.key === k) || columns.find((c) => c.label === k);
      if (!col) {
        throw badInput(`字段「${def.label}」没有列「${k}」（现有列: ${columns.map((c) => c.label).join('、')}）。`
          + '表格的列也存在数据里：加列用面板的「列设置」，或把 columns 一起写进值里');
      }
      // 计算列由公式算，传进来的值不落盘（注意这里用 formula 判定：sanitizeColumns
      // 返回的是**可落盘的紧凑定义**，不带 computed 这种运行时字段）
      if (col.formula) continue;
      // 密文对象原样保留：导入/还原会把已经加密的格子原样送回来
      if (v && typeof v === 'object' && col.sensitive) { row[col.key] = v; continue; }
      const cell = coerceCell(col, v);
      if (cell.error) { problems.push(`第 ${i + 1} 行「${col.label}」${cell.error}`); continue; }
      if (cell.value === null || cell.value === undefined) continue;
      if (Array.isArray(cell.value) && !cell.value.length) continue;
      row[col.key] = cell.value;
    }
    if (Object.keys(row).length) rows.push(row);
  });
  if (problems.length) {
    throw badInput(`字段「${def.label}」有填错的值：${problems.slice(0, 4).join('；')}`
      + (problems.length > 4 ? `；等 ${problems.length} 处` : ''));
  }
  if (def.maxRows && rows.length > def.maxRows) {
    throw badInput(`字段「${def.label}」最多 ${def.maxRows} 行，收到 ${rows.length} 行`);
  }

  const doc = { v: 1, columns: columns.map((c) => columnToDef(c)), rows };
  // 统计行：数据里显式写了就校验后存下；没写就用字段定义的（都没写则渲染时按类型自动）
  if (given && given.totals !== undefined) {
    try {
      doc.totals = sanitizeTotals(given.totals, columns, { where: `字段「${def.label}」` });
    } catch (e) {
      throw badInput(e.message);
    }
  }
  if (given && given.summary === false) doc.summary = false;
  else if (!given && def.summary === false) doc.summary = false;
  return doc;
}

/**
 * 结构清单的写入：normalize 之后，敏感子值与顶层敏感字段同一条边界——
 * 密文落盘；面板把打码占位原样回传时保留原密文（不把掩码当新密码存进去）。
 * 打码占位与现有密文对不上时必须报错：那多半是「想改密码但只拷了打码值」。
 */
async function prepareEntryList(def, raw, current) {
  const rows = normalizeValue(def, raw);
  if (!rows) return null;
  const subs = (def.fields || []).filter((s) => s.sensitive);
  if (!subs.length) return rows;
  const curRows = Array.isArray(current) ? current : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = { ...rows[i] };
    for (const s of subs) {
      const text = row[s.key];
      if (text === undefined) continue;
      if (looksMasked(text)) {
        const cur = curRows[i]?.[s.key];
        if (isCipherBlob(cur)) {
          try {
            const { key } = await resolveVaultKey();
            if (maskValue(decryptValue(key, cur)) === String(text)) { row[s.key] = cur; continue; }
          } catch { /* 解不开就按新值走，下面照常报错 */ }
        }
        throw badInput(`字段「${def.label}」第 ${i + 1} 行的「${s.label}」收到的是打码占位而非明文。给完整值，或把这一格清掉重填。`);
      }
      const { key } = await resolveVaultKey();
      row[s.key] = encryptValue(key, String(text));
    }
    out.push(row);
  }
  return out;
}

/**
 * 表格的写入：归一之后，敏感**列**与顶层敏感字段同一条边界——密文落盘。
 *
 * 与 entrylist 的一处改进：打码占位先按**同一行**找原密文，找不到再按**整列**找。
 * 表格是能上下拖动排序的，只按行号对齐会在拖过一次之后把「密码」认到别人头上——
 * 那种错不报错、只是悄悄换了一个人的密码，比直接报错难查得多。
 */
async function prepareTable(def, raw, current) {
  const doc = normalizeTable(def, raw);
  if (!doc) return null; // 空表：清空这个字段
  const cols = doc.columns.filter((c) => c.sensitive && !c.formula);
  if (!cols.length) return doc;
  const curDoc = Array.isArray(current) ? { rows: current } : (current && typeof current === 'object' ? current : {});
  const cur = Array.isArray(curDoc.rows) ? curDoc.rows : [];
  const plainByBlob = new Map();

  const decryptBlob = async (blob) => {
    if (!isCipherBlob(blob)) return null;
    if (plainByBlob.has(blob)) return plainByBlob.get(blob);
    let plain = null;
    try {
      const { key } = await resolveVaultKey();
      plain = decryptValue(key, blob);
    } catch { /* 解不开（换过密钥）就当作对不上 */ }
    plainByBlob.set(blob, plain);
    return plain;
  };


  const rows = [];
  for (let i = 0; i < doc.rows.length; i += 1) {
    const row = { ...doc.rows[i] };
    for (const c of cols) {
      const text = row[c.key];
      if (text === undefined || text === null) continue;
      if (typeof text === 'object') continue; // 已是密文对象（导入/还原）
      const s = String(text);
      if (!looksMasked(s)) {
        const { key } = await resolveVaultKey();
        row[c.key] = encryptValue(key, s);
        continue;
      }
      // 打码占位 = 「这一格没改」。不能只按行号对齐：表格能上下拖动排序，
      // 拖过一次就会把密码认到别人头上。
      //   先按**打码值**认（能唯一命中就正确，与行序无关）；
      //   认不出来（这一列有多个格子打码后长得一样，短密码全是星）时退回**行号**兜底——
      //   这就是 entrylist 一直以来的行为，也是这条路唯一的已知限制：
      //   打码状态下拖动行，且两格打码值相同，就无法区分谁是谁。
      const cands = [];
      for (const blob of [cur[i]?.[c.key], ...cur.map((r) => r?.[c.key])]) {
        if (!blob || !isCipherBlob(blob) || cands.includes(blob)) continue;
        const plain = await decryptBlob(blob);
        if (plain !== null && maskValue(plain) === s) cands.push(blob);
      }
      if (cands.length === 1) { row[c.key] = cands[0]; continue; }
      // 兜底：同一行原来的密文。没拖动过时这是对的；拖动过且打码值相同则无法区分
      //（打码值本身不携带身份信息，短密码全是星）——这是这条路上唯一的已知限制。
      const here = cur[i]?.[c.key];
      if (here && isCipherBlob(here)) {
        const plain = await decryptBlob(here);
        if (plain !== null && maskValue(plain) === s) { row[c.key] = here; continue; }
      }
      throw badInput(`字段「${def.label}」第 ${i + 1} 行「${c.label}」收到的是打码占位而非明文。`
        + '给完整值，或把这一格清掉重填（取消「打码显示」后保存也可以）。');
    }
    rows.push(row);
  }
  return { ...doc, rows };
}

async function prepareValue(section, def, raw, current) {
  if (def.type === 'entrylist') return prepareEntryList(def, raw, current);
  if (def.type === 'table') return prepareTable(def, raw, current);
  if (!isSensitiveField(section, def.key)) return normalizeValue(def, raw);
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw);
  // 面板把打码后的值原样回传时，必须保留原密文——否则掩码会被当成新密钥存进去
  if (isCipherBlob(current)) {
    try {
      const { key } = await resolveVaultKey();
      if (maskValue(decryptValue(key, current)) === text) return current;
    } catch { /* 解不开就按新值处理 */ }
  }
  if (looksMasked(text)) {
    throw badInput(`字段「${def.label}」收到的是打码占位而非明文。给完整值，或用 --unset ${def.key} 清空。`);
  }
  const { key } = await resolveVaultKey();
  return encryptValue(key, text);
}

/**
 * 新字段的类型推断。**刻意不推 number**：
 * 18 位的身份证号 / 长数字 ID 超过 2^53，推成数字会**静默丢精度**。
 * 值仍是字符串，所以「直接存 kv」不会因为类型推断损坏数据。
 */
// 值像不像附件 id（`f_xxxx`）。用来推断「写了一个没登记过的键」该登记成什么类型：
// `--set 简历附件=f_abc` / `--set 简历附件=f_a,f_b` 应当登记成**附件字段**，
// 而不是一个普通文本字段或 tags。
const looksLikeFileId = (x) => typeof x === 'string' && /^f_[0-9a-z]+$/i.test(x.trim());
const looksLikeRow = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// 标量类型：值就是一个字符串/数字/布尔。能安全地改成密文字段（type: 'secret'）。
// 数组类（file / entrylist / source / tags）有自己的形状，不在自动改型的范围里。
const SCALAR_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'month', 'bool']);

function inferFieldType(raw) {
  if (Array.isArray(raw)) {
    if (raw.length && raw.every(looksLikeFileId)) return 'file';
    // 一袋 source（带 kind 且有内容）→ 登记成原始资料袋；判断比 entrylist 严，
    // 因为 entrylist 的列也可能叫 kind —— 宁可登记成 entrylist 也不要错认成 source
    if (looksLikeSourceList(raw)) return 'source';
    // 行对象数组登记成结构清单——`--data '{"账号清单":[{…},{…}]}'` 自动建出能渲染的字段
    if (raw.length && raw.every(looksLikeRow)) return 'entrylist';
    return 'tags';
  }
  if (looksLikeFileId(raw)) return 'file';
  if (typeof raw === 'string') {
    const parts = raw.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length && parts.every(looksLikeFileId)) return 'file';
  }
  if (typeof raw === 'boolean') return 'bool';
  const s = String(raw).trim().toLowerCase();
  if (BOOL_TRUE.includes(s) || BOOL_FALSE.includes(s)) return 'bool';
  return 'text';
}

/**
 * 趟 A：在草稿 section 上解析字段、算出要写进去的值。
 *
 * **不认识的键不再报错**——直接登记进字段字典再写。
 * 字典从「写入的关卡」降级成「已用字段的台账 + 模板给的填写提示」：
 * 用户想存什么键就存什么键，这才是 KV 该有的手感。
 */
async function prepareWrite({ section, currentValues = {}, incoming }) {
  const draft = structuredClone(section);
  const newFields = [];
  const values = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    let def = resolveFieldDef(draft, rawKey);
    if (!def) {
      def = registerField(draft, rawKey, rawValue);
      newFields.push(def);
    }
    values[def.key] = await prepareValue(draft, def, rawValue, currentValues[def.key]);
  }
  return { values, newFields };
}

function autoTitle(section, values) {
  const v = section.titleField ? values[section.titleField] : undefined;
  return v === undefined || v === null || v === '' ? '' : String(v);
}

export async function listEntries({ section, q } = {}) {
  const store = await loadStore();
  let list = store.entries;
  if (section) list = list.filter((e) => e.section === mustFindSection(store, section).id);
  const viewers = new Map();
  const out = [];
  for (const e of list) {
    const sec = store.sections.find((s) => s.id === e.section);
    if (!sec) continue;
    if (!viewers.has(sec.id)) viewers.set(sec.id, await sensitiveViewer(sec, list.filter((x) => x.section === sec.id)));
    const item = serializeEntry(sec, e, { decrypt: viewers.get(sec.id) });
    if (q) {
      // file 字段值是附件 id（可能挂多个），把解析出的附件名都加进搜索文本，
      // 才能按「简历/成绩单」搜到条目
      const fileNames = sec.fields
        .filter((f) => f.type === 'file')
        .flatMap((f) => att.fileIdsOf(e.values?.[f.key])
          .map((id) => att.findFileRecord(store, id)?.name || ''));
      const hay = [item.title, sec.title, ...fileNames,
        ...Object.values(item.values).map(hayText)]
        .join('\n').toLowerCase();
      if (!hay.includes(String(q).toLowerCase())) continue;
    }
    out.push({ ...item, sectionTitle: sec.title });
  }
  return { count: out.length, total: store.entries.length, entries: out };
}

/** 搜索文本：行对象（entrylist）与表格文档要摊成 JSON 才能按里面的账号/链接搜到条目。 */
function hayText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (isPlainRow(x) ? JSON.stringify(x) : String(x))).join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function getEntry(ref, { mask, section } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = store.sections.find((s) => s.id === entry.section);
  if (!sec) throw notFound(`条目 ${entry.id} 指向的栏目已不存在: ${entry.section}`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt });
  // 附带附件信息：键 = 附件 id / 文件名，值为名称 / 路径 / 链接。
  // 两个来源：`file` 字段挂的附件，以及**图文字段正文里内嵌的图片**（`![说明](f_x)`）——
  // 后者不进来的话，`entry get` 只能打印一串 f_xxx，而人/agent 要的是「这份文件在磁盘哪」。
  const files = {};
  const putFile = (ref) => {
    if (!ref || files[ref]) return;
    const rec = att.findFileRecord(store, ref);
    if (!rec) return;
    const links = att.fileLinks(rec);
    files[ref] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  };
  for (const f of sec.fields.filter((x) => x.type === 'file')) {
    for (const ref of att.fileIdsOf(serialized.values[f.key])) putFile(ref);
  }
  for (const f of sec.fields.filter((x) => x.type === 'md')) {
    for (const id of mdImageIds(serialized.values[f.key])) putFile(id);
  }
  // 原始资料袋里的附件也要解析出来：袋里躺着一份 PDF，读的人/agent 要知道它叫什么、
  // 在磁盘哪、怎么下 —— 否则只剩一串 f_xxx
  for (const f of sec.fields.filter((x) => x.type === 'source')) {
    for (const item of serialized.values[f.key] || []) {
      if (item && item.kind === 'file' && item.fileId) putFile(item.fileId);
    }
  }
  // 字段类型随读出来：CLI 渲染要知道哪个值是「图文」，才能把 f_xxx 换成文件名/路径；
  // 结构清单还要带**列定义**（entryFields），渲染行时才知道每个键的人读标签
  const fieldTypes = {};
  const entryFields = {};
  for (const f of sec.fields) {
    fieldTypes[f.key] = f.type;
    if (f.type === 'entrylist') {
      entryFields[f.key] = (f.fields || []).map((s) => ({ key: s.key, label: s.label, sensitive: s.sensitive === true }));
    }
  }
  // 表格的**现值**：计算列与统计行在读的时候现算，不落盘 ——
  // 所以「存的数字」和「算出来的合计」永远同源，不会出现「合计是上个月的值」。
  const tables = {};
  for (const f of sec.fields) {
    if (f.type !== 'table') continue;
    tables[f.key] = computeTable(f, serialized.values[f.key]);
  }
  return { ...serialized, sectionTitle: sec.title, mask: !!mask, files, fieldTypes, entryFields, tables };
}

export async function addEntry({ section, title, set, data, tags, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const sec = mustFindSection(store, section);
  const incoming = mergeInputs(set, data);
  if (!Object.keys(incoming).length && !title) {
    throw badInput(`至少要给一个字段：--set ${sec.fields[0]?.label || '字段'}=值（可重复），或 --data @file.json`);
  }

  const { values, newFields } = await prepareWrite({ section: sec, incoming });
  const finalTitle = String(title || autoTitle(sec, values) || '').trim();
  if (!finalTitle) {
    throw badInput(`无法确定条目名：加 --title <名>，或先填上「${sec.titleField || '首个字段'}」字段`);
  }
  const dup = store.entries.find((e) => e.section === sec.id && e.title === finalTitle);
  if (dup) throw conflict(`栏目「${sec.title}」下已有叫「${finalTitle}」的条目（${dup.id}）。要改它就用 entry update，别再加一条。`);

  const entry = {
    id: newId('e'), section: sec.id, title: finalTitle, tags: Array.isArray(tags) ? tags.map(String) : [],
    values, createdAt: nowIso(), updatedAt: nowIso(),
  };
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldCreate: { ...entry, values: maskAll(sec, entry) }, createdFields: newFields.map((f) => f.key) };
  }
  await mutateStore((s) => {
    // 自动登记的字段必须跟条目一起落盘：只有 addEntry 报了 createdFields 却不写
    // 字典，面板/`entry get` 都按 section.fields 序列化——那些值会当场「隐身」。
    // updateEntry 一直是写的（见下方同名逻辑），这里对齐成同一份行为。
    const section = s.sections.find((x) => x.id === sec.id);
    for (const f of newFields) {
      if (!section.fields.some((x) => x.key === f.key)) section.fields.push(f);
    }
    if (newFields.length) section.updatedAt = nowIso();
    s.entries.push(entry);
  });
  return {
    status: 'ok', created: true, id: entry.id, title: entry.title, section: sec.id,
    completeness: completeness(sec, entry), createdFields: newFields.map((f) => f.key),
  };
}

export async function updateEntry(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = resolveEntry(store, ref, patch.section);
  const sec = mustFindSection(store, target.section);
  const incoming = mergeInputs(patch.set, patch.data);
  const unset = patch.unset || [];

  const changedKeys = [...Object.keys(incoming), ...unset.map((k) => `-${k}`)];
  if (!changedKeys.length && patch.title === undefined && patch.tags === undefined) {
    throw badInput('没有要改的内容：用 --set 字段=值 / --data @file.json / --unset 字段 / --title / --tags');
  }
  // 先把 unset 的字段名解析出来（错别字要在写盘前就报掉）
  const unsetKeys = [];
  for (const k of unset) {
    const def = resolveFieldDef(sec, k);
    if (!def) throw notFound(`栏目「${sec.title}」没有字段: ${k}`);
    unsetKeys.push(def.key);
  }

  const { values, newFields } = await prepareWrite({
    section: sec, currentValues: target.values, incoming,
  });

  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldChange: {
        id: target.id, fields: Object.keys(values), unset: unsetKeys,
        title: patch.title, tags: patch.tags, newFields: newFields.map((f) => f.key),
      },
    };
  }

  // 重名会让 `entry get <名字>` / `key get <名字>` 变成二义（只能靠 id 定位），
  // 所以改名时挡一下：KV 表格改键名、agent 改条目标题都走这里。
  if (patch.title !== undefined && String(patch.title) !== target.title) {
    const dup = store.entries.find((e) => e.id !== target.id && e.section === target.section && e.title === String(patch.title));
    if (dup) throw conflict(`同栏目下已有叫「${patch.title}」的了（${dup.id}）；先合并或删掉那一条。`);
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    const section = s.sections.find((x) => x.id === e.section);
    for (const f of newFields) {
      if (!section.fields.some((x) => x.key === f.key)) section.fields.push(f);
    }
    for (const [k, v] of Object.entries(values)) e.values[k] = v;
    for (const k of unsetKeys) e.values[k] = null;
    if (patch.title !== undefined) e.title = String(patch.title);
    if (Array.isArray(patch.tags)) e.tags = patch.tags.map(String);
    e.updatedAt = nowIso();
    if (newFields.length) section.updatedAt = nowIso();
  });

  const after = await loadStore();
  const finalEntry = after.entries.find((x) => x.id === target.id);
  const finalSec = after.sections.find((x) => x.id === finalEntry.section);
  return {
    status: 'ok', id: finalEntry.id, title: finalEntry.title, section: finalEntry.section,
    // 报**解析后**的字段 key，而不是用户敲的中文标签——调用方/agent 拿它去对比字典
    changed: [...Object.keys(values), ...unsetKeys.map((k) => `-${k}`)],
    newFields: newFields.map((f) => f.key),
    completeness: completeness(finalSec, finalEntry),
  };
}

export async function removeEntry(ref, { section, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, title: target.title, section: target.section } };
  }
  await mutateStore((s) => { s.entries = s.entries.filter((e) => e.id !== target.id); });
  return { status: 'ok', removed: { id: target.id, title: target.title, section: target.section } };
}

/** 字段字典：agent 在填之前必须先看这个，否则只能靠猜字段名。 */
export async function fieldDictionary({ section } = {}) {
  const store = await loadStore();
  const shape = (sec) => ({
    id: sec.id,
    title: sec.title,
    titleField: sec.titleField,
    titleLabel: sec.titleLabel,
    groups: sec.groups,
    fields: sec.fields.map((x) => ({
      key: x.key, label: x.label, type: x.type, group: x.group,
      kind: x.kind || '',
      // 结构清单的列跟着字典出去：agent 写行之前得知道行里允许哪些键
      fields: x.fields || null,
      // 表格的列（带类型/公式）与统计行同理
      columns: x.columns || null,
      totals: x.totals || null,
      maxRows: x.maxRows || null,
      hint: x.hint || '', options: x.options || null, sensitive: isSensitiveField(sec, x.key),
    })),
  });
  if (section) return { count: 1, sections: [shape(mustFindSection(store, section))] };
  return { count: store.sections.length, sections: store.sections.map(shape) };
}

/**
 * KV 直通命令（`key *`）——「存个密钥」不该先说 `--section` 再说 `--set 字段=`。
 *
 * 设计要点：这**不是**第二套业务逻辑。下面每个函数都只是把
 * 「哪个栏目 + 哪个值字段」定好，再调 addEntry / updateEntry / removeEntry 本身。
 * 所以加解密、打码、快照、--dry-run 全部只有一份实现，不可能与 `entry` 命令分叉。
 */
/**
 * 找 KV 表格：默认是**标了 `kv: true` 的栏目**（密钥模板自带），
 * 也可以用 `--section` 指定任何一个「只有一个值字段」的栏目。
 */
async function kvTarget(store, ref) {
  const sec = ref
    ? findSection(store, ref)
    : findKvSection(store);
  if (!sec) {
    if (ref) throw notFound(`找不到栏目: ${ref} —— 现有: ${sectionNames(store)}`);
    throw badInput('还没有 KV 栏目：用 `nx-sk section add keys --template secret` 建一个。'
      + `现有栏目: ${sectionNames(store)}`);
  }
  const named = (sec.fields || []).find((x) => x.key === 'value');
  if (named) return { sec, valueKey: named.key };
  if (!sec.fields || !sec.fields.length) throw badInput(`栏目「${sec.title}」没有任何字段，不能当 KV 用`);
  if (sec.fields.length > 1) {
    throw badInput(`栏目「${sec.title}」有 ${sec.fields.length} 个字段，不是 KV（KV 表格只能有一个值字段）`);
  }
  return { sec, valueKey: sec.fields[0].key };
}

/** KV 名称不是文件路径，所以比 assertSafeName 宽松：允许中文与空格，只挡路径分隔符。 */
function assertKeyName(name) {
  const s = String(name ?? '').trim();
  if (!s) throw badInput('密钥名不能为空：nx-sk key set <名称> <值>');
  if (s.length > 64) throw badInput(`密钥名过长（${s.length} > 64）: ${s}`);
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw badInput(`密钥名不能含路径分隔符或 '..': ${JSON.stringify(name)}`);
  }
  return s;
}

export async function keyList({ mask, section } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const mine = store.entries.filter((e) => e.section === sec.id);
  const decrypt = await sensitiveViewer(sec, mine);
  return {
    section: sec.id,
    sectionTitle: sec.title,
    valueKey,
    mask: !!mask,
    count: mine.length,
    keys: mine.map((e) => ({
      id: e.id,
      name: e.title,
      value: displaySensitive(e.values?.[valueKey], { mask: !!mask, decrypt }),
      updatedAt: e.updatedAt,
    })),
  };
}

export async function keyGet(name, { mask, section } = {}) {
  const store = await loadStore();
  const { sec, valueKey } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}（用 'nx-sk key list' 看现有的）`);
  const decrypt = await sensitiveViewer(sec, [entry]);
  return {
    id: entry.id,
    name: entry.title,
    section: sec.id,
    value: displaySensitive(entry.values?.[valueKey], { mask: !!mask, decrypt }),
    mask: !!mask,
    updatedAt: entry.updatedAt,
  };
}

/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 */
/**
 * KV 的 SET 语义：不存在就建，存在就**覆盖**。
 * 这与 `entry add` 的「重名报 CONFLICT」是刻意不同的——`set` 这个名字本身就说明是覆盖，
 * 返回值里带 `created` 让调用方知道到底发生了哪一种。
 *
 * 播种不再自带密钥栏目之后，「第一次 `key set`」会撞上「还没有 KV 栏目」。
 * 写路径在这里**自动补建**一个（与 `section add --template secret` 同一模板、同一形状）：
 * `key set` 的语义是「我要存」，被挡回来只会让人去抄一遍建栏目的命令。
 * 读路径（get / list）不建——读不到就是读不到，悄悄建一个空栏目是噪音。
 */
export async function keySet(name, value, { section, 'dry-run': dryRun } = {}) {
  const key = assertKeyName(name);
  const raw = value === undefined || value === null ? '' : String(value);
  if (!raw.trim()) throw badInput(`密钥值不能为空：nx-sk key set ${key} <值>`);

  let store = await loadStore();
  let createdKv = false;
  if (!section && !findKvSection(store)) {
    await mutateStore((s) => {
      const sec = { ...instantiateTemplate('secret', { id: 'secret', title: '密钥', order: 90 }), createdAt: nowIso(), updatedAt: nowIso() };
      s.sections.push(sec);
      s.sections.sort((a, b) => a.order - b.order);
    });
    store = await loadStore();
    createdKv = true;
  }
  const { sec, valueKey } = await kvTarget(store, section);

  const existing = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (existing) {
    // 两种「没变」都要认出来，否则会产生无意义的新密文 + 新快照：
    //   ① 明文与现值相同（重复写同一个 key 是常态，agent 会重试）
    //   ② 传进来的是**打码占位**（面板把列表里的值原样回传）
    const decrypt = await sensitiveViewer(sec, [existing]);
    if (decrypt) {
      try {
        const plain = String(decrypt(existing.values?.[valueKey]));
        if (plain === raw || maskValue(plain) === raw) {
          return { status: 'skipped', created: false, unchanged: true, name: key, section: sec.id, id: existing.id, createdKv };
        }
      } catch { /* 解不开（换过密钥）就按覆盖处理 */ }
    }
    const r = await updateEntry(existing.title, { set: { [valueKey]: raw }, section: sec.id, 'dry-run': dryRun });
    if (r.status === 'skipped') return { ...r, name: key, created: false, section: sec.id, createdKv };
    return { status: 'ok', created: false, replaced: true, name: key, section: sec.id, id: r.id, createdKv };
  }

  const r = await addEntry({ section: sec.id, title: key, set: { [valueKey]: raw }, 'dry-run': dryRun });
  if (r.status === 'skipped') return { ...r, name: key, created: true, section: sec.id, createdKv };
  return { status: 'ok', created: true, replaced: false, name: key, section: sec.id, id: r.id, createdKv };
}

export async function keyRemove(name, { section, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const { sec } = await kvTarget(store, section);
  const key = assertKeyName(name);
  const entry = store.entries.find((e) => e.section === sec.id && e.title === key);
  if (!entry) throw notFound(`没有这个密钥: ${key}`);
  return removeEntry(entry.id, { 'dry-run': dryRun });
}

// —— 原始资料袋（source 字段）——
//
// 袋是**乱入区**：先原样收下杂乱资料（邮件、截图、PDF 摘录、手抄的表），
// 之后由 agent 或人按栏目字段字典整理成结构化字段。
// 命令族：source list / get / add / remove / ensure。

/** 某条目的袋内容（原始形状）。 */
function sourceItemsOf(entry) {
  return normalizeSourceItems(entry?.values?.source) || [];
}

/** 袋里引用的附件解析（名字 / 物理路径 / 链接）——否则只剩一串 f_xxx。 */
function sourceFiles(store, items) {
  const files = {};
  for (const item of items) {
    if (item.kind !== 'file' || !item.fileId || files[item.fileId]) continue;
    const rec = att.findFileRecord(store, item.fileId);
    if (!rec) continue;
    const links = att.fileLinks(rec);
    files[item.fileId] = {
      id: rec.id, name: rec.name, ext: rec.ext, isImage: att.isImageExt(rec.ext),
      path: displayPath(att.fileRecordAbs(rec)), url: links.url, downloadUrl: links.downloadUrl,
    };
  }
  return files;
}

/** source list：各栏目的袋子概况。 */
export async function listSource({ section } = {}) {
  const store = await loadStore();
  const secs = section
    ? [mustFindSection(store, section)]
    : store.sections.filter((s) => s.kv !== true);
  const out = [];
  for (const sec of secs) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    let items = 0;
    let filled = 0;
    for (const e of mine) {
      const n = sourceItemsOf(e).length;
      if (n) { filled += 1; items += n; }
    }
    out.push({
      section: sec.id,
      sectionTitle: sec.title,
      hasField: sec.fields.some((f) => f.type === 'source'),
      entries: mine.length,
      filled,
      items,
    });
  }
  return { count: out.length, sections: out };
}

/** source get：某条目的袋明细。 */
export async function getSource(ref, { section } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const items = sourceItemsOf(entry);
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    hasField: sec.fields.some((f) => f.type === 'source'),
    count: items.length,
    // 当前版本 = 没被取代的；旧的留痕但不算数
    current: items.filter((x) => !x.superseded).length,
    superseded: items.filter((x) => x.superseded).length,
    items,
    files: sourceFiles(store, items),
    updatedAt: entry.updatedAt,
  };
}

/** source add：往袋里加一条（文字 / 文件 / 网址）。 */
export async function addSourceItem(ref, { section, text, file, url, name, note, mapped, at, supersedes, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, target.section);
  if (!sec.fields.some((f) => f.type === 'source')) {
    throw badInput(`栏目「${sec.title}」没有「原始资料」字段（source）——先跑 nx-sk source ensure 补上`);
  }
  const items = sourceItemsOf(target);
  let item = null;
  const extra = { note, mapped, at };
  if (supersedes) extra.supersedes = Array.isArray(supersedes) ? supersedes : [supersedes];
  if (file) {
    // 文件先进附件库，袋里只留引用。**默认复制不搬走**：「加一条资料」不该把用户本机的
    // 原件搬进库里（那是 `file add` 的语义，且它明写「默认移动」）。
    const outcome = await att.importLocalFile(store, { path: file, copy: true, category: 'other' });
    item = normalizeSourceItem({ kind: 'file', fileId: outcome.record.id, name: name || outcome.record.name, ...extra });
    if (!dryRun && !outcome.duplicate) await mutateStore((s) => { s.files.push(outcome.record); });
  } else if (url) {
    item = normalizeSourceItem({ kind: 'url', url, name, ...extra });
  } else if (text !== undefined && text !== null && String(text).trim() !== '') {
    item = normalizeSourceItem({ kind: 'text', text, name, ...extra });
  } else {
    throw badInput('要给一条资料：--text <文字> | --file <本机路径> | --url <网址>');
  }
  if (!item) throw badInput('这条资料是空的，没东西可加');
  // 冲突判定（同名以新的为准、旧的留痕）在归一层统一发生
  const next = resolveSourceConflicts([...items, item]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: item, count: next.length };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', added: item, count: next.length, current: next.filter((x) => !x.superseded).length, id: target.id, title: target.title, section: sec.id };
}

/**
 * source update：改袋里某一条的**元信息**（名字 / 备注 / 整理去向）。
 *
 * 为什么要它：「整理完要留痕」是双向同步的锚点 —— 一条资料被同步到哪些字段（mapped）
 * 记在它自己身上，下次同步就能知道「这条已经用过」，不会重复整理。
 * 注意**不改正文**（text 永远是原文；改内容 = 删掉重加）。
 */
export async function updateSourceItem(ref, { section, id, name, note, mapped, at, superseded, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) throw notFound(`袋里没有这条资料: ${key}`);
  const item = { ...items[idx] };
  if (name !== undefined) item.name = String(name);
  if (note !== undefined) item.note = String(note);
  if (at !== undefined) item.at = String(at);
  if (superseded !== undefined) {
    if (superseded === true) item.superseded = true;
    else delete item.superseded;
  }
  if (mapped !== undefined) {
    const list = Array.isArray(mapped) ? mapped : String(mapped).split(/[,，、]+/);
    const keys = list.map((x) => String(x).trim()).filter(Boolean);
    if (keys.length) item.mapped = keys;
    else delete item.mapped;
  }
  const next = resolveSourceConflicts([...items.slice(0, idx), item, ...items.slice(idx + 1)]);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldChange: item };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    e.values.source = next;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', updated: item, count: next.length, id: target.id, title: target.title };
}

/** source remove：从袋里删掉一条。 */
export async function removeSourceItem(ref, { section, id, 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const items = sourceItemsOf(target);
  const key = String(id || '').trim();
  const idx = items.findIndex((x) => x.id === key);
  if (idx < 0) {
    const hint = items.length ? `袋里有 ${items.length} 条，用 nx-sk source get ${target.id} 看 id` : '袋是空的';
    throw notFound(`袋里没有这条资料: ${key}（${hint}）`);
  }
  const [gone] = items.splice(idx, 1);
  if (dryRun) return { status: 'skipped', dryRun: true, wouldRemove: gone };
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    e.values.source = items.length ? items : null;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', removed: gone, count: items.length, id: target.id, title: target.title };
}

/**
 * source ensure：给所有缺「原始资料」字段的栏目补上。
 *
 * 为什么需要它：栏目是**持久化数据**，模板后来新增的字段不会回溯到已建好的栏目
 * （老问题的同一形状，见 `section sync`）。source 字段是「每个栏目都该有」的那种，
 * 所以给一条命令把缺口一次补齐，而不是让用户逐个栏目加。
 */
export async function ensureSourceFields({ 'dry-run': dryRun } = {}) {
  const store = await loadStore();
  const added = [];
  const skipped = [];
  for (const sec of store.sections) {
    if (sec.kv) { skipped.push({ id: sec.id, title: sec.title, why: 'KV 表（形状固定，不加字段）' }); continue; }
    if (sec.fields.some((f) => f.type === 'source')) { skipped.push({ id: sec.id, title: sec.title, why: '已有' }); continue; }
    added.push(sec.id);
  }
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: added, skipped };
  if (!added.length) return { status: 'ok', added: [], skipped, count: 0 };
  await mutateStore((s) => {
    for (const id of added) {
      const sec = s.sections.find((x) => x.id === id);
      if (!sec) continue;
      if (!sec.groups.some((g) => g.id === SOURCE_GROUP.id)) sec.groups.push({ ...SOURCE_GROUP });
      if (!sec.fields.some((f) => f.key === SOURCE_FIELD.key)) sec.fields.push({ ...SOURCE_FIELD });
      sec.updatedAt = nowIso();
    }
  });
  return { status: 'ok', added, skipped, count: added.length };
}

// —— CLI 人读渲染（KV 系列） ——
export function renderKeyList(d) {
  const lines = [`${d.count} 个密钥 · 栏目 ${d.section}${d.mask ? ' · 已打码' : ''}`];
  for (const k of d.keys) lines.push(`  ${String(k.name).padEnd(24)} ${k.value}`);
  lines.push('', `取值: nx-sk key get <名称>　　写入: nx-sk key set <名称> <值>　　（要打码加 --mask）`);
  return lines.join('\n');
}

export function renderKeyGet(d) {
  return `${d.name} = ${d.value}${d.mask ? '\n（已打码显示；去掉 --mask 即原文）' : ''}`;
}

export function renderKeySet(d) {
  if (d.status === 'skipped' && d.unchanged) return `未改动：${d.name} 的值与现有值相同`;
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange)}`;
  return `${d.created ? '已新建' : '已覆盖'}密钥 ${d.name}（栏目 ${d.section}）`
    + `\n值已密文落盘；核对用 nx-sk key get ${d.name}`;
}

export function renderKeyRemove(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldRemove)}`;
  return `已删除密钥 ${d.removed.title}`;
}

// —— CLI 人读渲染（原始资料） ——
const SOURCE_KIND_LABEL = { text: '文字', file: '附件', url: '网址' };

export function renderSourceList(d) {
  const lines = [`原始资料袋 · ${d.count} 个栏目`];
  for (const s of d.sections) {
    const tag = s.hasField ? '' : '　[缺 source 字段：nx-sk source ensure 补上]';
    lines.push(`  ${s.section.padEnd(14)}${s.sectionTitle}　${s.items} 条资料 / ${s.filled} 个条目有袋（栏目共 ${s.entries} 条目）${tag}`);
  }
  lines.push('', '看某个条目的袋: nx-sk source get <条目id>　　加一条: nx-sk source add <条目id> --text "…"');
  return lines.join('\n');
}

export function renderSourceGet(d) {
  const lines = [`${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 原始资料 ${d.count} 条`
    + (d.superseded ? `（当前 ${d.current} 条，另有 ${d.superseded} 条被更新的取代、留痕可查）` : '')];
  if (!d.count) {
    lines.push('  （袋子是空的）');
    lines.push('', `加一条: nx-sk source add ${d.id} --text "随手记的一句"`);
    return lines.join('\n');
  }
  for (const item of d.items) {
    const kind = SOURCE_KIND_LABEL[item.kind] || item.kind;
    const mapped = item.mapped?.length ? `　→ 已整理到 ${item.mapped.join('、')}` : '';
    const old = item.superseded ? '　[已被取代，留痕]' : '';
    const when = sourceItemTimeLabel(item);
    lines.push(`  ${item.id}　[${kind}] ${item.name}${when ? `　${when}` : ''}${old}${mapped}`);
    if (item.kind === 'file') {
      const f = d.files?.[item.fileId];
      lines.push(`      ${f ? `${f.name}　${f.path}` : `附件 ${item.fileId}（库里已不存在）`}`);
    } else if (item.kind === 'text') {
      for (const line of String(item.text).split('\n')) lines.push(`      ${line}`);
    } else if (item.kind === 'url') {
      lines.push(`      ${item.url}`);
    }
    if (item.note) lines.push(`      备注: ${item.note}`);
  }
  lines.push('', `整理成结构化字段: nx-sk entry update ${d.id} --data @整理.json`);
  return lines.join('\n');
}

export function renderSourceChange(d) {
  if (d.status === 'skipped') {
    // 顺序要紧：ensure 的 wouldAdd 是**栏目 id 数组**，add 的是**一条资料对象**——
    // 数组也是真值，先判 item 会把数组当成资料渲染成 "[undefined] undefined"。
    if (Array.isArray(d.wouldAdd)) {
      return d.wouldAdd.length
        ? `试运行（未落盘）：将给 ${d.wouldAdd.length} 个栏目补上「原始资料」字段：${d.wouldAdd.join('、')}`
        : '试运行（未落盘）：所有栏目都已有「原始资料」字段，无需补';
    }
    if (d.wouldAdd) return `试运行（未落盘）：将加入一条资料 [${d.wouldAdd.kind}] ${d.wouldAdd.name}`;
    if (d.wouldRemove) return `试运行（未落盘）：将移除 ${d.wouldRemove.id}（${d.wouldRemove.name}）`;
    return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldRemove || {})}`;
  }
  if (d.removed) return `已从资料袋移除 ${d.removed.id}（${d.removed.name}）· 袋里还剩 ${d.count} 条`;
  if (d.added && !Array.isArray(d.added)) return `已加入资料 [${d.added.kind}] ${d.added.name} · 袋里共 ${d.count} 条`;
  if (Array.isArray(d.added)) {
    return d.added.length
      ? `已给 ${d.added.length} 个栏目补上「原始资料」字段：${d.added.join('、')}`
      : '所有栏目都已有「原始资料」字段，无需补';
  }
  return '没有改动';
}

function maskAll(section, entry, decrypt, mask) {
  const out = {};
  for (const [k, v] of Object.entries(entry.values)) {
    out[k] = isSensitiveField(section, k) ? displaySensitive(v, { mask, decrypt }) : v;
  }
  return out;
}

// —— CLI 人读渲染 ——
export function renderEntryList(d) {
  const lines = [`${d.count} 条 / 共 ${d.total} 条`];
  for (const e of d.entries) {
    lines.push(`  ${e.id}  ${(e.title || '（无名）').padEnd(16)} ${String(e.completeness.ratio).padStart(3)}% 完整度　[${e.section}]`);
    const missing = e.missing.slice(0, 6).map((m) => m.label).join('、');
    if (missing) lines.push(`      未填: ${missing}${e.missing.length > 6 ? ` 等 ${e.missing.length} 项` : ''}`);
    // 「不填」只报**真的空着**的可选字段。可选字段填了值还列出来，会让人以为
    // 这份数据缺东西（`excluded` 是策略标记，不是空值清单）。
    const skipped = (e.excluded || []).filter((m) => isBlank(e.values?.[m.key]));
    if (skipped.length) {
      lines.push(`      不填: ${skipped.map((m) => m.label).join('、')}（主动跳过，不计入完整度）`);
    }
  }
  lines.push('', '看全部字段: nx-sk entry get <id> --json　或　nx-sk entry fields --section <id>');
  return lines.join('\n');
}

/**
 * 一个字段值渲染成几行文本。
 * - 附件（`file` 字段，值可能是 id 列表）：解析成「附件名　物理路径」，**几个占几行**
 * - 结构清单（entrylist）：**一行一条**，`列名=值 · 列名=值`——清单本来就是拿来看的
 * - 原始资料（source）：**一行一条**，带类型与摘要——袋里的东西要能一眼分清是字还是文件
 * - 其它数组（tags 之类）：仍旧一行、顿号连接——不要顺手把它们也拆成多行
 */
function valueLines(d, v, key) {
  const type = d.fieldTypes?.[key];
  const asFile = (x) => (d.files && d.files[x] ? `${d.files[x].name}　${d.files[x].path}` : null);
  // 表格整张印出来（表头 + 数据 + 统计行 + 公式报错）。不这么做的话，一行表格只会被压成
  // 一条 `k=v · k=v`，合计和计算列全看不见 —— 而「看一眼合计」正是这类表最常见的用途。
  if (type === 'table' && d.tables?.[key]) return renderTableText(d.tables[key], { indent: '' }).split('\n');
  if (Array.isArray(v) && v.length && v.every((x) => asFile(x))) return v.map(asFile);
  const one = asFile(v);
  if (one) return [one];
  if (type === 'source' && Array.isArray(v)) {
    const kindLabel = { text: '文字', file: '附件', url: '网址' };
    return v.map((item) => {
      const tag = kindLabel[item.kind] || item.kind || '资料';
      const body = item.kind === 'file' && d.files?.[item.fileId]
        ? `${d.files[item.fileId].name}　${d.files[item.fileId].path}`
        : sourceItemSummary(item);
      const mapped = item.mapped?.length ? `　→ 已整理到 ${item.mapped.join('、')}` : '';
      return `[${tag}] ${item.name || body}${body && body !== item.name ? `　${body}` : ''}${mapped}`;
    });
  }
  if (Array.isArray(v) && v.length && v.every(isPlainRow)) {
    const subs = d.entryFields?.[key] || [];
    const labelOf = (k) => subs.find((s) => s.key === k)?.label || k;
    return v.map((row, i) => Object.entries(row)
      .filter(([, x]) => !isBlank(x))
      .map(([k2, x]) => `${labelOf(k2)}=${x}`)
      .join(' · ') || `第 ${i + 1} 行（空）`);
  }
  if (Array.isArray(v)) return [v.join('、')];
  if (typeof v === 'boolean') return [v ? '是' : '否'];
  // 图文字段：`![说明](f_x)` → `[图片: 说明] 本地路径`。不换的话 CLI 只会吐一串 id，
  // 而「这个 id 对应哪个文件」正是读的人唯一想知道的。缺附件时保留醒目的「图片缺失」。
  const s = String(v);
  const text = type === 'md' ? rewriteMdImages(s, (id) => d.files?.[id] || null) : s;
  // 多行正文（YAML / Dockerfile / 一段说明）按行拆开再回填缩进。
  // 不拆的话只有第一行带着键名列宽，后面每一行都从第 0 列开始 ——
  // 一段 40 行的清单打印出来像"掉出了表格"，人眼完全没法对。
  return text.includes('\n') ? text.split('\n') : [text];
}

export function renderEntryGet(d) {
  const c = d.completeness || {};
  // 只算**真的空着**的可选字段：填了值的可选字段不属于「跳过」，
  // 否则一份填满的资料会被报成「另有 7 项已标不填」，自相矛盾。
  const skipped = (d.excluded || []).filter((m) => isBlank(d.values?.[m.key]));
  const lines = [
    `${d.title || d.id}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
    + (skipped.length ? ` · 另有 ${skipped.length} 项已标不填` : '')
    + `${d.mask ? ' · 已打码' : ''}`,
  ];
  for (const [k, v] of Object.entries(d.values)) {
    if (v === null) continue;
    const rendered = valueLines(d, v, k);
    lines.push(`  ${k.padEnd(24)} ${rendered[0]}`);
    for (const extra of rendered.slice(1)) lines.push(`  ${' '.repeat(24)} ${extra}`);
  }
  if (d.missing.length) {
    lines.push('', `未填（${d.missing.length}）: ${d.missing.map((m) => `${m.label}(${m.key})`).join('、')}`);
  }
  // 「不填」和「未填」必须分开说：混在一起会让人以为这些字段还欠着，
  // 而它们恰恰是用户主动决定跳过的。
  if (skipped.length) {
    lines.push('', `不填（${skipped.length}）· 主动跳过、不计入完整度: `
      + skipped.map((m) => `${m.label}(${m.key}｜${m.fillLabel || m.fill})`).join('、'));
  }
  return lines.join('\n');
}

/**
 * 批量删条目 —— 面板上「勾一堆条目按删除」的后端。
 *
 * 与单个删除的差别：
 *   - 找不到的**跳过并记在 missing 里**（status: 'partial'），不让整批失败；
 *     批量操作里「另一个标签页刚删掉一条」比「全都没删」常见得多，整批回滚只会让人重来。
 *   - 一个都找不到才算错（NOT_FOUND）——那时确实是 id 给错了。
 *   - 只认 NOT_FOUND / CONFLICT 两种业务错，别的（比如解密失败）照常抛，不吞。
 */
export async function removeMany(refs, { section, 'dry-run': dryRun } = {}) {
  const list = (Array.isArray(refs) ? refs : String(refs ?? '').split(','))
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!list.length) throw badInput('没有要删的条目（把 id 用逗号分隔，或重复传参）');

  const store = await loadStore();
  const ids = new Set();
  const removed = [];
  const missing = [];
  for (const ref of list) {
    let e = null;
    try {
      e = resolveEntry(store, ref, section);
    } catch (err) {
      if (err?.code !== 'NOT_FOUND' && err?.code !== 'CONFLICT') throw err;
      e = null;
    }
    if (!e) { missing.push(ref); continue; }
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    removed.push({ id: e.id, title: e.title, section: e.section });
  }
  if (!ids.size) throw notFound(`这些条目都不存在: ${list.join(', ')}`);

  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: removed, count: removed.length, missing };
  }
  await mutateStore((s) => { s.entries = s.entries.filter((e) => !ids.has(e.id)); });
  return { status: missing.length ? 'partial' : 'ok', removed, count: removed.length, missing };
}

export function renderEntryRemoveMany(d) {
  const list = d.removed || d.wouldRemove || [];
  const lines = [d.status === 'skipped'
    ? `试运行（未落盘）：将删除 ${d.count} 条条目`
    : `已删除 ${d.count} 条条目`];
  for (const e of list.slice(0, 20)) lines.push(`  ${e.title || '（无名）'}（${e.id}）· ${e.section}`);
  if (list.length > 20) lines.push(`  …另有 ${list.length - 20} 条`);
  if (d.missing?.length) lines.push(`未找到（已跳过）: ${d.missing.join('、')}`);
  return lines.join('\n');
}

export function renderEntryChange(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldCreate || d.wouldChange || d.wouldRemove)}`;
  if (d.removed) return `已删除条目 ${d.removed.id}（${d.removed.title}）`;
  const c = d.completeness;
  if (d.created) {
    return `已创建条目 ${d.title}（${d.id}）· 栏目 ${d.section} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%`
      + (d.createdFields?.length ? `\n新增字段: ${d.createdFields.join(', ')}` : '');
  }
  const extra = d.newFields?.length ? `\n新增字段: ${d.newFields.join(', ')}` : '';
  return `已更新条目 ${d.title}（${d.id}）· 改动 ${d.changed.join(', ')} · 完整度 ${c.filled}/${c.total} = ${c.ratio}%${extra}`;
}

// —— 表格字段（table）的现值 ——
//
// 为什么要一条专门的命令：`entry get` 会把整条条目都印出来，而表格常常是这个条目的主体；
// 只想看「这张表现在多少、合计多少」时，一条命令给一张对齐的表比翻整条条目快得多。
// 它**不写**任何东西：计算列与统计行都是现算的，没有第二份状态可以走偏。

export async function getTable(ref, { field, mask, section } = {}) {
  const store = await loadStore();
  const entry = resolveEntry(store, ref, section);
  const sec = mustFindSection(store, entry.section);
  const defs = sec.fields.filter((f) => f.type === 'table');
  if (!defs.length) {
    throw notFound(`栏目「${sec.title}」没有表格字段（table）。现有字段: ${sec.fields.map((f) => `${f.label}(${f.type})`).join('、')}`);
  }
  const wanted = String(field ?? '').trim();
  const def = wanted
    ? (defs.find((f) => f.key === wanted || f.label === wanted) || null)
    : defs[0];
  if (!def) {
    throw notFound(`栏目「${sec.title}」没有叫「${wanted}」的表格字段（有: ${defs.map((f) => `${f.label}(${f.key})`).join('、')}）`);
  }
  const decrypt = await sensitiveViewer(sec, [entry]);
  const serialized = serializeEntry(sec, entry, { mask: !!mask, decrypt });
  return {
    id: entry.id,
    title: entry.title,
    section: sec.id,
    sectionTitle: sec.title,
    field: def.key,
    fieldLabel: def.label,
    mask: !!mask,
    table: computeTable(def, serialized.values[def.key]),
  };
}

export function renderTable(d) {
  const t = d.table;
  const head = `${d.title || d.id}（${d.id}）· 栏目 ${d.sectionTitle} · 表格「${d.fieldLabel}」${d.field} · ${t.count} 行`
    + (t.errorCount ? ` · ${t.errorCount} 处公式错误` : '')
    + (d.mask ? ' · 已打码' : '');
  const totals = t.totals.length
    ? `\n统计行: ${t.totals.map((x) => x.label).join(' / ')}（每列算不算、怎么算，看列定义的 total；整表表达式写在数据的 totals 里）`
    : '';
  const formulas = t.columns.filter((c) => c.computed);
  const fx = formulas.length ? `\n计算列: ${formulas.map((c) => `${c.label} = ${c.formula}`).join('；')}` : '';
  return `${head}\n${renderTableText(t)}${fx}${totals}`;
}

export function renderFields(d) {
  const lines = [`字段字典：${d.count} 个栏目`];
  for (const s of d.sections) {
    lines.push('', `【${s.title}】${s.id}　条目名字段: ${s.titleField || '（未设）'}　共 ${s.fields.length} 字段`);
    for (const g of s.groups) {
      lines.push(`  ${g.title}（${g.id}）`);
      for (const x of s.fields.filter((f) => f.group === g.id)) {
        const cols = Array.isArray(x.columns)
          ? `  列: ${x.columns.map((c) => `${c.label}[${c.type}${c.formula ? ' 算' : ''}]`).join(' / ')}`
          : '';
        lines.push(`    ${x.key.padEnd(22)} ${x.label}${x.sensitive ? '  [密文]' : ''}${x.options ? `  可选: ${x.options.join(' / ')}` : ''}${cols}${x.hint ? `　${x.hint}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------- 关键 key 台账（链接 / 账号 / 密码 / 镜像 的跨栏目统一列表） ----------
//
// 需求：散在各栏目条目里的「关键 key」（控制台链接、账号、密码、镜像名…）要有一张
// 统一清单，方便一眼拿到、也方便交给 agent 定位修改。
// 匹配规则：字段 key/label 命中启发式 **或** 字段类型是 secret/标记 sensitive。
// **结构清单要展开成行**：场景凭据（deploy 的「凭据清单」）住在清单的行里，
// 只扫顶层字段的话台账就看不见最该看见的那些。
// 值策略：链接类明文（地址是要点击使用的）；账号/密码/token 类一律打码（短值全 *）；
// 其余长文本前 4+尾 4。--reveal 才出原文（密文走解密）。
const KEY_URL_RE = /(url|link|链接|console|入口|registry|仓库|image|镜像)/i;
const KEY_SECRET_RE = /(account|user(?!id)|账号|帐号|password|密码|passwd|pwd|token|secret|apikey|api_key|密钥|身份证|idcard|phone|电话|bank)/i;
const KEY_FIELD_RE = new RegExp(`${KEY_URL_RE.source}|${KEY_SECRET_RE.source}`, 'i');

export async function keysLedger({ section, q, reveal } = {}) {
  const store = await loadStore();
  let sections = store.sections;
  if (section) sections = [mustFindSection(store, section)];
  const out = [];
  for (const sec of sections) {
    const mine = store.entries.filter((e) => e.section === sec.id);
    if (!mine.length) continue;
    const decrypt = await sensitiveViewer(sec, mine);
    for (const e of mine) {
      const item = serializeEntry(sec, e, { decrypt });
      for (const def of sec.fields) {
        const raw = item.values?.[def.key];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;

        // **清单类字段要展开成行**：场景凭据住在清单的行里（deploy 的「凭据清单」、
        // 表格里的「密码」列）—— 只扫顶层字段的话，台账恰好看不见最该看见的那些，
        // 「一条命令看全部凭据」必须真的看得到全部。
        const listRows = def.type === 'entrylist' && Array.isArray(raw)
          ? raw
          : (def.type === 'table' && raw && Array.isArray(raw.rows) ? raw.rows : null);
        if (listRows) {
          // 表格的列存在数据里（结构归数据），优先用数据里的那份
          const subs = def.type === 'table'
            ? (Array.isArray(raw.columns) && raw.columns.length ? raw.columns : (def.columns || []))
            : (def.fields || []);
          for (const row of listRows) {
            if (!row || typeof row !== 'object') continue;
            const rowName = row.name ?? row.名称 ?? row.task ?? row.任务 ?? '';
            for (const [cellKey, cellVal] of Object.entries(row)) {
              if (cellVal === undefined || cellVal === null || String(cellVal).trim() === '') continue;
              const sub = subs.find((x) => x.key === cellKey);
              const cellLabel = sub?.label || cellKey;
              const secretish = sub?.sensitive === true
                || KEY_SECRET_RE.test(cellKey) || KEY_SECRET_RE.test(cellLabel);
              const urlish = KEY_URL_RE.test(cellKey) || KEY_URL_RE.test(cellLabel);
              if (!secretish && !urlish && !KEY_FIELD_RE.test(cellKey) && !KEY_FIELD_RE.test(cellLabel)) continue;
              const s = String(cellVal);
              out.push({
                section: sec.title,
                sectionId: sec.id,
                entry: e.title,
                entryId: e.id,
                key: `${def.key}.${cellKey}`,
                label: rowName ? `${rowName} · ${cellLabel}` : cellLabel,
                sensitive: secretish,
                value: reveal ? s
                  : (secretish || isCipherBlob(s)) ? maskValue(s)
                    : urlish ? s
                      : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
              });
            }
          }
          continue;
        }

        const hit = KEY_FIELD_RE.test(def.key) || KEY_FIELD_RE.test(def.label) || def.type === 'secret' || def.sensitive === true;
        if (!hit) continue;
        const s = Array.isArray(raw) ? raw.join('、') : String(raw);
        const isSecretish = def.type === 'secret' || def.sensitive === true || isSensitiveField(sec, def.key) || KEY_SECRET_RE.test(def.key) || KEY_SECRET_RE.test(def.label);
        const isUrlish = KEY_URL_RE.test(def.key) || KEY_URL_RE.test(def.label);
        out.push({
          section: sec.title,
          sectionId: sec.id,
          entry: e.title,
          entryId: e.id,
          key: def.key,
          label: def.label,
          sensitive: isSecretish,
          value: reveal ? s
            : (isSecretish || isCipherBlob(s)) ? maskValue(s)
              : isUrlish ? s
                : (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : `${s.slice(0, 2)}***`),
        });
      }
    }
  }
  if (q) {
    const needle = String(q).toLowerCase();
    return { count: out.length, reveal: Boolean(reveal), items: out.filter((x) =>
      [x.section, x.entry, x.key, x.label, x.value].some((v) => String(v).toLowerCase().includes(needle))) };
  }
  return { count: out.length, reveal: Boolean(reveal), items: out };
}

export function renderKeysLedger(d) {
  if (!d.items.length) return '（没有命中关键 key 的字段——往条目里填 链接/账号/密码/镜像 类字段后这里会出现）';
  const lines = [`关键 key 台账：${d.items.length} 条${d.reveal ? '（明文）' : '（打码；--reveal 看原文）'}`];
  let last = '';
  for (const x of d.items) {
    if (x.section !== last) { lines.push('', `【${x.section}】${x.sectionId}`); last = x.section; }
    lines.push(`  ${x.entry}（${x.entryId}）`);
    lines.push(`    ${x.label.padEnd(10)} ${x.key.padEnd(14)} ${x.sensitive ? '[密文] ' : ''}${x.value}`);
  }
  return lines.join('\n');
}

// —— 块正文（v4，entry.body）—————————————————————————————————————
//
// 五条 action（设计 §九 9.2）：add / update / move / remove / remove-many。
// 「转类型」没有独立 action —— 就是 `entry.block.update` 一份新形状的块（**整块替换**）。
// secret 块的值走与敏感字段**同一条**密文边界：写时加密、读时默认原文、打码占位拒收。
// 打码写回按 **blockId** 认领 —— 这是块级相对表格列的安全优势（表格只能按值猜 + 行号兜底）。

/** 必须先有一条有正文的条目；没有就明确报错（别静默建一个空 body）。 */
function mustFindEntryWithBody(store, ref, sectionRef) {
  const entry = resolveEntry(store, ref, sectionRef);
  if (!Array.isArray(entry.body)) {
    throw badInput(`条目「${entry.title}」（${entry.id}）还没有块正文。先 entry block add 建一块。`);
  }
  return entry;
}

/**
 * 趟 A：把调用方给的块数据归一成**可落盘**的形状（异步加密在这里做）。
 *
 *   · secret 块：明文 → AES-256-GCM 加密；打码占位 → 按 blockId 认领现值
 *     （认领成功 = 没改，原样保留；认领失败 = 报错，**掩码写回会毁凭据**）；
 *     已是密文对象（导入/还原）→ 原样保留。
 *   · 其余类型：normalizeBlock 归一（非法形状在这里暴露，而不是落盘后读出来才发现）。
 *
 * convert（type 变了）返回 `{ block, converted: true }`；否则 `{ block }`（PATCH 合并语义）。
 */
async function prepareBlockValue(currentBlock, data = {}) {
  const merged = { ...(currentBlock || {}), ...(data && typeof data === 'object' ? data : {}) };
  const type = String(merged.type || (currentBlock ? currentBlock.type : '') || '');
  if (!BLOCK_TYPES.includes(type)) {
    throw badInput(`未知块类型: ${type || '（空）'}（可用: ${BLOCK_TYPES.join(' / ')}）`);
  }

  if (type === 'secret' && merged.value !== undefined && merged.value !== null && merged.value !== '') {
    if (!isCipherBlob(merged.value)) {
      const text = String(merged.value);
      if (looksMasked(text)) {
        const current = currentBlock && currentBlock.type === 'secret' ? currentBlock.value : null;
        if (isCipherBlob(current)) {
          try {
            const { key } = await resolveVaultKey();
            if (maskValue(decryptValue(key, current)) === text) {
              merged.value = current; // 打码占位 == 现值的打码 → 没改，保留现密文
            }
          } catch { /* 解不开（换过密钥）就按新值走，下面照常报错 */ }
        }
        if (!isCipherBlob(merged.value)) {
          throw badInput('secret 块收到的是打码占位而非明文。给完整值，或把这块清掉重填。'
            + '（打码值回写会**毁掉凭据**——块级按 blockId 认领，这次没认领上。）');
        }
      } else {
        const { key } = await resolveVaultKey();
        merged.value = encryptValue(key, text);
      }
    }
  }

  // 新块的 id 在这里就定下来（normalizeBlock 缺 id 会返回 null —— 那正是「块数据不合法」的由来）
  const normalized = normalizeBlock({
    ...merged, type,
    id: (currentBlock && currentBlock.id) || merged.id || newBlockId(),
  });
  if (!normalized) throw badInput(`块数据不合法（类型 ${type}）`);
  const converted = !currentBlock || currentBlock.type !== type;
  return { block: normalized, converted };
}

/** 新块的 id：b_ 前缀（与 f_ 附件同一先例）。 */
function newBlockId() {
  return newId('b');
}

/** 条目的块正文整体校验：一条错误就整体拒绝（写入即体检，与面板预检共用 shared/blocks）。 */
function assertBodyOk(body) {
  const errors = validateBlocks(body);
  if (errors.length) throw badInput(`块正文校验失败（未落盘）：\n- ${errors.join('\n- ')}`);
}

/** 条目（含 body）的读出口：serializeEntry 已带 body（secret 块按 mask/decrypt 展示）。 */
export async function listBlocks(ref, { mask, section } = {}) {
  const d = await getEntry(ref, { mask, section });
  return {
    id: d.id, section: d.section, sectionTitle: d.sectionTitle, title: d.title,
    mask: !!mask, blocks: d.body || [], count: (d.body || []).length,
  };
}

export async function addBlock(ref, { type, data, after, section, 'dry-run': dryRun } = {}) {
  const kind = String(type || (data && data.type) || '').trim();
  if (!kind) throw badInput(`缺少块类型：--type ${BLOCK_TYPES.join(' / ')}`);
  if (!BLOCK_TYPES.includes(kind)) throw badInput(`未知块类型: ${kind}（可用: ${BLOCK_TYPES.join(' / ')}）`);

  const store = await loadStore();
  const target = resolveEntry(store, ref, section);
  const body = Array.isArray(target.body) ? target.body : [];
  const current = data && data.id ? findBlock(body, data.id) : null;
  if (current) throw conflict(`块 id 已存在: ${current.id}（改块用 entry block update，别用 add 冒名顶替）`);

  const incoming = { ...(data && typeof data === 'object' ? data : {}), type: kind };
  const { block } = await prepareBlockValue(null, incoming);
  const withId = data && data.id ? { ...block, id: String(data.id) } : block;

  if (after && !findBlock(body, String(after))) throw notFound(`找不到插入锚点块: ${after}`);
  assertBodyOk(appendBlock(body, withId, after ? String(after) : null));

  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldAdd: withId, after: after || null };
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    if (!Array.isArray(e.body)) e.body = [];
    e.body = appendBlock(e.body, structuredClone(withId), after ? String(after) : null);
    e.updatedAt = nowIso();
  });

  const afterStore = await loadStore();
  const finalEntry = afterStore.entries.find((x) => x.id === target.id);
  return {
    status: 'ok', id: target.id, blockId: withId.id, type: withId.type,
    blocks: (finalEntry.body || []).length,
  };
}

export async function updateBlockValue(ref, blockId, { data, section, 'dry-run': dryRun } = {}) {
  if (!data || typeof data !== 'object' || !Object.keys(data).length) {
    throw badInput('没有要改的内容：--data @file.json（块级只有 PATCH 一种写法）');
  }
  const store = await loadStore();
  const target = mustFindEntryWithBody(store, ref, section);
  const current = findBlock(target.body, blockId);
  if (!current) throw notFound(`找不到块: ${blockId} —— 现有: ${target.body.map((b) => b.id).join(' / ')}`);

  const { block, converted } = await prepareBlockValue(current, data);
  const body = converted ? replaceBlock(target.body, blockId, block) : updateBlock(target.body, blockId, block);
  assertBodyOk(body);

  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldChange: { id: target.id, blockId, converted, type: block.type } };
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    e.body = structuredClone(body);
    e.updatedAt = nowIso();
  });

  return { status: 'ok', id: target.id, blockId, type: block.type, converted };
}

export async function moveBlockTo(ref, blockId, { to, section, 'dry-run': dryRun } = {}) {
  const toIndex = Number(to);
  if (!Number.isFinite(toIndex)) {
    throw badInput('缺少目标位置：--to <index>（0 起；负数表示从尾部数）');
  }
  const store = await loadStore();
  const target = mustFindEntryWithBody(store, ref, section);
  const current = findBlock(target.body, blockId);
  if (!current) throw notFound(`找不到块: ${blockId}`);
  const container = findContainer(target.body, blockId);
  const arr = container ? (container.children || []) : target.body;
  const length = arr.length;
  const from = arr.findIndex((b) => b.id === blockId);
  // 允许负数从尾部数（-1 = 最后一个），与数组下标的直觉一致
  const resolved = toIndex < 0 ? length + toIndex : toIndex;
  if (resolved < 0 || resolved >= length) {
    throw badInput(`--to ${toIndex} 越界：这个容器里有 ${length} 个块（合法 0–${length - 1}，或负数从尾部数）`);
  }
  if (resolved === from) {
    return { status: 'skipped', unchanged: true, id: target.id, blockId, to: resolved };
  }
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldChange: { id: target.id, blockId, from, to: resolved } };
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    e.body = moveToIndex(e.body, container ? container.id : null, blockId, resolved);
    e.updatedAt = nowIso();
  });

  return { status: 'ok', id: target.id, blockId, from, to: resolved };
}

export async function removeBlocks(ref, ids, { section, 'dry-run': dryRun } = {}) {
  // ids 是**逗号分隔的一串**（`entry block remove-many <ref> a,b`）——不拆的话
  // 整串会被当成一个块 id，永远「找不到」（而且报错里的 id 长得像对的）。
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids])
    .flatMap((x) => String(x ?? '').split(/[,，、\s]+/))
    .map((x) => x.trim())
    .filter(Boolean))];
  if (!wanted.length) throw badInput('缺少要删的块 id：entry block remove <ref> <blockId>（多个用逗号分隔）');
  const store = await loadStore();
  const target = mustFindEntryWithBody(store, ref, section);

  const found = wanted.filter((id) => !!findBlock(target.body, id));
  const skipped = wanted.filter((id) => !findBlock(target.body, id));
  if (!found.length) {
    throw notFound(`找不到要删的块: ${wanted.join(', ')} —— 现有: ${target.body.map((b) => b.id).join(' / ')}`);
  }

  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: found, skipped };
  }

  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === target.id);
    for (const id of found) e.body = removeBlockIn(e.body, id);
    e.updatedAt = nowIso();
  });

  const left = (await loadStore()).entries.find((x) => x.id === target.id)?.body?.length ?? 0;
  const partial = skipped.length > 0 && found.length > 0;
  return {
    status: partial ? 'partial' : 'ok',
    removed: found,
    skipped,
    id: target.id,
    blocks: left,
  };
}


/**
 * 导入专用：把一份**明文**块（导出包里恒为明文）重新加密落盘。
 *
 * 与 prepareBlockValue 的分工：那条是「用户改一个块」的入口，按 blockId 认领打码值；
 * 这条是「整份正文换掉」的入口（导入），没有当前块可比对，所以只认明文 → 加密。
 * 两条都走同一个 `encryptValue`，密文形状因此完全一致（store.json 里看不出差别）。
 */
async function sealBlocks(blocks) {
  const out = [];
  for (const raw of blocks || []) {
    const b = normalizeBlock(raw);
    if (!b) continue;
    if (b.type === 'secret' && typeof b.value === 'string' && b.value) {
      const { key } = await resolveVaultKey();
      b.value = encryptValue(key, b.value);
    }
    if (Array.isArray(b.children)) b.children = await sealBlocks(b.children);
    out.push(b);
  }
  return out;
}

/**
 * 整份正文写入（导入路径用）。校验不过就**整份拒绝**——与块 CRUD 同一条「写入即体检」，
 * 免得半份合法的正文落盘（导出的包坏了，应该在边界处停下，而不是存一半）。
 *
 * 空数组 = 清掉正文（键删除，不是留一个空 body：老数据里「没有正文」就是这个形状）。
 */
export async function setEntryBody(entryId, blocks) {
  const sealed = await sealBlocks(blocks);
  assertBodyOk(sealed);
  await mutateStore((s) => {
    const e = s.entries.find((x) => x.id === entryId);
    if (!e) throw notFound(`找不到条目: ${entryId}`);
    if (sealed.length) e.body = sealed;
    else delete e.body;
    e.updatedAt = nowIso();
  });
  return { status: 'ok', id: entryId, blocks: sealed.length };
}

// —— 块正文（v4）的 CLI 渲染 ——
//
// 块的形状是**自描述**的（类型自带值形状），所以渲染要按类型给不同的读法：
// 段落/标题直接印文字，表格印成表，附件印 id + 文件名，密文印打码。
function renderBlockLine(b, indent = '') {
  const label = BLOCK_LABELS[b.type] || b.type;
  switch (b.type) {
    case 'paragraph':
    case 'md':
      return `${indent}[${label}] ${b.text || ''}`;
    case 'heading':
      return `${indent}[${label}] ${'#'.repeat(b.level || 2)} ${b.text || ''}`;
    case 'table': {
      const cols = (b.columns || []).map((c) => c.label || c.key);
      const head = cols.join(' | ');
      const rows = (b.rows || []).map((r) => cols.map((_, i) => {
        const key = (b.columns || [])[i]?.key;
        return String(r[key] ?? '');
      }).join(' | '));
      return `${indent}[${label}] ${cols.length} 列 · ${(b.rows || []).length} 行`
        + `\n${indent}  ${head}`
        + rows.map((r) => `\n${indent}  ${r}`).join('');
    }
    case 'entrylist': {
      const cols = (b.fields || []).map((f) => f.label || f.key);
      return `${indent}[${label}] ${cols.join(' | ')} · ${(b.value || []).length} 行`;
    }
    case 'file':
      return `${indent}[${label}] ${(b.files || []).join(' / ') || '（空）'}`;
    case 'secret': {
      // 与字段同一条边界：默认原文，--mask 打码。displaySensitive 已经在序列化时
      // 把密文解成字符串（或按 mask 打成星号），所以这里读到字符串就是「能显示的」；
      // 读到对象 = 密文解不开（缺密钥 / 换过密钥），必须说清楚而不是假装正常。
      const v = b.value;
      const text = v == null || v === ''
        ? '（空）'
        : (typeof v === 'string' ? v : '（密文无法解开：本机缺密钥或换过密钥）');
      return `${indent}[${label}] ${b.label || '密钥'} = ${text}`;
    }
    case 'section':
      return `${indent}[${label}] ${b.sectionId || '（未指定栏目）'}${b.viewId ? ` · 视图 ${b.viewId}` : ''}`;
    case 'column':
      return `${indent}[${label}] ${(b.widths || []).length ? `列组 · 宽 ${(b.widths || []).join('/')}` : '叶子列'}`
        + ` · ${(b.children || []).length} 个子块`;
    default:
      return `${indent}[${b.type}] ${JSON.stringify(b)}`;
  }
}

export function renderBlocks(d) {
  const lines = [`条目 ${d.title}（${d.id}）· 栏目 ${d.sectionTitle || d.section} · ${d.count} 块`];
  const walk = (blocks, depth) => {
    for (const b of blocks || []) {
      lines.push(renderBlockLine(b, '  '.repeat(depth)));
      if (b.children) walk(b.children, depth + 1);
    }
  };
  walk(d.blocks, 1);
  return lines.join('\n');
}

export function renderBlockChange(d) {
  if (d.status === 'skipped') {
    return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldChange || d.wouldRemove || {})}`;
  }
  if (d.removed) {
    const skipped = d.skipped?.length ? ` · 跳过 ${d.skipped.join(', ')}` : '';
    return `已删除块 ${d.removed.join(', ')}${skipped}`;
  }
  if (d.wouldAdd) return `（试运行）将加块 ${d.wouldAdd.id}（${d.wouldAdd.type}）`;
  if (d.converted) return `已改块 ${d.blockId} · 转为 ${d.type}（整块替换）`;
  return `已改块 ${d.blockId}（${d.type}）`;
}
