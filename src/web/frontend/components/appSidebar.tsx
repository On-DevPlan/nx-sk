// 左侧导航树（Notion 式）：分组 › 栏目 › 条目，整体可收起（收起由 App 控制）。
//
// 为什么用 antd Tree：目录树要「生产级」的手感——键盘导航、展开态、选中态、
// 大栏目虚拟滚动、懒加载子节点。自研这些细节成本高且容易粗糙，antd 是成熟开源实现；
// 本文件只负责**数据编排**（栏目/条目/工具三层数据怎么喂给树）与**单色主题**。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, Dispatch, Key, SetStateAction } from 'react';
import { Tree, Input, Tooltip } from 'antd';
import type { TreeProps } from 'antd';
import {
  AppstoreOutlined, DatabaseOutlined, ExportOutlined, FileTextOutlined,
  FolderOutlined, ImportOutlined, PaperClipOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons';
import { Copyable } from './ui.tsx';
import { api } from '../api/client.ts';
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

interface AppSidebarProps {
  boot: Boot | null;
  nav: SidebarNav;
  currentId: string;
  entryId: string;
  entryMap: Record<string, EntryLite[]>;
  setEntryMap: Dispatch<SetStateAction<Record<string, EntryLite[]>>>;
  onGo: (id: string) => void;
  onOpenEntry: (sectionId: string, entryId: string) => void;
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

  // 搜索过滤：栏目标题或（已加载的）条目标题命中就保留；命中的分支全展开。
  // 未加载条目的栏目只按栏目名搜——懒加载的数据不该在搜索时被整库拉一遍。
  const needle = q.trim().toLowerCase();

  const treeData = useMemo<DataNode[]>(() => {
    const hit = (s: string) => !!needle && s.toLowerCase().includes(needle);
    const entryNode = (sid: string, e: EntryLite): DataNode => ({
      key: entryKey(sid, e.id),
      isLeaf: true,
      title: (
        <span className="sb-row" title={e.title}>
          <FileTextOutlined className="sb-icon sb-icon-leaf" />
          <span className="sb-label nowrap">{e.title || '（无标题）'}</span>
        </span>
      ),
    });

    const sectionNode = (s: NavSectionItem): DataNode => {
      const entries = entryMap[s.id];
      const count = typeof s.count === 'number' ? s.count : undefined;
      return {
        key: s.id,
        // 还没加载过子节点的栏目交给 loadData；已知 0 条的栏目就是叶子
        isLeaf: entries ? entries.length === 0 : count === 0,
        children: entries ? entries.map((e) => entryNode(s.id, e)) : undefined,
        title: (
          <span className="sb-row" title={s.title}>
            <DatabaseOutlined className="sb-icon" />
            <span className="sb-label nowrap">{s.title}</span>
            {typeof count === 'number' ? <span className="count">{count}</span> : null}
          </span>
        ),
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
        title: (
          <span className="sb-row">
            <FolderOutlined className="sb-icon" />
            <span className="sb-label nowrap">{g.title}</span>
            <span className="count">{kept.length}</span>
          </span>
        ),
      } as DataNode;
    }).filter(Boolean) as DataNode[];

    const flatNodes = nav.flat
      .filter((s) => !needle || hit(s.title) || (entryMap[s.id] || []).some((e) => hit(e.title)))
      .map(sectionNode);

    const toolNodes: DataNode[] = nav.tools.map((t) => ({
      key: `v:${t.id}`,
      isLeaf: true,
      title: (
        <span className="sb-row" title={t.title}>
          {toolIcon(t.id)}
          <span className="sb-label nowrap">{t.title}</span>
        </span>
      ),
    }));

    return [...groupNodes, ...flatNodes, ...toolNodes];
  }, [nav, entryMap, needle, toolIcon]);

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
    <aside className="sb">
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
          placeholder="搜索栏目 / 条目"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

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
    </aside>
  );
}
