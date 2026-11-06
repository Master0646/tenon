#!/usr/bin/env node
// devflow 命令行入口。所有命令支持 --json；出错时退出码为 1
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { detectAgents, installAgents, parseAgents, type AgentResult } from './agents.ts';
import { check } from './check.ts';
import { lintWiki } from './wiki.ts';
import { DevflowError, listChanges, repoRoot, requireChange, requireInit, reviewedFiles, type Issue } from './core.ts';
import { init, newChange } from './init.ts';
import { approve, deriveStatus, prepareApproval } from './status.ts';
import { validateChange, validateProject } from './validate.ts';

const HELP = `用法：devflow <命令> [参数] [--json]

  init [--agents a,b]  在当前 Git 项目创建 .devflow/、安装 pre-commit hook，
                       并为 Agent 生成技能与入口片段（默认 claude,codex）
  update [--agents]    重新生成 Agent 文件（默认：已安装过的 Agent）
  new <id>             生成变更目录骨架
  wiki lint            校验知识页的引用、链接与是否过期
  validate <id>        校验变更文件是否齐全、格式正确
  status [id]          显示变更的派生状态
  approve <id>         批准变更并绑定内容哈希（只能由人在交互终端中运行）
  check [--staged]     门禁检查（pre-commit hook 与 CI 使用）
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' }, staged: { type: 'boolean' }, agents: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, arg] = positionals;

function printIssues(issues: Issue[]): void {
  for (const i of issues) {
    const out = i.level === 'error' ? console.error : console.warn;
    out(`${i.level === 'error' ? '✗' : '!'} ${i.file}: ${i.message}`);
    if (i.hint) out(i.hint.replace(/^/gm, '    '));
  }
}

function printAgents(a: AgentResult): void {
  for (const f of a.written) console.log(`✓ ${f}`);
  for (const w of a.warnings) console.warn(`! ${w}`);
}

/** 输出校验结果；有错误时返回退出码 1 */
function report(issues: Issue[], okText: string): number {
  const failed = issues.some((i) => i.level === 'error');
  if (opts.json) console.log(JSON.stringify({ ok: !failed, issues }, null, 2));
  else {
    printIssues(issues);
    if (!failed) console.log(okText);
  }
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  if (opts.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const root = repoRoot(process.cwd());

  switch (cmd) {
    case 'init': {
      const agents = parseAgents(opts.agents);
      const r = init(root);
      const a = installAgents(root, agents);
      if (opts.json) console.log(JSON.stringify({ ...r, agents: a }, null, 2));
      else {
        for (const f of r.created) console.log(`+ ${f}`);
        if (r.hook === 'foreign') {
          console.warn(`! ${r.hookPath} 已有其他 hook，未覆盖。请在其中加一行：devflow check --staged`);
        } else console.log(`✓ pre-commit hook 已${r.hook === 'installed' ? '安装' : '更新'}：${r.hookPath}`);
        printAgents(a);
      }
      return 0;
    }
    case 'update': {
      requireInit(root);
      const agents = opts.agents ? parseAgents(opts.agents) : detectAgents(root);
      if (!agents.length) throw new DevflowError('没有找到已安装的 Agent 文件', '用 devflow update --agents claude,codex 指定');
      const a = installAgents(root, agents);
      if (opts.json) console.log(JSON.stringify(a, null, 2));
      else printAgents(a);
      return 0;
    }
    case 'wiki': {
      requireInit(root);
      if (arg !== 'lint') throw new DevflowError(`未知子命令：wiki ${arg ?? ''}`, '用法：devflow wiki lint');
      const { issues, pages } = lintWiki(root);
      return report(issues, `✓ ${pages.length} 个知识页校验通过`);
    }
    case 'new': {
      const files = newChange(root, arg);
      if (opts.json) console.log(JSON.stringify({ files }, null, 2));
      else {
        for (const f of files) console.log(`+ ${f}`);
        console.log(`填写完成后运行 devflow validate ${arg}`);
      }
      return 0;
    }
    case 'validate': {
      requireInit(root);
      const id = requireChange(root, arg);
      return report([...validateProject(root), ...validateChange(root, id, true)], `✓ ${id} 校验通过`);
    }
    case 'status': {
      requireInit(root);
      const list = (arg ? [requireChange(root, arg)] : listChanges(root)).map((id) => deriveStatus(root, id));
      if (opts.json) console.log(JSON.stringify(list, null, 2));
      else if (!list.length) console.log('没有进行中的变更。用 devflow new <id> 新建');
      else for (const s of list) console.log(`${s.id}  ${s.status}  任务 ${s.tasks.done}/${s.tasks.total}  ${s.reason}`);
      return 0;
    }
    case 'approve': {
      // 人专属：Agent 的 shell 工具通常不是 TTY。这不是防篡改，只防 Agent 越级（见设计 §2.2）
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new DevflowError('approve 只能由人在交互终端中运行', '请在你自己的终端里执行该命令，不要让 Agent 代为执行');
      }
      const id = requireChange(root, arg);
      const ev = prepareApproval(root, id);
      console.log(`变更：${id}`);
      console.log(`基线：${ev.base_commit.slice(0, 7)}  批准人：${ev.actor}`);
      console.log(`内容哈希：${ev.hash}`);
      console.log('被审文件：');
      for (const f of reviewedFiles(root, id)) console.log(`  ${f}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+D / Ctrl+C 会让 question 抛 AbortError，按取消处理
      const answer = (await rl.question('确认批准？输入 y 确认：').catch(() => '')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y') {
        console.log('已取消');
        return 1;
      }
      approve(root, id, ev.hash);
      console.log(`✓ 已批准 ${id}`);
      return 0;
    }
    case 'check':
      return report(check(root, { staged: !!opts.staged }), '✓ devflow check 通过');
    default:
      throw new DevflowError(`未知命令：${cmd}`, HELP);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (!(e instanceof DevflowError)) throw e;
    if (opts.json) console.log(JSON.stringify({ ok: false, error: e.message, hint: e.hint }, null, 2));
    else {
      console.error(`✗ ${e.message}`);
      if (e.hint) console.error(e.hint.replace(/^/gm, '    '));
    }
    process.exit(1);
  },
);
