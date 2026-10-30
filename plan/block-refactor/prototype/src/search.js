/* 全局搜索 —— 纯函数（可单测）
 *
 * 搜三类：**条目名** / **字段值** / **块正文**，跨所有栏目。
 *
 * **安全边界（最重要的一条）**：密文**不参与搜索**——
 *   · `secret` 字段与 `secret` 块一律跳过（搜它们的明文 = 搜索框成了泄露口）
 *   · `entrylist` 的 **sensitive 子列**、表格的 sensitive 列同样跳过
 * 搜索结果里**永远不出现密文明文**（连片段都不给）。
 *
 * 命中片段带上下文（前后各 SNIPPET_PAD 字），并给出片段内的匹配区间，
 * 由 UI 高亮——不在这里塞 HTML。
 *
 * 实现期的落点见设计文档 §十七：**服务端全量扫**（`entry search`），
 * 前端只负责渲染；原型阶段数据在内存，所以在浏览器里扫（同一套纯函数）。
 */

/** 不参与搜索的字段类型：密文与结构型（table/entrylist/file 有各自的子列规则） */
const FIELD_SKIP = new Set(['secret', 'file']);
/** 不参与搜索的块类型 */
const BLOCK_SKIP = new Set(['secret', 'file']);

const SNIPPET_PAD = 28;
const MAX_PER_ENTRY = 8;

/** 标量字段值 → 可搜的文本 */
function scalarText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.filter((v) => v != null).join(' ');
  if (typeof value === 'object') return '';
  return String(value);
}

/** 表格 / 结构清单的行文本（跳过敏感列） */
function rowsText(value, columns) {
  if (!Array.isArray(value)) return '';
  const cols = Array.isArray(columns) ? columns : [];
  const sensitive = new Set(cols.filter((c) => c && c.sensitive).map((c) => c.key));
  return value
    .map((row) => (row && typeof row === 'object'
      ? Object.keys(row).filter((k) => !sensitive.has(k)).map((k) => scalarText(row[k])).join(' ')
      : scalarText(row)))
    .join(' ');
}

/** 在文本里找查询词（不区分大小写）；找不到返回 null */
export function findMatch(text, query) {
  const hay = String(text ?? '');
  const needle = String(query ?? '');
  if (!hay || !needle) return null;
  const i = hay.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  return { index: i, length: needle.length };
}

/** 取带上下文的片段，并给出片段内的匹配区间 */
export function snippet(text, query) {
  const hay = String(text ?? '');
  const m = findMatch(hay, query);
  if (!m) return null;
  const start = Math.max(0, m.index - SNIPPET_PAD);
  const end = Math.min(hay.length, m.index + m.length + SNIPPET_PAD);
  return {
    text: (start > 0 ? '…' : '') + hay.slice(start, end) + (end < hay.length ? '…' : ''),
    matchStart: m.index - start + (start > 0 ? 1 : 0),
    matchEnd: m.index - start + m.length + (start > 0 ? 1 : 0),
  };
}

/** 块树里所有可搜的文本节点 */
function collectBlocks(blocks, out = []) {
  for (const b of blocks || []) {
    if (!BLOCK_SKIP.has(b.type)) {
      if (typeof b.text === 'string' && b.text) out.push(b);
      if (b.type === 'table') {
        const t = rowsText(b.rows, b.columns);
        if (t) out.push({ ...b, text: t });
      }
    }
    if (b.children) collectBlocks(b.children, out);
  }
  return out;
}

/**
 * 全局搜索。
 * @param {object} sections      栏目字典 { [id]: { id, title, fields, entries } }
 * @param {object} blocksByEntry { [entryId]: Block[] }
 * @param {string} query
 * @returns {Array} 命中列表
 */
export function searchAll(sections, blocksByEntry, query) {
  const q = String(query ?? '').trim();
  if (!q) return [];

  const hits = [];
  for (const sec of Object.values(sections || {})) {
    const fields = sec.fields || [];

    // ⓪ 栏目名命中 → 开的是**这个栏目的数据库面板**（不是某条条目）
    const st = snippet(sec.title, q);
    if (st) {
      hits.push({
        kind: 'section', entryId: null, sectionId: sec.id, sectionTitle: sec.title,
        title: sec.title, snippet: st, fieldLabel: null, blockId: null,
      });
    }

    for (const entry of sec.entries || []) {
      const local = [];

      // ① 条目名
      const t = snippet(entry.title, q);
      if (t) {
        local.push({
          kind: 'title', entryId: entry.id, sectionId: sec.id, sectionTitle: sec.title,
          title: entry.title, snippet: t, fieldLabel: null, blockId: null,
        });
      }

      // ② 字段值（密文与结构型跳过；table/entrylist 只搜非敏感列）
      for (const f of fields) {
        const v = entry.values?.[f.key];
        let text = '';
        if (f.type === 'table') text = rowsText(v, f.columns);
        else if (f.type === 'entrylist') text = rowsText(v, f.fields);
        else if (!FIELD_SKIP.has(f.type)) text = scalarText(v);
        const s = snippet(text, q);
        if (s) {
          local.push({
            kind: 'field', entryId: entry.id, sectionId: sec.id, sectionTitle: sec.title,
            title: entry.title, snippet: s, fieldLabel: f.label, blockId: null,
          });
        }
      }

      // ③ 块正文
      for (const b of collectBlocks(blocksByEntry?.[entry.id])) {
        const s = snippet(b.text, q);
        if (s) {
          local.push({
            kind: 'block', entryId: entry.id, sectionId: sec.id, sectionTitle: sec.title,
            title: entry.title, snippet: s, fieldLabel: null, blockId: b.id,
            blockType: b.type,
          });
        }
      }

      const rank = { title: 0, field: 1, block: 2 };
      local.sort((a, b) => rank[a.kind] - rank[b.kind]);
      hits.push(...local.slice(0, MAX_PER_ENTRY));
    }
  }
  return hits;
}

/** 命中的去重视图（同一条目同一块只算一次） */
export function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.entryId}:${h.kind}:${h.blockId || h.fieldLabel || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
