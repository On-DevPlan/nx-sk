// 栏目管理：**容器 + 拖拽**。整页只有一个心智模型——
//   一个栏目要么在「平铺」里、要么在某个分组里、要么在「隐藏」里；
//   拖，就是把它从一个容器挪到另一个。
//
// 「隐藏」不再是一个开关，就是一个容器：拖进去 = 不出现在头部（`#/栏目id` 直达仍可用）。
// 这样「显隐」和「归组」是同一套操作，不用记两种交互。
//
// **受控组件**：数据（cfg）与保存都在设置页；这里只管画与调 onChange。
// 所有数据操作走 navModel 的纯函数（可单测），组件里不做状态体操。
import { useState } from 'react';
import * as nav from '../../web/frontend/components/navModel.js';

export default function NavManager({ sections, value, onChange }) {
  const [drag, setDrag] = useState(null); // { kind:'section', sid } | { kind:'group', gi }
  const [over, setOver] = useState(null); // { key, index }：当前拖到哪个容器的第几位

  const allIds = sections.map((s) => s.id);
  const sectionOf = (id) => sections.find((s) => s.id === id) || null;
  const draggingSid = drag?.kind === 'section' ? drag.sid : null;
  const pool = allIds.filter((id) => nav.containerOf(value, id).kind === 'pool');

  const endDrag = () => { setDrag(null); setOver(null); };

  const dropInto = (key, target, index = null) => {
    if (!draggingSid) return;
    onChange(nav.moveToContainer(value, draggingSid, target, index));
    endDrag();
  };

  // 容器外壳：接住「拖到空白处 = 追加到末尾」，并显示落点高亮
  const zone = (key, target, base = '') => ({
    className: `${base} ${over?.key === key && over.index === null ? 'drop-target' : ''}${over?.key === key && over.group ? ' drop-target' : ''}`,
    onDragOver: (e) => {
      if (draggingSid) { e.preventDefault(); setOver({ key, index: null }); }
    },
    onDragLeave: () => setOver((o) => (o?.key === key ? null : o)),
    onDrop: (e) => { e.preventDefault(); dropInto(key, target, null); },
  });

  const rowProps = (key, sid, si, target) => ({
    onDragOver: (e) => { if (draggingSid && draggingSid !== sid) { e.preventDefault(); e.stopPropagation(); setOver({ key, index: si }); } },
    onDrop: (e) => { e.preventDefault(); e.stopPropagation(); dropInto(key, target, si); },
    onDragStart: () => setDrag({ kind: 'section', sid }),
  });

  return (
    <div className="stack">
      {/* ① 平铺：不进任何容器的栏目（= 头部平铺显示） */}
      <section {...zone('pool', { kind: 'pool' }, 'nav-pool')}>
        <div className="hint">平铺：不进分组也不隐藏的栏目，直接显示在头部（拖到这里 = 移出分组 / 取消隐藏）</div>
        {pool.length ? (
          <div className="nav-list">
            {pool.map((sid, si) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid} si={si}
                dragging={draggingSid === sid}
                {...rowProps('pool', sid, si, { kind: 'pool' })}
                onDragEnd={endDrag}
                actions={null} />
            ))}
          </div>
        ) : <div className="muted">没有平铺的栏目。</div>}
      </section>

      {/* ② 分组：组名可改、组间可拖把手换位 */}
      {value.groups.map((g, gi) => (
        <section key={gi} {...zone(`g${gi}`, { kind: 'group', gi }, 'card nav-group')}>
          <div
            className={`colhead ${over?.key === `g${gi}` && over.group ? 'drop-target' : ''}`}
            onDragOver={(e) => { if (drag?.kind === 'group') { e.preventDefault(); setOver({ key: `g${gi}`, group: true }); } }}
            onDrop={(e) => { e.preventDefault(); if (drag?.kind === 'group' && drag.gi !== gi) onChange(nav.moveGroup(value, drag.gi, gi - drag.gi)); endDrag(); }}
          >
            <span className="grip" title="拖动调整分组顺序" draggable
              onDragStart={() => setDrag({ kind: 'group', gi })} onDragEnd={endDrag} />
            <input className="nav-title" placeholder="组名，如「求职」" value={g.title}
              onChange={(e) => onChange(nav.renameGroup(value, gi, e.target.value))} />
            <span className="muted">{g.sections.length} 个栏目</span>
            <span className="right rowgap">
              <button className="btn small ghost" onClick={() => onChange(nav.removeGroup(value, gi))}>删除组</button>
            </span>
          </div>
          {g.sections.length ? (
            <div className="nav-list">
              {g.sections.map((sid, si) => (
                <SectionRow key={sid} section={sectionOf(sid)} sid={sid} si={si}
                  dragging={draggingSid === sid}
                  {...rowProps(`g${gi}`, sid, si, { kind: 'group', gi })}
                  onDragEnd={endDrag}
                  actions={<button className="btn small ghost" onClick={() => onChange(nav.ungroupSection(value, sid))}>移出</button>} />
              ))}
            </div>
          ) : <div className="row"><span className="desc">空分组——把栏目拖进来。</span></div>}
        </section>
      ))}

      {/* ③ 隐藏：与分组同构的容器——拖进去即「不进头部」 */}
      <section {...zone('hidden', { kind: 'hidden' }, 'card nav-group nav-hidden')}>
        <div className="colhead">
          隐藏
          <span className="muted">{value.hidden.length} 个栏目</span>
          <span className="right muted">不进头部 · #/栏目id 直达仍可用</span>
        </div>
        {value.hidden.length ? (
          <div className="nav-list">
            {value.hidden.map((sid, si) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid} si={si}
                dragging={draggingSid === sid}
                {...rowProps('hidden', sid, si, { kind: 'hidden' })}
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
function SectionRow({ section, sid, dragging, actions, onDragStart, onDragEnd, onDragOver, onDrop }) {
  return (
    <div className={`row nav-row ${dragging ? 'dragging' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
      <span className="grip" title="拖动：换位 / 换容器" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />
      <span className="name">{section ? section.title : `栏目已删除（${sid}）`}</span>
      <span className="desc">{section ? `${section.entries} 条` : '保存前请移出'}</span>
      <span className="acts">{actions}</span>
    </div>
  );
}
