// ImportModal.tsx —— 粘贴/上传 TOML 的导入弹窗,内嵌格式说明

import { useRef, useState } from 'react';
import { parseImportToml, type ImportParseResult } from './importParser.ts';
import type { ShortcutItem as Shortcut } from '../../../../../shared/fields/types.ts';

// 与参考实现同名的组合键去重键（combo 按 code 归一）
function comboKey(combo: Array<{ code: string }>): string {
  return combo.map((k) => k.code).join('+');
}

interface Props {
  onImport: (data: ImportParseResult) => { groupsAdded: number; groupsAppended: number; shortcutsAdded: number; errors: string[] };
  onClose: () => void;
  /** 当前选中组名(用于「AI 增量提示词」按钮;无组时按钮 disabled) */
  selectedGroupName?: string;
  /** 当前选中组的 shortcuts(用于在 prompt 里列出已存在 combo,避免冲突) */
  selectedGroupShortcuts?: Shortcut[];
}

type TabMode = 'paste' | 'file';

// 格式说明 —— 喂给 LLM 用,让它直接产出符合本组件规范的 TOML。
// 设计原则:
//   1. 角色 + 任务清楚,LLM 不会被误以为是「通用 TOML 教学」
//   2. 字段表 + 修饰键表,机器生成时能直接查表
//   3. 多场景示例(纯组合、condition、重复修饰键),覆盖典型用法
//   4. 反例 + 易错点放在末尾,降低「自由发挥」概率
const FORMAT_PROMPT = `你是一个快捷键数据生成助手。根据用户需求,产出符合以下规范的 TOML,用于导入到 ShortcutLibrary 组件(一个本地快捷键管理工具)。

# === 格式规范 ===
# - 每个 \`[[groups]]\` 表示一个应用分组(如 VSCode、Chrome)
# - 每个 \`[[groups.shortcuts]]\` 是该分组下的一条快捷键
# - 同一分组的快捷键条目必须紧跟在该 \`[[groups]]\` 之后,不能跨组穿插
# - UTF-8 编码,使用中文说明时无需转义
# - 文件大小不超过 1 MB

# === 字段表 ===
# [[groups]]        类型:表数组        必填:是  说明:每个分组一个 [[groups]]
# name              类型:字符串        必填:是  说明:分组名称,如 "VSCode"、"Chrome"
# [[groups.shortcuts]]  类型:嵌套表数组  必填:否  说明:分组下的快捷键条目
# combo             类型:字符串        必填:是  说明:组合键,用 + 连接,如 "Ctrl+R"
# desc              类型:字符串        必填:否  说明:这条快捷键做什么(中文/英文均可)
# condition         类型:字符串        必填:否  说明:激活条件,纯备注,运行时不做检查。例:"选中数字时"、"仅 macOS"、"编辑器内"

# === 修饰键写法(不区分左右) ===
# Ctrl  Shift  Alt  ⌘(Meta/Command)

# === 单键快捷键(无修饰键)也是合法的 ===
# combo 可以只写一个主键,不带任何修饰键。
# 很多非编码类应用 —— 尤其是传媒/剪辑软件(Premiere / 达芬奇 / 剪映 / DaVinci 等),
# 为了让素材编排"手不离键",大量使用单键:
#   J / K / L   快退 / 暂停 / 快进
#   I / O       标记入点 / 出点
#   C / V       切刀 / 选择
#   Space       播放/暂停
# 这类应用请大胆输出单键 combo(如 combo = "K"),不必强行加 Ctrl。

# === 主键写法(大小写不敏感) ===
# 字母: A-Z     数字: 0-9     功能键: F1-F12
# 方向: ↑ ↓ ← → —— 必须写箭头符号,禁止写英文名 Left/Right/Up/Down,也不要写 ArrowUp 这类 code 名
# 符号: - = [ ] ; ' , . / \` 以及反斜杠(写法见下方"字符串转义")
# 特殊: Enter Esc Tab Space Backspace
# 导航: Insert(Ins) Home PageUp(PgUp) Delete(Del) End PageDown(PgDn)
#       └ 括号内是等价简写,两种都能识别
# 注意: 优先使用上表写法,不要发明清单外的名字。

# === 字符串转义(TOML 双引号字符串规则) ===
# 在 combo / desc / condition 的双引号内,这两个字符必须转义:
#   反斜杠 → 写两个反斜杠      引号 → 写 \\"
# 例:反斜杠键这条快捷键(Krita 的"显示工具选项")
#   对: combo = "\\\\"          错: combo = "\\"
# 例:说明文字里出现路径
#   对: desc = "打开 C:\\\\Users 目录"
# 中文、全角标点、emoji 都不需要转义,直接写。

# === 不要这样写 ===
# - 不要用列表外的按键名。常见错误:
#     错 Return   → 对 Enter
#     错 Escape   → 对 Esc
#     错 Control  → 对 Ctrl
#     错 Ctrl_L   → 对 Ctrl
#     错 KeyA     → 对 A
#     错 Digit1   → 对 1
#     错 Minus    → 对 -
#     错 Equal    → 对 =
#     错 Numpad1  → 小键盘不支持,改用主键区数字 1
#     错 Left / Right / Up / Down → 对 ← / → / ↑ / ↓(方向键必须用箭头符号)
#     错 ArrowLeft / ArrowUp 等   → 对 ← / ↑
# - 不要把 + 键本身放进 combo —— + 是分隔符,无法转义。
#   需要表达 "Alt+Shift 加上加号键" 时,请改用它在主键行的符号名 =
#   (US 布局下 + 是 Shift+= ),例:combo = "Alt+Shift+="
#   同理 combo = "Alt+Shift++" 或 "Alt+Shift++;" 都会被静默解析成错误的组合键。
# - combo 不能为空,也不能只含修饰键 —— 必须有一个主键。
#   错:combo = ""           ← 被解析器报「组合键不能为空」
#   错:combo = "Ctrl+Shift" ← 被解析器报「组合键缺少主键」
#   对:无法表达的条目直接省略,不要硬填(原应用确实没默认快捷键时跳过整条)。
# - 不要给同一分组写出两条完全相同的 combo(会被判为冲突并标红)

# === 示例 1:基础分组 ===
[[groups]]
name = "VSCode"

[[groups.shortcuts]]
combo = "Ctrl+R"
desc = "打开目录"

[[groups.shortcuts]]
combo = "Ctrl+Shift+P"
desc = "命令面板"

[[groups.shortcuts]]
combo = "Ctrl+P"
desc = "文件搜索"

# === 示例 2:多个分组 ===
[[groups]]
name = "Chrome"

[[groups.shortcuts]]
combo = "Ctrl+T"
desc = "新建标签页"

[[groups.shortcuts]]
combo = "Ctrl+Shift+T"
desc = "恢复关闭标签页"

[[groups]]
name = "Slack"

[[groups.shortcuts]]
combo = "Ctrl+K"
desc = "快速切换频道"

# === 示例 3:带激活条件的快捷键(条件为备注,不参与运行时判断) ===
[[groups]]
name = "Word"

[[groups.shortcuts]]
combo = "Ctrl+Shift+1"
desc = "上标"
condition = "选中文本时"

[[groups.shortcuts]]
combo = "Ctrl+Shift+2"
desc = "下标"
condition = "选中文本时"

[[groups.shortcuts]]
combo = "Ctrl+Shift+L"
desc = "切换侧边栏"
condition = "仅 Windows/Linux"

# === 示例 4:传媒剪辑软件(大量单键,手不离键) ===
[[groups]]
name = "DaVinci Resolve"

[[groups.shortcuts]]
combo = "Space"
desc = "播放/暂停"

[[groups.shortcuts]]
combo = "J"
desc = "快退(连按加速)"

[[groups.shortcuts]]
combo = "K"
desc = "停止"

[[groups.shortcuts]]
combo = "L"
desc = "快进(连按加速)"

[[groups.shortcuts]]
combo = "I"
desc = "标记入点"

[[groups.shortcuts]]
combo = "O"
desc = "标记出点"

[[groups.shortcuts]]
combo = "C"
desc = "切刀工具"

# === 示例 5:导航键 + 符号键 + 转义(照这个写法准没错) ===
[[groups]]
name = "Krita"

[[groups.shortcuts]]
combo = "PageUp"
desc = "切换到上一层图层"

[[groups.shortcuts]]
combo = "Ctrl+PageDown"
desc = "把当前图层下移一层"

[[groups.shortcuts]]
combo = "\\\\"
desc = "显示工具选项"
condition = "Krita 2.9.6 起 \\\\ 打开工具选项"

[[groups.shortcuts]]
combo = ";"
desc = "切换到上一个被激活的图层"

[[groups.shortcuts]]
combo = "Alt+Shift+="
desc = "切换上一个混合模式"
condition = "US 布局下 + 是 Shift+= ,所以这里写 ="

# === 易错点(必须避免) ===
# 1. combo 只写修饰键 → "Ctrl+Shift" 是非法,必须含主键
# 2. 主键用全名 → 错:"Control+R" / "Digit1" / "Minus" / "ArrowLeft";对:"Ctrl+R" / "1" / "-" / "←"
# 3. 顺序不规范 → 修饰键在前,主键在末尾,例:"Ctrl+Shift+P" 而不是 "P+Ctrl+Shift"
# 4. 出现未知字段 → 每个 [[groups.shortcuts]] 只允许 combo / desc / condition
# 5. 缩进/引号混乱 → name 与 desc 一律用双引号包裹
# 6. 反斜杠没转义 → 错:combo = "\\";对:combo = "\\\\"
# 7. 想表达 + 键 → 不能写 "+",改写成 "="(见示例 4)

# === 输出要求 ===
# - 只输出 TOML 文本,不要包裹在 markdown 代码块里(用户复制时不需要三个反引号 toml)
# - 不要写解释、不要写前言,直接第一行就是 [[groups]]
# - 不要使用 [[groups.shortcut]] 单数,必须是复数 shortcuts`;

export default function ImportModal({ onImport, onClose, selectedGroupName, selectedGroupShortcuts }: Props) {
  const [mode, setMode] = useState<TabMode>('paste');
  const [text, setText] = useState('');
  const [parseResult, setParseResult] = useState<ImportParseResult | null>(null);
  const [parsed, setParsed] = useState(false);
  const [resultSummary, setResultSummary] = useState<ReturnType<typeof onImport> | null>(null);
  const [showFormat, setShowFormat] = useState(false);
  const [copied, setCopied] = useState(false);
  // AI 增量提示词按钮的「已复制」反馈(独立 state,避免和「复制格式提示词」冲突)
  const [incrementalCopied, setIncrementalCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  // 文件页：原生拖放区的拖拽高亮与 file input 引用（参考实现用共享 FileDropZone，
  // nx-sk 没有 Vue 共享层，这里用同视觉的原生实现）
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 项目不变量禁止浏览器原生 alert：复制/读文件失败改为弹窗内提示
  const [notice, setNotice] = useState('');

  // 复制格式说明到剪贴板
  async function handleCopyFormat() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(FORMAT_PROMPT);
      } else {
        // 旧浏览器 fallback: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = FORMAT_PROMPT;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setNotice('复制失败，请手动选择文本');
      console.error(err);
    }
  }

  /**
   * 拼出"AI 增量生成"提示词:
   *   - 角色 + 任务:扩展当前组的快捷键合集
   *   - 原 FORMAT_PROMPT 完整原文(让 LLM 严格遵循 TOML 格式)
   *   - 当前组已存在 combo 清单(comboKey 序列,显式列出)
   *   - 避冲突指令:必须避开以上 combo
   * 用户拿到后贴给任意 LLM,直接产出不冲突的 TOML 文本。
   */
  function buildIncrementalPrompt(groupName: string, shortcuts: Shortcut[]): string {
    const lines: string[] = [];
    lines.push(`你是一个快捷键扩展助手。当前主题「${groupName}」已经存在以下快捷键,请你按照下面给出的 TOML 格式规范,基于「${groupName}」的语义,扩展出更多快捷键(更多组合、更全的场景覆盖)。`);
    lines.push('');
    lines.push('# === 已有快捷键(请严格避开这些 combo,不要输出相同或冲突的条目) ===');
    if (shortcuts.length === 0) {
      lines.push('# (当前组为空,可以自由扩展)');
    } else {
      for (const s of shortcuts) {
        const key = comboKey(s.combo);
        const desc = s.description || '(无描述)';
        const cond = s.condition ? `,condition="${s.condition}"` : '';
        lines.push(`# - combo="${key}"  desc="${desc}"${cond}`);
      }
    }
    lines.push('');
    lines.push('# === 输出要求 ===');
    lines.push('# - 严格按下面给出的 TOML 格式规范输出');
    lines.push('# - 不要重复上述「已有快捷键」列表中的任何 combo');
    lines.push('# - 输出 [[groups]] 时 name 必须为 "${groupName}"');
    lines.push('# - 只输出 TOML 文本,不要 markdown 代码块包裹,不要写前言/解释');
    lines.push('');
    lines.push('# === TOML 格式规范(原样遵循) ===');
    lines.push('');
    lines.push(FORMAT_PROMPT);
    return lines.join('\n');
  }

  async function handleCopyIncremental() {
    if (!selectedGroupName) return;
    const prompt = buildIncrementalPrompt(selectedGroupName, selectedGroupShortcuts ?? []);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        const ta = document.createElement('textarea');
        ta.value = prompt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setIncrementalCopied(true);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setIncrementalCopied(false), 1800);
    } catch (err) {
      setNotice('复制失败，请手动选择文本');
      console.error(err);
    }
  }

  // 卸载时清理 timer
  function handleCleanup() {
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }

  function handleConfirm() {
    if (!parseResult) return;
    const stats = onImport(parseResult);
    setResultSummary(stats);
  }

  // 文件页用原生虚线拖放区（nx-sk 无 Vue 共享层），视觉与共享 FileDropZone 的 zone 形态一致。
  function handleFile(picked: File[]) {
    setNotice('');
    const file = picked[0];
    if (!file) return;
    // 与共享 FileDropZone 的 accept 过滤一致：Windows 下 .toml 的 type 常为空，
    // 所以回退到扩展名判断；拖入文件夹（type 为空且无扩展名）也在这里被拒。
    if (!file.name.toLowerCase().endsWith('.toml')) return;
    if (file.size > 1_000_000) {
      setNotice('文件过大，请控制在 1MB 以内');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      setText(content);
      // Auto-parse on file load
      const result = parseImportToml(content);
      setParseResult(result);
      setParsed(true);
    };
    reader.onerror = () => setNotice('无法读取文件');
    reader.readAsText(file);
  }

  // Re-parse when text changes in paste mode
  function handleTextChange(val: string) {
    setNotice('');
    setText(val);
    setResultSummary(null);
    if (!val.trim()) {
      setParseResult(null);
      setParsed(false);
      return;
    }
    const result = parseImportToml(val);
    setParseResult(result);
    setParsed(true);
  }

  const totalGroups = parseResult?.groups.length ?? 0;
  const totalShortcuts = parseResult?.groups.reduce((n, g) => n + g.shortcuts.length, 0) ?? 0;
  const hasErrors = parseResult && parseResult.errors.length > 0;
  const isValid = parseResult && totalGroups > 0 && totalShortcuts > 0;

  return (
    <div className="sl-sl-overlay" onClick={() => { handleCleanup(); onClose(); }}>
      <div className="sl-sl-modal" onClick={(e) => e.stopPropagation()}>
        <header className="sl-sl-modal__head">
          <h2 className="sl-sl-modal__title">导入快捷键</h2>
          <button className="sl-sl-icon-btn" onClick={() => { handleCleanup(); onClose(); }}>×</button>
        </header>

        {/* Tab switch */}
        <div className="sl-sl-modal__tabs">
          <button
            className={`sl-sl-modal__tab ${mode === 'paste' ? 'is-active' : ''}`}
            onClick={() => { setMode('paste'); setResultSummary(null); }}
          >
            粘贴文本
          </button>
          <button
            className={`sl-sl-modal__tab ${mode === 'file' ? 'is-active' : ''}`}
            onClick={() => { setMode('file'); setResultSummary(null); }}
          >
            选择文件
          </button>
        </div>

        {mode === 'paste' ? (
          <textarea
            className="sl-sl-modal__textarea"
            rows={10}
            placeholder={`粘贴 TOML 内容...\n\n示例:\n[[groups]]\nname = "VSCode"\n\n[[groups.shortcuts]]\ncombo = "Ctrl+R"\ndesc = "打开目录"`}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <div className="sl-sl-modal__file-zone">
            <div
              className={`sl-sl-dropzone${dragActive ? ' is-dragging' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="点击或拖拽文件到此处"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                handleFile(Array.from(e.dataTransfer.files));
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".toml"
                hidden
                onChange={(e) => {
                  handleFile(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <span className="sl-sl-dropzone__title">点击或拖拽文件到此处</span>
              <span className="sl-sl-dropzone__hint">支持 .toml</span>
            </div>
            {text && (
              <p className="sl-sl-modal__file-name">
                已加载 {text.length} 字节
              </p>
            )}
          </div>
        )}

        {/* Preview */}
        <div className="sl-sl-modal__preview">
          {parsed && !text.trim() && (
            <span className="sl-sl-modal__preview-text">未输入内容</span>
          )}
          {parsed && text.trim() && parseResult && (
            <span className="sl-sl-modal__preview-text">
              解析结果: {totalGroups} 个分组, {totalShortcuts} 条快捷键
              {hasErrors && (
                <span className="sl-sl-modal__preview-warn">
                  , {parseResult.errors.length} 个警告
                </span>
              )}
            </span>
          )}
        </div>

        {/* Error detail */}
        {hasErrors && (
          <div className="sl-sl-modal__errors">
            {parseResult!.errors.slice(0, 10).map((err, i) => (
              <div key={i} className="sl-sl-modal__error-item">{err}</div>
            ))}
            {parseResult!.errors.length > 10 && (
              <div className="sl-sl-modal__error-item">… 还有 {parseResult!.errors.length - 10} 条</div>
            )}
          </div>
        )}

        {/* Format reference (collapsible) */}
        <div className="sl-sl-modal__format">
          <div className="sl-sl-modal__format-head">
            <button
              className="sl-sl-modal__format-toggle"
              onClick={() => setShowFormat(!showFormat)}
            >
              {showFormat ? '收起格式说明' : '查看格式说明'}
            </button>
            <button
              type="button"
              className={`sl-sl-modal__format-copy ${incrementalCopied ? 'is-copied' : ''}`}
              onClick={handleCopyIncremental}
              disabled={!selectedGroupName}
              title={selectedGroupName
                ? `把当前组「${selectedGroupName}」的扩展提示词(含已有 combo 清单)复制到剪贴板`
                : '请先在左侧选中一个组'}
            >
              {incrementalCopied ? '已复制' : 'AI 增量提示词'}
            </button>
            <button
              type="button"
              className={`sl-sl-modal__format-copy ${copied ? 'is-copied' : ''}`}
              onClick={handleCopyFormat}
              title="复制格式说明到剪贴板"
            >
              {copied ? '已复制' : '复制格式提示词'}
            </button>
          </div>
          {showFormat && (
            <div className="sl-sl-modal__format-body">
              <pre>{FORMAT_PROMPT}</pre>
            </div>
          )}
        </div>

        {/* Result summary after import */}
        {resultSummary && (
          <div className="sl-sl-modal__result">
            导入完成: 新增 {resultSummary.groupsAdded} 个分组,
            追加 {resultSummary.groupsAppended} 个现有分组,
            合计 {resultSummary.shortcutsAdded} 条快捷键
            {resultSummary.errors.length > 0 && (
              <div className="sl-sl-modal__result-warn">
                {resultSummary.errors.length} 个警告已忽略
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        {notice && (
          <div className="sl-sl-modal__errors" role="alert">
            <p className="sl-sl-modal__error-item">{notice}</p>
          </div>
        )}
        <div className="sl-sl-modal__actions">
          {!resultSummary ? (
            <>
              <button className="sl-sl-btn sl-sl-btn--ghost" onClick={() => { handleCleanup(); onClose(); }}>取消</button>
              <button
                className="sl-sl-btn sl-sl-btn--primary"
                disabled={!isValid}
                onClick={handleConfirm}
              >
                确认导入
              </button>
            </>
          ) : (
            <button className="sl-sl-btn sl-sl-btn--primary" onClick={() => { handleCleanup(); onClose(); }}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
