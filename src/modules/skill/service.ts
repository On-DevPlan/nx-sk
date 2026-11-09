// skill 分发：`skill install` 让识别 ~/.claude/skills 的 agent 学会用 nx-sk；
// `skill get` 让**不读那个目录**的外部 agent 一次性拿到全上下文（prefix + 文档 + install 状态）。
// 两条解决的是不同场景，缺一即单边能力归零——所以它们平级，不是补充关系。
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ASSETS_DIR, SKILL_NAME, assertSafeName, displayPath } from '../../core/paths.ts';
import { copyTree, diffTrees, ensureDir, listFiles, pathExists, readFileText, removeTree } from '../../core/fsx.ts';
import { badInput, notFound } from '../../core/errors.ts';

export const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** CLI / HTTP 传入的原始参数：类型由 flags 声明保证。 */
interface SkillOptions {
  name?: string;
  all?: boolean;
  to?: string;
  force?: boolean;
  mode?: string;
  ref?: string;
  'dry-run'?: boolean;
}

export async function listSkills() {
  let names: string[] = [];
  try {
    const items = await fsp.readdir(ASSETS_DIR, { withFileTypes: true });
    names = items.filter((i) => i.isDirectory()).map((i) => i.name).sort();
  } catch { /* assets 缺失 */ }
  const out = [];
  for (const n of names) {
    const src = join(ASSETS_DIR, n);
    const files = await listFiles(src);
    const refs = files.filter((f) => f.startsWith('references/'));
    out.push({
      name: n,
      assetsPath: displayPath(src),
      files: files.length,
      refs: refs.map((r) => r.replace(/^references\//, '').replace(/\.md$/, '')),
      hasSkillMd: files.includes('SKILL.md'),
    });
  }
  return { count: out.length, defaultTarget: displayPath(DEFAULT_SKILLS_DIR), skills: out };
}

async function resolveSkillSource(name?: string) {
  const n = assertSafeName(name || SKILL_NAME, 'skill 名');
  const src = join(ASSETS_DIR, n);
  if (!(await pathExists(join(src, 'SKILL.md')))) {
    const { skills } = await listSkills();
    throw notFound(`未找到内置 skill: ${n}（可用: ${skills.map((s) => s.name).join(', ') || '（无）'}）`);
  }
  return { name: n, src };
}

/**
 * 三态安装，**不静默覆盖**用户目录里的东西。
 *
 * 两种模式（骨架 ref 的 `--mode <symlink|copy>`）：
 * - `copy`（默认，**规范默认**）：把 `assets/<name>` 复制过去。装出来的是副本，
 *   不受项目目录移动影响，适合 `npx` 分发到别人机器上；代价是改了 `assets/` 不会跟着走。
 * - `symlink`：把目标**软链**到项目里的源 —— 这就是「shim 到全局」。改代码立刻生效、
 *   永不漂移，适合本机开发（用户目录里那些 skill 本来就是这么挂的）。
 */
export async function installSkill({ name, all, to, force, mode, 'dry-run': dryRun }: SkillOptions = {}): Promise<any> {
  // TODO(P4): 返回体有 ok / skipped / conflict / dry-run 多种形态，暂未逐形态建模
  // --all：装齐 assets/ 下全部 skill，且**直接覆盖**（force 恒开，不用再补 --force）。
  // 范围取目录扫描（事实源 assets/<x>/SKILL.md）——不依赖任何分组表，
  // 新加 skill 就算没登记也装得上。要保留目标目录里的本地改动就别用 --all。
  if (all) {
    if (name && String(name).trim()) {
      throw badInput('--all 与 [name] 互斥；--all 会安装全部 skill');
    }
    const { skills } = await listSkills();
    const targets = skills.filter((s) => s.hasSkillMd).map((s) => s.name);
    if (!targets.length) throw notFound('assets/ 下没有可分发的 skill（缺 SKILL.md？）');
    const results = [];
    for (const n of targets) {
      const r = await installSkill({ name: n, to, force: true, mode, 'dry-run': dryRun });
      results.push({ skill: n, ...r });
    }
    return {
      status: 'ok',
      all: true,
      mode: mode === 'symlink' ? 'symlink' : 'copy',
      dryRun: !!dryRun,
      count: results.length,
      skills: results,
    };
  }
  const { name: n, src } = await resolveSkillSource(name);
  const dst = join(resolve(to || DEFAULT_SKILLS_DIR), n);
  const wantsLink = mode === 'symlink';

  if (wantsLink) return installAsLink({ src, dst, force, dryRun });

  const files = await diffTrees(src, dst);
  if (!files.length) return { status: 'ok', skipped: true, path: displayPath(dst), pathRaw: dst, files: 0 };

  const exists = await pathExists(dst);
  if (exists && !force) {
    return {
      status: 'conflict', path: displayPath(dst), pathRaw: dst, files, count: files.length,
      hint: '目标已存在且内容不同。确认要覆盖就加 --force（内容一致时不会走到这里）。',
    };
  }
  if (dryRun) {
    return { status: 'skipped', dryRun: true, wouldInstall: { path: displayPath(dst), replaced: exists, files: files.length, diff: files } };
  }

  if (exists) await removeTree(dst);
  await copyTree(src, dst);
  return { status: 'ok', installed: !exists, replaced: exists, path: displayPath(dst), pathRaw: dst, files: files.length };
}

/** 软链模式：目标是项目里的源，改完立刻生效。三态照旧（不静默覆盖）。 */
async function installAsLink({ src, dst, force, dryRun }: { src: string; dst: string; force?: boolean; dryRun?: boolean }) {
  const st = await fsp.lstat(dst).catch(() => null);
  const pointsAtSrc = st && st.isSymbolicLink() && resolve(await fsp.realpath(dst).catch(() => '')) === resolve(src);

  if (pointsAtSrc) {
    return {
      status: 'ok', skipped: true, mode: 'symlink', files: 0,
      path: displayPath(dst), pathRaw: dst, target: displayPath(src),
    };
  }

  const kind = st ? (st.isSymbolicLink() ? '软链（指向别处）' : '真实目录') : null;
  if (st && !force) {
    return {
      status: 'conflict', mode: 'symlink', path: displayPath(dst), pathRaw: dst,
      existing: kind, target: displayPath(src),
      hint: `目标已存在（${kind}）。改成软链会动它，确认就加 --force。`,
    };
  }
  if (dryRun) {
    return {
      status: 'skipped', dryRun: true, wouldInstall: { mode: 'symlink', path: displayPath(dst), target: displayPath(src), replaced: !!st },
    };
  }

  if (st) await removeTree(dst);
  await ensureDir(join(dst, '..'));   // symlink 不会自建父目录（copyTree 会），不补这步就 ENOENT
  // Windows 上用 junction：目录软链需要特权（或开发者模式），junction 不需要。
  await fsp.symlink(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    status: 'ok', mode: 'symlink', installed: !st, replaced: !!st, files: 0,
    path: displayPath(dst), pathRaw: dst, target: displayPath(src),
  };
}

/**
 * ref 解析规则（agent 一键输入，输入门槛最低优先）：
 *   缺省                     → SKILL.md
 *   含分隔符或 ./\ 开头       → 相对 assets/<name>/ 解析
 *   裸名                     → 先 references/<名>.md，再 <名>.md，再 <名>
 *   `..` 或绝对路径           → 拒绝
 */
export async function resolveRef(name: string, ref: unknown) {
  const raw = String(ref ?? '').trim();
  if (raw.includes('..')) throw badInput("ref 路径不允许包含 '..'");
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) throw badInput(`ref 越界: ${raw}`);

  const base = join(ASSETS_DIR, name);
  if (!raw) return { rel: 'SKILL.md', abs: join(base, 'SKILL.md') };
  if (raw.includes('/') || raw.includes('\\') || raw.startsWith('.')) {
    const rel = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    if (rel.includes('..')) throw badInput("ref 路径不允许包含 '..'");
    return { rel, abs: join(base, rel) };
  }
  const candidates = [`references/${raw}.md`, `${raw}.md`, raw];
  for (const c of candidates) {
    const abs = join(base, c);
    if (await pathExists(abs)) return { rel: c, abs };
  }
  const refs = (await listFiles(join(base, 'references'))).map((f) => f.replace(/\.md$/, ''));
  throw badInput(`未知 ref: ${raw}（可用: ${refs.join(', ') || '（无）'}；也可直接写 references/xxx.md）`);
}

export async function getSkill({ name, ref, to, force, mode, 'dry-run': dryRun }: SkillOptions = {}) {
  const { name: n } = await resolveSkillSource(name);
  const { rel, abs } = await resolveRef(n, ref);
  const content = await readFileText(abs);
  // `skill get` 永远给文档——哪怕目标是 conflict 状态，文档也照常输出。
  // 「目标端有 diff」是用户的决策范畴，不是 agent 的中止信号。
  const install = await installSkill({ name: n, to, force, mode, 'dry-run': dryRun });
  return {
    skillName: n,
    ref: rel,
    content,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    install,
  };
}

// —— 人读渲染：prefix → 文档 → install 状态，**三段顺序固定** ──
// 顺序为什么重要：部分 agent 输出过长会自动截断——prefix 必须在最前告诉它
// 「这是哪个 skill、建议把内容复制到自己可访问的路径」，否则它拿到一坨文档不知道要干什么。
export function renderSkillContext(d: Awaited<ReturnType<typeof getSkill>>) {
  const sentinel = '# --- begin skill content (do not modify this line) ---';
  const prefix = [
    `# === nx-sk skill context ===`,
    `# 以下内容来自 nx-sk skill \`${d.skillName}\` 的 ${d.ref}。`,
    '# nx-sk 是本机个人资源管理器（栏目化存个人信息与大模型密钥，CLI 与 Web 同源）。',
    '# 如果你（agent）不能直接读取 ~/.claude/skills 目录，请把下面 sentinel 之间、',
    '# 到下一处 "-- install 状态 --" 之前的内容**完整复制**到你自己的上下文或可访问的文件里，',
    '# 然后按文档里的命令操作用户的本机数据。',
    sentinel,
  ].join('\n');
  const install = renderInstall(d.install);
  return `${prefix}\n\n${d.content}\n\n-- install 状态 --\n${install}`;
}

export function renderInstall(r: Awaited<ReturnType<typeof installSkill>>) {
  if (!r) return '（未知）';
  // --all：装齐全部（显式字段判别，先于单 skill 的三态分支）
  if (r.all) {
    const how = r.dryRun ? '试运行，未落盘' : r.mode === 'symlink' ? '软链，已覆盖' : '副本，已覆盖';
    const lines = [`--all：${r.count} 个 skill（${how}）`];
    for (const s of r.skills) {
      const state = s.status === 'conflict' ? '冲突'
        : s.skipped ? '已是最新'
          : s.mode === 'symlink' ? '已软链'
            : s.installed ? '已安装' : s.replaced ? '已替换' : '完成';
      lines.push(`  ${String(s.skill).padEnd(14)} ${state} ${s.path || ''}`);
    }
    return lines.join('\n');
  }
  if (r.status === 'skipped' && r.dryRun) return `试运行：将装到 ${r.wouldInstall.path}（${r.wouldInstall.files} 个文件，替换已有: ${r.wouldInstall.replaced ? '是' : '否'}）`;
  if (r.skipped) return `已是最新: ${r.path}${r.mode === 'symlink' ? `（已软链到 ${r.target}）` : '（与内置内容一致，无差异）'}`;
  if (r.status === 'conflict' && r.mode === 'symlink') {
    return `冲突: ${r.path} 已存在（${r.existing}）。改软链会动它，确认：nx-sk skill install ${SKILL_NAME} --mode symlink --force`;
  }
  if (r.status === 'conflict') return `冲突: ${r.path} 已存在且内容不同（${r.count} 个文件有差异）。确认覆盖：nx-sk skill install ${SKILL_NAME} --force`;
  if (r.mode === 'symlink') return `已软链: ${r.path} → ${r.target}（改项目里的源码立刻生效）`;
  if (r.installed) return `已安装: ${r.path}（${r.files} 个文件）`;
  if (r.replaced) return `已替换: ${r.path}（${r.files} 个文件）`;
  return `完成: ${r.path}`;
}

export function renderSkillList(d: Awaited<ReturnType<typeof listSkills>>) {
  const lines = [`内置 skill ${d.count} 个　默认安装位置: ${d.defaultTarget}`];
  for (const s of d.skills) {
    lines.push(`  ${s.name.padEnd(12)} ${s.files} 个文件　refs: ${s.refs.join(', ') || '（无）'}`);
  }
  lines.push('', `装到本机: nx-sk skill install ${SKILL_NAME}`);
  lines.push(`给外部 agent 取上下文: nx-sk skill get ${SKILL_NAME} --json`);
  return lines.join('\n');
}
