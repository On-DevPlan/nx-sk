// 三态面板的「窗口外壳」：用 flexlayout-react 提供可拖拽分栏与三态几何。
//
// 为什么引入外部库（#12 第 3 轮验收）：自研的绝对定位 + CSS 分栏没有拽线，
// 用户对自研框架丧失信任。这里把**外壳**交给 flexlayout-react：
//   - side     铺满视口，左侧留一条透明「鬼影」栏、右侧是面板，中间是可拖拽 splitter；
//              shell 本身 pointer-events:none，只有面板与 splitter 接收指针事件，
//              所以左边条目仍然能点、能滚（保持 Notion side peek 的「不遮不挡」）。
//   - center   屏幕居中的固定框，flexlayout 单栏铺满框内（框的尺寸随视口响应）。
//   - fullpage 铺满视口，flexlayout 单栏铺满。
//
// 拖拽后的分栏宽度写进 localStorage（键按面板类型隔离），下次打开沿用。
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Layout, Model } from 'flexlayout-react';
import type { IJsonModel, TabNode } from 'flexlayout-react';

const LAYOUT_PREFIX = 'nx-sk-peek-layout:';

function layoutKey(persistKey?: string) {
  return persistKey ? `${LAYOUT_PREFIX}${persistKey}` : '';
}

function readJson(key: string): IJsonModel | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as IJsonModel) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, model: Model) {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(model.toJson()));
  } catch {
    /* 隐私模式 / 配额满：分栏宽度不持久化，但本次拖拽仍然生效 */
  }
}

const GLOBAL_OPTS = {
  splitterSize: 8,
  splitterExtra: 6,
  tabEnableClose: false,
  tabEnableRename: false,
  tabEnableFloat: false,
  tabSetEnableMaximize: false,
  tabSetEnableDrop: false,
  tabSetEnableTabStrip: false,
  tabSetEnableDivide: false,
  tabSetEnableDeleteWhenEmpty: false,
  enableEdgeDock: false,
};

function sideJson(): IJsonModel {
  // 窄屏下列宽按权重走会只剩一条缝，默认直接把面板放成 86vw（旧 CSS 是 94vw）；
  // 宽屏保持 38% ≈ 500~560px，和原 side peek 的观感一致。
  const narrow = typeof window !== 'undefined' && window.innerWidth < 900;
  const panelWeight = narrow ? 86 : 38;
  const ghostWeight = 100 - panelWeight;
  return {
    global: GLOBAL_OPTS,
    borders: [],
    layout: {
      type: 'row',
      id: '#root',
      weight: 100,
      children: [
        {
          type: 'tabset',
          id: '#ghost',
          weight: ghostWeight,
          enableTabStrip: false,
          children: [{ type: 'tab', id: '#ghost-tab', name: '', component: 'ghost', enableClose: false }],
        },
        { type: 'splitter', id: '#split' },
        {
          type: 'tabset',
          id: '#panel',
          weight: panelWeight,
          enableTabStrip: false,
          children: [{ type: 'tab', id: '#panel-tab', name: '', component: 'panel', enableClose: false }],
        },
      ],
    },
  };
}

function singleJson(): IJsonModel {
  return {
    global: GLOBAL_OPTS,
    borders: [],
    layout: {
      type: 'row',
      id: '#root',
      weight: 100,
      children: [
        {
          type: 'tabset',
          id: '#panel',
          weight: 100,
          enableTabStrip: false,
          children: [{ type: 'tab', id: '#panel-tab', name: '', component: 'panel', enableClose: false }],
        },
      ],
    },
  };
}

function makeModel(mode: 'side' | 'center' | 'fullpage', persistKey?: string): Model {
  if (mode === 'side') {
    const saved = readJson(layoutKey(persistKey));
    if (saved) {
      try {
        const model = Model.fromJson(saved);
        // 旧存档若缺 ghost/panel（早期结构），退回默认，避免半边空窗。
        // 注意：flexlayout 序列化时会丢掉 splitter 节点（它由相邻 tabset 隐式生成），
        // 所以这里不能按 '#split' 判断存在性。
        if (model.getNodeById('#ghost') && model.getNodeById('#panel')) return model;
      } catch {
        /* 存档坏了就按默认 */
      }
    }
  }
  return Model.fromJson(mode === 'side' ? sideJson() : singleJson());
}

export interface FlexPeekShellProps {
  mode: 'side' | 'center' | 'fullpage';
  /** 分栏宽度持久化键（source / shortcut）；不给则只在本此打开内有效。 */
  persistKey?: string;
  children: ReactNode;
}

export function FlexPeekShell({ mode, persistKey, children }: FlexPeekShellProps) {
  const keyRef = useRef(layoutKey(persistKey));
  const modelRef = useRef<Model | null>(null);
  if (!modelRef.current) modelRef.current = makeModel(mode, persistKey);
  // 形态切换时重建模型（side 有分栏、center/fullpage 单栏）
  const modeRef = useRef(mode);
  if (modeRef.current !== mode) {
    modeRef.current = mode;
    modelRef.current = makeModel(mode, persistKey);
  }

  const factory = (node: TabNode) => {
    if (node.getComponent() === 'ghost') return <div className="nx-flexpeek-ghost" aria-hidden />;
    return <div className="nx-flexpeek-panelwrap">{children}</div>;
  };

  return (
    <div className={`nx-flexpeek nx-flexpeek-${mode}`}>
      <div className="nx-flexpeek-frame">
        <Layout
          model={modelRef.current}
          factory={factory}
          onModelChange={(model) => {
            if (mode === 'side') writeJson(keyRef.current, model);
            return undefined;
          }}
        />
      </div>
    </div>
  );
}
