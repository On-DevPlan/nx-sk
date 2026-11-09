// 交给 OS 的动作：开浏览器 / 开文件管理器。纯尽力而为，失败绝不影响主流程。
import { spawn } from 'node:child_process';

function launch(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => finish(false));
      child.unref();
      setTimeout(() => finish(true), 300);
    } catch {
      finish(false);
    }
  });
}

export async function openBrowser(url: string): Promise<boolean> {
  if (process.platform === 'win32') {
    // `start` 是 cmd 内建命令，第一个空串参数是窗口标题占位，不能省
    return launch('cmd', ['/c', 'start', '', url]);
  }
  if (process.platform === 'darwin') return launch('open', [url]);
  return launch('xdg-open', [url]);
}

export async function openPath(target: string): Promise<boolean> {
  if (process.platform === 'win32') return launch('explorer', [target]);
  if (process.platform === 'darwin') return launch('open', [target]);
  return launch('xdg-open', [target]);
}
