// 附件列表的「就地合并」。
//
// 这是一次真实故障的回归测试：Ctrl+V 贴图后，图已经进了附件中心，字段里却一直显示
// 「图片缺失」。根因是附件列表**带缓存** —— 上传完再 `listAttachments()` 拿到的还是
// 挂载时那份，新 id 不在表里；而预览是按 id 查表渲染的。
// 这种错不报异常、只是显示不对，只能靠断言钉住。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { mergeFiles } = await import('../../src/web/frontend/api/files.js');

test('mergeFiles：刚上传的记录立刻可查（不必等列表刷新）', () => {
  const stale = [{ id: 'f_old', name: '旧图.png', url: '/api/files/f_old/content' }];
  const fresh = [{ id: 'f_new', name: '粘贴截图.png', url: '/api/files/f_new/content' }];
  const list = mergeFiles(stale, fresh);
  assert.equal(list[0].id, 'f_new', '新记录放最前，下拉框里一眼能看到');
  assert.equal(list.length, 2);
  assert.ok(list.some((f) => f.id === 'f_new'), '预览按 id 查表时必须查得到');
});

test('mergeFiles：重复粘贴同一张图不会出现两条（服务端返回已有 id）', () => {
  const prev = [{ id: 'f_1', name: '图.png', url: '/api/files/f_1/content' }];
  const list = mergeFiles(prev, [{ id: 'f_1', name: '图.png', url: '/api/files/f_1/content' }]);
  assert.equal(list.length, 1);
});

test('mergeFiles：空入参不制造新数组（避免无意义的重渲染）', () => {
  const prev = [{ id: 'f_1' }];
  assert.equal(mergeFiles(prev, []), prev);
  assert.equal(mergeFiles(prev, null), prev);
  assert.deepEqual(mergeFiles(null, [{ id: 'f_2' }]), [{ id: 'f_2' }]);
});
