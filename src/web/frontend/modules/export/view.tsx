import TransferPanel from '../../components/transferPanel.tsx';

// 「导出导入」页 = 取数据的唯一入口：在条目树里选条目（勾一个就带走整棵子树）→
// 设口令 → 下载；把包拖回来解密导入。全量备份就是勾「全选」。
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
        <span className="muted">勾条目或文件夹（自动带全部子条目）→ 设口令 → 下载；全选 = 全量备份</span>
      </div>

      <TransferPanel />
    </>
  );
}

