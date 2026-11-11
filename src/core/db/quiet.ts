// node:sqlite 的 ExperimentalWarning 抑制（**必须在 import node:sqlite 之前执行**）。
//
// 为什么要单独一个模块：ESM 的静态 import 会被提升到模块体之前，所以写在
// driver.ts 顶部的手写代码拦不住；只有「先 import 一个装着过滤器的模块」，
// 才能保证过滤器在 node:sqlite 求值之前装好（依赖按 import 声明顺序求值）。
//
// 不抑制的后果：每次 CLI 调用都会往 stderr 打一行
//   (node:...) ExperimentalWarning: SQLite is an experimental feature ...
// 而冒烟测试对 CLI 子进程的 stderr 有断言（失败时整段贴出来），全都会被污染。
//
// 只吞 ExperimentalWarning，其余 warning 照常打 —— 别的实验性 API 该看见还是要看见。
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning') return;
  const name = (w && w.name) || 'Warning';
  const message = (w && w.message) || String(w);
  console.error(`${name}: ${message}`);
});
