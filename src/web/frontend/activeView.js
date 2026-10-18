// 「当前该显示哪个 tab」的解析规则 —— **一处实现，可以单测**。
//
// 抽出来的理由：这个项目在这里反复出过同一种错 ——「兜底不该兜的时候兜了」。
// 早先 DEFAULT_UI.view 写死成 'job'，删掉 job 栏目后首屏就落在一个不存在的 id 上；
// 反过来在 boot 之前兜底，又会把深链 `#/job` 覆盖成「第一个静态工具页」。
// 这类错在浏览器里肉眼很难发现（页面看起来一切正常，只是落在错的地方），
// 所以规则必须是纯函数 + 断言，而不是散在组件里的三元表达式。
//
// 解析顺序：显式选择（地址栏深链 / 本次会话点过的 tab）> settings.defaultSection > 第一个 tab。
// 第三级即「设置 → 默认栏目」的落地点。

// 旧书签与 localStorage 里的别名（加密备份模块已删除，原 #/backup 落到「设置」）
export const LEGACY_VIEW = { backup: 'settings' };

export function normalizeViewId(id) {
  return LEGACY_VIEW[id] || id || '';
}

/**
 * @param {string} uiView       显式选择（空串 = 还没选过）
 * @param {Array}  tabs         可用 tab（栏目 + 工具）。**boot 之前传空数组**
 * @param {string} defaultSection settings.defaultSection（可能指向已被删掉的栏目）
 * @param {{booted?: boolean}} opts boot 之前不做任何兜底：
 *        那时 tabs 里只有静态工具页，兜底会选中它，从而顶掉深链与默认栏目。
 */
export function resolveActiveView(uiView, tabs, defaultSection, { booted = true } = {}) {
  const list = Array.isArray(tabs) ? tabs : [];

  const wanted = normalizeViewId(uiView);
  if (wanted) {
    const hit = list.find((t) => t.id === wanted);
    if (hit) return hit; // 显式选择永远优先，哪怕它排在默认栏目之后
  }
  if (!booted) return null;

  const def = normalizeViewId(defaultSection);
  if (def) {
    const hit = list.find((t) => t.id === def);
    if (hit) return hit; // 默认栏目指向已删栏目时优雅跳过
  }
  return list[0] || null;
}
