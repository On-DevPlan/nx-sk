import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 只借 FlexLayout 的**结构 CSS**（.flexlayout__* 的盒模型与拖拽几何）——不引它的配色：
// 配色全部由 styles.css 里的 --flexlayout-* 变量覆写接管（单色 + 唯一语义红）。
// 不引这份结构 CSS 的后果实测过：面板组高度算成 0，库直接不渲染面板内容（页签在、内容是空的）。
import 'flexlayout-react/style/light.css';
import App from './App.jsx';
import { StoreProvider } from './store.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
