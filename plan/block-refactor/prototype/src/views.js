/* 视图 —— 栏目视图的**推断 / 解析 / 投影**（纯函数，可单测）
 *
 * 设计 §八 8.2：`section.views?: ViewConfig[]`，缺省时**读取层推断一条**（不落盘）。
 *
 *   ViewConfig = {
 *     id, type: 'table'|'board'|'kv', title,
 *     columns?: [{ key, width?, hidden? }],   // 只存投影：类型/标签回查字段字典
 *     groupBy?: string,                       // board：select 字段 key
 *     sort?: { key, dir } | null,
 *   }
 *
 * 三条规矩（都来自设计，不是本轮发明的）：
 *   ① **缺省供给不落盘**：`views` 缺席时推断，但**不写回** store。
 *   ② **投影只存 key**：类型/标签/候选值一律回查字段字典（单一事实源）。
 *   ③ **投影降级**：view 引用的字段被删 → 渲染「已删字段」弱占位，**不炸、不静默消失**。
 *
 * 四种视图（面板上的四个 chips）与 ViewConfig.type 的对应：
 *   表格 → table（全部列）　精简 → table（少几列，**仍是 table**）
 *   看板 → board（groupBy = 某个 select 字段）　KV → kv（整栏目的键值读法）
 */

/** 栏目是 KV 栏目吗 */
export function isKvSection(section) {
  return !!section && section.kv === true;
}

/**
 * 可投影的字段：**除 source（原始资料袋）以外的全部字段**（设计 §八 8.2：
 * 「非 kv → 一条 {type:'table', columns: 全部非 source 字段}」）。
 * 密文字段照常进列——值默认打码，列本身不是秘密。
 */
export function projectableFields(section) {
  return (section?.fields || []).filter((f) => f.key !== 'source');
}

/** 缺省视图推断（**只读路径，不落盘**） */
export function inferViews(section) {
  if (isKvSection(section)) {
    return [{ id: 'v_kv', type: 'kv', title: 'KV' }];
  }
  const fields = section?.fields || [];
  const titleKey = section?.titleField || fields.find((f) => f.type === 'text')?.key;
  const selectField = fields.find((f) => f.type === 'select');

  const views = [
    {
      id: 'v_table',
      type: 'table',
      title: '表格',
      columns: projectableFields(section).map((f) => ({ key: f.key })),
    },
    {
      id: 'v_compact',
      type: 'table',
      title: '精简',
      columns: [titleKey, selectField?.key].filter(Boolean).map((key) => ({ key })),
    },
  ];
  if (selectField) {
    views.push({ id: 'v_board', type: 'board', title: '看板', groupBy: selectField.key });
  }
  return views;
}

/** 栏目当前生效的视图清单：配置优先，缺席则推断（**不写回**） */
export function viewsOf(section) {
  const configured = section?.views;
  return Array.isArray(configured) && configured.length ? configured : inferViews(section);
}

/**
 * 解析出一个视图。
 * @returns {{ view: object, views: object[], isDefault: boolean }}
 */
export function resolveView(section, viewId) {
  const views = viewsOf(section);
  const view = views.find((v) => v.id === viewId) || views[0];
  return { view, views, isDefault: !viewId || view.id !== viewId };
}

/**
 * 把 view 的 columns 解析成**带标签与降级标记**的投影。
 * 字段被删 → `{ key, label:'已删字段', field:null, missing:true }`（弱占位，不炸）。
 */
export function resolveColumns(section, view) {
  const byKey = new Map((section?.fields || []).map((f) => [f.key, f]));
  const cols = Array.isArray(view?.columns) ? view.columns : [];
  return cols.map((c) => {
    const f = byKey.get(c.key) || null;
    return {
      key: c.key,
      label: f ? f.label : '已删字段',
      field: f,
      missing: !f,
      width: c.width,
      hidden: !!c.hidden,
    };
  });
}

/** 看板视图的分组字段（select） */
export function groupFieldOf(section, view) {
  if (!view || view.type !== 'board' || !view.groupBy) return null;
  return (section?.fields || []).find((f) => f.key === view.groupBy) || null;
}

/** 按视图排序（v1 只支持 columns / sort，不发明查询 DSL——设计 §八 8.2） */
export function sortRows(rows, view) {
  const s = view?.sort;
  if (!s || !s.key) return rows;
  const dir = s.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a.values?.[s.key];
    const bv = b.values?.[s.key];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av > bv ? 1 : -1) * dir;
  });
}
