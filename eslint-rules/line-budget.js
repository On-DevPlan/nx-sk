// 本地 ESLint 规则：文件行数预算（四条规则 ID，对应四档）。
//
// 为什么不用内置 max-lines：它一个文件只产生一条消息、只认一个 max 阈值，
// 表达不了「600 提醒 / 800 要审批 / 1000 硬报错」的分段语义。
//
// 为什么拆成多条规则 ID 而不是一条规则多档：
//   ESLint 的严重级别是**按规则配置**定的，不是一条消息一个级别。
//   同一条规则 ID 在同一个 config block 里只能有一个级别，所以「同规则不同档不同级」
//   只能靠不同的规则 ID 实现。每条规则只负责自己那一个档，区间互斥。
//
// 四档（行数含注释与空行 = 编辑器行号 = 内置 max-lines 的默认口径）：
//   line-budget-warn          601 ~ 800    warn    提醒，拆不拆自己决定
//   line-budget-approve       801 ~ 1000   error   要审批：除非在 approved 名单里
//   line-budget-hard          > 1000       error   硬上限：未登记即报错
//   line-budget-hard-deferred > 1000       warn    硬上限的**存量过渡**豁免
//
// 行数口径说明：本项目注释密度 13%~27%，注释是设计意图的载体而非噪声，
// 算进去等于把「行数」当「认知负担」——与拆文件要解决的问题是同一个口径。
//
// 两份名单都在 eslint-line-budget.json（可 code review）：
//   approved —— 放行「801~1000 要审批」档
//   deferred —— 「>1000 硬上限」档的存量过渡豁免；拆分完成后必须删掉对应记录
//
// 注意：本文件只跑在 src/**。tests / scripts 本来就允许长（smoke.mjs 583 行、
// link-local.mjs 527 行），卡它们只会逼人把测试拆碎，不解决任何问题。

/** 把仓库路径归一化成仓库内相对路径（win32 / posix 混用都要吃得住）。 */
function repoRelative(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/src/');
  if (idx >= 0) return norm.slice(idx + 1);
  const marker = '/nx-sk/';
  const m = norm.lastIndexOf(marker);
  if (m >= 0) return norm.slice(m + marker.length);
  return norm;
}

function toMap(list) {
  const map = new Map();
  for (const item of list || []) {
    map.set(item.path.replace(/\\/g, '/'), item.reason || '');
  }
  return map;
}

const SCHEMA = {
  type: 'object',
  properties: {
    warn: { type: 'integer' },
    approve: { type: 'integer' },
    hard: { type: 'integer' },
    approved: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    },
    deferred: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const MESSAGES = {
  overWarn: '文件有 {{count}} 行（> {{warn}} 提醒档）。这是提醒，考虑拆分。',
  overApprove:
    '文件有 {{count}} 行（> {{approve}} 要审批档，未达硬上限 {{hard}}）。'
    + '需在 eslint-line-budget.json 的 approved 里登记理由才能通过。',
  overHard:
    '文件有 {{count}} 行（> {{hard}} 硬上限）。硬上限只对存量过渡有豁免，'
    + '新文件必须拆分；存量文件需在 eslint-line-budget.json 的 deferred 里登记。',
  overHardDeferred:
    '文件有 {{count}} 行（> {{hard}} 硬上限），已登记为过渡项：{{reason}}'
    + '—— 拆分完成后请删掉 deferred 里的这条记录。',
};

/**
 * 造一条只管某一档的规则。
 * @param {'warn'|'approve'|'hard'|'hard-deferred'} band
 */
function makeBandRule(band) {
  return {
    meta: {
      type: 'suggestion',
      docs: { description: `单文件行数预算：${band} 档` },
      schema: [SCHEMA],
      messages: MESSAGES,
    },

    create(context) {
      const opts = context.options[0] || {};
      const warn = opts.warn ?? 600;
      const approve = opts.approve ?? 800;
      const hard = opts.hard ?? 1000;
      const approved = toMap(opts.approved);
      const deferred = toMap(opts.deferred);

      const count = context.sourceCode.lines.length;
      const rel = repoRelative(context.filename);

      // 本档的判定区间。相邻档互斥，一个文件只会落进一个档。
      let inBand = false;
      if (band === 'warn') inBand = count > warn && count <= approve;
      else if (band === 'approve') inBand = count > approve && count <= hard;
      else inBand = count > hard; // 'hard' 与 'hard-deferred' 都要先过这一关

      if (!inBand) return {};

      if (band === 'hard' || band === 'hard-deferred') {
        const reason = deferred.get(rel);
        const isDeferred = reason !== undefined;
        // 'hard' 只管未登记的文件；'hard-deferred' 只管登记过的。两条互斥，不会重复报告。
        if (band === 'hard' && isDeferred) return {};
        if (band === 'hard-deferred' && !isDeferred) return {};
        return {
          Program(node) {
            context.report({
              node,
              messageId: isDeferred ? 'overHardDeferred' : 'overHard',
              data: { count, hard, reason: reason || '' },
            });
          },
        };
      }

      if (band === 'approve') {
        if (approved.has(rel)) return {}; // 已审批，放行
        return {
          Program(node) {
            context.report({ node, messageId: 'overApprove', data: { count, approve, hard } });
          },
        };
      }

      return {
        Program(node) {
          context.report({ node, messageId: 'overWarn', data: { count, warn } });
        },
      };
    },
  };
}

export const lineBudgetWarn = makeBandRule('warn');
export const lineBudgetApprove = makeBandRule('approve');
export const lineBudgetHard = makeBandRule('hard');
export const lineBudgetHardDeferred = makeBandRule('hard-deferred');

export default {
  rules: {
    'line-budget-warn': lineBudgetWarn,
    'line-budget-approve': lineBudgetApprove,
    'line-budget-hard': lineBudgetHard,
    'line-budget-hard-deferred': lineBudgetHardDeferred,
  },
};
