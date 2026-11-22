import { TagsOutlined } from '@ant-design/icons';
import { Empty, Tag } from '../../components/ui/index.tsx';
import { MoreMenu } from '../../components/menu/index.tsx';
import BlockBoard from '../../components/blockBoard/index.tsx';
import type { BoardGroup, FieldActions } from '../../components/blockBoard/index.tsx';
import type { BlockLayout } from '../../../../shared/blockLayout.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';
import type { Draft, TemplateDump } from './viewTypes.ts';

/**
 * 右栏：选中条目的详情（面包屑 / 标题 / 添加字段 / 已脱离字段 / 块版式 / 底部动作条）。
 * 纯展示——草稿、脏值、版式与保存类动作全部由容器持有并用 props 传入。
 */
export default function EntryDetailColumn({
  data,
  draft,
  current,
  dirtyCount,
  skippedExcluded,
  templateId,
  groups,
  boardView,
  fieldActions,
  onSave,
  onCopyRef,
  onSaveAsTemplate,
  onDraftTitle,
  onDraftDesc,
  onEditTags,
  onAddField,
  onRestoreField,
  onBoard,
  onPatchField,
  onCommitField,
  onDiscard,
  onRemoveEntry,
  onOpenHistory,
}: {
  data: TemplateDump;
  draft: Draft | null;
  current: SerializedEntry | null;
  dirtyCount: number;
  skippedExcluded: Array<{ key: string; label: string }>;
  templateId: string;
  groups: BoardGroup[];
  boardView: BlockLayout;
  fieldActions: FieldActions;
  onSave: () => void;
  onCopyRef: (entry: { id: string; title: string } | null) => void;
  onSaveAsTemplate: () => void;
  onDraftTitle: (title: string) => void;
  /** 任务 #63：条目 desc（一句话说明），随「保存」一起提交。 */
  onDraftDesc: (desc: string) => void;
  onEditTags: () => void;
  onAddField: () => void;
  onRestoreField: (key: string, label: string) => void;
  onBoard: (next: BlockLayout) => void;
  onPatchField: (key: string, value: unknown) => void;
  /** 字段级直接回写（grill 确认按钮用；保存整份草稿）。 */
  onCommitField: (key: string, value: unknown) => Promise<boolean | undefined>;
  onDiscard: () => void;
  onRemoveEntry: () => void;
  /** 任务 #27：打开本条目全字段变化时间线。 */
  onOpenHistory: () => void;
}) {
  return (
    <div className="col">
      {!draft ? (
        <div className="card"><Empty>左边选一条，或新建一条</Empty></div>
      ) : (
        <div className="card">
          {/* 顶栏固定在窗口右上角：长条目模板滚到一半也能看见「保存」——
              否则改完一个字段要翻到表单最底点保存，翻页越多越容易漏保存。 */}
          {/* 任务 #29：面包屑只留窗口顶栏那一条，这里不再重复「条目模板 › 条目」；
              原来挂在这条面包屑上的「点击复制定位」挪成一个常显的 ⧉ 按钮，功能不丢。 */}
          <div className="colhead sticky-head">
            <span className="muted mono nowrap">{draft.id}</span>
            <span className="grow" />
            {dirtyCount ? (
              <>
                <span className="hint nowrap">{dirtyCount} 处改动未保存</span>
                <button type="button" className="btn small" onClick={onSave} title="保存当前条目的改动">保存</button>
                <button type="button" className="btn small ghost" onClick={onDiscard} title="丢弃未保存的改动">放弃改动</button>
              </>
            ) : null}
            {/* 低频动作收进「更多」：顶栏只留保存/放弃与一个图标按钮，长条目读数不被按钮墙打断。
                任务 #9：更多按钮 + 下拉面板全站统一为 components/menu 的 MoreMenu。 */}
            <MoreMenu
              label="更多条目操作"
              items={[
                { key: 'copy', icon: 'copy', label: '复制条目定位', onClick: () => onCopyRef(current || draft) },
                { key: 'history', icon: 'history', label: '变化历史', onClick: onOpenHistory },
                { key: 'template', icon: 'save', label: '存为模板', onClick: onSaveAsTemplate },
                'divider',
                { key: 'remove', icon: 'x', label: '删除条目', danger: true, onClick: onRemoveEntry },
              ]}
            />
          </div>

          {/* 条目名是「这一页的标题」，不是第一个字段：给它一点标题的语气，
              但仍然是可编辑的输入，不让用户以为要另开弹窗改名 */}
          <div className="entry-title pad">
            <div className="entry-title-label">{data.template.titleLabel || '名称'}</div>
            <input
              className="entry-title-input"
              value={draft.title}
              onChange={(e) => onDraftTitle(e.target.value)}
              aria-label={data.template.titleLabel || '名称'}
            />
            {current ? <Tag kind={current.missing.length ? '' : 'strong'}>完整度 {current.completeness.ratio}%</Tag> : null}
            {current?.tags?.length ? (
              <span className="tag-row" aria-label="条目标签">
                {current.tags.map((t) => <span key={t} className="tag chip-tag">#{t}</span>)}
                <button
                  type="button"
                  className="btn icon-btn tag-edit-btn"
                  onClick={onEditTags}
                  aria-label="编辑条目标签"
                  title="编辑条目标签"
                >
                  <TagsOutlined />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn small ghost icon-btn tag-edit-btn"
                onClick={onEditTags}
                aria-label="添加条目标签"
                title="添加条目标签"
              >
                <TagsOutlined />
              </button>
            )}
          </div>

          {/* 任务 #63：条目 desc —— 给 agent / 人「这条是什么」的一句话。
              它不是字段（不进完整度、不占块版式），所以放在标题下、字段区之前。 */}
          <div className="entry-desc pad">
            <input
              className="entry-desc-input"
              value={draft.desc}
              onChange={(e) => onDraftDesc(e.target.value)}
              placeholder="一句话说明：这条是什么（给 agent 认条目用，可留空）"
              aria-label="条目说明"
            />
          </div>

          {/* 条目内字段扩展正门（类型/分组可选）。#19：「字段=值 快填」旁路按验收反馈撤除 */}
          <div className="add-field-bar">
            <button
              type="button"
              className="btn small ghost"
              onClick={onAddField}
            >＋ 添加字段</button>
          </div>

          {/* 任务 #20：已脱离的条目模板字段管理条——弱字 chips + 恢复按钮（值一直在，restore 即回） */}
          {current?.detachedFields?.length ? (
            <div className="detached-bar">
              <span className="hint">已从本条目移除：</span>
              {current.detachedFields.map((f) => (
                <span key={f.key} className="tag detached-chip" title={`条目模板字段 ${f.key}：已从本条目脱离，值仍保留`}>
                  {f.label || f.key}
                  <button type="button" className="chip-restore" onClick={() => onRestoreField(f.key, f.label || f.key)}>恢复</button>
                </span>
              ))}
            </div>
          ) : null}

          <BlockBoard
            groups={groups}
            board={boardView}
            onBoard={onBoard}
            draft={draft.values}
            onPatch={onPatchField}
            templateTitle={data.template.title}
            entryTitle={current?.title || draft.title}
            templateId={templateId}
            entryId={draft.id}
            onCommitField={onCommitField}
            fieldActions={fieldActions}
          />

          <div className="rowgap pad entry-hints">
            {current?.missing.length ? (
              <span className="hint">条目模板建议里还有 {current.missing.length} 项没填（不影响使用）：{current.missing.slice(0, 5).map((m) => m.label).join('、')}{current.missing.length > 5 ? '…' : ''}</span>
            ) : null}
            {skippedExcluded.length ? (
              <span className="hint">另有 {skippedExcluded.length} 项已标不填、不计入完整度：{skippedExcluded.slice(0, 6).map((m) => m.label).join('、')}{skippedExcluded.length > 6 ? '…' : ''}</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

