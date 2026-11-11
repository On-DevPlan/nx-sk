// debug（资源引用）的写入封装（任务 #21 验收反馈：「不要引用结构」「结果至少是条目/条目-字段」）。
//
// coerce 是纯函数，分不出 `nx-sk://field/<head>/<key>` 的 head 是**条目**还是**栏目**
// （模板字段引用 = 结构引用：值不住在它身上，格子内联不出实时值）。
// 这一层查库把它拦下：head 解不到条目、却解得到栏目 → 丢弃进 warnings。
// 解不到任何地方的（坏链）**保留**——#18 的「坏链留证」原则不因这条改动而变。
import { loadStore } from '../../store.ts';
import { parseLocator } from '../../../shared/locator.ts';
import { behaviorOf } from '../registry.ts';
import type { RefDoc, SealContext, SealHook } from '../../../shared/fields/types.ts';

export const sealDebug: SealHook = async ({ def, raw }: SealContext) => {
  const doc = raw === null || raw === undefined
    ? null
    : behaviorOf('debug').coerce(def, raw) as RefDoc | null;
  if (!doc || !doc.refs.length) return doc;
  const store = await loadStore();
  const warnings = Array.isArray(doc.warnings) ? [...doc.warnings] : [];
  const kept: string[] = [];
  for (const r of doc.refs) {
    const parts = parseLocator(r);
    if (parts?.kind === 'field' && parts.entryId && parts.key) {
      // parseLocator 把 `nx-sk://field/<head>/<key>` 的 head 一律收进 entryId 段
      const head = parts.entryId;
      const isEntry = store.entries.some((e) => e.id === head);
      if (!isEntry && store.sections.some((s) => s.id === head)) {
        warnings.push(`${r}（模板字段是结构引用：值住在各条目上，请引用 nx-sk://field/<条目id>/${parts.key}）`);
        continue;
      }
    }
    kept.push(r);
  }
  const out: RefDoc = { v: doc.v ?? 1, refs: kept };
  if (warnings.length) out.warnings = warnings;
  return out;
};
