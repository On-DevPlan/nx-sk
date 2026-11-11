// 栏目级导出 / 导入（ZIP）—— 这是**编排模块**，不是数据模块。
//
// 数据模块之间互不依赖（entries 只管条目、sections 只管栏目、files 只管附件）；
// 这里要把三者串起来完成「打一个包 / 解一个包」，所以显式跨模块调用它们的 service。
// 依赖方向是单向的（transfer → entries/sections），不构成环。
//
// 包的形状：
//   manifest.json            栏目定义 + 条目 + 附件清单（sha256）
//   README.txt               给人看的说明
//   attachments/<id><ext>    附件原件
//
// 包里**恒为明文**：保护靠口令（`--passphrase`），不再有「打码 / 明文」二选。
// 打码只保留在**读取侧**——0.11.0 及更早导出、带 `******` 的包仍按旧口径跳过该字段，
// 不会把打码串当新密码存进去。
//
// 实现按职责拆在同目录：common（常量与底层工具）/ section-export / section-import /
// bundle / render；本文件只做门面再导出，导出名与拆分前保持一致。
export { needsPassphrase } from './common.ts';
export { buildSectionZip, exportToFile, serveExportZip } from './section-export.ts';
export { applyImport, importFromBuffer, importFromFile, previewImport } from './section-import.ts';
export { applyBundle, buildBundleZip, exportBundleToFile, importAuto, importBundleFromBuffer, importBundleFromFile, previewBundle, serveBundleZip } from './bundle.ts';
export { renderBundleApply, renderBundleExport, renderBundlePreview, renderExportZip, renderImport } from './render.ts';
