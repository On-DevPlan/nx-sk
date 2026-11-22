// 全站唯一的 SVG 图标出口（任务 #8 第 4 轮：图标按钮化落地的基础设施）。
//
// 三条纪律：
//   1. **一个功能一个图标**：加新图标前先查下面的「功能 → 图标」登记表——
//      同功能必须复用既有图标（比如「确认」全站只有 check 一颗），确属新功能
//      才加新条目并登记进表；禁止给同一个功能画第二个图标。
//   2. **尺寸不写死**：Icon 的 size 只有三档（sm / md / lg），落到
//      styles/tokens.css 的 --icon-sm / --icon-md / --icon-lg。
//      全站要统一调整图标大小，改 token 即可；不要在组件里传像素宽高。
//   3. **单色线性**（currentColor，strokeWidth 1.2–1.7，viewBox 16）——
//      彩色图标、面性图标不收；状态色由外层按钮的 CSS（.btn.danger 等）给。
//
// 功能 → 图标登记表：
//   添加（行 / 列 / 组 / 条目）              plus
//   删除 / 移除 / 关闭                       x
//   下载                                     download
//   复制（路径 / 定位符 / 原文）             copy
//   编辑（进入编辑态 / 改名 / 改属性）       pencil
//   完成 / 确认 / 勾选（grill ack 同用）     check
//   保存（进度 / 存为模板）                  save
//   预览 / 查看 / 信息                       eye
//   插入图片                                 image
//   上传 / 选择文件 / 导入 ZIP               upload
//   检索（引用资源等）                       search
//   更多 / 设置菜单（⋯ / ⋮ 触发钮）         dots
//   变化历史 / 时间线                        history
//   刷新 / 重新加载                          reload
//   peek 三态：侧边 / 居中 / 整页            pane-side / pane-center / pane-full
//   新窗口打开                               new-tab
//   peek 视图选项                            sliders

import type { ReactNode } from 'react';

export type IconSize = 'sm' | 'md' | 'lg';

export type IconName =
  | 'plus' | 'x' | 'download' | 'copy' | 'pencil' | 'check' | 'save' | 'eye'
  | 'image' | 'upload' | 'search' | 'dots' | 'history' | 'reload'
  | 'pane-side' | 'pane-center' | 'pane-full' | 'new-tab' | 'sliders';

/** 尺寸三档 → token 变量（定义在 styles/tokens.css，改那里即全站生效）。 */
const SIZES: Record<IconSize, string> = {
  sm: 'var(--icon-sm)',
  md: 'var(--icon-md)',
  lg: 'var(--icon-lg)',
};

const PATHS: Record<IconName, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  x: <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  download: <path d="M8 3v7M5 7.5L8 10.5l3-3M2.5 12.5V14h11v-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 3.5v-.3a1.2 1.2 0 0 0-1.2-1.2H4.2a1.2 1.2 0 0 0-1.2 1.2v5.1a1.2 1.2 0 0 0 1.2 1.2h.3" stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
  pencil: <path d="M11.3 2.7l2 2L5.2 12.8l-2.6.6.6-2.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  check: <path d="M3.2 8.4l3.1 3.1 6.5-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />,
  save: (
    <>
      <path d="M3 3h8.5L13.5 5v8H3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.5 3v3.5h5V3M5.5 13V9.5h5V13" stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </>
  ),
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.8" cy="6.3" r="1" fill="currentColor" />
      <path d="M3.5 11.5l3-3 2.5 2.5 2-2 2 2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </>
  ),
  upload: <path d="M8 10V3M5 5.5L8 2.5l3 3M2.5 11v2.5h11V11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 10.2l3.6 3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  dots: (
    <>
      <circle cx="8" cy="3.5" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.1" fill="currentColor" />
    </>
  ),
  history: (
    <>
      <path d="M8 4.2V8l2.6 1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.5 5.9M2.5 3.4v2.5H5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  reload: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7L13.4 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13.5 3.4V6h-2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  'pane-side': (
    <>
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3.5" y="3.7" width="3.4" height="8.6" rx="1.1" fill="currentColor" />
    </>
  ),
  'pane-center': (
    <>
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="5.2" y="4.8" width="5.6" height="6.4" rx="1.1" fill="currentColor" />
    </>
  ),
  'pane-full': (
    <>
      <rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.6 5.9h8.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  'new-tab': (
    <>
      <rect x="4.6" y="2.4" width="8.9" height="9.6" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="4.8" width="8.9" height="8.8" rx="2" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.6 5.2h10.8M2.6 10.8h10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6.1" cy="5.2" r="1.7" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="10.8" r="1.7" style={{ fill: 'var(--paper)' }} stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
};

export function Icon({ name, size = 'md', className }: { name: IconName; size?: IconSize; className?: string }) {
  const box = SIZES[size];
  return (
    <svg
      viewBox="0 0 16 16"
      style={{ width: box, height: box }}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
