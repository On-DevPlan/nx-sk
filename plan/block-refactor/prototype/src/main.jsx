import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 只借 FlexLayout 的**结构 CSS**（.flexlayout__* 盒模型与拖拽几何），
// 不引它的配色——配色全部由 theme.css 里的 --flexlayout-* 覆写接管。
import 'flexlayout-react/style/light.css';
import './theme.css';
import Shell from './shell.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
