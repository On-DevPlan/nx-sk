import { EyeInvisibleOutlined, EyeOutlined, TagsOutlined } from '@ant-design/icons';
import { Tag } from '../../components/ui/index.tsx';
import type { TemplateDumpInfo } from './viewTypes.ts';

/**
 * 条目模板工具条：标题 / 条数 / 打码开关 /（侧栏收起时的）新建条目。
 * 导出与导入统一收在「导入导出」页（条目树多选 / 文件夹子树；设置页另有全量备份），
 * 这里不再重复摆一份 ZIP 菜单；拖入 ZIP 的快捷导入仍保留。
 * 刷新也只有顶栏一个入口（任务 #30：顶栏「刷新数据」会连本页 dump 一起重拉），
 * 这里不再放第二个「刷新」按钮。
 * 任务 #28：新建条目搬到侧栏条目模板行右侧的「＋」；只有侧栏收起、那个「＋」够不着时
 * 才在这里兜底显示一个按钮（showAdd），两种入口不会同时出现。
 * 纯展示，所有状态与动作都由容器传入。
 */
export default function TemplateToolbar({
  template,
  count,
  mask,
  showAdd,
  onToggleMask,
  onEditTags,
  onAddEntry,
}: {
  template: TemplateDumpInfo;
  count: number;
  mask: boolean;
  showAdd: boolean;
  onToggleMask: () => void;
  onEditTags: () => void;
  onAddEntry: () => void;
}) {
  return (
    <div className="toolbar rowgap pad">
      <strong>{template.title}</strong>
      <Tag>{template.id}</Tag>
      {/* 默认标签就是 [id, 标题]，已在左侧展示；这里只补真正额外的模板标签，避免「求职 job #求职」整行重复 */}
      {template.tags.filter((t) => t !== template.id && t !== template.title).map((t) => <Tag key={t}>#{t}</Tag>)}
      <button
        type="button"
        className="btn small ghost icon-btn"
        onClick={onEditTags}
        title="编辑模板默认标签"
        aria-label="编辑模板默认标签"
      >
        <TagsOutlined />
      </button>
      <span className="muted">{count} 条 / {template.fields} 字段</span>
      {template.description ? <span className="desc muted nowrap grow">{template.description}</span> : <span className="grow" />}
      <button
        type="button"
        className={`btn small ghost icon-btn${mask ? ' active' : ''}`}
        onClick={onToggleMask}
        title={mask ? '取消打码显示' : '打码显示（投屏/截图时用）'}
        aria-label={mask ? '取消打码显示' : '打码显示'}
      >
        {mask ? <EyeInvisibleOutlined /> : <EyeOutlined />}
      </button>
      {showAdd ? <button className="btn small" onClick={onAddEntry}>新建条目</button> : null}
    </div>
  );
}

