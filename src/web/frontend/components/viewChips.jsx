import { VIEW_LABELS } from '../../../shared/views.js';

/**
 * 视图 chips：数据库页的「同一批数据的多种投影」切换器（设计 §19）。
 *
 * 三条纪律：
 *   · **芯片不是装饰**：每个 chip 都是真按钮（Enter / Space 可触发），不是假控件（§24 B10 教训）；
 *   · 缺省推断出来的视图要**说明来源**（`provisional`）—— 不写这一行，用户会以为这套是他自己配的；
 *   · 看板在 S2 只有配置（schema + action），渲染随 S3 —— 这里显式置灰并给出原因，
 *     而不是点了没反应。
 */
export default function ViewChips({ views, active, provisional, onPick, disabledTypes = ['board'] }) {
  if (!views || !views.length) return null;
  return (
    <div className="viewbar" role="group" aria-label="视图切换">
      <span className="viewbar-label muted">视图</span>
      {views.map((v) => {
        const disabled = disabledTypes.includes(v.type);
        const on = v.id === active;
        return (
          <button
            key={v.id}
            type="button"
            className={`vchip${on ? ' on' : ''}`}
            aria-pressed={on}
            disabled={disabled}
            title={disabled
              ? `${VIEW_LABELS[v.type] || v.type}视图的渲染随 S3 落地；配置本身已可用（section view list）`
              : `${v.title}（${VIEW_LABELS[v.type] || v.type}）`}
            onClick={() => { if (!disabled && !on) onPick(v.id); }}
          >
            {v.title}
          </button>
        );
      })}
      {provisional ? (
        <span className="hint" title="这套视图是按字段字典推断的，还没写进 store；第一次改视图才会固化">
          推断（未落盘）
        </span>
      ) : null}
    </div>
  );
}
