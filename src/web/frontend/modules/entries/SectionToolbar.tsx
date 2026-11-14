import { Tag } from '../../components/ui.tsx';
import type { SectionDumpInfo } from './viewTypes.ts';

/**
 * 栏目工具条：标题 / 条数 / 打码开关 /（侧栏收起时的）新建条目。
 * 导出与导入统一收在「导入导出」页（支持整库 / 按栏目 / 按条目勾选），
 * 这里不再重复摆一份 ZIP 菜单；拖入 ZIP 的快捷导入仍保留。
 * 刷新也只有顶栏一个入口（任务 #30：顶栏「刷新数据」会连本页 dump 一起重拉），
 * 这里不再放第二个「刷新」按钮。
 * 任务 #28：新建条目搬到侧栏栏目行右侧的「＋」；只有侧栏收起、那个「＋」够不着时
 * 才在这里兜底显示一个按钮（showAdd），两种入口不会同时出现。
 * 纯展示，所有状态与动作都由容器传入。
 */
export default function SectionToolbar({
  section,
  count,
  mask,
  showAdd,
  onToggleMask,
  onAddEntry,
}: {
  section: SectionDumpInfo;
  count: number;
  mask: boolean;
  showAdd: boolean;
  onToggleMask: () => void;
  onAddEntry: () => void;
}) {
  return (
    <div className="toolbar rowgap pad">
      <strong>{section.title}</strong>
      <Tag>{section.id}</Tag>
      <span className="muted">{count} 条 / {section.fields} 字段</span>
      {section.description ? <span className="desc muted nowrap grow">{section.description}</span> : <span className="grow" />}
      <label className="inline hint">
        <input type="checkbox" checked={mask} onChange={onToggleMask} />
        打码显示（投屏/截图时用）
      </label>
      {showAdd ? <button className="btn small" onClick={onAddEntry}>新建条目</button> : null}
    </div>
  );
}
