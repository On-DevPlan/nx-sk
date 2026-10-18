// 「导出导入」这个**页面**的模块壳。
//
// 它没有 actions —— 可读导出（JSON / Markdown，`export run` / `export list`）已随
// 备份模块一起删除，项目里只剩 transfer 一条导出路径。本模块仅负责把这一页挂进
// 面板导航（view 在 ./view.jsx，真正的面板是 transferPanel）。
//
// 所以 `nx-sk export run` 现在报「未知命令」，对应能力用 `nx-sk transfer export`。
export default {
  id: 'export',
  title: '导出导入',
  order: 700,
  view: () => import('./view.jsx'),
  actions: [],
};
