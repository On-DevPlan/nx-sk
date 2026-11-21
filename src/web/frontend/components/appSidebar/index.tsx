// 左侧导航树（0.43）：条目树，不再有模板容器层。
//
// 设计口径（Lion 式目录）：
//   - 左侧只有一个层级：条目。有子条目 → 文件夹图标 + 展开三角；没有 → 文档图标。
//   - 文件夹自身也是条目，点它就是打开它自己的内容，不是「只当容器」。
//   - 条目模板不出现在导航里；条目模板只决定条目初始字段，选中条目时由详情页自己显示。
//   - 树来自 bootstrap.tree（扁平节点按 parent/sort 深度优先），不再懒加载条目。
//
// 保留的基础设施：右缘拖拽改宽、右键菜单、底部工具页、全局资源搜索。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, DragEvent as ReactDragEvent, Key, ReactNode } from 'react';
import { Dropdown, Tree, Input, Tooltip } from 'antd';
import type { MenuProps, TreeProps } from 'antd';
import {
  AppstoreOutlined, ExportOutlined, FileTextOutlined, FolderOpenOutlined,
  ImportOutlined, PaperClipOutlined, ProfileOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons';
import { Copyable } from '../ui/index.tsx';
import { useStore } from '../../store.tsx';
import { api } from '../../api/client.ts';
import { copyText, entryRefText } from '../../util/entryRef.ts';
import type { Boot } from '../../../../shared/model.ts';
import type { TreeNode } from '../../../../shared/tree.ts';

type DataNode = NonNullable<TreeProps['treeData']>[number];

/** 静态工具页（附件 / 导出导入 / 设置）。component 仅供 App 渲染，侧栏不读。 */
export interface NavViewItem {
  id: string;
  title: string;
  order?: number;
  kind: 'view';
  component?: unknown;
}

export interface SidebarNav {
  tools: NavViewItem[];
  all: Array<{ id: string; title: string; kind: 'template' | 'view'; [k: string]: unknown }>;
}

interface ResourceHit {
  locator: string;
  kind: string;
  title: string;
  subtitle: string;
  templateId?: string;
  entryId?: string;
  key?: string;
}

/** 条目节点 key：条目模板只用于路由（`#/<条目模板>?entry=<id>`），不参与层级。 */
export const entryKey = (templateId: string, entryId: string) => `e:${templateId}:${entryId}`;

const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  templates: AppstoreOutlined,
  files: PaperClipOutlined,
  export: ExportOutlined,
  settings: SettingOutlined,
  'export-import': ImportOutlined,
};

const SB_W_KEY = 'nx-sk-sidebar-w';
const SB_EXP_KEY = 'nx-sk-sidebar-expanded';
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

function loadExpanded(): Key[] {
  try {
    const raw = localStorage.getItem(SB_EXP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

const entryHash = (templateId: string, entryId: string) =>
  `#/${encodeURIComponent(templateId)}?entry=${encodeURIComponent(entryId)}`;
const fullUrl = (hash: string) => `${window.location.origin}${window.location.pathname}${hash}`;

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
  tree: TreeNode[];
  onGo: (id: string) => void;
  onOpenEntry: (templateId: string, entryId: string, focus?: string) => void;
  /** 在某个条目下新建子条目；parent=null 表示根。模板在创建弹窗里显式选择。 */
  onAddEntry: (parent: string | null) => void;
  /** 拖动条目：parent 为目标父级；before/after 是插到某个兄弟前/后（二选一）。 */
  onMoveEntry: (id: string, parent: string | null, before?: string, after?: string) => Promise<void>;
}

export default function AppSidebar({
  boot, nav, currentId, entryId, tree, onGo, onOpenEntry, onAddEntry, onMoveEntry,
}: AppSidebarProps) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Key[]>(loadExpanded);
  const { toast } = useStore();

  // —— 右缘拖拽改宽 ——
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

  useEffect(() => {
    try { localStorage.setItem(SB_EXP_KEY, JSON.stringify(expanded.map(String))); } catch { /* 隐私模式 */ }
  }, [expanded]);

  const toggleExpand = useCallback((key: Key) => {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  // 首次加载 / 数据刷新：默认展开所有有子条目的节点（Lion 的「目录一眼看到层级」）。
  useEffect(() => {
    if (!tree.length) return;
    setExpanded((prev) => {
      if (prev.length) return prev;
      return tree.filter((n) => n.hasChildren).map((n) => entryKey(n.template || '', n.id));
    });
  }, [tree]);

  const needle = q.trim().toLowerCase();

  // —— 全局资源检索：保留原能力（字段 / 条目）——
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
      && !!entryId && r.templateId === currentId && (!r.entryId || r.entryId === entryId);
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
      onOpenEntry(r.templateId || '', r.entryId || entryId || '', r.key);
    } else if (r.kind === 'entry') {
      onOpenEntry(r.templateId || '', r.entryId || '');
    } else if (r.kind === 'template') {
      onGo(r.templateId || '');
    }
  }, [onGo, onOpenEntry, entryId]);

  // 节点 key 解析：e:<条目模板>:<entry>
  const parseKey = useCallback((key: string): { template: string; id: string } | null => {
    if (!key.startsWith('e:')) return null;
    const rest = key.slice(2);
    const cut = rest.indexOf(':');
    if (cut < 0) return null;
    return { template: rest.slice(0, cut), id: rest.slice(cut + 1) };
  }, []);

  /** 目标是不是自己的后代：拖拽落点必须排除，否则后端成环检查会拒绝。 */
  const isDescendant = useCallback((id: string, ancestor: string): boolean => {
    let cur = tree.find((n) => n.id === id);
    const seen = new Set<string>();
    while (cur?.parent && !seen.has(cur.parent)) {
      if (cur.parent === ancestor) return true;
      seen.add(cur.parent);
      cur = tree.find((n) => n.id === cur!.parent);
    }
    return false;
  }, [tree]);

  const nodeDraggable = useCallback((node: DataNode) => {
    if (needle) return false;
    return !!parseKey(String(node.key));
  }, [needle, parseKey]);

  // —— Notion 式拖拽：自己接管 drag 事件，不靠 antd 的 dropToGap ——
  // rc-tree 只有「拖到左边空白」才算放进节点，垂直中线永远算 after；这和 Notion 的
  // 「落在行中央 = 收成子条目」不一致。这里在捕获阶段算行内三分区，先一步拦掉 antd。
  const dragFrom = useRef<string | null>(null);
  const dropPainted = useRef<{ node: HTMLElement; cls: string } | null>(null);

  const clearDropPaint = useCallback(() => {
    if (dropPainted.current) dropPainted.current.node.classList.remove(dropPainted.current.cls);
    dropPainted.current = null;
  }, []);

  const dropZoneOf = useCallback((row: HTMLElement, clientY: number): 'before' | 'inside' | 'after' => {
    const rect = row.getBoundingClientRect();
    const ratio = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    if (ratio < 0.3) return 'before';
    if (ratio > 0.7) return 'after';
    return 'inside';
  }, []);

  const searchRow = useCallback((target: EventTarget | null): { row: HTMLElement; node: HTMLElement; id: string; template: string } | null => {
    const el = target as HTMLElement | null;
    // dragstart 的 target 是整个 .ant-tree-treenode（行是它的后代），dragover/drop 的 target 才常是 .sb-row
    const row = (el?.closest?.('.sb-row') || el?.querySelector?.('.sb-row')) as HTMLElement | null;
    const node = row?.closest?.('.ant-tree-treenode') as HTMLElement | null;
    if (!row || !node) return null;
    const id = row.dataset.entryId || '';
    return id ? { row, node, id, template: row.dataset.templateId || '' } : null;
  }, []);

  const handleDragStartCapture = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    const hit = searchRow(e.target);
    dragFrom.current = hit?.id || null;
    clearDropPaint();
  }, [searchRow, clearDropPaint]);

  const handleDragOverCapture = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    const hit = searchRow(e.target);
    if (!from || !hit || hit.id === from || isDescendant(hit.id, from)) {
      clearDropPaint();
      return;
    }
    const zone = dropZoneOf(hit.row, e.clientY);
    const cls = `notion-drop-${zone}`;
    if (dropPainted.current?.node !== hit.node || dropPainted.current.cls !== cls) {
      clearDropPaint();
      hit.node.classList.add(cls);
      dropPainted.current = { node: hit.node, cls };
    }
    // 必须在 capture 里吃掉，否则 rc-tree 会按自己的 dropToGap 再画一套落点
    e.preventDefault();
    e.stopPropagation();
  }, [searchRow, isDescendant, dropZoneOf, clearDropPaint]);

  const handleDropCapture = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    const hit = searchRow(e.target);
    clearDropPaint();
    dragFrom.current = null;
    if (!from || !hit || hit.id === from || isDescendant(hit.id, from)) return;
    const zone = dropZoneOf(hit.row, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    if (zone === 'inside') {
      const key = entryKey(hit.template, hit.id);
      setExpanded((prev) => (prev.includes(key) ? prev : [...prev, key]));
      void onMoveEntry(from, hit.id).catch((err) => toast((err as Error)?.message || String(err), 'bad'));
      return;
    }
    const target = tree.find((n) => n.id === hit.id);
    const parent = target?.parent ?? null;
    const before = zone === 'before' ? hit.id : undefined;
    const after = zone === 'after' ? hit.id : undefined;
    void onMoveEntry(from, parent, before, after).catch((err) => toast((err as Error)?.message || String(err), 'bad'));
  }, [searchRow, isDescendant, dropZoneOf, clearDropPaint, tree, onMoveEntry, toast]);

  const handleDragEndCapture = useCallback(() => {
    dragFrom.current = null;
    clearDropPaint();
  }, [clearDropPaint]);

  const nodeMenu = useCallback((n: TreeNode): MenuProps['items'] => [
    { key: 'open', label: '打开条目', onClick: () => onOpenEntry(n.template || '', n.id) },
    { key: 'tab', label: '新标签页打开', onClick: () => window.open(entryHash(n.template || '', n.id), '_blank') },
    {
      key: 'copy',
      label: '复制条目链接',
      onClick: async () => {
        await copyText(fullUrl(entryHash(n.template || '', n.id)));
        toast(`已复制条目链接：${n.title}`);
      },
    },
    {
      key: 'cli',
      label: '复制条目定位（CLI）',
      onClick: async () => {
        await copyText(entryRefText({ id: n.id, title: n.title }));
        toast(`已复制：${n.title}`);
      },
    },
    {
      key: 'child',
      label: '在此新建子条目（默认空白）',
      onClick: () => onAddEntry(n.id),
    },
    ...(n.hasChildren ? [{
      key: 'toggle',
      label: '展开 / 折叠',
      onClick: () => toggleExpand(entryKey(n.template || '', n.id)),
    }] : []),
  ], [onOpenEntry, onAddEntry, toast, toggleExpand]);

  const treeData = useMemo<DataNode[]>(() => {
    const children = new Map<string | null, TreeNode[]>();
    for (const n of tree) {
      const p = n.parent && tree.some((x) => x.id === n.parent) ? n.parent : null;
      const list = children.get(p) || [];
      list.push(n);
      children.set(p, list);
    }
    for (const list of children.values()) list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));

    const matches = (n: TreeNode) => {
      if (!needle) return true;
      return [n.title, n.templateTitle, ...(n.tags || [])].some((x) => String(x || '').toLowerCase().includes(needle));
    };
    // 搜索：命中节点 + 祖先保留；整支没命中就剪掉
    const keep = new Set<string>();
    if (needle) {
      const markAncestors = (id: string) => {
        let cur = tree.find((x) => x.id === id);
        while (cur?.parent) {
          keep.add(cur.parent);
          cur = tree.find((x) => x.id === cur!.parent);
        }
      };
      for (const n of tree) if (matches(n)) { keep.add(n.id); markAncestors(n.id); }
    }

    const build = (parent: string | null): DataNode[] => (children.get(parent) || [])
      .filter((n) => !needle || keep.has(n.id))
      .map((n) => {
        const visibleKids = build(n.id);
        const label = (
          <span
            className="sb-row"
            data-entry-id={n.id}
            data-template-id={n.template || ''}
            title={`${n.title}${n.templateTitle ? ` · ${n.templateTitle}` : ''}`}
          >
            {n.hasChildren
              ? <FolderOpenOutlined className="sb-icon" />
              : <FileTextOutlined className="sb-icon sb-icon-leaf" />}
            <span className="sb-label nowrap">{n.title || '（无标题）'}</span>
            {typeof n.childCount === 'number' && n.childCount > 0 ? <span className="count">{n.childCount}</span> : null}
            <button
              type="button"
              className="sb-add"
              title={`在「${n.title}」下新建子条目（默认空白）`}
              aria-label={`在「${n.title}」下新建子条目`}
              onClick={(e) => { e.stopPropagation(); onAddEntry(n.id); }}
            >＋</button>
          </span>
        );
        return {
          key: entryKey(n.template || '', n.id),
          isLeaf: visibleKids.length === 0,
          children: visibleKids.length ? visibleKids : undefined,
          title: withCtx(nodeMenu(n), label),
        } as DataNode;
      });

    return build(null);
  }, [tree, needle, nodeMenu, onAddEntry]);

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

  const visibleTools = useMemo(() => {
    if (!needle) return nav.tools;
    return nav.tools.filter((t) => t.title.toLowerCase().includes(needle));
  }, [nav.tools, needle]);

  const selectedKeys = useMemo(() => {
    if (entryId) return [entryKey(currentId, entryId)];
    return [];
  }, [entryId, currentId]);

  const onSelect = useCallback((keys: Key[], info: { node: DataNode }) => {
    const parsed = parseKey(String(info.node.key));
    if (!parsed) return;
    // 再点已选节点也要重新打开（antd 会清空 keys，这里不受影响）
    onOpenEntry(parsed.template, parsed.id);
    void keys;
  }, [onOpenEntry, parseKey]);

  return (
    <aside className="sb" ref={asideRef} style={{ width: sbW }}>
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
          placeholder="搜索条目 / 字段"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="sb-new">
        <button
          type="button"
          className="btn small ghost sb-new-btn"
          onClick={() => onAddEntry(null)}
          title="在根目录新建条目（模板可在弹窗里选择）"
        >
          ＋ 新建条目
        </button>
      </div>

      {needle ? (
        <div className="sb-results" data-testid="sb-results">
          {hitsBusy && !hits.length ? <div className="hint pad">检索中…</div> : null}
          {!hitsBusy && !hits.length ? <div className="hint pad">没有命中的字段 / 条目</div> : null}
          <ResultGroup title="当前条目字段" items={hitGroups.ownFields} onOpen={openHit} />
          <ResultGroup title="全局字段" items={hitGroups.globalFields} onOpen={openHit} />
          <ResultGroup title="条目" items={hitGroups.entryHits} onOpen={openHit} />
        </div>
      ) : null}

      <div
        className="sb-tree"
        onDragStartCapture={handleDragStartCapture}
        onDragOverCapture={handleDragOverCapture}
        onDropCapture={handleDropCapture}
        onDragEndCapture={handleDragEndCapture}
      >
        {treeData.length ? (
          <Tree
            blockNode
            draggable={{ icon: false, nodeDraggable }}
            treeData={treeData}
            selectedKeys={selectedKeys}
            expandedKeys={searchExpanded ?? expanded}
            onExpand={(keys) => { if (!searchExpanded) setExpanded(keys); }}
            onSelect={onSelect}
          />
        ) : (
          <div className="hint pad">还没有条目</div>
        )}
      </div>

      {visibleTools.length ? (
        <nav className="sb-tools" aria-label="工具">
          {visibleTools.map((t) => (
            <div key={t.id}>
              {withCtx(viewMenu(t, onGo, toast), (
                <button
                  type="button"
                  className={`sb-tool${currentId === t.id ? ' on' : ''}`}
                  title={t.title}
                  onClick={() => onGo(t.id)}
                >
                  {toolIcon(t.id)}
                  <span className="sb-label nowrap">{t.title}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      ) : null}

      {boot ? (
        <div className="sb-foot">
          <Tooltip title={`存储目录：${boot.storePathRaw}`} placement="top">
            <span className="sb-store nowrap">
              <Copyable className="mono" text={boot.storePathRaw}>{boot.storePath}</Copyable>
            </span>
          </Tooltip>
        </div>
      ) : null}

      <div
        className={`sb-resizer${dragSb ? ' active' : ''}`}
        title="拖动调整侧栏宽度（双击恢复默认）"
        onMouseDown={(e) => { e.preventDefault(); setDragSb(true); }}
        onDoubleClick={resetSbW}
      />
    </aside>
  );
}

const toolIcon = (id: string) => {
  const Icon = TOOL_ICONS[id] || AppstoreOutlined;
  return <Icon className="sb-icon" />;
};

const viewMenu = (
  t: NavViewItem,
  onGo: (id: string) => void,
  toast: (msg: string, kind?: 'ok' | 'bad') => void,
): MenuProps['items'] => [
  { key: 'open', label: '打开', onClick: () => onGo(t.id) },
  { key: 'tab', label: '新标签页打开', onClick: () => window.open(`#/${encodeURIComponent(t.id)}`, '_blank') },
  {
    key: 'copy',
    label: '复制页面链接',
    onClick: async () => {
      await copyText(fullUrl(`#/${encodeURIComponent(t.id)}`));
      toast(`已复制页面链接：${t.title}`);
    },
  },
];

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
