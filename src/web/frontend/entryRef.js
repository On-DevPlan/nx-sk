// 条目定位文本 + 脏值比较：详情面板与栏目视图都要用，放一起免得抄两份。
//
// 定位文本是**人读的路径 + agent 可直接执行的 CLI**：id 与标题都带——标题可能重名/被改，
// id 是唯一事实；命令里用 id 定位最稳。
export function entryRefText(section, entry) {
  return [
    `nx-sk 条目 · 栏目「${section.title}」(${section.id}) › 条目「${entry.title}」(${entry.id})`,
    `读: nx-sk entry get --section ${section.id} ${entry.id}`,
    `改: nx-sk entry update --section ${section.id} ${entry.id} --set 字段=值`,
  ].join('\n');
}

// 脏值比较用：对象/数组（tags、entrylist 的行）必须走 JSON 序列化——
// String(obj) 恒为 '[object Object]'，会把「没改」误判成「每处都改了」
export const norm = (x) => (x === null || x === undefined ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)));
