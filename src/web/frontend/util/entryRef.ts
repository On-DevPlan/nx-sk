// 条目定位文本与剪贴板复制：条目视图（⧉ 按钮）与侧栏右键菜单共用一份。
// #14 从条目页（pages/entries/index.tsx）原样抽出——文本与行为不变，只是两处消费。
// #18 补一行内部资源定位符（locator）：写法唯一来源是 shared/locator.ts，
// 原有三行 CLI 命令文案逐字不变（行为等价红线）。
import { formatLocator } from '../../../shared/locator.ts';

/**
 * 条目定位文本（点击复制用）：人读的标题 + agent 可直接执行的 CLI。
 * 条目是唯一存储单元，命令只认条目 id；条目模板只在创建初始化时用过，
 * 后续读写不参与定位，所以这里不生成 `--template` 参数。
 */
export function entryRefText(entry: { id: string; title: string }) {
  return [
    `nx-sk 条目「${entry.title}」(${entry.id})`,
    `读: nx-sk entry get ${entry.id}`,
    `改: nx-sk entry update ${entry.id} --set 字段=值`,
    `定位: ${formatLocator({ kind: 'entry', entryId: entry.id })}`,
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

