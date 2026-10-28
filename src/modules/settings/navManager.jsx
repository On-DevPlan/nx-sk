// 栏目管理：**容器 + 拖拽**。整页只有一个心智模型——
//   一个栏目要么在「平铺」里、要么在某个分组里、要么在「隐藏」里；
//   拖，就是把它从一个容器挪到另一个。
//
// 「隐藏」不再是一个开关，就是一个容器：拖进去 = 不出现在头部（`#/栏目id` 直达仍可用）。
// 这样「显隐」和「归组」是同一套操作，不用记两种交互。
//
// **受控组件**：数据（cfg）与保存都在设置页；这里只管画与调 onChange。
// 所有数据操作走 navModel 的纯函数（可单测），组件里不做状态体操。
//
// **拖动时列表本身不动**。早前这里是「实时预览」：拖动过程中就把被拖的行挪到落点上。
// 那条路必然抖，原因很硬——预览一挪行，指针底下的元素就换了、下面的容器也整体位移一行
// （28px），dragover 于是算出另一个落点，再挪，再算……自己推自己，屏幕上就是闪屏；
// 跨容器时位移最大，闪得最厉害。
// 现在改为：行按**原样**待在原地（被拖的那行半透明），落点用一条**不占布局**的指示线
// （inset 阴影压在行边上）表示。列表在拖动期间是静止的 → 指针与行的对应关系恒定，
// 落点只随指针单调变化，怎么晃都不会跳。松手一次性提交，结果就是指示线指的位置。
import { useState } from 'react';
import * as nav from '../../web/frontend/components/navModel.js';

export default function NavManager({ sections, value, onChange }) {
  const [drag, setDrag] = useState(null); // { kind:'section', sid } | { kind:'group', gi }
  const [over, setOver] = useState(null); // { key, index }：落在哪个容器的第几行之前；组合 { key, group:true }

  const allIds = sections.map((s) => s.id);
  const sectionOf = (id) => sections.find((s) => s.id === id) || null;

  const keyToTarget = (key) => {
    if (key === 'pool') return { kind: 'pool' };
    if (key === 'hidden') return { kind: 'hidden' };
    const gi = Number(String(key).slice(1));
    return Number.isFinite(gi) ? { kind: 'group', gi } : null;
  };

  const draggingSid = drag?.kind === 'section' ? drag.sid : null;
  // 平铺容器的内容与顺序都来自模型：显式排过的（order）优先，其余按栏目自身顺序
  const pool = nav.ungroupedIds(value, allIds);

  const endDrag = () => { setDrag(null); setOver(null); };

  // 只在落点**真的变了**才 setState：dragover 每次鼠标移动都触发，
  // 不做这层去重就是每次移动都重算一遍整页 → 抖
  const setOverIfChanged = (next) => setOver((o) => (o && o.key === next.key && o.index === next.index ? o : next));

  /**
   * 指针在容器里落在第几行之前（0..n）。
   * 行位置每帧现取（行高/换行会随窗口变），判据交给 nav.slotAt：只比**中线**。
   * 于是行的上下边缘、行间缝隙、容器内边距都归到最近的一侧，不再出现
   * 「压在行上是一个落点、挪进缝隙变成追加到末尾」这种整列表跳位。
   */
  const slotOf = (el, y) => nav.slotAt(
    [...el.querySelectorAll('[data-nav-row]')].map((row) => {
      const r = row.getBoundingClientRect();
      return r.top + r.height / 2;
    }),
    y,
  );

  /** 松手：按当前指示线落位。结构没变就不提交（否则拖一下就提示「有未保存的改动」）。 */
  const commit = () => {
    const target = over ? keyToTarget(over.key) : null;
    if (drag?.kind === 'group') {
      // 分组只能落到分组卡上（落到平铺 / 隐藏里没有意义，那两处不是「第几个分组」）
      if (target?.kind === 'group') {
        const next = nav.moveGroupTo(value, drag.gi, target.gi);
        if (next !== value) onChange(next);
      }
      endDrag();
      return;
    }
    if (draggingSid && target) {
      const index = nav.insertionIndex(value, draggingSid, target, over.index, allIds);
      const next = nav.moveToContainer(value, draggingSid, target, index, allIds);
      if (!nav.sameStructure(next, value, allIds)) onChange(next);
    }
    endDrag();
  };

  // 容器：整块都是落点（含空白处 / 说明文字 / 分组头）。
  // 拖栏目时落点位置由行中线算出；拖分组时整张分组卡都是落点——
  // 只认那 28px 的分组头的话，手要瞄得很准，松手稍偏就白拖了。
  const zone = (key, base = '') => ({
    className: `${base} ${over?.key === key ? 'drop-target' : ''}`,
    onDragOver: (e) => {
      if (drag?.kind === 'group') {
        if (keyToTarget(key)?.kind !== 'group') { setOver(null); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOverIfChanged({ key, group: true });
        return;
      }
      if (!draggingSid) return;
      e.preventDefault(); // 不拦就没有 drop
      e.dataTransfer.dropEffect = 'move';
      setOverIfChanged({ key, index: slotOf(e.currentTarget, e.clientY) });
    },
    onDrop: (e) => { e.preventDefault(); commit(); },
  });

  /**
   * 拖起一行。拖影取**整行**而不是那个 10px 的把手——把手小到看不出在拖什么，
   * 松手前心里没底。setData 是给 Firefox 的：不设就不算启动拖拽。
   */
  const startSectionDrag = (e, sid) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sid);
    const row = e.currentTarget.closest('.nav-row');
    if (row) e.dataTransfer.setDragImage(row, 14, 14);
    setDrag({ kind: 'section', sid });
    setOver(null);
  };

  /** 行的落点指示：落在第 i 行之前画上边，落在末尾画最后一行的下边。 */
  const markOf = (key, i, n) => {
    if (over?.key !== key || typeof over.index !== 'number') return '';
    if (over.index === i) return 'ins-before';
    if (i === n - 1 && over.index >= n) return 'ins-after';
    return '';
  };

  return (
    <div className="stack">
      {/* ① 平铺：不进任何容器的栏目（= 头部平铺显示） */}
      <section {...zone('pool', 'nav-pool')}>
        <div className="hint">平铺：不进分组也不隐藏的栏目，直接显示在头部（拖到这里 = 移出分组 / 取消隐藏）</div>
        {pool.length ? (
          <div className="nav-list">
            {pool.map((sid, i) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                dragging={draggingSid === sid}
                mark={markOf('pool', i, pool.length)}
                onDragStart={(e) => startSectionDrag(e, sid)}
                onDragEnd={endDrag}
                actions={null} />
            ))}
          </div>
        ) : <div className="muted">没有平铺的栏目。</div>}
      </section>

      {/* ② 分组：组名可改、组间可拖把手换位 */}
      {value.groups.map((g, gi) => (
        <section key={gi} {...zone(`g${gi}`, 'card nav-group')}>
          <div className={`colhead ${over?.key === `g${gi}` && over.group ? 'drop-target' : ''}`}>
            <span className="grip" title="拖动调整分组顺序" draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', `g${gi}`);
                setDrag({ kind: 'group', gi });
                setOver(null);
              }}
              onDragEnd={endDrag} />
            <input className="nav-title" placeholder="组名，如「求职」" value={g.title}
              onChange={(e) => onChange(nav.renameGroup(value, gi, e.target.value))} />
            <span className="muted">{g.sections.length} 个栏目</span>
            <span className="right rowgap">
              <button className="btn small ghost" onClick={() => onChange(nav.removeGroup(value, gi))}>删除组</button>
            </span>
          </div>
          {g.sections.length ? (
            <div className="nav-list">
              {g.sections.map((sid, i) => (
                <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                  dragging={draggingSid === sid}
                  mark={markOf(`g${gi}`, i, g.sections.length)}
                  onDragStart={(e) => startSectionDrag(e, sid)}
                  onDragEnd={endDrag}
                  actions={<button className="btn small ghost" onClick={() => onChange(nav.ungroupSection(value, sid))}>移出</button>} />
              ))}
            </div>
          ) : <div className="row"><span className="desc">空分组——把栏目拖进来。</span></div>}
        </section>
      ))}

      {/* ③ 隐藏：与分组同构的容器——拖进去即「不进头部」 */}
      <section {...zone('hidden', 'card nav-group nav-hidden')}>
        <div className="colhead">
          隐藏
          <span className="muted">{value.hidden.length} 个栏目</span>
          <span className="right muted">不进头部 · #/栏目id 直达仍可用</span>
        </div>
        {value.hidden.length ? (
          <div className="nav-list">
            {value.hidden.map((sid, i) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                dragging={draggingSid === sid}
                mark={markOf('hidden', i, value.hidden.length)}
                onDragStart={(e) => startSectionDrag(e, sid)}
                onDragEnd={endDrag}
                actions={<button className="btn small ghost" onClick={() => onChange(nav.ungroupSection(value, sid))}>移出</button>} />
            ))}
          </div>
        ) : <div className="row"><span className="desc">没有隐藏的栏目——把不常用的拖进来。</span></div>}
      </section>

      <div className="rowgap">
        <button className="btn" onClick={() => onChange(nav.addGroup(value))}>新增分组</button>
        <span className="hint">组顺序 = 头部显示顺序；组内顺序 = 展开列表里的顺序</span>
      </div>
    </div>
  );
}

/** 一行栏目：把手（拖）+ 名称 + 计数 + 容器自己的动作（移出 / 无）。 */
function SectionRow({ section, sid, dragging, mark, actions, onDragStart, onDragEnd }) {
  return (
    <div className={`row nav-row ${dragging ? 'dragging' : ''} ${mark}`} data-nav-row data-sid={sid}>
      <span className="grip" title="拖动：换位 / 换容器" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />
      <span className="name">{section ? section.title : `栏目已删除（${sid}）`}</span>
      <span className="desc">{section ? `${section.entries} 条` : '保存前请移出'}</span>
      <span className="acts">{actions}</span>
    </div>
  );
}
