// 图文字段（`type: 'md'`）的正文渲染：react-markdown + remark-gfm。
//
// 为什么不再手写：手写那版只认「图片 + 链接」两种行内标记，一旦正文里出现
// `## 步骤`、`- 列表`、`1. 顺序`、表格、代码块，预览里全是字面量 —— 而 SOP 恰恰
// 全靠这些结构才读得下去。任务列表更是不可能靠正则做：勾选框要能点、点完要写回正文。
//
// 只做三件自定义，其余交给解析器：
//   1. `img`：`src` 是附件 id（`f_xxx`）时去附件表里换成真实地址；外链图直接用；
//      查不到就留一条醒目的「图片缺失」，不静默吞掉。
//   2. `a`：只放行 http(s) 与能查到的附件 id，其余按普通文字渲染；
//      GFM 自动链接会把中文标点吃进 href，这里按 `cleanHttpUrl` 的同一口径截断。
//   3. `input`：GFM 生成的勾选框默认 `disabled`，换成可点的 —— 点一下 = 改正文那一行。
//
// 裸写的 `125.67.197.2:7443`、`qcloud.sicau.edu.cn/login` 由 `../mdSmart.js` 这个 remark 插件
// 补成「点击复制 / 点击打开」的节点（IP 用 `hName` 直接生成 `<button data-copy>`）。
//
// 任务勾选靠**行号**回写：`li` 的 hast 节点带 `position.start.line`（解析器给的行号，
// 1 起算），通过 context 传给里面的勾选框，`mdSource.toggleTaskAtLine` 据此取反。
// 不用「第几个勾选框」这种计数法：嵌套列表 + 并发渲染下顺序没有保证，行号是确定的。
import { createContext, useContext, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cleanHttpUrl, isHttpUrl, linkTextParts } from '../mdInline.js';
import { remarkSmartLinks } from '../mdSmart.js';

// 顺序有讲究：gfm 先把 `https://…`、`www.…` 收走，smartLinks 只处理它剩下的裸 IP / 裸域名。
//   gfm        —— 表格、任务列表、删除线、自动链接；
//   breaks     —— 单个换行渲染成 <br>。这条是**为了不倒退**：手写那版是 `pre-wrap`，
//                 用户早就习惯「一行一步」；不装它，已有的 SOP 会挤成一整段；
//   smartLinks —— 裸写的 `125.67.197.2:7443` / `qcloud.sicau.edu.cn/login`。
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkSmartLinks];

/** 渲染层要用的三样东西：附件表、放大镜、勾选回写。用 context 传，组件才能是模块级常量。 */
const MdCtx = createContext({ byId: null, onOpenImage: null, onToggleTask: null });
/** 当前 `<li>` 在正文里的起始行（1 起算）；0 = 不在列表项里。 */
const TaskLine = createContext(0);

/**
 * 把图片引用解析成「有 url 的记录」：先查附件库，再认外链，都不是就 null。
 * 图库缩略图与正文内联图共用这一条规则 —— 两处各写一遍的话，
 * 迟早出现「下面有图、正文说没有」。
 */
export function imageRecord(byId, id, alt) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  const rec = byId?.get?.(key);
  if (rec) return rec;
  if (!isHttpUrl(key)) return null;
  // 外链图没有附件记录，就地拼一个同形状的对象：放大镜按同一套字段取值。
  return { id: key, name: alt || key, url: key, remote: true };
}

/**
 * 交给解析器之前先把 URL 洗一遍：只放行 http(s) 与附件 id。
 * 其余（`javascript:`、相对路径、`mailto:`）返回空串 —— 组件层再按「不可点」渲染，
 * 这样既不会出现点了没反应的链接，也不会有 `javascript:` 被执行的机会。
 */
function safeUrl(url, key) {
  const raw = String(url ?? '').trim();
  if (isHttpUrl(raw)) return cleanHttpUrl(raw);
  if (/^f_[A-Za-z0-9_-]+$/.test(raw)) return raw;
  // 图片的 src 原样留着：`MdImage` 认不出时要把这个 id/路径**显示出来**
  // （`[图片缺失: ./a.png]`）。洗成空串，用户就只剩一句「图片缺失: 」，无从排查。
  if (key === 'src') return raw;
  return '';
}

function MdImage({ node: _node, src, alt, title }) {
  const { byId, onOpenImage } = useContext(MdCtx);
  const rec = imageRecord(byId, src, alt);
  if (!rec) {
    return (
      <span className="md-missing" title="这条引用指向的附件已不在库里（可能已在附件中心删除）；重新粘贴一次会得到新引用">
        [图片缺失: {String(src ?? '')}]
      </span>
    );
  }
  return (
    <img
      className="md-inline"
      src={rec.url}
      alt={alt || rec.name}
      title={title || (rec.remote ? '外链图片（点击放大）' : '点击放大')}
      onClick={() => onOpenImage?.(rec)}
    />
  );
}

function MdLink({ node: _node, href, title, children }) {
  const { byId } = useContext(MdCtx);
  const raw = String(href ?? '').trim();

  if (!isHttpUrl(raw)) {
    // `[说明](f_xxx)`：指向附件库里的一份文件，能查到就打开它，查不到按原文渲染。
    const rec = byId?.get?.(raw) || null;
    if (!rec) return <span className="md-link-dead" title="只有 http(s) 链接和附件 id 可以点开">{children}</span>;
    return (
      <a className="md-link" href={rec.url} target="_blank" rel="noopener noreferrer" title={`在新标签页打开附件：${rec.name}`}>
        {children}
      </a>
    );
  }

  // GFM 自动链接把 `https://a.com。另见` 整段算成了链接文字与 href。
  // href 已经在 urlTransform 里截干净了，这里把「不属于网址」的尾巴拆回正文。
  const parts = typeof children === 'string' ? linkTextParts(children, raw) : { text: children, tail: '' };
  return (
    <>
      <a className="md-link" href={raw} target="_blank" rel="noopener noreferrer" title={title || `在新标签页打开：${raw}`}>
        {parts.text}
      </a>
      {parts.tail}
    </>
  );
}

/** GFM 的勾选框默认 `disabled`：换成可点的，点一下改正文那一行。 */
function TaskCheckbox({ node: _node, type, checked, disabled: _disabled }) {
  const line = useContext(TaskLine);
  const { onToggleTask } = useContext(MdCtx);
  if (type !== 'checkbox') return <input type="checkbox" checked={!!checked} disabled readOnly />;
  if (!line || !onToggleTask) return <input type="checkbox" className="md-task" checked={!!checked} disabled readOnly />;
  return (
    <input
      type="checkbox"
      className="md-task"
      checked={!!checked}
      onChange={() => onToggleTask(line)}
      title={checked ? '点一下标记为未完成（写回正文）' : '点一下标记为已完成（写回正文）'}
    />
  );
}

function MdListItem({ node, className, children, ...rest }) {
  const line = node?.position?.start?.line || 0;
  if (!line) return <li className={className} {...rest}>{children}</li>;
  return (
    <li className={className} {...rest}>
      <TaskLine.Provider value={line}>{children}</TaskLine.Provider>
    </li>
  );
}

/** 表格在窄面板里会被挤成一列字，套一层横向滚动。 */
function MdTable({ node: _node, children, ...rest }) {
  return (
    <div className="md-table">
      <table {...rest}>{children}</table>
    </div>
  );
}

// 模块级常量：组件身份稳定，正文变化时只重渲染内容，不整棵子树重挂。
const COMPONENTS = {
  a: MdLink,
  img: MdImage,
  input: TaskCheckbox,
  li: MdListItem,
  table: MdTable,
};

/**
 * 渲染一段 markdown 正文。
 *
 * `byId` 是附件 id → 记录的 Map；`onOpenImage(rec)` 打开放大镜；
 * `onToggleTask(line)` 收到的是**正文行号**，由调用方写回（见 `mdSource.toggleTaskAtLine`）；
 * `onCopy(value)` 是 IP「点击复制」后的反馈（提示条），不传就直接写剪贴板。
 */
export function MdView({ text, byId, onOpenImage, onToggleTask, onCopy, className = '' }) {
  const ctx = useMemo(() => ({ byId, onOpenImage, onToggleTask }), [byId, onOpenImage, onToggleTask]);

  // IP 渲染成 `<button data-copy>`（由 remark 插件用 hName 生成），点击走**代理**：
  // 正文节点动辄上千，逐个挂 handler 既慢又没必要；气泡到这里再认一次就够了。
  const onClick = (e) => {
    const btn = e.target?.closest?.('button[data-copy]');
    if (!btn) return;
    e.preventDefault();
    const value = btn.dataset.copy || '';
    if (onCopy) { onCopy(value); return; }
    navigator.clipboard?.writeText(value).catch(() => { /* 没有反馈通道时静默失败 */ });
  };

  return (
    <MdCtx.Provider value={ctx}>
      <div className={`md-body ${className}`.trim()} onClick={onClick}>
        <Markdown remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrl} components={COMPONENTS}>
          {String(text ?? '')}
        </Markdown>
      </div>
    </MdCtx.Provider>
  );
}
