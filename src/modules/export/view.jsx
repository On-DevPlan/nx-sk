import TransferPanel from '../../web/frontend/components/transferPanel.jsx';
import { CliHints } from '../../web/frontend/components/ui.jsx';

// 「导出导入」页 = 取数据：选栏目（全选即整库）→ 设口令 → 下载；把包拖回来解密导入。
// 就这一件事，所以页面只有一个面板：
//   - 可读的 JSON / Markdown 导出在「设置」页 —— 人读副本，不参与导入。
// 备份模块已删除：导出包本身就是唯一回退手段，删之前先导一份即可。
// 页脚 CliHints 提示与本页相关的命令。
export default function ExportView() {
  return (
    <>
      <div className="toolbar rowgap pad">
        <strong>导出导入</strong>
        <span className="muted">选栏目（全选即整库）→ 设口令 → 下载；把包拖回来解密导入。可读的 JSON / Markdown 导出在「设置」里</span>
      </div>

      <TransferPanel />

      <CliHints module={['export', 'transfer']} />
    </>
  );
}
