import * as service from './service.js';

export default {
  id: 'skill',
  title: 'Skill',
  order: 800,
  // 用户明确要求：skill 不呈现在 Web 面板里（CLI 的 skill install / skill get 保持不变）。
  // 后端模块不声明视图，面板只在 src/web/frontend/registry.js 登记。
  actions: [
    {
      id: 'skill.list',
      cli: ['skill', 'list'],
      http: ['GET', '/api/skills'],
      summary: '列出随包分发的内置 skill 与其 ref 文档',
      flags: {},
      run: () => service.listSkills(),
      render: (d) => service.renderSkillList(d),
    },
    {
      id: 'skill.install',
      cli: ['skill', 'install'],
      http: ['POST', '/api/skills/install'],
      summary: '把内置 skill 装到 ~/.claude/skills（三态：安装 / 已最新 / 冲突需 --force）；--mode symlink 用软链挂过去，改完立刻生效；--all 装齐全部并直接覆盖',
      args: [{ name: 'name', required: false }],
      flags: {
        to: { type: 'string', hint: '安装目录，缺省 ~/.claude/skills' },
        mode: { type: 'string', enum: ['copy', 'symlink'], hint: 'copy=装副本（默认，可分发）；symlink=软链回项目源码（本机开发，改完立刻生效）' },
        force: { type: 'boolean', hint: '目标存在且内容不同时覆盖' },
        'dry-run': { type: 'boolean' },
        all: { type: 'boolean', hint: '装 assets/ 下全部 skill（隐式覆盖，不需要 --force）' },
      },
      run: (ctx) => service.installSkill(ctx),
      render: (d) => service.renderInstall(d),
    },
    {
      id: 'skill.get',
      cli: ['skill', 'get'],
      http: ['POST', '/api/skills/get'],
      summary: '输出 SKILL.md 或 references/<ref> 全文（prefix + 文档 + install 状态三段），同时按 install 逻辑装好',
      args: [{ name: 'name', required: false }, { name: 'ref', required: false }],
      flags: {
        to: { type: 'string' },
        mode: { type: 'string', enum: ['copy', 'symlink'] },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean', hint: '只输出文档，不装到本机' },
      },
      run: (ctx) => service.getSkill(ctx),
      render: (d) => service.renderSkillContext(d),
    },
  ],
};
