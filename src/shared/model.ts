// 前后端**共用的数据形状**：栏目 / 条目 / 设置 / bootstrap / 附件台账。
//
// 这里是唯一声明点：后端 `core/store.ts` 直接引用（不再自己写第二份），
// 面板从 `shared/model.ts` 取类型。加字段只改这一处，两边同时受编译期约束。
//
// 与 `shared/fields/types.ts` 一样必须保持**零运行时依赖**（只有类型），
// 否则面板会被拖进 fs / crypto。
import type { FieldDef, FieldType } from './fields/types.ts';

/** 栏目分组声明（头部导航的一个分组）。 */
export interface SectionGroup {
  id: string;
  title: string;
}

/** 栏目（字段字典 + 版式）。 */
export interface Section {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  kv: boolean;
  titleField: string | null;
  titleLabel: string;
  groups: SectionGroup[];
  fields: FieldDef[];
  // 播种/新建的草稿在 normalize 之前可能没有 layout；读路径一律过 sanitizeLayout
  layout?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 条目。 */
export interface Entry {
  id: string;
  section: string;
  title: string;
  tags: string[];
  values: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 条目读出去的形状（`core/render.ts` 的唯一序列化出口，面板与 CLI 共用）。 */
export interface SerializedEntry {
  id: string;
  section: string;
  title: string;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  completeness: { filled: number; total: number; ratio: number; excluded: number; excludedFilled: number };
  missing: Array<{ key: string; label: string }>;
  excluded: Array<{ key: string; label: string; fill: unknown; fillLabel: unknown }>;
  values: Record<string, unknown>;
  /** v3：条目自身的字段定义（结构行优先，回退栏目字典）——面板块渲染的唯一依据。 */
  entryFields?: FieldDef[];
  /** 任务 #20：从本条目脱离（meta.detached）的模板字段清单——面板管理条与 restore 入口的依据。 */
  detachedFields?: Array<{ key: string; label: string }>;
  [key: string]: unknown;
}

/** 头部导航分组配置（`settings.navGroups`）。 */
export interface NavGroup {
  title: string;
  sections: string[];
}

/** 设置（`store.settings`，也是 `/api/bootstrap` 下发的 settings）。 */
export interface Settings {
  defaultSection: string;
  navGroups: NavGroup[];
  /** 入口不显示的栏目 id（`#/栏目` 直达仍可用）。 */
  navHidden?: string[];
  /** 平铺区的显示顺序；没列进去的按栏目自身 order 跟在后面。 */
  navOrder?: string[];
  kvSection?: unknown;
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

/** bootstrap 里每个栏目的摘要（字段数、条目数，不是完整栏目）。 */
export interface BootSection {
  id: string;
  title: string;
  description: string;
  order: number;
  template: string | null;
  kv: boolean;
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
  sections: BootSection[];
  counts: { sections: number; entries: number; commands: number };
  vault?: {
    source?: string;
    keyFile?: string;
    saltFile?: string;
    note?: string;
    [k: string]: unknown;
  } | null;
  templates?: unknown;
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
