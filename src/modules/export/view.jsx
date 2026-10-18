import TransferPanel from '../../web/frontend/components/transferPanel.jsx';
import { CliHints } from '../../web/frontend/components/ui.jsx';

// 「导出导入」页 = 取数据的唯一入口：选栏目（全选即整库）→ 设口令 → 下载；
// 把包拖回来解密导入。页面只有这一个面板。
//
// 可读导出（JSON / Markdown）与备份模块都已删除：项目里只剩 transfer 一条导出路径，
// 导出的 ZIP 既能搬数据也能当回退手段（备份曾想做同一件事，口径必然漂移）。
//
// 这个 view 还挂在 modules/export 下（它是「导出导入」这一页），但**不再有 export 命令**——
// 本页对应的 CLI 是 transfer。
export default function ExportView() {
  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>导出导入</strong>
        <span className="muted">选栏目（全选即整库）→ 设口令 → 下载；把包拖回来解密导入</span>
      </div>

      <TransferPanel />

      <CliHints module="transfer" />
    </>
  );
}
