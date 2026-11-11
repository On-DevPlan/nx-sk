// 本地 ESLint 规则：单文件物理行数预算（三档）。
//
// 口径（固定在这里；改口径必须同时改注释和单测）：
//   - 统计对象：单个文件的**物理行**，等于编辑器里看到的行号。
//   - 实现上取 `sourceCode.lines`，但**末尾换行不额外算一行**：
//     ESLint 的 lines 在文件以换行结尾时会多出一个空串，必须减掉，
//     否则「995 行的文件」会被算成 996，和编辑器/MaxLines 口径都对不上。
//   - 空行、注释行、块注释都计入：本项目注释是设计意图的主要载体，
//     行数在这里是「认知负担」的代理指标，注释不是噪声。
//   - 不按函数或代码块统计：拆分决策发生在文件粒度。
//
// 三档（阈值含等号，相邻档互斥，一个文件只落进一档）：
//   >= 600 且 < 800   warn   提醒档，拆不拆自己判断
//   >= 800 且 < 1000  error  必须登记：eslint-line-budget.json 的 registry 里有该路径、
//                            且当前行数不超过登记上限 max，才放行
//   >= 1000           error  硬禁止：**不接受任何登记豁免**，只能拆
//
// 登记表每条必须写：path / lines（登记时行数）/ max（允许上限，必须 < 1000）/
// reason（为什么暂不拆）/ by（登记人）/ at（登记日期）。
// 文件回落到 800 以下后，该条登记即「陈旧」，由 warn 档报出来——登记表不能烂。
//
// 生效目录：src/**、tests/**、scripts/**。登记表里的路径统一写成
// `src/...` / `tests/...` / `scripts/...`（仓库内相对路径）。
//
// 为什么是两个规则 ID 而不是一条规则多档：ESLint 的严重级别是按规则配置定的，
// 不是按消息定的；同一条规则不能既 warn 又 error，所以提醒档（含陈旧登记）
// 与禁止档拆成两个 ID。

/** 把绝对/相对文件名归一化成仓库内相对路径（win32 / posix 混用都要吃得住）。 */
function repoRelative(filePath) {
  const norm = String(filePath).replace(/\\/g, '/');
  const m = norm.match(/(?:^|\/)(src|tests|scripts)\/(.+)$/);
  return m ? `${m[1]}/${m[2]}` : norm;
}

/** registry 数组 → path → 登记项。 */
function toRegistryMap(list) {
  const map = new Map();
  for (const item of list || []) {
    map.set(String(item.path).replace(/\\/g, '/'), item);
  }
  return map;
}

const SCHEMA = {
  type: 'object',
  properties: {
    warn: { type: 'integer', minimum: 1 },
    approve: { type: 'integer', minimum: 1 },
    hard: { type: 'integer', minimum: 1 },
    registry: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          lines: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
          reason: { type: 'string' },
          by: { type: 'string' },
          at: { type: 'string' },
        },
        required: ['path', 'lines', 'max', 'reason', 'by', 'at'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const MESSAGES = {
  overWarn: '文件有 {{count}} 行（>= {{warn}} 提醒档）。这是提醒：考虑按职责拆分。',
  overApprove:
    '文件有 {{count}} 行（>= {{approve}} 登记档，未到 {{hard}} 硬禁止档）。'
    + '需在 eslint-line-budget.json 的 registry 里登记 path/lines/max/reason/by/at 才能通过。',
  overMax:
    '文件有 {{count}} 行，超过登记上限 {{max}}（登记时 {{lines}} 行）。'
    + '要么拆回去，要么调高 max 并说明理由。',
  overHard:
    '文件有 {{count}} 行（>= {{hard}} 硬禁止档）。硬禁止不接受登记豁免，必须拆分。',
  hardWithEntry:
    '该文件 {{count}} 行 >= {{hard}} 硬禁止档，登记表不接受豁免；'
    + '请删除 registry 里的这条登记（它只会制造假的安全感）。',
  staleEntry:
    '文件只有 {{count}} 行，已低于需要登记的 {{approve}} 档；'
    + 'registry 里这条登记（登记时 {{lines}} 行）已陈旧，请删除。',
};

function readOptions(context) {
  const opts = context.options[0] || {};
  return {
    warn: opts.warn ?? 600,
    approve: opts.approve ?? 800,
    hard: opts.hard ?? 1000,
    registry: toRegistryMap(opts.registry),
  };
}

/** 物理行数：与编辑器一致，末尾换行不算额外一行。 */
function physicalLines(context) {
  const lines = context.sourceCode.lines;
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** 提醒档：600~799 报提醒；已登记但回落到 800 以下报陈旧登记。 */
export const lineBudgetWarn = {
  meta: {
    type: 'suggestion',
    docs: { description: '单文件行数预算：提醒档 + 陈旧登记' },
    schema: [SCHEMA],
    messages: MESSAGES,
  },

  create(context) {
    const { warn, approve, registry } = readOptions(context);
    const count = physicalLines(context);
    const rel = repoRelative(context.filename);
    const entry = registry.get(rel);

    if (count >= approve) return {}; // 登记档/硬禁止档由 error 规则负责

    if (entry) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'staleEntry',
            data: { count, approve, lines: entry.lines },
          });
        },
      };
    }

    if (count < warn) return {};
    return {
      Program(node) {
        context.report({ node, messageId: 'overWarn', data: { count, warn } });
      },
    };
  },
};

/** 禁止档：800~999 未登记/超上限报错；>=1000 一律报错（登记了再补一条）。 */
export const lineBudgetError = {
  meta: {
    type: 'problem',
    docs: { description: '单文件行数预算：必须登记档 + 硬禁止档' },
    schema: [SCHEMA],
    messages: MESSAGES,
  },

  create(context) {
    const { approve, hard, registry } = readOptions(context);
    const count = physicalLines(context);
    const rel = repoRelative(context.filename);
    const entry = registry.get(rel);

    if (count >= hard) {
      return {
        Program(node) {
          context.report({ node, messageId: 'overHard', data: { count, hard } });
          if (entry) {
            context.report({ node, messageId: 'hardWithEntry', data: { count, hard } });
          }
        },
      };
    }

    if (count < approve) return {};

    if (!entry) {
      return {
        Program(node) {
          context.report({ node, messageId: 'overApprove', data: { count, approve, hard } });
        },
      };
    }

    if (count > entry.max) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'overMax',
            data: { count, max: entry.max, lines: entry.lines },
          });
        },
      };
    }

    return {};
  },
};

export default {
  rules: {
    'line-budget-warn': lineBudgetWarn,
    'line-budget-error': lineBudgetError,
  },
};
