/* 工具类面板：附件中心 / 导出导入 / 设置 / 布局 JSON
 *
 * 布局 JSON 面板是**模型的体检口**：直接把 model.toJson() 摊开给人看——
 * 布局不是画出来的，是这棵树推导出来的。改布局 = 改这棵树。
 */

import { useState } from 'react';
import { Model } from 'flexlayout-react';
import { useApp } from '../appctx.jsx';
import { applyGlobalAttrs, clearStoredModel } from '../workspace.js';
import { FILES, SECTIONS } from '../data.js';
import { Chip, Panel } from '../ui.jsx';

export function FilesPanel() {
  const { sections, fileRefs } = useApp();
  const [onlyUnused, setOnlyUnused] = useState(false);
  // 引用关系**算出来**，不存：谁在引用由块/字段里的附件 id 列表决定
  const rows = FILES.map((f) => ({ ...f, refs: fileRefs?.get(f.id) || 0 }))
    .filter((f) => (onlyUnused ? f.refs === 0 : true))
    .sort((a, b) => (a.refs - b.refs) || a.name.localeCompare(b.name));
  const unused = FILES.filter((f) => !(fileRefs?.get(f.id))).length;
  return (
    <Panel
      toolbar={
        <>
          <strong>附件中心</strong>
          <span className="muted">{FILES.length} 份</span>
          <span className="grow" />
          <Chip on={onlyUnused} onClick={() => setOnlyUnused((v) => !v)}>
            只看未引用（{unused}）
          </Chip>
        </>
      }
      footer={<span className="muted">附件中心只做库存展示：指派发生在条目 / 块里（两种引用都算：file 块 + file 字段）</span>}
    >
      <table>
        <thead>
          <tr><th>名称</th><th>被引用</th><th style={{ width: 90 }} className="num">大小</th></tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td className="muted">{f.refs ? `已被 ${f.refs} 处引用` : '未引用'}</td>
              <td className="num">{f.size}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ padding: '8px 12px' }}>
        栏目 {Object.keys(sections).length} 个 · 上传入口在块编辑器里，不在这里。
      </div>
    </Panel>
  );
}

export function ExportPanel() {
  const [picked, setPicked] = useState(['demo', 'job']);
  const toggle = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Panel
      toolbar={<><strong>导出导入</strong><span className="grow" /><button className="primary">导出 ZIP</button></>}
      footer={<span className="mono muted">bundle.json + sections/&lt;id&gt;.zip · 整库包：口令用 AES-256-GCM，包恒明文</span>}
    >
      <div style={{ padding: '10px 12px' }}>
        <div className="rowgap">
          {Object.values(SECTIONS).map((s) => (
            <span key={s.id} className={`chip${picked.includes(s.id) ? ' on' : ''}`} onClick={() => toggle(s.id)}>
              {s.title}
            </span>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 10 }}>
          导出的是<b>数据</b>（栏目 + 条目 + 块 + 附件），不含工作区布局——布局是本机偏好。
        </div>
      </div>
    </Panel>
  );
}

export function SettingsPanel() {
  const { masked, setMasked, navTree, hidden, treeSource, legacySettings } = useApp();
  return (
    <Panel
      toolbar={<strong>设置</strong>}
      footer={<span className="muted">栏目只从侧边栏目录树进入；顶栏只留全局动作</span>}
    >
      <div style={{ padding: '10px 12px' }}>
        <div className="prop"><span className="k">默认栏目</span><span>字段样例</span></div>
        <div className="prop">
          <span className="k">目录树来源</span>
          <span className={treeSource === 'inferred' ? 'muted' : ''}>
            {treeSource === 'inferred' ? '推断（老三套，未写回）' : '显式 settings.navTree'}
          </span>
        </div>
        <div className="prop">
          <span className="k">老 navGroups</span>
          <span className="mono">{JSON.stringify(legacySettings?.navGroups || [])}</span>
        </div>
        <div className="prop">
          <span className="k">老 navHidden</span>
          <span className="mono">{JSON.stringify(legacySettings?.navHidden || [])}</span>
        </div>
        <div className="prop">
          <span className="k">老 navOrder</span>
          <span className="mono">{JSON.stringify(legacySettings?.navOrder || [])}</span>
        </div>
        <div className="prop"><span className="k">当前隐藏</span><span className="mono">settings.navHidden（{hidden.length}）</span></div>
        <div className="prop"><span className="k">目录树节点</span><span className="mono">{navTree.length} 个</span></div>
        <div className="prop"><span className="k">工作区布局</span><span className="mono">ui.workspace（localStorage）</span></div>
        <div className="prop">
          <span className="k">键位</span>
          <span className="mono" style={{ fontSize: 11 }}>
            Ctrl+Delete 关闭页签 · F2 重命名 · F6 焦点切到面板内容 · Ctrl+F6 / Ctrl+Shift+F6 下/上个面板组
          </span>
        </div>
        <div className="prop">
          <span className="k">全局打码</span>
          <label className="rowgap" style={{ gap: 4 }}>
            <input type="checkbox" checked={masked} onChange={(e) => setMasked(e.target.checked)} />
            密文默认打码展示
          </label>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          目录树节点 {navTree.length} 个（栏目节点是配置；条目节点是推导出来的，不入库）。
        </div>
      </div>
    </Panel>
  );
}

export function LayoutPanel() {
  const { model, setModel, resetLayout } = useApp();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(model?.toJson?.() ?? {}, null, 2);

  /** 导入：粘贴一份布局 JSON → 整个替换当前布局（设计：布局 = 模型，存的是模型） */
  const apply = () => {
    try {
      const parsed = JSON.parse(draft);
      if (!parsed || !parsed.layout) throw new Error('缺少 layout 字段——这不是一份 FlexLayout 布局');
      clearStoredModel();
      setModel(applyGlobalAttrs(Model.fromJson(parsed)));
      setError('');
      setDraft('');
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  return (
    <Panel
      toolbar={
        <>
          <strong>工作区布局（JSON）</strong>
          <span className="muted">model.toJson()</span>
          <span className="grow" />
          <button onClick={() => { navigator.clipboard?.writeText(json); setCopied(true); }}>复制</button>
          <button onClick={resetLayout}>重置布局</button>
        </>
      }
      footer={
        <>
          <span className="muted">布局不是画出来的，是这棵树推导出来的</span>
          <span className="grow" />
          {copied ? <span className="muted">已复制</span> : null}
        </>
      }
    >
      <pre className="mono" style={{ margin: 0, padding: '10px 12px', fontSize: 11, whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 260, borderBottom: '1px solid var(--soft-2)' }}>
        {json}
      </pre>

      {/* 导入：粘贴一份布局 JSON 整体替换（坏 JSON 明确报错，不吞掉整台应用） */}
      <div style={{ padding: '10px 12px' }}>
        <div className="muted" style={{ marginBottom: 4 }}>导入：粘贴一份布局 JSON（整体替换当前布局）</div>
        <textarea
          id="layout-import"
          name="layout-import"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder='{"global":{…},"layout":{"type":"row",…}}'
          style={{ width: '100%', minHeight: 90, font: '11px ui-monospace, Consolas, monospace', border: '1px solid var(--soft-2)', borderRadius: 6, padding: 6 }}
        />
        <div className="rowgap" style={{ marginTop: 6 }}>
          <button className="primary" onClick={apply} disabled={!draft.trim()}>应用粘贴的布局</button>
          {error ? <span className="bad mono">{error}</span> : null}
        </div>
      </div>
    </Panel>
  );
}
