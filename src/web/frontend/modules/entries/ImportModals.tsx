import { Modal, Tag } from '../../components/ui.tsx';
import { fmtBytes } from '../../api/zip.ts';
import type { AskState, Conflict, ModalState, ZipState } from './viewTypes.ts';

/**
 * 栏目导入相关的弹窗：加密包口令、导入预览/冲突处理，以及容器共用的通用 Modal。
 * 纯展示——口令、冲突策略、导入中标志都由容器持有。
 */
export default function ImportModals({
  ask,
  askPw,
  importing,
  onAskPw,
  onAskClose,
  onAskCancel,
  onSubmitAsk,
  zip,
  conflict,
  onConflict,
  onZipClose,
  onZipCancel,
  onApplyZip,
  modal,
  onModalClose,
}: {
  ask: AskState | null;
  askPw: string;
  importing: boolean;
  onAskPw: (v: string) => void;
  onAskClose: () => void;
  onAskCancel: () => void;
  onSubmitAsk: () => void;
  zip: ZipState | null;
  conflict: Conflict;
  onConflict: (c: Conflict) => void;
  onZipClose: () => void;
  onZipCancel: () => void;
  onApplyZip: () => void;
  modal: ModalState | null;
  onModalClose: () => void;
}) {
  return (
    <>
      {ask ? (
        <Modal
          title={`这个包已加密 · ${ask.fileName}`}
          onClose={onAskClose}
          footer={(
            <>
              <button className="btn ghost" onClick={onAskCancel} disabled={importing}>取消</button>
              <button className="btn" onClick={onSubmitAsk} disabled={importing || !askPw.trim()}>
                {importing ? '解密中…' : '打开预览'}
              </button>
            </>
          )}
        >
          <div className="stack">
            <div className="hint">导出时给这个包设了口令。输入同一口令才能预览与导入——口令不在文件里，错了只能重试。</div>
            <input
              type="password"
              autoComplete="off"
              value={askPw}
              onChange={(e) => onAskPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSubmitAsk(); }}
              placeholder="导出时设置的口令"
            />
          </div>
        </Modal>
      ) : null}

      {zip ? (
        <Modal
          title={`导入预览 · ${zip.fileName}`}
          onClose={onZipClose}
          footer={(
            <>
              <button className="btn ghost" onClick={onZipCancel} disabled={importing}>取消</button>
              <button className="btn" onClick={onApplyZip} disabled={importing}>{importing ? '导入中…' : '确认导入'}</button>
            </>
          )}
        >
          {(() => {
            const p = zip.preview;
            return (
              <div className="stack">
                <div>
                  来源：<strong>{p.section.source.title}</strong><span className="muted">（{p.section.source.id}）</span>
                  {' → '}目标：<strong>{p.section.title}</strong><span className="muted">（{p.section.targetId}）</span>
                  {p.section.willCreate ? <span className="bad">　将新建栏目</span> : null}
                </div>
                <div className="hint">
                  导出时间 {p.exportedAt || '未知'}　·　{p.withSecrets ? '含凭据明文' : '凭据已打码'}
                  {p.encrypted ? '　·　已解密（口令已验证）' : ''}
                </div>
                <div className="rowgap">
                  <Tag>条目 {p.entries.total}</Tag>
                  <Tag>将新增 {p.entries.fresh}</Tag>
                  {p.entries.conflicts.length ? <span className="tag bad">冲突 {p.entries.conflicts.length}</span> : null}
                  <Tag>附件 新增 {p.files.new} / 复用 {p.files.reused}（{fmtBytes(p.files.bytes)}）</Tag>
                </div>
                {p.section.fieldsToAdd.length ? (
                  <div className="hint">将补 {p.section.fieldsToAdd.length} 个字段：{p.section.fieldsToAdd.map((f) => f.label).join('、')}</div>
                ) : null}
                {p.entries.conflicts.length ? (
                  <div className="block">
                    <div className="flabel"><span>冲突明细</span><span className="fkey">撞 = 本地已有同 id 或同标题的条目</span></div>
                    <div className="conflict-list">
                      {p.entries.conflicts.map((c) => (
                        <div key={`${c.id}-${c.existingId}`} className="conflict-row">
                          <span className="title">{c.title}</span>
                          <span className="hint">
                            {c.reason === 'id' ? `同 id 撞上「${c.existingTitle}」` : `同标题撞上「${c.existingTitle}」`}
                          </span>
                          {conflict === 'copy' ? <span className="hint ok">→ {c.copyTitle}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {p.entries.conflicts.length ? (
                  <div className="stack">
                    <div className="flabel"><span>冲突怎么处理</span></div>
                    <label className="inline"><input type="radio" checked={conflict === 'skip'} onChange={() => onConflict('skip')} /> 跳过（保留现有）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'copy'} onChange={() => onConflict('copy')} /> 另存为新条目（标题加「导入」）</label>
                    <label className="inline"><input type="radio" checked={conflict === 'overwrite'} onChange={() => onConflict('overwrite')} /> 覆盖现有条目的字段</label>
                  </div>
                ) : null}
                {p.warnings.map((w) => <div key={w} className="hint bad">注意：{w}</div>)}
              </div>
            );
          })()}
        </Modal>
      ) : null}

      {modal ? (
        <Modal title={modal.title} onClose={onModalClose}>
          {modal.body}
        </Modal>
      ) : null}
    </>
  );
}
