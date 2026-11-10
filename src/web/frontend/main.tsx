import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { StoreProvider } from './store.tsx';
// flexlayout-react 的外壳样式先加载，styles.css 里的 .nx-flexpeek 覆盖主题默认值
import 'flexlayout-react/style/light.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
