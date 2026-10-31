// 列表排序的**唯一算法**：把 from 处的元素搬到 insertAt（**插入位**，不是下标）。
//
// 为什么单独一个文件（而不是写在组件里）：这是纯逻辑、又是最容易藏 off-by-one 的地方，
// 要能被 node 直接 import 做单测（`.jsx` 没法被 node 直接 import）。
//
// 插入位语义（与浏览器的拖拽直觉一致）：
//   insertAt = 0  → 插到最前
//   insertAt = n  → 插到最后
//   insertAt === from 或 from + 1 → 原地不动（返回**同一个**数组，不制造一次无意义的写）
export function reorderAt(list, from, insertAt) {
  if (!Array.isArray(list)) return list;
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;
  if (insertAt === from || insertAt === from + 1) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(insertAt > from ? insertAt - 1 : insertAt, 0, item);
  return next;
}
