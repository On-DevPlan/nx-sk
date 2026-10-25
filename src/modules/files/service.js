// 附件（file）：统一附件库的业务编排。物理文件操作在 core/attachments.js，
// 台账（store.files）的读写走 store.js——和 entries 一样的「两趟」结构：
// 先在事务外完成文件移动/复制，再在 mutateStore 事务里改台账。
import { loadStore, mutateStore } from '../../core/store.js';
import { displayPath, filesDir } from '../../core/paths.js';
import { badInput, external, notFound } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { openPath } from '../../core/open.js';
import {
  CATEGORY_IDS, collectFileSections, describeFile, fileReferences,
  deletePhysical, fileRecordAbs, findFileRecord, importContent, importLocalFile,
  relocateFile, restoreFile, streamRecord,
} from '../../core/attachments.js';

function mustFind(store, ref) {
  const r = findFileRecord(store, ref);
  if (!r) throw notFound(`找不到附件: ${ref}（用 'nx-sk file list' 看现有附件）`);
  return r;
}

function assertCategory(cat) {
  if (!cat) return null;
  if (!CATEGORY_IDS.includes(cat)) {
    throw badInput(`分类只能是 ${CATEGORY_IDS.join(' / ')}，收到 ${JSON.stringify(cat)}`);
  }
  return cat;
}

/**
 * 列附件。组织方式**完全由栏目驱动**：`sections` 给出「哪些栏目在引用附件」，
 * `section` 参数按栏目过滤（`none` = 只列没有任何条目引用的）。不预定义分类/槽位。
 */
export async function listFiles({ category, q, section, limit = 0, offset = 0 } = {}) {
  const store = await loadStore();
  assertCategory(category);
  const withRefs = store.files.map((rec) => ({ rec, usedBy: fileReferences(store, rec) }));
  let list = withRefs;
  if (category) list = list.filter((x) => x.rec.category === category);
  if (section === 'none' || section === 'unlinked') {
    list = list.filter((x) => !x.usedBy.length);
  } else if (section) {
    const sec = store.sections.find((s) => s.id === section);
    if (!sec) throw notFound(`找不到栏目: ${section}`);
    list = list.filter((x) => x.usedBy.some((u) => u.sectionId === sec.id));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((x) => [
      x.rec.name, x.rec.note, x.rec.originalName, ...x.rec.tags,
      ...x.usedBy.map((u) => `${u.sectionTitle} ${u.entryTitle} ${u.fieldLabel}`),
    ].join('\n').toLowerCase().includes(needle));
  }
  list = list.slice().sort((a, b) => String(b.rec.createdAt || '').localeCompare(String(a.rec.createdAt || '')));
  // 分页只切「过滤后的列表」；total 仍是全库数量（面板顶部的「全部」用它）。
  // limit=0 表示不分页（CLI / 测试沿用旧行为，避免一次拉全库进浏览器导致 OOM）。
  const filtered = list.length;
  const size = Number(limit) > 0 ? Number(limit) : filtered;
  const start = Math.max(0, Number(offset) || 0);
  const pageList = size > 0 ? list.slice(start, start + size) : [];
  let totalBytes = 0;
  for (const r of store.files) totalBytes += r.bytes;
  // 分组素材：带 file 或 md 字段的栏目（栏目驱动）及其引用数
  const sections = collectFileSections(store).map((s) => ({
    ...s, count: withRefs.filter((x) => x.usedBy.some((u) => u.sectionId === s.id)).length,
  }));
  return {
    count: filtered,
    total: store.files.length,
    totalBytes,
    unlinked: withRefs.filter((x) => !x.usedBy.length).length,
    root: displayPath(filesDir()),
    rootRaw: filesDir(),
    sections,
    page: { limit: size, offset: start, count: pageList.length, total: filtered, hasMore: start + pageList.length < filtered },
    files: pageList.map((x) => describeFile(x.rec, store)),
  };
}

export async function getFile(ref) {
  const store = await loadStore();
  // 带 store：顺带反查「被哪些条目引用」
  return describeFile(mustFind(store, ref), store);
}

export async function addFile(patch = {}) {
  const dryRun = patch['dry-run'];
  assertCategory(patch.category);
  const store = await loadStore();

  let outcome;
  if (patch.path) {
    outcome = await importLocalFile(store, {
      path: patch.path,
      category: patch.category || undefined,
      copy: patch.copy === true,
      tags: patch.tags,
      note: patch.note,
      name: patch.name,
      dryRun,
    });
  } else if (patch.content !== undefined) {
    outcome = await importContent(store, {
      content: patch.content,
      name: patch.name,
      category: patch.category || undefined,
      tags: patch.tags,
      note: patch.note,
      dryRun,
    });
  } else {
    throw badInput('导入附件需要：--path <本机路径>（默认移动，--copy 仅复制），或 Web 上传内容 --content <base64> --name <文件名>');
  }

  if (outcome.duplicate) {
    return { status: 'ok', duplicated: true, id: outcome.record.id, ...describeFile(outcome.record) };
  }
  if (dryRun) return { status: 'skipped', dryRun: true, wouldAdd: describeFile(outcome.record) };

  await mutateStore((s) => { s.files.push(outcome.record); });
  return {
    status: 'ok', created: true, moved: outcome.moved === true,
    ...describeFile(outcome.record),
  };
}

export async function updateFile(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  assertCategory(patch.category);
  const store = await loadStore();
  const target = mustFind(store, ref);

  const hasPhysicalChange = patch.category !== undefined || patch.name !== undefined;
  const hasMetaChange = patch.tags !== undefined || patch.note !== undefined;
  if (!hasPhysicalChange && !hasMetaChange) {
    throw badInput('没有要改的内容：--name / --category / --tags / --note');
  }
  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldChange: {
        category: patch.category ?? target.category, name: patch.name ?? target.name,
        tags: patch.tags ?? target.tags, note: patch.note ?? target.note,
      },
    };
  }

  // 物理文件先改（失败即抛，台账不动）
  const relocated = hasPhysicalChange
    ? await relocateFile(store, target, {
      category: patch.category ?? target.category,
      name: patch.name ?? target.name,
    })
    : target;
  await mutateStore((s) => {
    const r = mustFind(s, target.id);
    r.rel = relocated.rel;
    r.name = relocated.name;
    r.category = relocated.category;
    if (patch.tags !== undefined) r.tags = patch.tags.map(String);
    if (patch.note !== undefined) r.note = String(patch.note);
    r.updatedAt = nowIso();
  });
  const after = await loadStore();
  return { status: 'ok', id: target.id, ...describeFile(mustFind(after, target.id)) };
}

export async function removeFile(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = mustFind(store, ref);
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldRemove: { id: target.id, name: target.name, category: target.category } };
  }
  // 先删物理文件（Windows 上文件被占用会直接抛错，台账保持不变）
  await deletePhysical(target);
  await mutateStore((s) => { s.files = s.files.filter((x) => x.id !== target.id); });
  return { status: 'ok', removed: { id: target.id, name: target.name, category: target.category } };
}

/**
 * 一键清理**未被任何条目引用**的附件（孤儿附件）。
 *
 * 判据与「附件中心」的「未引用」筛选片**完全同一套**（`fileReferences` 为空）：
 * 没有任何条目的 file 字段引用它、正文里也没有引用它的图。
 *
 * 为什么值得一键做：附件库是「导入即进库」，批量导入 SOP 截图、临时传一份再删
 * 都会留下孤儿——它们既占空间，又在附件中心混在真资料里。逐个删是折磨。
 *
 * 不可撤销（物理原件一起删），所以：
 *   - 面板侧先弹确认，列出将删的数量与体积；
 *   - CLI 侧有 --dry-run，先看清单再动手。
 */
export async function cleanupUnreferenced(patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const orphans = store.files.filter((rec) => !fileReferences(store, rec).length);
  if (!orphans.length) {
    // 已经是期望状态（没有孤儿）→ skipped，不是失败
    return { status: 'skipped', count: 0, removed: [], reason: '没有未引用的附件' };
  }
  const brief = orphans.map((r) => ({
    id: r.id, name: r.name, category: r.category, bytes: r.bytes, path: displayPath(fileRecordAbs(r)),
  }));
  if (dryRun) {
    return { status: 'skipped', dryRun: true, count: orphans.length, wouldRemove: brief };
  }
  // 先删物理文件（失败即抛，台账不动）——不能出现「台账没了、文件还在」的中间态
  for (const rec of orphans) await deletePhysical(rec);
  const ids = new Set(orphans.map((r) => r.id));
  await mutateStore((s) => { s.files = s.files.filter((x) => !ids.has(x.id)); });
  return { status: 'ok', count: orphans.length, removed: brief };
}

/** CLI 的 file content：给出物理路径与链接（不直接吐二进制，终端里没法看）。 */
export async function contentInfo(ref, { download } = {}) {
  const store = await loadStore();
  return { ...describeFile(mustFind(store, ref)), download: !!download };
}

/** HTTP 原始流：由 api.js 在 action.raw 时直接委派。 */
export async function serveRaw(ctx, { res }) {
  const store = await loadStore();
  const rec = mustFind(store, ctx.ref);
  await streamRecord(res, rec, { download: ctx.download === true });
}

export async function restoreFileAction(ref, patch = {}) {
  const dryRun = patch['dry-run'];
  const store = await loadStore();
  const target = mustFind(store, ref);
  const exportCopy = patch.copy === true;
  if (!target.sourcePath && !patch.to && !exportCopy) {
    throw badInput('这是 Web 上传的附件、没有原始位置：给 --to <目标目录>，或加 --copy 只导出副本');
  }
  if (dryRun) {
    return {
      status: 'skipped', dryRun: true,
      wouldRestore: { to: patch.to || (target.sourcePath ? displayPath(target.sourcePath) : ''), copy: exportCopy },
    };
  }
  const r = await restoreFile(store, target, { to: patch.to, copy: exportCopy });
  if (!exportCopy) {
    await mutateStore((s) => { s.files = s.files.filter((x) => x.id !== target.id); });
  }
  // restored 标记：renderFileChange 靠它区分「还原」与「更新」——
  // 两者的 payload 都带 path，只看 path 会把 update 误报成还原（旧 bug）。
  return { status: 'ok', restored: true, exported: exportCopy, kept: r.kept, path: r.path, displayPath: r.displayPath };
}

export async function openFileAction(ref) {
  const store = await loadStore();
  const rec = mustFind(store, ref);
  const ok = await openPath(fileRecordAbs(rec));
  if (!ok) throw external(`系统拒绝打开: ${rec.name}`);
  return { status: 'ok', opened: rec.name, path: displayPath(fileRecordAbs(rec)) };
}

// —— CLI 人读渲染 ——
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function refLabel(u) {
  return `${u.sectionTitle} / ${u.entryTitle || '（无名）'} / ${u.fieldLabel}`;
}

export function renderFileList(d) {
  const lines = [`附件库 ${d.total} 个 · 共 ${fmtBytes(d.totalBytes)} · 目录 ${d.root}`];
  lines.push(`被条目引用 ${d.total - d.unlinked} / ${d.total}（未引用 ${d.unlinked} 个）`);
  if (d.sections.length) lines.push(`栏目：${d.sections.map((s) => `${s.title}(${s.count})`).join('　')}`);
  for (const r of d.files) {
    lines.push(`  ${r.id}  [${r.categoryLabel}] ${r.name}　${fmtBytes(r.bytes)}`);
    if (r.usedBy?.length) lines.push(`      被引用: ${r.usedBy.map(refLabel).join('、')}`);
    if (r.note) lines.push(`      备注: ${r.note}`);
  }
  lines.push('', '导入: nx-sk file add --path <文件>（默认移动）　链接: 在栏目条目的 file 字段选本附件，或在 md 正文写 ![说明](本附件id)');
  return lines.join('\n');
}

export function renderFileGet(d) {
  const lines = [
    `${d.name}（${d.id}）· ${d.categoryLabel} · ${fmtBytes(d.bytes)}`,
    `路径:   ${d.displayPath}`,
    `链接:   ${d.url}`,
  ];
  if (d.usedBy?.length) lines.push(`被引用: ${d.usedBy.map(refLabel).join('、')}`);
  else lines.push('被引用: （没有条目引用；在栏目的 file 字段里选本附件，或在 md 正文里写 ![说明](本附件id) 即建立链接）');
  if (d.sourceDisplay) lines.push(`原始:   ${d.sourceDisplay}（${d.mode === 'move' ? '移动导入' : '复制导入'}）`);
  if (d.tags.length) lines.push(`标签:   ${d.tags.join('、')}`);
  if (d.note) lines.push(`备注:   ${d.note}`);
  return lines.join('\n');
}

export function renderFileChange(d) {
  if (d.status === 'skipped') return `试运行（未落盘）：${JSON.stringify(d.wouldAdd || d.wouldChange || d.wouldRemove || d.wouldRestore)}`;
  if (d.removed) return `已删除附件 ${d.removed.name}（${d.removed.id}）`;
  if (d.duplicated) return `库中已有相同文件，未重复存储：${d.name}（${d.id}）`;
  if (d.created) {
    return `已导入附件 ${d.name}（${d.id}）· ${d.categoryLabel}${d.moved ? ' · 原件已移入（nx-sk file restore 可还原）' : ''}`;
  }
  if (d.restored && d.exported) return `已导出副本到 ${d.displayPath}（库中保留原件）`;
  if (d.restored) return `已还原到 ${d.displayPath}（台账记录已撤销）`;
  return `已更新附件 ${d.name}（${d.id}）`;
}

export function renderFileCleanup(d) {
  if (d.dryRun) {
    const lines = [`试运行（未落盘）：将清理 ${d.count} 个未引用的附件`];
    for (const r of d.wouldRemove || []) lines.push(`  ${r.id}  ${r.name}　${fmtBytes(r.bytes)}`);
    lines.push('确认无误后去掉 --dry-run 即可执行。');
    return lines.join('\n');
  }
  if (d.status === 'skipped') return `没有未引用的附件，无需清理`;
  const lines = [`已清理 ${d.count} 个未引用的附件（物理原件一并删除，不可撤销）`];
  for (const r of d.removed || []) lines.push(`  ${r.id}  ${r.name}　${fmtBytes(r.bytes)}`);
  return lines.join('\n');
}

export function renderContent(d) {
  return `${d.name}（${d.id}）\n路径: ${d.displayPath}\n浏览器链接: ${d.url}${d.download ? d.downloadUrl : ''}`;
}

export function renderOpen(d) {
  return `已用系统默认程序打开：${d.opened}　${d.path}`;
}
