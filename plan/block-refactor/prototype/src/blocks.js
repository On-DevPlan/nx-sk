/* 块树操作 —— 纯函数（可单测）
 *
 * 块是**递归**的（§十三 13.1）：容器块有 children，叶块没有。
 * 这里只管树的结构操作，不碰渲染、不碰数据层。
 *
 * 形状（§十三 13.2 + R13 修订）：
 *   column 组   = { type:'column', widths:[60,40], children:[列, 列] }   // widths 非空
 *   column 叶子 = { type:'column', widths:[],      children:[内容块…] }  // widths 为空
 *   section     = { type:'section', sectionId, viewId? }                // 内嵌另一个栏目的数据库视图
 * 判别规则：**`column` 节点的 widths 为空 → 它是叶子列**（内容直接挂它下面）；
 * 非空 → 它是列组，widths[i] 是第 i 个子列的宽度百分比。
 */

/** 深度优先找块 */
export function findBlock(list, id) {
  for (const b of list || []) {
    if (b.id === id) return b;
    if (b.children) {
      const hit = findBlock(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** 不可变更新一个块（按 id 深搜） */
export function updateBlock(list, id, patch) {
  return (list || []).map((b) => {
    if (b.id === id) return { ...b, ...patch };
    if (!b.children) return b;
    const children = updateBlock(b.children, id, patch);
    return children === b.children ? b : { ...b, children };
  });
}

/** 不可变删除一个块（含其子树） */
export function removeBlock(list, id) {
  const out = [];
  for (const b of list || []) {
    if (b.id === id) continue;
    out.push(b.children ? { ...b, children: removeBlock(b.children, id) } : b);
  }
  return out;
}

/** 在某个容器里把 fromId 移到 toId 的位置（不可变） */
export function moveBlock(list, containerId, fromId, toId) {
  if (!containerId) {
    const arr = [...(list || [])];
    const i = arr.findIndex((b) => b.id === fromId);
    const j = arr.findIndex((b) => b.id === toId);
    if (i < 0 || j < 0 || i === j) return list;
    const [it] = arr.splice(i, 1);
    arr.splice(j, 0, it);
    return arr;
  }
  const target = findBlock(list, containerId);
  if (!target || !target.children) return list;
  const arr = [...target.children];
  const i = arr.findIndex((b) => b.id === fromId);
  const j = arr.findIndex((b) => b.id === toId);
  if (i < 0 || j < 0 || i === j) return list;
  const [it] = arr.splice(i, 1);
  arr.splice(j, 0, it);
  return updateBlock(list, containerId, { children: arr });
}

/** 在容器末尾追加块（containerId 为空 = 顶层） */
export function appendBlock(list, containerId, block) {
  if (!containerId) return [...(list || []), block];
  const target = findBlock(list, containerId);
  if (!target) return list;
  return updateBlock(list, containerId, { children: [...(target.children || []), block] });
}

/** 容器块（能装子块的） */
export function isContainer(block) {
  return !!block && (block.type === 'column' || block.type === 'section');
}

/** 块的子孙 id 集合（删除/移动时用来防止把父挪进自己的子树） */
export function descendantIds(block) {
  const out = new Set();
  const walk = (b) => {
    for (const c of b.children || []) {
      out.add(c.id);
      walk(c);
    }
  };
  walk(block);
  return out;
}

// —— 块的编辑动作（R20） ————————————————————————————————

/** 转换类型时**文本会不会丢**（只有文本型的块能保住 text） */
export function keepsText(type) {
  return type === 'paragraph' || type === 'heading' || type === 'md';
}

/**
 * 把一个块转成另一种类型。
 * 形状按 §十三 13.2 / §八 8.1 的词汇表给**该类型的默认值**；
 * 文本型的块（paragraph/heading/md）保留原文，结构型的**文本会丢**
 * （所以菜单里要标出来 —— 不能让用户以为转换是无损的）。
 */
export function convertBlock(block, type) {
  const text = typeof block.text === 'string' ? block.text : '';
  switch (type) {
    case 'paragraph': return { type, text };
    case 'heading': return { type, text, level: 2 };
    case 'md': return { type, text };
    case 'table': return { type, columns: [], rows: [] };
    case 'entrylist': return { type, fields: [], value: [] };
    case 'file': return { type, files: [] };
    case 'secret': return { type, label: '密钥', value: '' };
    case 'section': return { type, sectionId: '' };
    case 'column': return { type, widths: [], children: [] };
    default: return block;
  }
}

/** **整体替换**一个块（转换类型时用 —— 合并会把旧类型的残留字段留下） */
export function replaceBlock(list, id, newBlock) {
  return (list || []).map((b) => {
    if (b.id === id) return { ...newBlock, id };
    if (!b.children) return b;
    const children = replaceBlock(b.children, id, newBlock);
    return children === b.children ? b : { ...b, children };
  });
}

/** 在容器内上移 / 下移（delta = -1 / +1） */
export function moveBy(list, containerId, id, delta) {
  const target = containerId ? findBlock(list, containerId) : null;
  const arr = target && target.children ? target.children : list;
  if (!arr) return list;
  const i = arr.findIndex((b) => b.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return list;
  const next = [...arr];
  const [it] = next.splice(i, 1);
  next.splice(j, 0, it);
  if (!containerId) return next;
  return updateBlock(list, containerId, { children: next });
}
