/* KV 投影 —— KV 栏目的一种视图
 *
 * KV 栏目没有「表格列」这回事，就是一条条名称 + 值。
 * 打码是**全局动作**（顶栏开关），但读法不同：这里值默认打码，明文要手动点「显示明文」。
 */

import { useApp } from '../appctx.jsx';
import { Secret } from '../ui.jsx';

export default function KvView({ section }) {
  const { masked, setMasked } = useApp();
  const entries = section.entries || [];

  return (
    <div>
      <div className="rowgap" style={{ padding: '6px 12px' }}>
        <span className="muted">{entries.length} 个键</span>
        <span className="grow" />
        <label className="rowgap" style={{ gap: 4 }}>
          <input id="kv-plaintext" name="kv-plaintext" type="checkbox" checked={!masked} onChange={(e) => setMasked(!e.target.checked)} />
          显示明文
        </label>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 200 }}>名称</th>
            <th>值</th>
            <th style={{ width: 120 }}>归属</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.title}</td>
              <td><Secret value={e.values?.apikey} masked={masked} /></td>
              <td className="muted">{e.values?.owner || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length ? <div className="muted" style={{ padding: 12 }}>（空栏目）</div> : null}
    </div>
  );
}
