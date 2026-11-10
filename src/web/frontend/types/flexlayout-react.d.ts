// flexlayout-react 0.8.17 的类型包内部用无扩展名的相对导入（`export * from './view/Layout'`），
// 在 nodenext 下解析不到；这里只声明本项目用到的那一小撮 API，运行时仍走真实包。
// 用到的范围见 components/flexPeek.tsx：Model.fromJson/toJson/getNodeById、Layout 的 model/factory/onModelChange。
declare module 'flexlayout-react' {
  import * as React from 'react';

  export interface IJsonNode {
    type: 'row' | 'tabset' | 'tab' | 'splitter';
    id?: string;
    weight?: number;
    children?: IJsonNode[];
    [key: string]: unknown;
  }

  export interface IJsonModel {
    global?: Record<string, unknown>;
    borders?: unknown[];
    layout: IJsonNode;
    popouts?: Record<string, unknown>;
  }

  export class Node {
    getId(): string;
    getComponent(): string | undefined;
  }

  export class TabNode extends Node {}

  export class Model {
    static fromJson(json: IJsonModel): Model;
    toJson(): IJsonModel;
    getNodeById(id: string): Node | undefined;
  }

  export interface ILayoutProps {
    model: Model;
    factory: (node: TabNode) => React.ReactNode;
    onModelChange?: (model: Model) => void;
    realtimeResize?: boolean;
    className?: string;
    style?: React.CSSProperties;
  }

  export class Layout extends React.Component<ILayoutProps> {}
}
