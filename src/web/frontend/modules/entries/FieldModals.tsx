import { FieldEditModal, FieldInfoModal } from '../../components/fieldInfo.tsx';
import type { FieldDef } from '../../../../shared/fields/types.ts';
import type { SerializedEntry } from '../../../../shared/model.ts';
import type { Draft } from './viewTypes.ts';

/** 块头「⋯」菜单的两个弹窗：只读详情 / 编辑属性。纯展示，打开状态由容器持有。 */
export default function FieldModals({
  fieldView,
  fieldEdit,
  draft,
  current,
  sectionTitle,
  onCloseView,
  onCloseEdit,
  onSaved,
}: {
  fieldView: { def: FieldDef } | null;
  fieldEdit: { def: FieldDef } | null;
  draft: Draft | null;
  current: SerializedEntry | null;
  sectionTitle: string;
  onCloseView: () => void;
  onCloseEdit: () => void;
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
    </>
  );
}
