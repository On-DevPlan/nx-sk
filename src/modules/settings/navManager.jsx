// 栏目管理：**容器 + 拖拽**。整页只有一个心智模型——
//   一个栏目要么在「平铺」里、要么在某个分组里、要么在「隐藏」里；
//   拖，就是把它从一个容器挪到另一个。
//
// 「隐藏」不再是一个开关，就是一个容器：拖进去 = 不出现在头部（`#/栏目id` 直达仍可用）。
// 这样「显隐」和「归组」是同一套操作，不用记两种交互。
//
// **受控组件**：数据（cfg）与保存都在设置页；这里只管画与调 onChange。
// 所有数据操作走 navModel 的纯函数（可单测），组件里不做状态体操。
import { useMemo, useState } from 'react';
import * as nav from '../../web/frontend/components/navModel.js';

export default function NavManager({ sections, value, onChange }) {
  const [drag, setDrag] = useState(null); // { kind:'section', sid } | { kind:'group', gi }
  const [over, setOver] = useState(null); // { key, index }：当前拖到哪个容器的第几位

  // 注意顺序：preview 的依赖里用到 allIds / preview 的计算也用到预览配置，
  // const 声明晚于使用就是 TDZ 崩（"Cannot access … before initialization"）
  const allIds = sections.map((s) => s.id);
  const sectionOf = (id) => sections.find((s) => s.id === id) || null;

  const keyToTarget = (key) => {
    if (key === 'pool') return { kind: 'pool' };
    if (key === 'hidden') return { kind: 'hidden' };
    const gi = Number(String(key).slice(1));
    return Number.isFinite(gi) ? { kind: 'group', gi } : null;
  };

  /**
   * **实时预览**：拖动过程中就把落点算出来渲染，松手前就看到最终顺序（所见即所得）。
   * 插入位由 nav.insertionIndex 换算（同容器内往下拖要让位）——那条逻辑在模型里，有单测。
   */
  const preview = useMemo(() => {
    if (drag?.kind !== 'section' || !over) return value;
    const target = keyToTarget(over.key);
    if (!target) return value;
    const index = nav.insertionIndex(value, drag.sid, target, over.index, allIds);
    return nav.moveToContainer(value, drag.sid, target, index, allIds);
  }, [value, drag, over, allIds]);

  const draggingSid = drag?.kind === 'section' ? drag.sid : null;
  // 平铺容器的内容与顺序都来自模型：显式排过的（order）优先，其余按栏目自身顺序
  const pool = nav.ungroupedIds(preview, allIds);

  const endDrag = () => { setDrag(null); setOver(null); };

  /** 松手即提交预览里的顺序（预览就是结果，不再重新算一遍）。 */
  const commit = () => { if (preview !== value) onChange(preview); endDrag(); };

  // 只在落点**真的变了**才 setState：dragover 每次鼠标移动都触发，
  // 不做这层去重就是每次移动都重排一遍整页 → 抖
  const setOverIfChanged = (next) => setOver((o) => (o && o.key === next.key && o.index === next.index ? o : next));

  // 容器外壳：接住「拖到空白处 = 追加到末尾」，并显示落点高亮
  const zone = (key, base = '') => ({
    className: `${base} ${over?.key === key ? 'drop-target' : ''}`,
    onDragOver: (e) => { if (draggingSid) { e.preventDefault(); setOverIfChanged({ key, index: null }); } },
    onDragLeave: () => setOver((o) => (o?.key === key && o.index === null ? null : o)),
    onDrop: (e) => { e.preventDefault(); commit(); },
  });

  /**
   * 行的落点判定。两条防抖铁律：
   *   ① 行内事件**就地拦下**（preventDefault + stopPropagation）：一旦冒泡到容器，
   *      容器会把它当成「拖到空白处」翻成「追加到末尾」——指针正好压在被拖的行上时，
   *      两个判断来回切，页面就抖。
   *   ② 插入位取自**原始配置**里的位置（不随预览漂移）+ 指针在上半/下半决定前后。
   *      若反过来用「预览后的行号」，预览一重排索引就变，等于自己推自己。
   */
  const rowProps = (key, sid) => ({
    onDragOver: (e) => {
      if (!draggingSid) return;
      e.preventDefault();
      e.stopPropagation();
      if (draggingSid === sid) return; // 悬停在自己身上：保持当前落点，不重算
      const rect = e.currentTarget.getBoundingClientRect();
      const below = e.clientY > rect.top + rect.height / 2;
      const at = nav.containerOf(value, sid, allIds);
      const index = (typeof at.index === 'number' ? at.index : 0) + (below ? 1 : 0);
      setOverIfChanged({ key, index });
    },
    onDrop: (e) => { e.preventDefault(); e.stopPropagation(); commit(); },
    onDragStart: () => setDrag({ kind: 'section', sid }),
  });

  return (
    <div className="stack">
      {/* ① 平铺：不进任何容器的栏目（= 头部平铺显示） */}
      <section {...zone('pool', 'nav-pool')}>
        <div className="hint">平铺：不进分组也不隐藏的栏目，直接显示在头部（拖到这里 = 移出分组 / 取消隐藏）</div>
        {pool.length ? (
          <div className="nav-list">
            {pool.map((sid) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                dragging={draggingSid === sid}
                {...rowProps('pool', sid)}
                onDragEnd={endDrag}
                actions={null} />
            ))}
          </div>
        ) : <div className="muted">没有平铺的栏目。</div>}
      </section>

      {/* ② 分组：组名可改、组间可拖把手换位 */}
      {preview.groups.map((g, gi) => (
        <section key={gi} {...zone(`g${gi}`, 'card nav-group')}>
          <div
            className={`colhead ${over?.key === `g${gi}` && over.group ? 'drop-target' : ''}`}
            onDragOver={(e) => { if (drag?.kind === 'group') { e.preventDefault(); setOver({ key: `g${gi}`, group: true }); } }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag?.kind === 'group' && drag.gi !== gi) onChange(nav.moveGroup(value, drag.gi, gi - drag.gi));
              endDrag();
            }}
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
              {g.sections.map((sid) => (
                <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                  dragging={draggingSid === sid}
                  {...rowProps(`g${gi}`, sid)}
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
          <span className="muted">{preview.hidden.length} 个栏目</span>
          <span className="right muted">不进头部 · #/栏目id 直达仍可用</span>
        </div>
        {preview.hidden.length ? (
          <div className="nav-list">
            {preview.hidden.map((sid) => (
              <SectionRow key={sid} section={sectionOf(sid)} sid={sid}
                dragging={draggingSid === sid}
                {...rowProps('hidden', sid)}
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

