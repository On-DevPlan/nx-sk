// 字段类型的**唯一词汇表**。
//
// 这里是加一种字段类型时**必须**改的第一处；漏改其它地方由 tsc 兜住：
//   - 后端行为：`core/fields/registry.ts` 的 `FIELD_BEHAVIOR: Record<FieldType, FieldBehavior>`
//   - 面板控件：`components/fields/index.tsx` 的 `FIELD_CONTROLS: Record<FieldType, Control>`
//
// 本文件必须保持**零依赖**：浏览器会打包 `src/shared/**`（见 tsconfig.web.json），
// 一旦 import 了 fs/crypto，面板就构建不出来。所以这里只有类型与常量，
// 任何行为实现都放在 `core/fields/behaviors/`（服务端）与 `components/fields/`（面板）。

/** 字段类型清单。**顺序是可见行为的一部分**（bootstrap 原样下发，面板下拉框照此排序）。 */
export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'month', 'bool', 'select', 'tags',
  'entrylist', 'table', 'source', 'secret', 'file', 'md', 'shortcut', 'debug',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 类型的人读标签 —— 只用于**面板下拉框**。
 *
 * 下拉框此前直接渲染 `md` / `tags` 这种内部 id，选类型的人得先知道内部分类。
 * 这里给中文名，渲染成「图文（可贴图）（md）」：既看得懂，也不丢 id（排查时用得上）。
 */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  month: '月份',
  bool: '是/否',
  select: '单选',
  tags: '多值标签',
  entrylist: '结构清单（变长行）',
  table: '表格（勾选/下拉/计算）',
  source: '原始资料（乱入后整理）',
  shortcut: '快捷键（分组）',
  secret: '密文',
  file: '附件',
  md: '图文（可贴图）',
  debug: '资源引用（可检索）',
};

export type FillPolicy = 'normal' | 'optional' | 'avoid';

/** 结构清单（entrylist）的一列。 */
export interface SubFieldDef {
  key: string;
  label: string;
  sensitive?: boolean;
  hint?: string;
}

/** 表格列的定义形态（单元格类型见表 `TableCellType`）。 */
export interface TableColumnDef {
  key: string;
  label: string;
  type?: string;
  formula?: string;
  computed?: boolean;
  options?: string[];
  sensitive?: boolean;
  total?: string;
  width?: number | null;
  align?: string;
  precision?: number | null;
  unit?: string;
  hint?: string;
  default?: unknown;
}

export interface TableTotal {
  label: string;
  agg?: Record<string, string>;
  expr?: string;
  unit?: string;
  precision?: number | string;
}

/** 可作表格列的标量类型（顺序见 shared/table.js 的 TABLE_CELL_TYPES）。 */
export type TableCellType = 'text' | 'textarea' | 'number' | 'bool' | 'select' | 'date' | 'month' | 'tags';

/** 表格值：自描述文档。 */
export interface TableDoc {
  v?: number;
  columns?: TableColumnDef[];
  rows: Record<string, unknown>[];
  totals?: TableTotal[];
  summary?: boolean;
}

/** 原始资料袋里的一项。 */
export interface SourceItem {
  kind: 'text' | 'file' | 'url';
  name?: string;
  text?: string;
  fileId?: string;
  url?: string;
  id?: string;
  addedAt?: string;
  mapped?: string[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// shortcut（快捷键分组）
//
// 为什么不是「一串字符串」：快捷键是一条一条的**条目**，每条要带条件（什么时候生效）
// 和一句人话说明；分组是读者找东西的目录。结构：组(group) → 条目(shortcut) → 按键(combo)。
// `combo` 存的是 `KeyboardEvent.code`（物理键位），不是 `key`——`key` 会被布局/输入法改写。
// ---------------------------------------------------------------------------

/** 组合键里的一次按键。`code` 是 KeyboardEvent.code，`label` 是展示名（Ctrl / R）。 */
export interface ShortcutStroke {
  code: string;
  label: string;
  isModifier?: boolean;
}

/** 一条快捷键。 */
export interface ShortcutItem {
  id: string;
  combo: ShortcutStroke[];
  description: string;
  /** 生效条件（例如「在编辑器里」「全局」）；空表示全局。 */
  condition?: string;
  createdAt?: number;
}

/** 一组快捷键（面板左侧的目录项）。 */
export interface ShortcutGroup {
  id: string;
  name: string;
  shortcuts: ShortcutItem[];
  createdAt?: number;
  updatedAt?: number;
}

interface FieldDefBase {
  key: string;
  label: string;
  type: FieldType;
  group: string;
  hint?: string;
  sensitive?: boolean;
  fill?: FillPolicy;
  /** 读路径（core/render）按 fill 附加的人读标签；存储里不落这个键。 */
  fillLabel?: string;
  maxItems?: number;
  /** v3 模板默认值：sync 补行 / 新建条目时，该键没给值就落这个（JSON 语义值）。 */
  defaultValue?: unknown;
  /** 任务 #20：读路径按条目结构行附加的出身标记（true=模板行，false=扩展行）；存储里不落这个键。 */
  template?: boolean;
}

/** 标量 / 富内容字段：值是一个标量或字符串数组。 */
export interface ScalarFieldDef extends FieldDefBase {
  type: 'text' | 'textarea' | 'number' | 'date' | 'month' | 'bool' | 'select' | 'tags' | 'source' | 'shortcut' | 'secret' | 'file' | 'md';
  options?: string[];
  /** file 字段的附件类别提示（doc / image …）。 */
  kind?: string;
}

export interface EntryListFieldDef extends FieldDefBase {
  type: 'entrylist';
  fields: SubFieldDef[];
  maxRows?: number;
}

export interface TableFieldDef extends FieldDefBase {
  type: 'table';
  columns?: TableColumnDef[];
  totals?: TableTotal[];
  summary?: boolean;
  maxRows?: number;
}

/**
 * debug（资源引用）：值 = 内部资源定位符（locator）数组，见 shared/locator.ts。
 * 引用型字段——格子指向栏目/条目/字段/附件，悬浮可预览被引用内容。
 * 引用本身不敏感（sensitive=false），被引用的内容才可能敏感。
 */
export interface DebugFieldDef extends FieldDefBase {
  type: 'debug';
}

/** 引用字段的存储形状（自描述文档，与 table 的 TableDoc 同一条纪律）。 */
export interface RefDoc {
  v: number;
  refs: string[];
  /** coerce 时被丢弃的非法引用（原文），只在这次写入产生；空数组时不落这个键。 */
  warnings?: string[];
}

export type FieldDef = ScalarFieldDef | EntryListFieldDef | TableFieldDef | DebugFieldDef;

/** 字段值的宽松联合：历史数据与导入包可能带各种形态，读取侧必须照单全收。 */
export type FieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | Record<string, unknown>[]
  | TableDoc
  | RefDoc
  | ShortcutGroup[]
  | SourceItem[];

export interface RevealOptions {
  mask?: boolean;
  decrypt?: (blob: unknown) => string;
}

export interface FormatContext {
  files?: Record<string, { name?: string; path?: string }>;
  entryFields?: Record<string, SubFieldDef[]>;
  tables?: Record<string, unknown>;
}

export interface RefsOptions {
  /**
   * 是否把原始资料袋里 `kind: 'text'` 正文内嵌的图片也算引用。
   * 导出打包要算（否则包里的记录成了没图的文字）；附件中心的「谁引用了它」不算（既有行为）。
   */
  sourceTextImages?: boolean;
}

/**
 * 写入时把敏感值封装成密文的上下文。
 *
 * 这个钩子**必须碰 vault 密钥**，所以类型放 `shared`、实现只放 `core/fields/seal/`。
 * `section / def / raw / current` 都是历史数据的宽松形态（JSON），实现内部自行收窄。
 */
export interface SealContext {
  section: any;
  def: any;
  raw: any;
  current: any;
}

export type SealHook = (ctx: SealContext) => Promise<unknown>;

/**
 * 一种字段类型在后端的**全部行为**。
 *
 * 八个钩子都是必需的：加一种类型时少写任何一个，`Record<FieldType, FieldBehavior>`
 * 的赋值就会让 `tsc -b` 报错（见 docs/design-intent.md「编译期兜底」）。
 * 生命周期与失败语义见 docs/design-intent.md，不要在调用点另写 `if (type === …)`。
 */
export interface FieldBehavior {
  /** 能否作为表格列类型（`TABLE_CELL_TYPES` 的成员判据）。 */
  readonly cell: boolean;
  /** 字段定义校验/规范化：就地补 `def`，非法定义直接抛（sections 写入路径）。 */
  normalizeDef(raw: any, def: any): void;
  /** 写入归一：CLI/面板传进来的原始值 → 落盘形状。 */
  coerce(def: any, raw: any): unknown;
  /** 落盘值 → 读出去的形状（含清单类子值的密文展示）。 */
  reveal(def: any, raw: any, opts: RevealOptions): unknown;
  /** 这个值引用了哪些附件 id。 */
  refs(def: any, value: any, opts?: RefsOptions): string[];
  /** 导入时把附件 id 重映射到目标库。 */
  remap(def: any, value: any, idMap: Map<string, string>): unknown;
  /** 人读渲染：返回若干行；`null` = 交给通用的标量/数组兜底。 */
  format(def: any, value: any, ctx: FormatContext): string[] | null;
  /** 顶层字段是否按密文处理。 */
  sensitive(def: any): boolean;
  /** 清单类字段的列（密文子值的判据）；标量字段返回空数组。 */
  subFields(def: any): SubFieldDef[];
}
