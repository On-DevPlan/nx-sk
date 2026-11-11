// 条目定位文本与剪贴板复制：条目视图（⧉ 按钮）与侧栏右键菜单共用一份。
// #14 从 modules/entries/view.tsx 原样抽出——文本与行为不变，只是两处消费。

/**
 * 条目定位文本（点击复制用）：人读的路径 + agent 可直接执行的 CLI。
 * id 与标题都带——标题可能重名/被改，id 是唯一事实；命令里用 id 定位最稳。
 */
export function entryRefText(section: { id: string; title: string }, entry: { id: string; title: string }) {
  return [
    `nx-sk 条目 · 栏目「${section.title}」(${section.id}) › 条目「${entry.title}」(${entry.id})`,
    `读: nx-sk entry get --section ${section.id} ${entry.id}`,
    `改: nx-sk entry update --section ${section.id} ${entry.id} --set 字段=值`,
  ].join('\n');
}

/**
 * 复制文本：优先剪贴板 API，被拒（非安全上下文/权限）时退回 textarea+execCommand。
 * 返回是否走了 API 直路——调用方按它决定 toast 文案（与抽出前的两条分支一致）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return false;
  }
}
