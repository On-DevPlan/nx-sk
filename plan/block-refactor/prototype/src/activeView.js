/* 深链 —— `#/栏目id` / `#/栏目id/条目id` 的解析（纯函数，可单测）
 *
 * 抄的是老实现 `src/web/frontend/activeView.js` 的纪律：**一处实现 + 纯函数 + 断言**。
 * 那边反复吃过同一种亏——「兜底不该兜的时候兜了」：
 *   · 早先 `DEFAULT_UI.view` 写死 'job'，删掉 job 栏目后首屏落在不存在的 id 上；
 *   · 反过来在 boot 之前兜底，又把深链 `#/job` 覆盖成「第一个静态工具页」。
 * 这类错在浏览器里肉眼很难发现（页面看起来一切正常，只是落在错的地方）。
 *
 * **新壳的语义变了（设计 §十五 15.1）**：老壳里深链指向「哪个 tab 显示」，
 * 新壳里顶栏**没有栏目 tab**了 —— 深链指向「工作区里开哪个面板」：
 *   `#/栏目id`        → 开该栏目的**数据库面板**
 *   `#/栏目id/条目id` → 再开该条目的**详情面板**
 * 没有深链时 → 用存下来的工作区布局（ui.workspace），**不兜底到某个栏目**
 * （老壳的「默认栏目」这一级，由「持久化的布局」接手）。
 */

/** 解析 hash → { sectionId, entryId }；没有就两个都是 null */
export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  return {
    sectionId: parts[0] || null,
    entryId: parts[1] || null,
  };
}

/** 拼 hash（不跳页面，只给 navigate 用） */
export function buildHash(sectionId, entryId) {
  if (!sectionId) return '#/';
  return entryId ? `#/${encodeURIComponent(sectionId)}/${encodeURIComponent(entryId)}` : `#/${encodeURIComponent(sectionId)}`;
}

/**
 * 把深链解析成「要开哪些面板」。
 * @param {string} hash
 * @param {object} sections 栏目字典
 * @returns {{ sectionId: string, entryId: string|null, missing: 'section'|'entry'|null }|null}
 *          null = 没有深链（用工作区布局，不兜底）
 */
export function resolveDeepLink(hash, sections) {
  const { sectionId, entryId } = parseHash(hash);
  if (!sectionId) return null;

  const sec = sections?.[sectionId];
  if (!sec) return { sectionId, entryId: null, missing: 'section' };

  if (!entryId) return { sectionId, entryId: null, missing: null };
  const entry = (sec.entries || []).find((e) => e.id === entryId);
  if (!entry) {
    // 条目没了（被删）→ 只开栏目面板，**不要开一个坏掉的详情面板**
    return { sectionId, entryId: null, missing: 'entry' };
  }
  return { sectionId, entryId, missing: null };
}
