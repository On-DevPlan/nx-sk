// react-grid-layout v2 的 d.ts 依赖 `@types/react@19`（ReactNode 含 bigint），
// 与本项目的 `@types/react@18` 冲突，导致 `<Responsive />` 报 TS2786。
// 运行时无关（同一个 npm 包），这里只按**本项目实际用到的两个导出**给出类型。
// 通过 tsconfig.web 的 paths 映射生效；Vite 构建仍解析 node_modules 原包。
import type { ReactElement, ReactNode, RefObject } from 'react';

/** 与 shared/blockLayout.ts 的 GridItem 对齐。 */
export interface GridLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResponsiveProps {
  width: number;
  className?: string;
  layouts?: Partial<Record<string, readonly GridLayoutItem[]>>;
  breakpoints?: Record<string, number>;
  cols?: Record<string, number>;
  rowHeight?: number;
  margin?: readonly [number, number];
  containerPadding?: readonly [number, number] | null;
  dragConfig?: { enabled?: boolean; handle?: string };
  resizeConfig?: { enabled?: boolean; handles?: readonly string[] };
  onResizeStop?: (layout: readonly GridLayoutItem[]) => void;
  onBreakpointChange?: (breakpoint: string, cols: number) => void;
  children?: ReactNode;
}

export declare const Responsive: (props: ResponsiveProps) => ReactElement;
export default Responsive;

export declare function useContainerWidth(): {
  width: number;
  containerRef: RefObject<HTMLDivElement>;
  mounted: boolean;
};
