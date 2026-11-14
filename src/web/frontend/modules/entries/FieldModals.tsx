import { FieldEditModal, FieldInfoModal } from '../../components/fieldInfo.tsx';
import { EntryHistoryModal, FieldHistoryModal } from '../../components/fieldHistory.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';
import type { Draft } from './viewTypes.ts';

/** 块头「⋯」菜单的弹窗 + 条目级变化历史：纯展示，打开状态由容器持有。 */
export default function FieldModals({
  fieldView,
  fieldEdit,
  fieldHistory,
  entryHistoryOpen,
  draft,
  current,
  sectionTitle,
  onCloseView,
  onCloseEdit,
  onCloseHistory,
  onCloseEntryHistory,
  onSaved,
}: {
  fieldView: { def: FieldDef } | null;
  fieldEdit: { def: FieldDef } | null;
  /** 任务 #27：单字段变化历史。 */
  fieldHistory: { def: FieldDef } | null;
  /** 任务 #27：条目级变化时间线。 */
  entryHistoryOpen: boolean;
  draft: Draft | null;
  current: SerializedEntry | null;
  sectionTitle: string;
  onCloseView: () => void;
  onCloseEdit: () => void;
  onCloseHistory: () => void;
  onCloseEntryHistory: () => void;
  onSaved: () => void;
}) {
  return (
    <>
      {fieldView && draft ? (
        <FieldInfoModal
          entryId={draft.id}
          def={fieldView.def}
          value={draft.values?.[fieldView.def.key]}
          sectionTitle={sectionTitle}
          entryTitle={current?.title || draft.title}
          onClose={onCloseView}
        />
      ) : null}

      {fieldEdit && draft ? (
        <FieldEditModal
          entryId={draft.id}
          def={fieldEdit.def}
          onClose={onCloseEdit}
          onSaved={onSaved}
        />
      ) : null}

      {fieldHistory && draft ? (
        <FieldHistoryModal
          entryId={draft.id}
          def={fieldHistory.def}
          onClose={onCloseHistory}
          onRestored={onSaved}
        />
      ) : null}

      {entryHistoryOpen && draft ? (
        <EntryHistoryModal
          entryId={draft.id}
          entryTitle={current?.title || draft.title}
          onClose={onCloseEntryHistory}
        />
      ) : null}
    </>
  );
}
