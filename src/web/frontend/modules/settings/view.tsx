import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  AppstoreOutlined, AimOutlined, CodeOutlined, DatabaseOutlined,
  LockOutlined, SwapOutlined, WarningOutlined,
} from '@ant-design/icons';
import { api } from '../../api/client.ts';
import { useStore } from '../../store.tsx';
import { CliHints, Copyable, Tag } from '../../components/ui.tsx';
import * as nav from '../../components/navModel.ts';
import NavManager from './navManager.tsx';
import type { Settings } from '../../../../shared/model.ts';

/** `/api/settings` 里的栏目摘要（栏目管理按它渲染）。 */
interface SettingsSectionRow {
  id: string;
  title: string;
  entries: number;
}

/** `/api/settings` 的响应（外部 JSON 边界）。 */
interface SettingsData {
  settings: Settings;
  sections: SettingsSectionRow[];
  schema: unknown;
}

/** 保存请求的返回值：`set` 是落盘后的设置。 */
interface SettingsSaveResult {
  status: string;
  set: Settings;
}

/** 保存后的基准：脏值判断与「放弃改动」都以它为准。 */
interface Baseline { form: Settings; navCfg: nav.NavConfig }

/** 设置页左侧导航的一项。 */
interface SettingsPage {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** 条件页（数据迁移 / 上次读取异常）：不满足就不出现在导航里 */
  when?: boolean;
}

export default function SettingsView() {
  const { boot, reload, toast, guard } = useStore();
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [navCfg, setNavCfg] = useState(nav.emptyConfig());
  // 保存后的基准：脏值判断与「放弃改动」都以它为准，不靠逐项对比
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  // 左侧导航当前页：Notion 式设置 = 左边选区块、右边看内容
  const [page, setPage] = useState('nav');
  // 面板地址不写死：直接取用户此刻访问的这个 origin，换端口/换 host 都自动跟上
  const panelUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const panelPort = typeof window === 'undefined' ? '' : (window.location.port || '80');

  const sections = useMemo(() => data?.sections || [], [data]);
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);

  const load = useCallback(async () => {
    try {
      const d = await api<SettingsData>('/api/settings');
      const nextForm = { ...d.settings };
      const nextNav = nav.configFromSettings(d.settings);
      setData(d);
      setForm(nextForm);
      setNavCfg(nextNav);
      setBaseline({ form: nextForm, navCfg: nextNav });
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const problems = useMemo(() => (form ? nav.validate(navCfg, sectionIds) : []), [navCfg, sectionIds, form]);
  // 导航按「结构」判脏：拖出去又拖回原位不算改动（order 里会留下一串脚印，但不影响长相）；
  // 其余设置项逐键比
  const dirty = !!baseline && (!nav.sameStructure(navCfg, baseline.navCfg, sectionIds) || nav.isDirty(form, baseline.form));

  // 一次保存全部设置：标量项 + 导航（分组 / 隐藏）。分成两块各存各的，
  // 用户就得记住「刚才那块存了没」——统一保存 + 统一的脏值提示才是清晰的。
  const save = guard(async () => {
    if (!form) return;
    if (problems.length) { toast(`保存失败：${problems[0].message}`, 'bad'); return; }
    const r = await api<SettingsSaveResult>('/api/settings', {
      method: 'PATCH',
      body: {
        set: {
          defaultSection: form.defaultSection,
          ...nav.configToPayload(navCfg),
        },
      },
    });
    const nextForm = { ...r.set };
    const nextNav = nav.configFromSettings(r.set);
    setData((prev) => (prev ? { ...prev, settings: r.set } : prev));
    setForm(nextForm);
    setNavCfg(nextNav);
    setBaseline({ form: nextForm, navCfg: nextNav });
    toast('设置已保存');
    await reload();
  });

  const discard = () => {
    if (!baseline) return;
    setForm({ ...baseline.form });
    setNavCfg(structuredClone(baseline.navCfg));
  };

  // 条件页：迁移与异常记录只在真的有时出现（导航与内容共用同一个 when 判断）
  const pages = useMemo<SettingsPage[]>(() => [
    { id: 'nav', title: '栏目管理', icon: AppstoreOutlined },
    { id: 'default', title: '默认行为', icon: AimOutlined },
    { id: 'storage', title: '存储与运行', icon: DatabaseOutlined },
    { id: 'vault', title: '密钥', icon: LockOutlined },
    { id: 'panel', title: '面板与 CLI', icon: CodeOutlined },
    { id: 'migration', title: '数据迁移', icon: SwapOutlined, when: !!boot?.migration },
    { id: 'corrupt', title: '上次读取异常', icon: WarningOutlined, when: !!boot?.corrupt },
  ], [boot]);

  const pageIds = useMemo(() => new Set(pages.filter((p) => p.when !== false).map((p) => p.id)), [pages]);
  // 深状态失效（如迁移记录消失）时落回第一页，别停在空白上
  const active = pageIds.has(page) ? page : 'nav';
  const ActiveIcon = pages.find((p) => p.id === active)?.icon;

  if (!data || !form) return <div className="pad muted">加载中…</div>;

  return (
    <div className="settings">
      {/* 左侧导航：参考 Notion Preferences——分组列表 + 搜索框省略（区块只有 7 个，不配搜索） */}
      <nav className="settings-nav">
        {pages.filter((p) => p.when !== false).map((p) => (
          <button
            key={p.id}
            className={`sn-item ${p.id === active ? 'active' : ''}`}
            onClick={() => setPage(p.id)}
          >
            <p.icon className="sb-icon" />
            <span className="nowrap">{p.title}</span>
          </button>
        ))}
      </nav>

      {/* 右侧内容：无边框、行式表单——左边是「名称 + 说明」，右边是控件，行间 1px 细线 */}
      <div className="settings-body">
        <div className="set-head">
          <h1 className="set-title">
            {ActiveIcon ? <ActiveIcon className="sb-icon" /> : null}
            {pages.find((p) => p.id === active)?.title}
          </h1>
          <div className="set-sub">本机配置与运行状态</div>
          <div className="set-actions rowgap">
            {dirty ? (
              <>
                <span className="tag">有未保存的改动</span>
                <button className="btn small" onClick={() => { void save(); }}>保存</button>
                <button className="btn small ghost" onClick={discard}>放弃改动</button>
              </>
            ) : <span className="muted">已保存</span>}
            <button className="btn small ghost" onClick={load}>重新读取</button>
          </div>
        </div>

        <div className="set-content">
          {active === 'nav' ? (
            <div className="stack">
              <div className="hint">
                侧栏显示 {sectionIds.length - navCfg.hidden.length} 个栏目 · 隐藏 {navCfg.hidden.length} 个
                {navCfg.groups.length ? ` · ${navCfg.groups.length} 个分组` : ''}。
                拖动就是把结构摆成你要的样子：栏目可以拖进分组、组内换位、拖回平铺区即移出；拖分组把手换分组顺序。
                被隐藏的栏目只是侧栏不显示入口，用 <code>#/栏目id</code> 直达仍可用。
              </div>
              <NavManager sections={sections} value={navCfg} onChange={setNavCfg} />
              {problems.length ? (
                <div className="stack">
                  {problems.map((p) => <div key={p.field} className="hint bad">· {p.message}</div>)}
                </div>
              ) : null}
            </div>
          ) : null}

          {active === 'default' ? (
            <div className="set-row">
              <div className="set-k">
                <span className="name">默认栏目</span>
                <span className="desc">打开面板时落在哪</span>
              </div>
              <div className="set-v">
                <select value={form.defaultSection || ''} onChange={(e) => setForm({ ...form, defaultSection: e.target.value })}>
                  <option value="">（第一个栏目）</option>
                  {sections.map((s) => <option key={s.id} value={s.id}>{s.title}（{s.id}）</option>)}
                  {/* 历史值指向已删栏目：留着看得见（而不是被悄悄改成第一项），
                      保存时后端会拒绝并提示现有栏目 */}
                  {form.defaultSection && !sections.some((s) => s.id === form.defaultSection) ? (
                    <option value={form.defaultSection}>{form.defaultSection}（栏目已不存在）</option>
                  ) : null}
                </select>
              </div>
            </div>
          ) : null}

          {active === 'storage' ? (
            <>
              <InfoRow label="数据目录" value={boot?.home} copy={boot?.home} />
              <InfoRow label="store.json" value={boot?.storePath} copy={boot?.storePathRaw} />
              <InfoRow label="栏目 / 条目" value={boot ? `${boot.counts.sections} / ${boot.counts.entries}` : ''} />
              <InfoRow label="命令条数" value={boot ? String(boot.counts.commands) : ''} />
              <InfoRow label="app / node" value={boot ? `v${boot.app.version} · node ${boot.app.node} · ${boot.app.platform}` : ''} />
              <InfoRow
                label="环境变量覆盖"
                value={boot ? Object.entries(boot.envOverrides).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('　') || '（无）' : ''}
              />
            </>
          ) : null}

          {active === 'vault' ? (
            <>
              <InfoRow label="密钥来源" value={boot?.vault?.source === 'env' ? '环境变量 NX_SK_PASSPHRASE（口令不落盘）' : '本机密钥文件'} />
              <InfoRow label="密钥文件" value={boot?.vault?.keyFile || boot?.vault?.saltFile || ''} copy={boot?.vault?.keyFile || boot?.vault?.saltFile} />
              <div className="set-row">
                <div className="set-k"><span className="desc">{boot?.vault?.note}</span></div>
              </div>
              <div className="set-row">
                <div className="set-k"><span className="desc bad">删掉密钥文件或换掉口令后，已存的密文都解不开了——导出前先确认密钥可用。</span></div>
              </div>
            </>
          ) : null}

          {active === 'panel' ? (
            <>
              <div className="set-row">
                <div className="set-k">
                  <span className="name">面板地址</span>
                </div>
                <div className="set-v">
                  <span className="mono nowrap">{panelUrl}</span>
                  <Copyable className="mono" text={panelUrl}>复制</Copyable>
                </div>
              </div>
              <div className="set-row">
                <div className="set-k">
                  <span className="name">重启面板</span>
                  <span className="desc">面板本身就是 serve 提供的；改代码后重启它即可</span>
                </div>
                <div className="set-v">
                  <Copyable className="mono" text={`nx-sk serve --port ${panelPort}`}>{`nx-sk serve --port ${panelPort}`}</Copyable>
                </div>
              </div>
              <CliHints module="settings" />
            </>
          ) : null}

          {active === 'migration' && boot?.migration ? (
            <>
              <InfoRow label="迁移结果" value={`store 已从 v${boot.migration.from} 迁到 v${boot.migration.to}：密钥栏目字段 ${boot.migration.fieldsBefore} → ${boot.migration.fieldsAfter}，${boot.migration.entries} 条条目`} />
              <InfoRow label="迁移前的原始文件" value={boot.migration.snapshot} copy={boot.migration.snapshotRaw || ''} />
              {boot.migration.legacyValuesKept ? (
                <InfoRow label="旧字段" value={`另保留了 ${boot.migration.legacyValuesKept} 个旧字段的值（不再显示，但没删）`} />
              ) : null}
            </>
          ) : null}

          {active === 'corrupt' && boot?.corrupt ? (
            <div className="set-row">
              <div className="set-k">
                <span className="desc bad">store.json 解析失败，已挪到 {boot.corrupt.to}（原文件没有被覆盖）</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, copy }: { label: string; value?: string; copy?: string }) {
  return (
    <div className="set-row">
      <div className="set-k"><span className="name">{label}</span></div>
      <div className="set-v">
        <span className="mono nowrap" title={value || ''}>{value || '（空）'}</span>
        {copy ? <Copyable className="mono" text={copy}>复制</Copyable> : <Tag> </Tag>}
      </div>
    </div>
  );
}
