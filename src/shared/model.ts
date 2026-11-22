// 前后端**共用的数据形状**：条目模板 / 条目 / 设置 / bootstrap / 附件台账。
//
// 这里是唯一声明点：后端 `core/store.ts` 直接引用（不再自己写第二份），
// 面板从 `shared/model.ts` 取类型。加字段只改这一处，两边同时受编译期约束。
//
// 与 `shared/fields/types.ts` 一样必须保持**零运行时依赖**（只有类型），
// 否则面板会被拖进 fs / crypto。
import type { FieldDef, FieldType } from './fields/types.ts';
import type { TreeNode } from './tree.ts';

/**
 * 条目模板里的「组声明」**只存在于代码常量**（field template 的作者态）：
 * 模板是新建条目模板的说明书，落进 store 时已经被 instantiateTemplate 折成
 * type='group' 的字段（见 core/fields/templates.ts）。存储里没有这个形状。
 */
export interface TemplateGroup {
  id: string;
  title: string;
}

/** 条目模板：字段字典 + 版式；只负责条目创建时的初始化，不拥有条目。 */
export interface Template {
  id: string;
  title: string;
  description: string;
  order: number;
  /** 创建时用的内置预置 id（job / secret / …）；自定义模板为 null。 */
  template: string | null;
  /** 模板默认标签：从本模板新建条目时自动带进 entries.tags；可按 tag 检索。 */
  tags: string[];
  /** 内部空白模板：folder / 无模板条目使用；不补「原始资料」字段。 */
  blank?: boolean;
  titleField: string | null;
  titleLabel: string;
  // 0.42：模板不再有 `groups[]`——「组」是 fields 里 type='group' 的一条字段，
  // 用 `keys` 引用同模板其他字段。层级只有这一份结构，见 shared/fields/structure.ts。
  fields: FieldDef[];
  // 播种/新建的草稿在 normalize 之前可能没有 layout；读路径一律过 sanitizeLayout
  layout?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 条目。 */
export interface Entry {
  id: string;
  /** 创建时用过的模板 id；不参与导航、不参与级联删除。 */
  template: string;
  title: string;
  /** v10：一句话说明——给 agent / 人认条目用，不是字段值，不参与完整度。 */
  desc: string;
  tags: string[];
  values: Record<string, unknown>;
  /** folders 表：父条目；根节点为 null。 */
  parent?: string | null;
  /** 同级排序（folders.sort）。 */
  sort?: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 条目读出去的形状（`core/render.ts` 的唯一序列化出口，面板与 CLI 共用）。 */
export interface SerializedEntry {
  id: string;
  template: string;
  title: string;
  /** v10：一句话说明（旧数据/未设置时为空串）。 */
  desc?: string;
  tags: string[];
  parent?: string | null;
  sort?: number;
  createdAt: string | null;
  updatedAt: string | null;
  completeness: { filled: number; total: number; ratio: number; excluded: number; excludedFilled: number };
  missing: Array<{ key: string; label: string }>;
  excluded: Array<{ key: string; label: string; fill: unknown; fillLabel: unknown }>;
  values: Record<string, unknown>;
  /** v3：条目自身的字段定义（结构行优先，回退模板字典）——面板块渲染的唯一依据。 */
  entryFields?: FieldDef[];
  /** 任务 #20：从本条目脱离（meta.detached）的模板字段清单——面板管理条与 restore 入口的依据。 */
  detachedFields?: Array<{ key: string; label: string }>;
  [key: string]: unknown;
}

/** 头部导航分组配置（`settings.navGroups`）。 */
export interface NavGroup {
  title: string;
  templates: string[];
}

/** 设置（`store.settings`，也是 `/api/bootstrap` 下发的 settings）。 */
export interface Settings {
  defaultTemplate: string;
  /** 任务 #63：默认条目 id（空 = 未设）。CLI 省略 <ref> 时作用在它上面。 */
  defaultEntry?: string;
  /** 任务 #63：`status` 一次最多带多少条条目（默认条目 + 子条目，默认 5，上限 50）。 */
  entryScopeLimit?: number;
  navGroups: NavGroup[];
  /** 任务 #26：编辑字段后防抖自动保存（默认关；关 = 只走手动保存，行为与之前一致）。 */
  autoSaveFields?: boolean;
  /** 任务 #27：字段历史的保留方式——count=每个字段只留最近 N 版；time=只留最近 N 天。 */
  historyMode?: 'count' | 'time';
  /** 按条数保留时每个字段最多留多少版（默认 50）。 */
  historyCount?: number;
  /** 按时间保留时留最近多少天（默认 90）。 */
  historyDays?: number;
  /** 入口不显示的条目模板 id。 */
  navHidden?: string[];
  /** 平铺区的显示顺序；没列进去的按条目模板自身 order 跟在后面。 */
  navOrder?: string[];
}

/** 附件台账记录（`store.files` 与 `/api/files` 的条目）。 */
export interface Attachment {
  id: string;
  category: string;
  name: string;
  rel: string;
  originalName?: string;
  ext: string;
  bytes: number;
  sha256: string;
  sourcePath?: string;
  mode: string;
  tags: string[];
  note?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  [k: string]: unknown;
}

/** bootstrap 里每个条目模板的摘要（字段数、条目数，不是完整模板）。 */
export interface BootTemplate {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  blank?: boolean;
  titleLabel: string;
  fields: number;
  entries: number;
}


/** bootstrap 里的命令条目（面板的命令清单只展示 module / id / usage 等）。 */
export interface BootCommand {
  id: string;
  module: string;
  usage?: string;
  hint?: string;
  /** 面板提示里展示的可复制命令行。 */
  command?: string;
  cli?: string[];
  http?: string;
  [k: string]: unknown;
}

/** `/api/bootstrap` 的响应。 */
export interface Boot {
  app: {
    name: string;
    label: string;
    version: string;
    node: string;
    platform: string;
  };
  home: string;
  storePath: string;
  storePathRaw: string;
  envOverrides: Record<string, string | null>;
  settings: Settings;
  templates: BootTemplate[];
  /** 0.43：左侧目录树（条目父子关系）。 */
  tree?: TreeNode[];
  counts: { templates: number; entries: number; commands: number };
  vault?: {
    source?: string;
    keyFile?: string;
    saltFile?: string;
    note?: string;
    [k: string]: unknown;
  } | null;
  presets?: Array<{ id: string; label: string; description: string; groups: number; fields: number }>;
  fieldTypes: FieldType[];
  fieldTypeLabels: Record<FieldType, string>;
  builtin: { group: string; field: string };
  corrupt?: { to?: string; [k: string]: unknown } | null;
  migration?: {
    from?: number;
    to?: number;
    fieldsBefore?: number;
    fieldsAfter?: number;
    entries?: number;
    snapshot?: string;
    snapshotRaw?: string;
    legacyValuesKept?: number;
    [k: string]: unknown;
  } | null;
  commands: BootCommand[];
}

/** 面板只持久化的「选择」（见 store.tsx 的 DEFAULT_UI）。 */
export interface UiState {
  view: string;
  entry: string;
  q: string;
  mask: boolean;
  [k: string]: unknown;
}

