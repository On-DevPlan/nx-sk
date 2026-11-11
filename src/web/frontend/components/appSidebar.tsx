// 左侧导航树（Notion 式）：分组 › 栏目 › 条目，整体可收起（收起由 App 控制）。
//
// 为什么用 antd Tree：目录树要「生产级」的手感——键盘导航、展开态、选中态、
// 大栏目虚拟滚动、懒加载子节点。自研这些细节成本高且容易粗糙，antd 是成熟开源实现；
// 本文件只负责**数据编排**（栏目/条目/工具三层数据怎么喂给树）与**单色主题**。
//
// #14 补的两块基础设施：
// - 右缘拖拽线：拖动改侧栏宽度（localStorage 持久化，双击恢复默认）；
// - 右键菜单：节点类型各配一组动作（打开 / 新标签页 / 复制链接 / 展开折叠），
//   定位与弹层全部交给 antd Dropdown(trigger=contextMenu)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, Dispatch, Key, ReactNode, SetStateAction } from 'react';
import { Dropdown, Tree, Input, Tooltip } from 'antd';
import type { MenuProps, TreeProps } from 'antd';
import {
  AppstoreOutlined, DatabaseOutlined, ExportOutlined, FileTextOutlined,
  FolderOutlined, ImportOutlined, PaperClipOutlined, ProfileOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons';
import { Copyable } from './ui.tsx';
import { useStore } from '../store.tsx';
import { api } from '../api/client.ts';
import { copyText, entryRefText } from '../entryRef.ts';
import type { Boot } from '../../../shared/model.ts';

/** antd Tree 的节点形状（从 TreeProps 反推，避免 nodenext 下的深路径类型导入）。 */
type DataNode = NonNullable<TreeProps['treeData']>[number];

/** 栏目摘要（来自 bootstrap.sections）。 */
export interface NavSectionItem {
  id: string;
  title: string;
  order?: number;
  count?: number;
  kind: 'section';
}

/** 静态工具页（附件 / 导出导入 / 设置 / 栏目）。component 仅供 App 渲染，侧栏不读。 */
export interface NavViewItem {
  id: string;
  title: string;
  order?: number;
  kind: 'view';
  component?: unknown;
}

export interface SidebarNav {
  flat: NavSectionItem[];
  groups: Array<{ title: string; sections: NavSectionItem[] }>;
  tools: NavViewItem[];
  all: Array<NavSectionItem | NavViewItem>;
}

/** 条目摘要：侧栏树叶子节点只需要 id + 标题。 */
export interface EntryLite { id: string; title: string }

/** `resource.search` 命中项（与后端 ResourceHit 同形；面板只读这些键）。 */
interface ResourceHit {
  locator: string;
  kind: string;
  title: string;
  subtitle: string;
  sectionId?: string;
  entryId?: string;
  key?: string;
}

/** 条目叶子节点的 key 规则：与栏目 key（就是栏目 id）区分开。 */
export const entryKey = (sectionId: string, entryId: string) => `e:${sectionId}:${entryId}`;

/** 树节点 key → (类型, id)。 */
function parseKey(key: string): { type: 'section' | 'entry' | 'view' | 'group'; id: string } | null {
  if (key.startsWith('g:')) return { type: 'group', id: key.slice(2) };
  if (key.startsWith('e:')) {
    const rest = key.slice(2);
    const cut = rest.indexOf(':');
    return { type: 'entry', id: rest.slice(cut + 1) };
  }
  if (key.startsWith('v:')) return { type: 'view', id: key.slice(2) };
  return { type: 'section', id: key };
}

/** 工具页的图标（键 = registry 的视图 id；未识别的用栏目格图标兜底）。 */
const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  sections: AppstoreOutlined,
  files: PaperClipOutlined,
  export: ExportOutlined,
  settings: SettingOutlined,
  // 兜底之外再给「导出导入」一个备选语义（若 id 改名也不至于退回栏目格）
  'export-import': ImportOutlined,
};

/** 侧栏宽度：纯视觉偏好，和收起态一样落 localStorage（不进 store 的 ui）。 */
const SB_W_KEY = 'nx-sk-sidebar-w';
const SB_W_DEFAULT = 264;
const SB_W_MIN = 200;
const SB_W_MAX = 420;

function loadSbW(): number {
  try {
    const n = Number(localStorage.getItem(SB_W_KEY));
    return Number.isFinite(n) && n >= SB_W_MIN && n <= SB_W_MAX ? n : SB_W_DEFAULT;
  } catch {
    return SB_W_DEFAULT;
  }
}

/** 深链构造：与 App 的 onGo/onOpenEntry 写 hash 的格式同源。 */
const sectionHash = (id: string) => `#/${encodeURIComponent(id)}`;
const entryHash = (sid: string, eid: string) => `${sectionHash(sid)}?entry=${encodeURIComponent(eid)}`;
const fullUrl = (hash: string) => `${window.location.origin}${window.location.pathname}${hash}`;

/** 右键菜单外壳：antd Dropdown 的 contextMenu 触发。没有可用动作就不包（右键不弹空菜单）。 */
function withCtx(items: MenuProps['items'], row: ReactNode) {
  if (!items || items.length === 0) return row;
  return (
    <Dropdown trigger={['contextMenu']} menu={{ items }}>
      {row}
    </Dropdown>
  );
}

interface AppSidebarProps {
  boot: Boot | null;
  nav: SidebarNav;
  currentId: string;
  entryId: string;
  entryMap: Record<string, EntryLite[]>;
  setEntryMap: Dispatch<SetStateAction<Record<string, EntryLite[]>>>;
  onGo: (id: string) => void;
  /** focus = 打开条目后要把哪个字段块滚进视口（#18 侧栏全局搜索定位字段用）。 */
  onOpenEntry: (sectionId: string, entryId: string, focus?: string) => void;
}

export default function AppSidebar({
  boot, nav, currentId, entryId, entryMap, setEntryMap, onGo, onOpenEntry,
}: AppSidebarProps) {
  const [q, setQ] = useState('');
  // 展开态受控：搜索时全展开（只展有命中的分支），清空后回到用户自己的展开态
  const [expanded, setExpanded] = useState<Key[]>(() => nav.groups.map((_, gi) => `g:${gi}`));
  // 已加载条目列表的栏目（受控 loadedKeys：boot 变化后要整批刷新，不受控拿不到这份清单）
  const [loadedKeys, setLoadedKeys] = useState<Key[]>([]);
  const inFlight = useRef(new Set<string>());
  const { toast } = useStore();

  // —— 右缘拖拽线（Notion 式改宽）——
  // 拖动过程只改本地 state（mousemove 不落盘），松手才写 localStorage；双击恢复默认。
  const asideRef = useRef<HTMLElement>(null);
  const [sbW, setSbW] = useState(loadSbW);
  const sbWRef = useRef(sbW);
  const [dragSb, setDragSb] = useState(false);
  useEffect(() => {
    if (!dragSb) return undefined;
    const move = (ev: MouseEvent) => {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      const w = Math.round(Math.min(SB_W_MAX, Math.max(SB_W_MIN, ev.clientX - left)));
      sbWRef.current = w;
      setSbW(w);
    };
    const up = () => {
      setDragSb(false);
      try { localStorage.setItem(SB_W_KEY, String(sbWRef.current)); } catch { /* 隐私模式 */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('col-resizing');
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
    };
  }, [dragSb]);
  const resetSbW = useCallback(() => {
    sbWRef.current = SB_W_DEFAULT;
    setSbW(SB_W_DEFAULT);
    try { localStorage.setItem(SB_W_KEY, String(SB_W_DEFAULT)); } catch { /* 隐私模式 */ }
  }, []);

  // 右键菜单的展开/折叠开关（搜索态展开由 searchExpanded 临时接管，菜单此时不给切换项）
  const toggleExpand = useCallback((key: Key) => {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);
  const isExpanded = useCallback(
    (key: string) => expanded.some((k) => String(k) === key),
    [expanded],
  );

  // 侧栏树需要每层图标——不引 emoji，全部用 @ant-design/icons 的单色线性图标
  const toolIcon = useCallback((id: string) => {
    const Icon = TOOL_ICONS[id] || AppstoreOutlined;
    return <Icon className="sb-icon" />;
  }, []);

  /** 拉一个栏目的条目摘要（懒加载 + 去重）；列表按 store 原序，树里原样展示。 */
  const ensureEntries = useCallback(async (sectionId: string) => {
    if (inFlight.current.has(sectionId)) return;
    inFlight.current.add(sectionId);
    try {
      const d = await api<{ entries: Array<{ id: string; title: string }> }>(
        `/api/entries?section=${encodeURIComponent(sectionId)}`,
      );
      setEntryMap((prev) => ({
        ...prev,
        [sectionId]: d.entries.map((e) => ({ id: e.id, title: e.title })),
      }));
    } catch {
      // 拉不到就让它保持空：树里这个栏目展开后没有子节点，主区域会有完整报错
    } finally {
      inFlight.current.delete(sectionId);
    }
  }, [setEntryMap]);

  // 数据刷新后（reload → boot 换引用）把**已加载过**的栏目整批重拉：
  // 主区域增删改条目后侧栏计数与列表要跟上，而 antd 的 loadedKeys 一旦记录就不再触发 loadData。
  // 缓存里已有的栏目（entryMap 有键）也算已加载——它们展开时不会走 loadData。
  const loadedRef = useRef<Key[]>([]);
  loadedRef.current = loadedKeys;
  useEffect(() => {
    const fromKeys = loadedRef.current
      .map((k) => String(k))
      .filter((k) => !k.includes(':'));
    const ids = new Set([...fromKeys, ...Object.keys(entryMap)]);
    if (!ids.size) return;
    void Promise.all([...ids].map((id) => ensureEntries(id)));
    // entryMap 变化不触发（那是本 effect 自己写出来的）；只跟着 boot 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, ensureEntries]);

  // #14：打开某个栏目时，侧栏自动拉它的条目并展开——Notion 的「子页面就在树里」。
  // App 用「侧栏是否已有条目」决定正文要不要再显示列表（listHidden）；
  // 同时把栏目记进 loadedKeys，reload 后跟着上面的整批刷新走。
  useEffect(() => {
    if (!currentId) return;
    if (!(boot?.sections || []).some((s) => s.id === currentId)) return;
    setExpanded((prev) => (prev.includes(currentId) ? prev : [...prev, currentId]));
    setLoadedKeys((prev) => (prev.includes(currentId) ? prev : [...prev, currentId]));
    void ensureEntries(currentId);
  }, [currentId, boot, ensureEntries]);

  // 搜索过滤：栏目标题或（已加载的）条目标题命中就保留；命中的分支全展开。
  // 未加载条目的栏目只按栏目名搜——懒加载的数据不该在搜索时被整库拉一遍。
  const needle = q.trim().toLowerCase();

  // —— #18 全局资源检索：三类结果分组（当前条目字段 / 全局字段 / 条目）——
  // 后端与 debug 引用字段共用同一条 `resource.search`；防抖 250ms，
  // 树过滤保持原样（懒加载与右键菜单不回归），结果面板叠在树上方。
  const [hits, setHits] = useState<ResourceHit[]>([]);
  const [hitsBusy, setHitsBusy] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); setHitsBusy(false); return undefined; }
    let dead = false;
    setHitsBusy(true);
    const timer = setTimeout(async () => {
      try {
        const d = await api<{ items: ResourceHit[] }>(`/api/resources/search?q=${encodeURIComponent(term)}`);
        if (!dead) setHits(d.items || []);
      } catch {
        if (!dead) setHits([]);
      } finally {
        if (!dead) setHitsBusy(false);
      }
    }, 250);
    return () => { dead = true; clearTimeout(timer); };
  }, [q]);

  const hitGroups = useMemo(() => {
    const isOwn = (r: ResourceHit) => r.kind === 'field'
      && !!entryId && r.sectionId === currentId && (!r.entryId || r.entryId === entryId);
    const ownFields: ResourceHit[] = [];
    const globalFields: ResourceHit[] = [];
    const entryHits: ResourceHit[] = [];
    for (const r of hits) {
      if (r.kind === 'field') (isOwn(r) ? ownFields : globalFields).push(r);
      else if (r.kind === 'entry') entryHits.push(r);
    }
    return { ownFields, globalFields, entryHits };
  }, [hits, currentId, entryId]);

  const openHit = useCallback((r: ResourceHit) => {
    if (r.kind === 'field') {
      // 点字段结果 = 进条目并把该块滚进视口；模板字段没有条目段 → 用当前条目，
      // 都没有 → 进栏目（视图自动选首条后仍按 focus 定位块）。
      onOpenEntry(r.sectionId || '', r.entryId || entryId || '', r.key);
    } else if (r.kind === 'entry') {
      onOpenEntry(r.sectionId || '', r.entryId || '');
    } else if (r.kind === 'section') {
      onGo(r.sectionId || '');
    }
  }, [onGo, onOpenEntry, entryId]);

  // —— 右键菜单：按节点类型拼动作项，外壳交给 antd Dropdown（见 withCtx）——
  const entryMenu = useCallback((sid: string, e: EntryLite): MenuProps['items'] => {
    const secTitle = (boot?.sections || []).find((s) => s.id === sid)?.title || sid;
    return [
      { key: 'open', label: '打开条目', onClick: () => onOpenEntry(sid, e.id) },
      { key: 'tab', label: '新标签页打开', onClick: () => window.open(entryHash(sid, e.id), '_blank') },
      {
        key: 'ref',
        label: '复制条目定位（CLI）',
        onClick: async () => {
          await copyText(entryRefText({ id: sid, title: secTitle }, { id: e.id, title: e.title }));
          toast(`已复制条目定位：${secTitle} › ${e.title}`);
        },
      },
    ];
  }, [boot, onOpenEntry, toast]);

  const sectionMenu = useCallback((s: NavSectionItem, hasKids: boolean): MenuProps['items'] => {
    const items: MenuProps['items'] = [
      { key: 'open', label: '打开栏目', onClick: () => onGo(s.id) },
      { key: 'tab', label: '新标签页打开', onClick: () => window.open(sectionHash(s.id), '_blank') },
      {
        key: 'copy',
        label: '复制栏目链接',
        onClick: async () => {
          await copyText(fullUrl(sectionHash(s.id)));
          toast(`已复制栏目链接：${s.title}`);
        },
      },
    ];
    if (hasKids && !needle) {
      items.push({
        key: 'toggle',
        label: isExpanded(s.id) ? '折叠条目' : '展开条目',
        onClick: () => toggleExpand(s.id),
      });
    }
    return items;
  }, [needle, onGo, toast, isExpanded, toggleExpand]);

  const viewMenu = useCallback((t: NavViewItem): MenuProps['items'] => [
    { key: 'open', label: '打开', onClick: () => onGo(t.id) },
    { key: 'tab', label: '新标签页打开', onClick: () => window.open(sectionHash(t.id), '_blank') },
    {
      key: 'copy',
      label: '复制页面链接',
      onClick: async () => {
        await copyText(fullUrl(sectionHash(t.id)));
        toast(`已复制页面链接：${t.title}`);
      },
    },
  ], [onGo, toast]);

  const groupMenu = useCallback((gi: number): MenuProps['items'] => (
    needle ? [] : [{
      key: 'toggle',
      label: isExpanded(`g:${gi}`) ? '折叠分组' : '展开分组',
      onClick: () => toggleExpand(`g:${gi}`),
    }]
  ), [needle, isExpanded, toggleExpand]);

  const treeData = useMemo<DataNode[]>(() => {
    const hit = (s: string) => !!needle && s.toLowerCase().includes(needle);
    const entryNode = (sid: string, e: EntryLite): DataNode => ({
      key: entryKey(sid, e.id),
      isLeaf: true,
      title: withCtx(entryMenu(sid, e), (
        <span className="sb-row" title={e.title}>
          <FileTextOutlined className="sb-icon sb-icon-leaf" />
          <span className="sb-label nowrap">{e.title || '（无标题）'}</span>
        </span>
      )),
    });

    const sectionNode = (s: NavSectionItem): DataNode => {
      const entries = entryMap[s.id];
      const count = typeof s.count === 'number' ? s.count : undefined;
      const hasKids = entries ? entries.length > 0 : (count ?? 0) > 0;
      return {
        key: s.id,
        // 还没加载过子节点的栏目交给 loadData；已知 0 条的栏目就是叶子
        isLeaf: entries ? entries.length === 0 : count === 0,
        children: entries ? entries.map((e) => entryNode(s.id, e)) : undefined,
        title: withCtx(sectionMenu(s, hasKids), (
          <span className="sb-row" title={s.title}>
            <DatabaseOutlined className="sb-icon" />
            <span className="sb-label nowrap">{s.title}</span>
            {typeof count === 'number' ? <span className="count">{count}</span> : null}
          </span>
        )),
      };
    };

    // 搜索时：没有任何命中的分组整组隐藏（否则搜索结果里飘着一排空文件夹）
    const groupNodes = nav.groups.map((g, gi) => {
      const kept = g.sections.filter((s) => !needle
        || hit(g.title) || hit(s.title) || (entryMap[s.id] || []).some((e) => hit(e.title)));
      if (needle && !kept.length) return null;
      return {
        key: `g:${gi}`,
        selectable: false,
        children: kept.map(sectionNode),
        title: withCtx(groupMenu(gi), (
          <span className="sb-row">
            <FolderOutlined className="sb-icon" />
            <span className="sb-label nowrap">{g.title}</span>
            <span className="count">{kept.length}</span>
          </span>
        )),
      } as DataNode;
    }).filter(Boolean) as DataNode[];

    const flatNodes = nav.flat
      .filter((s) => !needle || hit(s.title) || (entryMap[s.id] || []).some((e) => hit(e.title)))
      .map(sectionNode);

    const toolNodes: DataNode[] = nav.tools.map((t) => ({
      key: `v:${t.id}`,
      isLeaf: true,
      title: withCtx(viewMenu(t), (
        <span className="sb-row" title={t.title}>
          {toolIcon(t.id)}
          <span className="sb-label nowrap">{t.title}</span>
        </span>
      )),
    }));

    return [...groupNodes, ...flatNodes, ...toolNodes];
  }, [nav, entryMap, needle, toolIcon, entryMenu, sectionMenu, viewMenu, groupMenu]);

  // 搜索时把有命中的分支全展开；此时受控展开态临时接管
  const searchExpanded = useMemo<Key[] | null>(() => {
    if (!needle) return null;
    const keys: Key[] = [];
    const walk = (nodes: DataNode[]) => {
      for (const n of nodes) {
        if (n.children?.length) { keys.push(n.key); walk(n.children); }
      }
    };
    walk(treeData);
    return keys;
  }, [treeData, needle]);

  // 选中态：当前栏目 / 工具页 / 当前条目（侧栏与主区域双向同步的锚点）
  const selectedKeys = useMemo(() => {
    if (entryId && entryMap[currentId]?.some((e) => e.id === entryId)) {
      return [entryKey(currentId, entryId)];
    }
    if (nav.all.some((t) => t.id === currentId)) return [currentId];
    return [];
  }, [entryId, entryMap, currentId, nav.all]);

  // 切到分组里的栏目时自动展开它的分组（用户点了面包屑/深链不该看到「树是收着的」）
  useEffect(() => {
    const gi = nav.groups.findIndex((g) => g.sections.some((s) => s.id === currentId));
    if (gi >= 0) {
      setExpanded((prev) => (prev.includes(`g:${gi}`) ? prev : [...prev, `g:${gi}`]));
    }
  }, [nav.groups, currentId]);

  const onSelect = useCallback((keys: Key[], info: { node: DataNode }) => {
    const clicked = String(info.node.key);
    const parsed = parseKey(clicked);
    if (!parsed) return;
    if (!keys.length) {
      // 点的是**已选中**节点：antd 把它当反选（keys 清空）。
      // 侧栏的语义应该是「再次点击 = 重新定位」——照常导航并同步地址栏，不清选择。
      if (parsed.type === 'entry') {
        const sid = clicked.slice(2).split(':')[0];
        onOpenEntry(sid, parsed.id);
      } else if (parsed.type === 'section' || parsed.type === 'view') {
        onGo(parsed.id);
      }
      return;
    }
    if (parsed.type === 'view') { onGo(parsed.id); return; }
    if (parsed.type === 'section') { onGo(parsed.id); return; }
    if (parsed.type === 'entry') {
      // 条目叶子的父栏目：从 key 里拆（e:<sid>:<eid> 的第一段）
      const sid = clicked.slice(2).split(':')[0];
      onOpenEntry(sid, parsed.id);
    }
  }, [onGo, onOpenEntry]);

  const onLoadData = useCallback(async (node: DataNode) => {
    const parsed = parseKey(String(node.key));
    if (parsed?.type === 'section') await ensureEntries(parsed.id);
    // antd 5 的 Tree 没暴露 onLoaded，受控 loadedKeys 在这里自己记
    setLoadedKeys((prev) => (prev.includes(node.key) ? prev : [...prev, node.key]));
  }, [ensureEntries]);

  return (
    <aside className="sb" ref={asideRef} style={{ width: sbW }}>
      {/* 顶部：品牌 + 版本。原头部的品牌区搬到这里——侧栏是「我是谁」，内容区只管「在看什么」 */}
      <div className="sb-head">
        <span className="brand">
          <img src="/logo-rounded.png" alt="" />
          nx-sk
        </span>
        {boot ? <span className="ver mono">v{boot.app.version}</span> : null}
      </div>

      <div className="sb-search">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined className="sb-icon" />}
          placeholder="搜索栏目 / 条目 / 字段"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* #18：三类结果分组。点结果 = 导航（条目）或定位字段块（进条目 + 滚动 + 短暂高亮）。 */}
      {needle ? (
        <div className="sb-results" data-testid="sb-results">
          {hitsBusy && !hits.length ? <div className="hint pad">检索中…</div> : null}
          {!hitsBusy && !hits.length ? <div className="hint pad">没有命中的字段 / 条目</div> : null}
          <ResultGroup title="当前条目字段" items={hitGroups.ownFields} onOpen={openHit} />
          <ResultGroup title="全局字段" items={hitGroups.globalFields} onOpen={openHit} />
          <ResultGroup title="条目" items={hitGroups.entryHits} onOpen={openHit} />
        </div>
      ) : null}

      <div className="sb-tree">
        <Tree
          blockNode
          treeData={treeData}
          selectedKeys={selectedKeys}
          expandedKeys={searchExpanded ?? expanded}
          onExpand={(keys) => { if (!searchExpanded) setExpanded(keys); }}
          onSelect={onSelect}
          loadData={onLoadData}
          loadedKeys={loadedKeys}
        />
      </div>

      {/* 底部：存储位置——原头部右侧的元信息搬到这里，弱化成一行可复制的小字 */}
      {boot ? (
        <div className="sb-foot">
          <Tooltip title={`存储目录：${boot.storePathRaw}`} placement="top">
            <span className="sb-store nowrap">
              <Copyable className="mono" text={boot.storePathRaw}>{boot.storePath}</Copyable>
            </span>
          </Tooltip>
        </div>
      ) : null}

      {/* 右缘拖拽线：拖动改宽（松手落 localStorage），双击恢复默认宽度 */}
      <div
        className={`sb-resizer${dragSb ? ' active' : ''}`}
        title="拖动调整侧栏宽度（双击恢复默认）"
        onMouseDown={(e) => { e.preventDefault(); setDragSb(true); }}
        onDoubleClick={resetSbW}
      />
    </aside>
  );
}

/** 一组检索结果（空组整组不渲染——三个分组是语义，不是占位）。 */
function ResultGroup({ title, items, onOpen }: {
  title: string;
  items: ResourceHit[];
  onOpen: (r: ResourceHit) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="sb-result-group">
      <div className="sb-result-title">{title}</div>
      {items.slice(0, 40).map((r) => (
        <button
          type="button"
          key={`${r.kind}:${r.locator}`}
          className="sb-result-row"
          title={`${r.locator}\n${r.subtitle}`}
          onClick={() => onOpen(r)}
        >
          {r.kind === 'field'
            ? <ProfileOutlined className="sb-icon" />
            : <FileTextOutlined className="sb-icon sb-icon-leaf" />}
          <span className="sb-label nowrap">{r.title}</span>
          <span className="sb-result-sub nowrap">{r.subtitle}</span>
        </button>
      ))}
      {items.length > 40 ? <div className="hint pad">…另有 {items.length - 40} 项</div> : null}
    </div>
  );
}
