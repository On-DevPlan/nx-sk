// 端到端冒烟：真起服务、真跑 CLI、真发 HTTP。
// 全部在临时 NX_SK_HOME 里跑 —— 绝不碰用户真实的 ~/nx-sk/store.json。
// 破坏性路径用 --dry-run 覆盖，最后一步才真删（删的是测试自己造的那条）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'nx-sk.mjs');
const NODE = process.execPath;

const home = await mkdtemp(join(tmpdir(), 'nx-sk-smoke-'));
const env = { ...process.env, NX_SK_HOME: home, NX_SK_STORE: join(home, 'store.json') };
delete env.NX_SK_PASSPHRASE;

let passed = 0;
const step = (name, ok, extra = '') => {
  passed++;
  process.stdout.write(`  ok ${String(passed).padStart(2)} · ${name}${extra ? `　${extra}` : ''}\n`);
  if (!ok) throw new Error(`断言失败: ${name}`);
};

function cli(args, { expectFail = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, ...args], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      if (!expectFail) assert.equal(code, 0, `CLI 失败: nx-sk ${args.join(' ')}\nstdout: ${out}\nstderr: ${err}`);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

async function cliJson(args) {
  const { out } = await cli([...args, '--json']);
  return JSON.parse(out);
}

/** 期望失败的命令：`--json` 下错误是 stdout 上的单个 JSON 值（agent 的解析协议）。 */
async function cliError(args) {
  const { out, err } = await cli([...args, '--json'], { expectFail: true });
  try {
    return JSON.parse(out);
  } catch {
    return { code: null, error: `${out}\n${err}`.trim() };
  }
}

/** 裸 HTTP：用来测 Origin 头这类浏览器侧行为（fetch 对某些头有额外处理）。 */
function rawRequest(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const h = { ...headers };
    if (body) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 1. CLI 全链路 ────────────────────────────────────────────
process.stdout.write('\n[1] CLI\n');

const boot = await cliJson(['bootstrap']);
step('bootstrap 给出上下文', boot.app.name === 'nx-sk' && boot.counts.sections >= 2);
step('第一个栏目是「求职」', boot.sections[0].id === 'job' && boot.sections[0].title === '求职', `${boot.sections.length} 个栏目`);
step('存储落在隔离的临时目录', boot.storePathRaw.startsWith(home), boot.storePath);

const ver = await cli(['version']);
step('version 裸输出', /^\d+\.\d+\.\d+$/.test(ver.out), ver.out);

const help = await cli(['help']);
step('help 由声明生成且含模块分组', help.out.includes('entry') && help.out.includes('栏目'));

const templates = await cliJson(['section', 'templates']);
step('section templates 列出内置模板',
  ['job', 'secret', 'projects', 'internships', 'campus', 'deploy'].every((id) => templates.templates.some((t) => t.id === id)),
  `${templates.templates.length} 个模板`);

const fields = await cliJson(['entry', 'fields', '--section', 'job']);
const fieldKeys = new Set(fields.sections[0].fields.map((f) => f.key));
step('字段字典含关键字段', ['name', 'phone', 'targetPosition', 'expectCities'].every((k) => fieldKeys.has(k)), `${fieldKeys.size} 个字段`);
step('字段字典标注了密文字段', fields.sections[0].fields.every((f) => f.sensitive === false));

const added = await cliJson(['entry', 'add', '--section', 'job', '--set', '姓名=冒烟测试', '--set', '电话=13800000000', '--set', '期望城市=北京、上海']);
step('entry add 自动取名并算完整度', added.created === true && added.title === '冒烟测试', `完整度 ${added.completeness.ratio}%`);

const got = await cliJson(['entry', 'get', '冒烟测试']);
step('entry get 用名字定位', got.values.name === '冒烟测试' && got.section === 'job');
step('tags 字段被强转成数组', Array.isArray(got.values.expectCities) && got.values.expectCities.length === 2);

const dup = await cliError(['entry', 'add', '--section', 'job', '--set', '姓名=冒烟测试']);
step('重复 add 报 CONFLICT（不静默 upsert）', dup.code === 'CONFLICT');

const noArg = await cliError(['entry', 'add', '--section', 'job']);
step('缺参数报错带「用法:」锚点', noArg.code === 'INVALID_INPUT' && noArg.error.includes('用法:'));

const autoField = await cliJson(['entry', 'update', '冒烟测试', '--set', '技术博客=https://example.com', '--set', '是否有offer=否']);
step('字典里没有的字段**直接写**（自动登记，不再报错）', autoField.status === 'ok' && autoField.newFields.includes('技术博客'), autoField.newFields.join(','));
const afterAuto = await cliJson(['entry', 'get', '冒烟测试']);
step('自动登记的字段立刻可读', afterAuto.values['技术博客'] === 'https://example.com');
step('自动登记时推断 bool（是/否 不存成文本）', afterAuto.values['是否有offer'] === false);
const ledger = await cliJson(['entry', 'fields', '--section', 'job']);
step('新字段进了台账（已知字段 = 模板建议 + 写过的）', ledger.sections[0].fields.some((f) => f.key === '技术博客'));
step('中文键直接可用（不必记英文别名）', ledger.sections[0].fields.some((f) => f.key === '是否有offer'));

// ─── 栏目 ZIP 导出 / 导入 ─────────────────────────────────────
const zipPath = join(home, 'job-export.zip');
const exp = await cliJson(['transfer', 'export', 'job', '--out', zipPath]);
step('transfer export 打出栏目 ZIP', exp.bytes > 0 && exp.entries >= 1, `${exp.entries} 条目 / ${exp.bytes}B`);

const zpv = await cliJson(['transfer', 'import', 'jobcopy', '--file', zipPath, '--dry-run']);
step('transfer import --dry-run 只预览、不建栏目', zpv.status === 'preview' && zpv.section.willCreate === true && zpv.entries.total === exp.entries);

const zimp = await cliJson(['transfer', 'import', 'jobcopy', '--file', zipPath]);
step('transfer import 新建栏目并导入条目', zimp.section.created === true && zimp.entries.added === exp.entries, `新增 ${zimp.entries.added}`);

const zgot = await cliJson(['entry', 'get', '冒烟测试', '--section', 'jobcopy']);
step('导入后的条目可读（字段与值都在）', zgot.values.name === '冒烟测试' && zgot.values.phone === '13800000000');

const zskip = await cliJson(['transfer', 'import', 'jobcopy', '--file', zipPath, '--on-conflict', 'skip']);
step('重复导入默认跳过冲突', zskip.entries.skipped === exp.entries && zskip.entries.added === 0);

// 副本栏目里有一条同名条目，会污染后续「按名字定位」的步骤 —— 测完就删
const zrm = await cliJson(['section', 'remove', 'jobcopy', '--force']);
step('清理导入测试的副本栏目', zrm.status === 'ok');

// 精确导出 + 零配置导入
const pickZip = join(home, 'job-pick.zip');
const pexp = await cliJson(['transfer', 'export', 'job', '--entries', '冒烟测试', '--out', pickZip]);
step('transfer export --entries 只导出选中条目', pexp.entries === 1, `${pexp.entries}/${pexp.available}`);

const pnew = await cliJson(['transfer', 'import-new', '--file', pickZip]);
step('零配置导入按包内结构新建栏目', pnew.section.created === true && pnew.section.id !== 'job', pnew.section.id);
const psec = await cliJson(['section', 'get', pnew.section.id]);
step('导入的栏目结构完整', psec.fields > 0 && psec.groups > 0, `${psec.fields} 字段`);
await cliJson(['section', 'remove', pnew.section.id, '--force']);

// 全局多栏目包
const bzip = join(home, 'bundle.zip');
const bexp = await cliJson(['transfer', 'bundle-export', '--sections', 'job,projects', '--out', bzip]);
step('bundle export 打出多栏目包', bexp.sections === 2 && bexp.entries >= 1, `${bexp.sections} 栏目 / ${bexp.entries} 条目`);

const bprev = await cliJson(['transfer', 'bundle-import', '--file', bzip, '--dry-run']);
step('bundle import --dry-run 汇总栏目数', bprev.status === 'preview' && bprev.totals.sections === 2);

const bimp = await cliJson(['transfer', 'bundle-import', '--file', bzip, '--on-conflict', 'skip']);
step('bundle import 默认跳过冲突', bimp.totals.skipped >= 1 && bimp.totals.added === 0);

// 口令加密：导出带口令 → 缺口令/错口令被拒 → 对口令才能进
const encZip = join(home, 'bundle-enc.zip');
const eexp = await cliJson(['transfer', 'bundle-export', '--sections', 'job', '--out', encZip, '--passphrase', 'S1cau!@#']);
step('加密导出标记 encrypted', eexp.encrypted === true);
const eno = await cli(['transfer', 'bundle-import', '--file', encZip, '--dry-run'], { expectFail: true });
step('加密包缺口令被拒（exit!=0）', eno.code !== 0, JSON.stringify(eno.json || {}).slice(0, 90));

const encHead = await readFile(encZip);
step('加密包外层仍是 ZIP（PK 头，系统压缩文件夹能打开）', encHead[0] === 0x50 && encHead[1] === 0x4b);
const eprev = await cliJson(['transfer', 'bundle-import', '--file', encZip, '--dry-run', '--passphrase', 'S1cau!@#']);
step('加密包对口令可预览', eprev.status === 'preview' && eprev.encrypted === true);
const ebad = await cli(['transfer', 'bundle-import', '--file', encZip, '--dry-run', '--passphrase', 'wrong'], { expectFail: true });
step('错口令被拒', ebad.code !== 0);

const updated = await cliJson(['entry', 'update', '冒烟测试', '--set', '目标岗位=后端开发', '--set', '是否应届生=是', '--unset', '电话']);
step('entry update 是 PATCH 语义', updated.changed.includes('targetPosition') && updated.changed.includes('-phone'));

const afterUnset = await cliJson(['entry', 'get', '冒烟测试']);
step('--unset 真的清空', afterUnset.values.phone === null && afterUnset.values.targetPosition === '后端开发');
step('bool 字段被强转', afterUnset.values.isFreshGraduate === true);

const dryRemove = await cliJson(['entry', 'remove', '冒烟测试', '--dry-run']);
step('remove --dry-run 不落盘', dryRemove.status === 'skipped' && dryRemove.dryRun === true);
const stillThere = await cliJson(['entry', 'get', '冒烟测试']);
step('试运行后条目还在', stillThere.id === got.id);

// 密钥 = 极简 KV：名称 → 值。走 key 直通命令（= entry 的语法糖，作用在 kvSection 上）
const secFields = await cliJson(['entry', 'fields', '--section', 'secret']);
step('密钥栏目是单字段 KV', secFields.sections[0].fields.length === 1 && secFields.sections[0].titleField === null,
  `${secFields.sections[0].fields.length} 个字段`);

const secList = await cliJson(['section', 'list']);
step('栏目带 kv 标记（面板据此渲染 KV 表格，不是条目列表）',
  secList.sections.find((s) => s.id === 'secret')?.kv === true
  && secList.sections.find((s) => s.id === 'job')?.kv === false);
step('bootstrap 也要带 kv（它是 agent 的首选入口，不能让 agent 再猜一次）',
  boot.sections.find((s) => s.id === 'secret')?.kv === true);

await cliJson(['key', 'set', 'KV_PROBE', 'sk-probe']);
const kvProbe = await cliJson(['key', 'list']);
step('key list 报出 KV 栏目名', kvProbe.section === 'secret');
const bySection = await cliJson(['key', 'list', '--section', 'secret']);
step('key list --section 可指定 KV 栏目', bySection.count === kvProbe.count);
await cliJson(['key', 'remove', 'KV_PROBE']);

const kvAddField = await cliError(['entry', 'update', 'KV_SHAPE_PROBE', '--set', '随便一个键=值']);
step('不存在的键在 KV 栏目里也走 key set 语义（不会变成字段）',
  kvAddField.code === 'NOT_FOUND');
await cliJson(['key', 'set', 'KV_SHAPE_PROBE', 'v1']);
const kvNoField = await cliError(['entry', 'update', 'KV_SHAPE_PROBE', '--set', '089=123']);
step('KV 栏目拒绝加字段，并指出该用 key set', kvNoField.code === 'INVALID_INPUT' && kvNoField.error.includes('KV 表'));
const stillOne = await cliJson(['entry', 'fields', '--section', 'secret']);
step('拒绝之后字段数没变', stillOne.sections[0].fields.length === 1);
await cliJson(['key', 'remove', 'KV_SHAPE_PROBE']);

const set1 = await cliJson(['key', 'set', 'SMOKE_KEY', 'sk-smoke-1234567890abcdef']);
step('key set 创建', set1.status === 'ok' && set1.created === true && set1.name === 'SMOKE_KEY');

const set2 = await cliJson(['key', 'set', 'SMOKE_KEY', 'sk-smoke-1234567890abcdef']);
step('key set 同值幂等（status=skipped，不重写密文）', set2.status === 'skipped' && set2.unchanged === true);

const set3 = await cliJson(['key', 'set', 'SMOKE_KEY', 'sk-smoke-NEW-0987654321fedcba']);
step('key set 是覆盖语义（KV 的 SET）', set3.status === 'ok' && set3.created === false && set3.replaced === true);

const shown = await cliJson(['key', 'get', 'SMOKE_KEY']);
step('key get 默认给原文（本机自己用，不拦自己）', shown.value === 'sk-smoke-NEW-0987654321fedcba');

const maskedOut = await cliJson(['key', 'get', 'SMOKE_KEY', '--mask']);
step('key get --mask 才打码', maskedOut.value === 'sk-s******dcba', maskedOut.value);
step('打码结果里读不到明文', !JSON.stringify(maskedOut).includes('0987654321fedcba'));

const keyList = await cliJson(['key', 'list']);
step('key list 默认给原文', keyList.count === 1 && keyList.keys[0].value === 'sk-smoke-NEW-0987654321fedcba');
const keyListMasked = await cliJson(['key', 'list', '--mask']);
step('key list --mask 打码', keyListMasked.keys[0].value === 'sk-s******dcba');

const raw = await readFile(join(home, 'store.json'), 'utf8');
step('store.json 里没有密钥明文', !raw.includes('sk-smoke'), '只有 AES-GCM 密文对象');
step('store.json 里落的是密文对象', /"alg": "aes-256-gcm"/.test(raw));

const refuseMask = await cliError(['key', 'set', 'SMOKE_KEY', 'sk-x******zzzz']);
step('拒绝把打码串当新密钥写回', refuseMask.error.includes('打码'));

const keepMask = await cliJson(['key', 'set', 'SMOKE_KEY', 'sk-s******dcba']);
step('写入「当前值的掩码」视为未改动（不把掩码存成新值）', keepMask.status === 'skipped' && keepMask.unchanged === true);
const keepMaskGet = await cliJson(['key', 'get', 'SMOKE_KEY']);
step('明文仍是原值', keepMaskGet.value === 'sk-smoke-NEW-0987654321fedcba');

const missKey = await cliError(['key', 'get', 'NO_SUCH_KEY']);
step('不存在的密钥报 NOT_FOUND', missKey.code === 'NOT_FOUND');
const emptyVal = await cliError(['key', 'set', 'EMPTY_ONE', '   ']);
step('空值被拒绝', emptyVal.code === 'INVALID_INPUT');
const dashVal = await cliJson(['key', 'set', 'DASH_ONE', '--value=--weird-key--']);
step('值以 - 开头时用 --value=<值>（显式 flag 覆盖位置参数）', dashVal.status === 'ok');
await cliJson(['key', 'remove', 'DASH_ONE']);

const dryKeyRemove = await cliJson(['key', 'remove', 'SMOKE_KEY', '--dry-run']);
step('key remove --dry-run 不落盘', dryKeyRemove.status === 'skipped' && (await cliJson(['key', 'list'])).count === 1);

const dump = await cliJson(['section', 'dump', 'job']);
step('section dump 给全量（字段 + 条目 + 未填清单）', dump.fields.length > 50 && dump.entries.length >= 1 && dump.entries[0].missing.length > 0);

// ── 头部导航分组（settings.navGroups，设置页可配）────────────
const groupsSet = await cliJson(['setting', 'set', '--set',
  'navGroups=[{"title":"求职域","sections":["projects","internships"]}]']);
step('setting set navGroups 落盘并归一',
  groupsSet.status === 'ok' && groupsSet.set.navGroups[0].sections.length === 2);
const bootGroups = await cliJson(['bootstrap']);
step('bootstrap 带出导航分组（前端头部据此收拢）', bootGroups.settings.navGroups[0].title === '求职域');
const badGroup = await cliError(['setting', 'set', '--set', 'navGroups=[{"title":"X","sections":["no_such"]}]']);
step('navGroups 里的栏目不存在会明确报错', badGroup.code === 'INVALID_INPUT');
const dupGroup = await cliError(['setting', 'set', '--set',
  'navGroups=[{"title":"A","sections":["projects"]},{"title":"B","sections":["projects"]}]']);
step('一个栏目进了两个分组会明确报错', dupGroup.code === 'INVALID_INPUT');
await cliJson(['setting', 'set', '--set', 'navGroups=[]']);
step('清空 navGroups = 恢复平铺', (await cliJson(['setting', 'get'])).settings.navGroups.length === 0);

// ── 一个 file 字段挂多个附件（值 = 附件 id 的列表）────────────
await writeFile(join(home, 'r1.pdf'), 'resume-one');
await writeFile(join(home, 'r2.pdf'), 'resume-two');
const mf1 = await cliJson(['file', 'add', '--path', join(home, 'r1.pdf')]);
const mf2 = await cliJson(['file', 'add', '--path', join(home, 'r2.pdf')]);
await cliJson(['entry', 'update', '冒烟测试', '--set', `resumeFile=${mf1.id},${mf2.id}`]);
const multi = await cliJson(['entry', 'get', '冒烟测试', '--section', 'job']);
step('一个字段挂多个附件：值是数组（哪怕单个也存数组）',
  Array.isArray(multi.values.resumeFile) && multi.values.resumeFile.length === 2);
step('两个附件都解析出名称与路径', multi.files[mf1.id]?.name === 'r1.pdf' && multi.files[mf2.id]?.name === 'r2.pdf');
const multiHuman = await cli(['entry', 'get', '冒烟测试', '--section', 'job']);
step('CLI 人类模式：多个附件各占一行',
  multiHuman.out.includes('r1.pdf') && multiHuman.out.includes('r2.pdf'));
const mf2Detail = await cliJson(['file', 'get', mf2.id]);
step('第二个附件也反查到「被引用」', mf2Detail.usedBy.some((u) => u.fieldKey === 'resumeFile'));
const bySecond = await cliJson(['entry', 'list', '--section', 'job', '--q', 'r2.pdf']);
step('按第二个附件的名字也能搜到条目', bySecond.entries.some((e) => e.title === '冒烟测试'));

// 可读导出（JSON / Markdown）已删除：备份与它都是「往本机目录留副本」，
// 与 transfer 的 ZIP 导出重复。这里钉住**命令确实没了**，别哪天又被加回来。
const goneExport = await cliError(['export', 'run']);
step('export run 已删除（导出只剩 transfer 一条路径）', /未知命令/.test(goneExport.error || ''), goneExport.error);
const goneList = await cliError(['export', 'list']);
step('export list 已删除', /未知命令/.test(goneList.error || ''), goneList.error);
const goneBackup = await cliError(['backup', 'export']);
step('backup export 已删除', /未知命令/.test(goneBackup.error || ''), goneBackup.error);

// 导出导入页仍挂在导航里，且 transfer 五条命令都在
const tRoutes = await cliJson(['routes']);
step('transfer 五条命令都还在', ['transfer export', 'transfer import', 'transfer bundle-export', 'transfer bundle-import', 'transfer import-new']
  .every((c) => tRoutes.entries.some((r) => r.command === `nx-sk ${c}`)));

// ── 加密备份 + 跨机器口令解开 ────────────────────────────────
// 关键回归：A 机 export --password 出的 .nxskbak 在 B 机（换了 vaultkey）
// ─── 跨机器：ZIP 导入后密文用本机密钥重新落盘 ────────────────────────────
// 关键回归：A 机导出的包（secret 已解成明文）在 B 机（换过 vaultkey）导入后，
// 敏感字段必须用 **B 机** 的 vaultKey 重新加密——否则「密文落盘」这条不变量就漏了。
const crossZip = join(home, 'cross-machine.zip');
const xExp = await cliJson(['transfer', 'bundle-export', '--sections', 'secret', '--out', crossZip]);
step('跨机导出：secret 栏目打进 ZIP', xExp.sections === 1 && xExp.entries >= 1);

const homeB = await mkdtemp(join(tmpdir(), 'nx-sk-smoke-B-'));
const envB = { ...process.env, NX_SK_HOME: homeB, NX_SK_STORE: join(homeB, 'store.json') };
delete envB.NX_SK_PASSPHRASE;
function cliB(args, { expectFail = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, ...args], { env: envB, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      if (!expectFail) assert.equal(code, 0, `CLI 失败: nx-sk ${args.join(' ')}\nstdout: ${out}\nstderr: ${err}`);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}
async function cliJsonB(args) {
  const { out } = await cliB([...args, '--json']);
  return JSON.parse(out);
}

// 触发 B 机 .vaultkey 生成，再删掉——模拟「B 机用户从没见过 A 机的旧 key」
await cliB(['bootstrap']);
try { await rm(join(homeB, '.vaultkey')); } catch { /* 不存在也行 */ }

// 零配置导入：B 机没有 secret 栏目，按包内结构新建
const xImp = await cliJsonB(['transfer', 'import-new', '--file', crossZip]);
step('B 机零配置导入成功（全局包）', xImp.status === 'ok' && xImp.totals.added >= 1, JSON.stringify(xImp.totals));

const gotB = await cliJsonB(['key', 'get', 'SMOKE_KEY']);
step('B 机导入后 key get 能解出明文（与原机密钥无关）',
  gotB.value === 'sk-smoke-NEW-0987654321fedcba', String(gotB.value));

// 落盘后必须**仍是密文对象**（落盘防护不丢），且解得开说明用的就是 B 机密钥
const storeB = JSON.parse(await readFile(join(homeB, 'store.json'), 'utf8'));
const entryB = storeB.entries.find((e) => e.section === 'secret');
function isCipher(v) { return !!v && typeof v === 'object' && typeof v.ct === 'string' && typeof v.iv === 'string'; }
step('导入后 secret 落盘仍是密文（已用本机 vaultKey 重新加密）',
  !!entryB && isCipher(entryB.values.value));

const skillGet = await cliJson(['skill', 'get', 'nx-sk', '10-sections-entries', '--dry-run']);
step('skill get --json 是四元', skillGet.skillName === 'nx-sk' && skillGet.ref === 'references/10-sections-entries.md'
  && skillGet.contentBytes > 1000 && typeof skillGet.install.status === 'string');

const skillHuman = await cli(['skill', 'get', 'nx-sk', '--dry-run']);
step('skill get 人类模式是三段拼接', skillHuman.out.startsWith('# === nx-sk skill context ===')
  && skillHuman.out.includes('begin skill content') && skillHuman.out.includes('-- install 状态 --'));

const refEscape = await cliError(['skill', 'get', 'nx-sk', '../package.json']);
step('skill get 拒绝路径穿越', refEscape.code === 'INVALID_INPUT');

// 软链模式（shim）：目标是项目源码的软链，改完立刻生效；三态照旧
const linkDir = join(home, 'skills-link');
const linkDry = await cliJson(['skill', 'install', '--mode', 'symlink', '--to', linkDir, '--dry-run']);
step('skill install --mode symlink --dry-run 只报计划', linkDry.status === 'skipped' && linkDry.wouldInstall?.mode === 'symlink');
const link1 = await cliJson(['skill', 'install', '--mode', 'symlink', '--to', linkDir]);
step('软链装上了（mode=symlink，指向项目源码）',
  link1.status === 'ok' && link1.mode === 'symlink' && link1.target.endsWith('assets/nx-sk'), link1.path);
const link2 = await cliJson(['skill', 'install', '--mode', 'symlink', '--to', linkDir]);
step('软链幂等：已指向源就跳过（不静默改）', link2.status === 'ok' && link2.skipped === true && link2.mode === 'symlink');
const linkFiles = await readFile(join(linkDir, 'nx-sk', 'SKILL.md'), 'utf8');
step('软链能读到源的内容', linkFiles.includes('nx-sk'));
const copyOntoLink = await cliJson(['skill', 'install', '--to', linkDir]);
step('copy 模式遇到指向源的同款软链 → 已是最新（不重复装、不报错）',
  copyOntoLink.status === 'ok' && copyOntoLink.skipped === true);

const routes = await cliJson(['routes']);
step('routes 与 help 覆盖同一批命令', routes.total === boot.counts.commands);
const backRoute = await cliJson(['routes', '--http', 'POST /api/entries']);
step('routes 支持反向查找', backRoute.entries.some((e) => e.command === 'nx-sk entry add'));

const drySection = await cliJson(['section', 'add', 'probe', '--template', 'job', '--dry-run']);
step('section add --dry-run 不落盘', drySection.status === 'skipped' && !(await cliJson(['section', 'list'])).sections.some((s) => s.id === 'probe'));

// ── 2. HTTP + 静态 ───────────────────────────────────────────
process.stdout.write('\n[2] HTTP API 与静态页\n');

const serve = spawn(NODE, [BIN, 'serve', '--no-open', '--json', '--port', '0'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const first = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('serve 启动超时')), 15000);
  serve.stdout.on('data', (c) => {
    buf += c;
    const nl = buf.indexOf('\n');
    if (nl >= 0) { clearTimeout(t); resolve(buf.slice(0, nl)); }
  });
  serve.once('exit', (code) => reject(new Error(`serve 提前退出: ${code}`)));
});
const info = JSON.parse(first);
step('serve --json 打出地址', /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url), info.url);

const j = async (path, opts = {}) => {
  const res = await fetch(info.url + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, contentType: res.headers.get('content-type') || '' };
};

const apiBoot = await j('/api/bootstrap');
step('GET /api/bootstrap', apiBoot.status === 200 && apiBoot.body.ok && apiBoot.body.data.app.name === 'nx-sk');

const apiTemplates = await j('/api/sections/templates');
step('字面量路由不被 :ref 遮蔽（/sections/templates）', apiTemplates.status === 200 && Array.isArray(apiTemplates.body.data.templates));

const apiFields = await j('/api/entries/fields');
step('字面量路由不被 :ref 遮蔽（/entries/fields）', apiFields.status === 200 && Array.isArray(apiFields.body.data.sections));

const apiKeyPut = await j('/api/keys/HTTP_KEY', { method: 'PUT', body: { value: 'sk-http-abcdefghijklmn' } });
step('PUT /api/keys/:name 写入密钥', apiKeyPut.status === 200 && apiKeyPut.body.data.created === true);

const apiKeyGet = await j('/api/keys/HTTP_KEY');
step('GET /api/keys/:name 默认给原文', apiKeyGet.status === 200 && apiKeyGet.body.data.value === 'sk-http-abcdefghijklmn', apiKeyGet.body.data.value);

const apiKeyGetMasked = await j('/api/keys/HTTP_KEY?mask=1');
step('GET /api/keys/:name?mask=1 打码', apiKeyGetMasked.body.data.value === 'sk-h******klmn');

const apiKeyList = await j('/api/keys');
step('GET /api/keys 列表', apiKeyList.status === 200 && apiKeyList.body.data.keys.some((k) => k.name === 'HTTP_KEY'));

const apiKeyDel = await j('/api/keys/HTTP_KEY', { method: 'DELETE', body: {} });
step('DELETE /api/keys/:name', apiKeyDel.status === 200 && apiKeyDel.body.data.removed.title === 'HTTP_KEY');

const apiKeyMissing = await j('/api/keys/NO_SUCH_KEY_HTTP');
step('不存在的密钥报 404', apiKeyMissing.status === 404 && apiKeyMissing.body.code === 'NOT_FOUND');

const apiAdd = await j('/api/entries', { method: 'POST', body: { section: 'job', set: { 姓名: 'HTTP造的数据' } } });
step('POST /api/entries', apiAdd.status === 200 && apiAdd.body.data.created === true);

const apiPatch = await j(`/api/entries/${apiAdd.body.data.id}`, { method: 'PATCH', body: { set: { 目标岗位: '全栈开发' } } });
step('PATCH /api/entries/:ref（PATCH 语义）', apiPatch.status === 200 && apiPatch.body.data.status === 'ok');

const apiBlocked = await j('/api/sections/job', { method: 'DELETE', body: {} });
step('栏目非空删除报 409 blocked', apiBlocked.status === 409 && apiBlocked.body.code === 'BLOCKED');

const apiNotFound = await j('/api/entries/不存在的东西');
step('不存在的条目报 404 NOT_FOUND', apiNotFound.status === 404 && apiNotFound.body.code === 'NOT_FOUND');

const apiUnknown = await j('/api/nope');
step('未知接口报 404', apiUnknown.status === 404 && apiUnknown.body.ok === false);

const apiBadOrigin = await rawRequest(info.url, '/api/entries', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: JSON.stringify({ section: 'job', set: { name: 'x' } }),
});
step('跨站 Origin 的写操作被拒', apiBadOrigin.status === 403, `HTTP ${apiBadOrigin.status}`);

const readOrigin = await rawRequest(info.url, '/api/bootstrap', { headers: { origin: 'http://evil.example' } });
step('跨站 Origin 的读操作仍放行', readOrigin.status === 200);

const localOrigin = await rawRequest(info.url, '/api/entries', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:7866' },
  body: JSON.stringify({ section: 'job', set: { 姓名: '本机面板造的' } }),
});
step('本机 Origin 的写操作放行', localOrigin.status === 200);

const staticRes = await fetch(info.url + '/');
const staticText = await staticRes.text();
if (staticRes.status === 200) {
  step('静态面板可访问', staticText.includes('nx-sk') && staticRes.headers.get('content-type').includes('text/html'));
} else {
  step('未构建时给可操作的提示（503）', staticRes.status === 503 && staticText.includes('vite build'), `HTTP ${staticRes.status}`);
}

const spa = await fetch(info.url + '/whatever/deep/path');
step('SPA 回退到 index.html 或提示', [200, 503].includes(spa.status));

serve.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));

// ── 3. 收尾：真删（只删测试自己造的那条） ───────────────────
process.stdout.write('\n[3] 真删\n');
const removed = await cliJson(['entry', 'remove', '冒烟测试']);
step('entry remove 成功', removed.removed.title === '冒烟测试');
step('entry remove 不再返回快照（本地备份已移除）', removed.snapshot === undefined);

const gone = await cliError(['entry', 'get', '冒烟测试']);
step('删除后 get 报 NOT_FOUND', gone.code === 'NOT_FOUND');

const finalList = await cliJson(['entry', 'list', '--section', 'job']);
const titles = finalList.entries.map((e) => e.title).sort();
step('CLI 与 HTTP 写进的是同一份数据', finalList.count === 2 && titles.join('|') === 'HTTP造的数据|本机面板造的', titles.join(' / '));

process.stdout.write(`\n冒烟通过：${passed} 项断言，全部在临时目录 ${home} 内完成\n`);
