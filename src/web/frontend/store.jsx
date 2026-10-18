import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api/client.js';

export const LS_KEY = 'nx-sk-ui';

// 只持久化**选择**，不持久化**数据**——数据永远从 /api 拉，避免陈旧缓存。
export const DEFAULT_UI = {
  // 当前 tab。空串 = **还没做过选择**，此时由 App 回落到 settings.defaultSection
  // （再不行才是第一个栏目）。写死成 'job' 会让「默认栏目」这个设置项彻底失效，
  // 而且删掉 job 栏目后首屏就落在一个不存在的 id 上。
  view: '',
  entry: '', // 各栏目选中的条目
  q: '', // 搜索词
  mask: false, // 打码显示密文字段（默认原文；投屏时勾上）
};

function loadUi() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    // 旧版本把「当前 tab」也落了盘。现在它归地址栏管（见 App 的 hash 处理），
    // 落盘会和 settings.defaultSection 抢「打开时落在哪」——用户改了默认栏目
    // 却看不到变化，正是双记忆源最典型的表现。老数据就地丢弃。
    if (saved && typeof saved === 'object') delete saved.view;
    return { ...DEFAULT_UI, ...saved };
  } catch {
    return { ...DEFAULT_UI };
  }
}

const Ctx = createContext(null);

export function StoreProvider({ children }) {
  const [boot, setBoot] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [ui, setUi] = useState(loadUi);
  const [toasts, setToasts] = useState([]);
  const [dialogState, setDialogState] = useState(null);

  const patchUi = useCallback((patch) => {
    setUi((prev) => {
      const next = { ...prev, ...patch };
      try {
        // 只持久化**跨会话有意义**的选择；当前 tab 不在其中（它由地址栏决定，
        // 见 App 里的解析顺序）。其余键一律照存，将来加键不必记得改这里。
        const rest = { ...next };
        delete rest.view;
        localStorage.setItem(LS_KEY, JSON.stringify(rest));
      } catch { /* 隐私模式 */ }
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await api('/api/bootstrap');
      setBoot(data);
      setBootError(null);
      return data;
    } catch (e) {
      setBootError(e.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const toast = useCallback((message, kind = 'ok') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  // Promise 风格：调用处读起来是同步的 —— `const ok = await dialog({...}); if (!ok) return;`
  const dialog = useCallback((opts) => new Promise((resolve) => {
    setDialogState({ ...opts, resolve });
  }), []);

  const closeDialog = useCallback((value) => {
    setDialogState((cur) => { cur?.resolve?.(value); return null; });
  }, []);

  // 包装函数必须**透传参数**：大量 guard(async (row) => …) 形式的行级操作
  // 靠调用方传入对象——不透传的话 row 恒为 undefined，
  // 抛 "Cannot read properties of undefined (reading 'name')"（真实事故：密钥页 CRUD 全挂）。
  const guard = useCallback((fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e?.message || String(e), 'bad');
    }
  }, [toast]);

  const value = useMemo(() => ({
    boot, bootError, ui, patchUi, reload, toast, dialog, closeDialog, guard, toasts, dialogState,
  }), [boot, bootError, ui, patchUi, reload, toast, dialog, closeDialog, guard, toasts, dialogState]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore 必须在 StoreProvider 内使用');
  return v;
}
