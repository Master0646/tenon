#!/usr/bin/env node
// devflow 命令行入口。所有命令支持 --json；出错时退出码为 1
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { detectAgents, installAgents, parseAgents, type AgentResult } from './agents.ts';
import { check } from './check.ts';
import { lintWiki } from './wiki.ts';
import { render } from './render.ts';
import { applyStart, taskDone, verify } from './exec.ts';
import { commitArchive, discardArchive, pendingTx, stageArchive } from './archive.ts';
import { resolve } from 'node:path';
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
  render <id> [-o f]   从被审文件生成离线审查页（默认 .devflow/runtime/rendered/<id>.html）
  approve <id>         批准变更并绑定内容哈希（只能由人在交互终端中运行）
  apply <id> --start   记录开工（状态须为 approved）
  task done <id> <T>   记录任务完成
  verify <id>          运行 project.yaml 声明的验证命令并记录结果
  archive <id>         合并规范增量并归档变更（只能由人在交互终端中运行；中断后重跑即继续）
  check [--staged]     门禁检查（pre-commit hook 与 CI 使用）
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' }, staged: { type: 'boolean' }, agents: { type: 'string' }, out: { type: 'string', short: 'o' },
    start: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, arg] = positionals;

/** 人专属命令：Agent 的 shell 工具通常不是 TTY。这不是防篡改，只防 Agent 越级（见设计 §2.2） */
function requireHuman(cmdName: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DevflowError(`${cmdName} 只能由人在交互终端中运行`, '请在你自己的终端里执行该命令，不要让 Agent 代为执行');
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D / Ctrl+C 会让 question 抛 AbortError，按取消处理
  const answer = (await rl.question(question).catch(() => '')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y') console.log('已取消');
  return answer === 'y';
}

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
      requireHuman('approve');
      const id = requireChange(root, arg);
      const ev = prepareApproval(root, id);
      console.log(`变更：${id}`);
      console.log(`基线：${ev.base_commit.slice(0, 7)}  批准人：${ev.actor}`);
      console.log(`内容哈希：${ev.hash}`);
      console.log('被审文件：');
      for (const f of reviewedFiles(root, id)) console.log(`  ${f}`);
      if (!(await confirm('确认批准？输入 y 确认：'))) return 1;
      approve(root, id, ev.hash);
      console.log(`✓ 已批准 ${id}`);
      return 0;
    }
    case 'apply': {
      if (!opts.start) throw new DevflowError('用法：devflow apply <id> --start', '记录开工；开工前状态必须为 approved');
      const ev = applyStart(root, arg!);
      if (opts.json) console.log(JSON.stringify(ev, null, 2));
      else console.log(`✓ ${arg} 已开工（基于 ${ev.type === 'apply-started' ? ev.head.slice(0, 7) : ''}）`);
      return 0;
    }
    case 'task': {
      if (arg !== 'done') throw new DevflowError(`未知子命令：task ${arg ?? ''}`, '用法：devflow task done <id> <任务ID>');
      const [, , id, task] = positionals;
      taskDone(root, id, task);
      const st = deriveStatus(root, id);
      if (opts.json) console.log(JSON.stringify(st, null, 2));
      else console.log(`✓ ${task} 已完成；任务 ${st.tasks.done}/${st.tasks.total}`);
      return 0;
    }
    case 'verify': {
      const r = verify(root, arg!);
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const c of r.checks) {
          console.log(`${c.exit === 0 ? '✓' : '✗'} ${c.name}  退出码 ${c.exit ?? '—'}  ${(c.ms / 1000).toFixed(1)}s${c.note ? `  ${c.note}` : ''}`);
          if (c.exit !== 0) console.log(`    日志：${c.log}`);
        }
        console.log(`结果：${r.result}${r.note ? `（${r.note}）` : ''}；状态：${deriveStatus(root, arg!).status}`);
      }
      return r.result === 'pass' ? 0 : 1;
    }
    case 'archive': {
      requireHuman('archive');
      requireInit(root);
      if (!arg) throw new DevflowError('缺少变更 ID', '用法：devflow archive <id>');
      if (pendingTx(root, arg)) {
        console.log(`发现 ${arg} 未完成的归档事务，继续执行剩余步骤`);
      } else {
        const tx = stageArchive(root, arg);
        console.log(`变更：${arg}  归档人：${tx.actor}`);
        console.log('将写入：');
        for (const w of tx.writes) console.log(`  ${w.to}`);
        console.log(`将移动：${tx.move.from} → ${tx.move.to}`);
        if (!(await confirm('确认归档？输入 y 确认：'))) {
          discardArchive(root, arg);
          return 1;
        }
      }
      const r = commitArchive(root, arg);
      console.log(`✓ 已归档到 ${r.target}${r.specs.length ? `；更新规范：${r.specs.join(', ')}` : ''}`);
      return 0;
    }
    case 'render': {
      requireInit(root);
      const id = requireChange(root, arg);
      const r = render(root, id, opts.out ? resolve(opts.out) : undefined);
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`✓ ${r.file}`);
        console.log(`  内容哈希：${r.hash}`);
        console.log(`  审查后由人在自己的终端运行：devflow approve ${id}`);
      }
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
