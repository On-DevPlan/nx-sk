// 条目树的纯形状：前后端共用，零运行时依赖。
//
// 0.43 起 nx-sk 不再有「条目模板容器」：条目是唯一内容节点，任何条目都能有子条目。
// 模板只记录创建时用过的字段结构；`__blank__` 是内部空白模板（folder/无模板条目用）。

/** 内置空白模板 id。它不是用户模板，不出现在模板库。 */
export const BLANK_TEMPLATE_ID = '__blank__';

/** 条目树节点（`/api/tree` / bootstrap.tree 的最小形状）。 */
export interface TreeNode {
  id: string;
  title: string;
  parent: string | null;
  sort: number;
  template: string;
  templateTitle: string;
  tags: string[];
  childCount: number;
  /** 有子条目时就是文件夹；没有子条目也可以是空条目。 */
  hasChildren: boolean;
}
