import { Empty, Tag } from '../../components/ui.tsx';
import BlockBoard from '../../components/blockBoard.tsx';
import type { BoardGroup, FieldActions } from '../../components/blockBoard.tsx';
import type { BlockLayout } from '../../../../shared/blockLayout.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';
import type { Draft, SectionDump } from './viewTypes.ts';

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
  sectionId,
  groups,
  boardView,
  fieldActions,
  onSave,
  onCopyRef,
  onDraftTitle,
  onAddField,
  onRestoreField,
  onBoard,
  onPatchField,
  onDiscard,
  onRemoveEntry,
  onOpenHistory,
}: {
  data: SectionDump;
  draft: Draft | null;
  current: SerializedEntry | null;
  dirtyCount: number;
  skippedExcluded: Array<{ key: string; label: string }>;
  sectionId: string;
  groups: BoardGroup[];
  boardView: BlockLayout;
  fieldActions: FieldActions;
  onSave: () => void;
  onCopyRef: (entry: { id: string; title: string } | null) => void;
  onDraftTitle: (title: string) => void;
  onAddField: () => void;
  onRestoreField: (key: string, label: string) => void;
  onBoard: (next: BlockLayout) => void;
  onPatchField: (key: string, value: unknown) => void;
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
          {/* 顶栏固定在窗口右上角：长栏目滚到一半也能看见「保存」——
              否则改完一个字段要翻到表单最底点保存，翻页越多越容易漏保存。 */}
          {/* 任务 #29：面包屑只留窗口顶栏那一条，这里不再重复「栏目 › 条目」；
              原来挂在这条面包屑上的「点击复制定位」挪成一个常显的 ⧉ 按钮，功能不丢。 */}
          <div className="colhead sticky-head">
            <span className="muted mono nowrap">{draft.id}</span>
            <button
              type="button"
              className="head-copy"
              title="复制条目定位（栏目›条目 + id + CLI 命令，贴给 agent 即可修改）"
              aria-label="复制条目定位"
              onClick={() => onCopyRef(current || draft)}
            >⧉</button>
            <span className="grow" />
            {current ? <Tag kind={current.missing.length ? '' : 'strong'}>完整度 {current.completeness.ratio}%</Tag> : null}
            {dirtyCount ? (
              <>
                <span className="hint nowrap">{dirtyCount} 处改动未保存</span>
                <button type="button" className="btn small" onClick={onSave} title="保存当前条目的改动">保存</button>
              </>
            ) : null}
          </div>

          {/* 条目名是「这一页的标题」，不是第一个字段：给它一点标题的语气，
              但仍然是可编辑的输入，不让用户以为要另开弹窗改名 */}
          <div className="entry-title pad">
            <div className="entry-title-label">{data.section.titleLabel || '名称'}</div>
            <input
              className="entry-title-input"
              value={draft.title}
              onChange={(e) => onDraftTitle(e.target.value)}
              aria-label={data.section.titleLabel || '名称'}
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

          {/* 任务 #20：已脱离的模板字段管理条——弱字 chips + 恢复按钮（值一直在，restore 即回） */}
          {current?.detachedFields?.length ? (
            <div className="detached-bar">
              <span className="hint">已从本条目移除：</span>
              {current.detachedFields.map((f) => (
                <span key={f.key} className="tag detached-chip" title={`模板字段 ${f.key}：已从本条目脱离，值仍保留`}>
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
            sectionTitle={data.section.title}
            entryTitle={current?.title || draft.title}
            sectionId={sectionId}
            entryId={draft.id}
            fieldActions={fieldActions}
          />

          <div className="rowgap pad">
            <button className="btn" onClick={onSave} disabled={!dirtyCount}>保存{dirtyCount ? `（${dirtyCount} 处改动）` : ''}</button>
            <button className="btn ghost" onClick={onDiscard} disabled={!dirtyCount}>放弃改动</button>
            <button className="btn ghost" onClick={onOpenHistory}>变化历史</button>
            <button className="btn ghost" onClick={onRemoveEntry}>删除条目</button>
            {current?.missing.length ? (
              <span className="hint">模板建议里还有 {current.missing.length} 项没填（不影响使用）：{current.missing.slice(0, 5).map((m) => m.label).join('、')}{current.missing.length > 5 ? '…' : ''}</span>
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
