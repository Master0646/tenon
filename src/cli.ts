#!/usr/bin/env node
// tenon 命令行入口。所有命令支持 --json；出错时退出码为 1
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { doctor } from './doctor.ts';
import { guard } from './guard.ts';
import { formatFeedback, markWaiting, takeFeedback, unreadCount } from './feedback.ts';
import { parseArgs } from 'node:util';
import { AGENTS, detectAgents, guessAgents, installAgents, parseAgents, type AgentResult } from './agents.ts';
import { check, checkCodeRepo } from './check.ts';
import { lintWiki } from './wiki.ts';
import { render, reviewIssues } from './render.ts';
import { reviewServer } from './review.ts';
import { applyStart, taskDone, verify } from './exec.ts';
import { commitArchive, discardArchive, pendingTx, stageArchive } from './archive.ts';
import { fileURLToPath } from 'node:url';
import { recordEvidence, confirmEvidence, evidenceMatrix } from './evidence.ts';
import { startUsage, finishUsage, configureUsage, pruneUsage, addFeedback, usageReport, exportUsage, getCandidate, listCandidates, resolveCandidate } from './usage.ts';
import { runWorkflowSuite, compareReports, readReport } from './evaluate.ts';
import { join, resolve } from 'node:path';
import { DevflowError, approvalCycle, changeDir, dfOf, doneTasks, readEvents, withWorktreeLock, listChanges, repoRoot, requireChange, requireInit, reviewedFiles, type Issue } from './core.ts';
import { init, newChange } from './init.ts';
import { approve, decisionAnswers, deriveStatus, humanTodo, listArchived, prepareApproval, staleHours, staleText } from './status.ts';
import { loadTasks, validateChange, validateProject } from './validate.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `tenon ${VERSION}
用法：tenon <命令> [参数] [--json]

  resume <id>         显示当前进度、证据缺口与下一步
  evidence add <id> --file <json>   记录验收证据
  evidence confirm <id> <evidence-id>  人工确认（仅限人的终端）
  usage configure --off | --on     控制本地使用记录
  usage report [--since YYYY-MM-DD]  本地使用报告
  usage feedback <id> --file <json>  记录使用反馈
  usage export --out <file>          导出聚合数据
  usage prune --before YYYY-MM-DD    清理过期使用数据
  improve draft <candidate-id> <change-id>  生成待完善提案
  improve resolve <candidate-id> --report <path>  关联优化结果
  eval run --suite workflow           运行隔离故障评测
  eval compare <baseline> <candidate>  比较固定协议报告
  doctor               检查环境、hook、Agent 文件与验证命令，并给出修复命令
  --version            显示版本号
  init [--agents a,b]  在当前 Git 项目创建 .tenon/（旧项目沿用 .devflow/）、安装 pre-commit hook，
                       并为 Agent 生成技能与入口片段（默认：检测到的 Agent；
                       一个都没检测到时 claude,codex）
  update [--agents]    重新生成 Agent 文件（默认：已安装过的 Agent）
  new <id>             生成变更目录骨架
  wiki lint            校验知识页的引用、链接与是否过期
  validate <id>        校验变更文件是否齐全、格式正确
  status [id] [--all]  显示变更的派生状态；--all 同时列出已归档的变更
  render <id> [-o f]   从被审文件生成离线审查页（默认 <数据目录>/runtime/rendered/<id>.html）
  review [id]          启动本地审查台（只能由人在交互终端中运行）：在浏览器里批准、
                       确认人工证据、归档；保持终端打开，Ctrl+C 结束
  wait <id> [--timeout 秒]  等人批准、确认证据、归档或发来批注后退出（Agent 在后台运行；默认 1800 秒）
  approve <id> [--hash h]  批准变更并绑定内容哈希（只能由人在交互终端中运行）；
                       --hash 为审查页上的哈希前缀，一致时直接批准
  apply <id> --start   记录开工（状态须为 approved）
  task done <id> <T>   记录任务完成
  verify <id>          运行 project.yaml 声明的验证命令并记录结果
  archive <id>         合并规范增量并归档变更（只能由人在交互终端中运行；中断后重跑即继续）
  check [--staged]     门禁检查（pre-commit hook 与 CI 使用）
  check --staged --project <dir>  在 code_roots 的代码仓库里检查暂存改动（代码仓库的 hook 使用）
  guard                供 Codex 的 PreToolUse 钩子调用：从标准输入读 JSON，拦截人专属命令和改 specs/、events.jsonl 的补丁
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' }, staged: { type: 'boolean' }, agents: { type: 'string' }, hash: { type: 'string' }, out: { type: 'string', short: 'o' },
    start: { type: 'boolean' }, all: { type: 'boolean' }, timeout: { type: 'string' }, version: { type: 'boolean', short: 'v' },
    'tool-version': { type: 'string' }, file: { type: 'string' }, schema: { type: 'string' }, since: { type: 'string' }, before: { type: 'string' }, off: { type: 'boolean' }, on: { type: 'boolean' }, suite: { type: 'string' }, report: { type: 'string' },
    project: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, arg] = positionals;

/** 人专属命令：Agent 的 shell 工具通常不是 TTY。这不是防篡改，只防 Agent 越级（见设计 §2.2） */
function requireHuman(cmdName: string): void {
  // Codex 可以自己申请交互终端，所以再看 Agent 的 shell 里才有的环境变量
  const agentEnv = ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'].find((k) => process.env[k]);
  if (agentEnv || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DevflowError(`${cmdName} 只能由人在交互终端中运行${agentEnv ? `（检测到 Agent 环境变量 ${agentEnv}）` : ''}`, '请在你自己的终端里执行该命令，不要让 Agent 代为执行');
  }
}

async function confirm(question: string, cancelText = '已取消'): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+D / Ctrl+C 会让 question 抛 AbortError，按取消处理
  const answer = (await rl.question(question).catch(() => '')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && cancelText) console.log(cancelText);
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

async function dispatch(): Promise<number> {
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  if (opts.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'doctor') {
    const findings = doctor(process.cwd());
    if (opts.json) console.log(JSON.stringify(findings, null, 2));
    else {
      for (const f of findings) {
        console.log(`${{ ok: '✓', warn: '!', error: '✗' }[f.level]} ${f.item}：${f.message}`);
        if (f.hint && f.level !== 'ok') console.log(`    修复：${f.hint}`);
      }
    }
    return findings.some((f) => f.level === 'error') ? 1 : 0;
  }
  if (cmd === 'guard') {
    let stdin = '';
    try { stdin = readFileSync(0, 'utf8'); } catch { /* 读不到输入：放行 */ }
    const out = guard(stdin);
    if (out) console.log(out);
    return 0;
  }
  const root = repoRoot(process.cwd());

  switch (cmd) {
    case 'resume': {
      const id = requireChange(root, arg);
      const state = deriveStatus(root, id);
      const evidence = evidenceMatrix(root, id);
      const missing = evidence.filter((e) => e.status !== 'valid');
      let next = state.status === 'draft' || state.status === 'rebase_required' ? `tenon render ${id}` : state.status === 'approved' ? `tenon apply ${id} --start` : state.status === 'ready_to_archive' ? `tenon archive ${id}` : `tenon verify ${id}`;
      if (state.reason.includes('快照')) next = '从 Git 恢复批准快照后重新运行 resume';
      else if (['applying', 'needs_fix'].includes(state.status) && missing[0]?.status === 'unconfirmed') next = `tenon evidence confirm ${id} ${missing[0].evidence_id}`;
      else if (['applying', 'needs_fix'].includes(state.status) && missing.length && !/重新验证|尚未验证|fail|unknown/.test(state.reason)) next = `tenon evidence add ${id} --file <${missing[0].acceptance}-evidence.json>`;
      else if (state.status === 'applying' && !missing.length && state.reason.includes('任务')) {
        const done = doneTasks(root, id);
        const task = loadTasks(root, id).find((t) => !done.has(t.id) && (t.depends_on ?? []).every((d) => done.has(d)));
        if (task) next = `tenon task done ${id} ${task.id}`;
      }
      const decisions = decisionAnswers(root, id);
      const unread = unreadCount(root, id);
      const result = { ...state, approval_id: approvalCycle(root, id).approval_id, evidence, decisions, next, blockers: missing, unread_feedback: unread };
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${id}: ${state.status} — ${state.reason}`);
        for (const d of decisions) console.log(`拍板：${d.question} → ${d.answer}${d.by === 'human' ? '' : '（用户未作答，按推荐项）'}`);
        for (const e of missing) console.log(`${e.acceptance}: ${e.status} ${e.reason ?? ''}`);
        if (unread) console.log(`未读批注：${unread} 条，运行 tenon wait ${id} 读取`);
        console.log(`下一步：${next}`);
      }
      return 0;
    }
    case 'evidence': {
      const id = requireChange(root, positionals[2]);
      const state = deriveStatus(root, id);
      if (!['applying', 'needs_fix', 'ready_to_archive'].includes(state.status) || state.reason.includes('快照')) throw new DevflowError('当前状态不允许记录证据', state.reason);
      if (arg === 'confirm') { requireHuman('evidence confirm'); console.log(JSON.stringify(confirmEvidence(root, id, positionals[3] ?? ''), null, 2)); }
      else if (arg === 'add' && opts.file) console.log(JSON.stringify(recordEvidence(root, id, JSON.parse(readFileSync(resolve(opts.file), 'utf8'))), null, 2));
      else throw new DevflowError('用法：evidence add <id> --file <json> 或 evidence confirm <id> <evidence-id>');
      return 0;
    }
    case 'usage': {
      if (arg === 'configure') { if (opts.on === opts.off) throw new DevflowError('指定 --on 或 --off'); configureUsage(root, !!opts.on); console.log(JSON.stringify({ enabled: !!opts.on })); }
      else if (arg === 'report') console.log(JSON.stringify(usageReport(root, { since: opts.since, tool_version: opts['tool-version'], schema_version: opts.schema ? Number(opts.schema) : undefined }), null, 2));
      else if (arg === 'feedback' && opts.file) console.log(JSON.stringify(addFeedback(root, positionals[2] ?? '', JSON.parse(readFileSync(resolve(opts.file), 'utf8'))), null, 2));
      else if (arg === 'export' && opts.out) console.log(JSON.stringify(exportUsage(root, { since: opts.since }, resolve(opts.out)), null, 2));
      else if (arg === 'prune' && opts.before) console.log(JSON.stringify(pruneUsage(root, opts.before), null, 2));
      else throw new DevflowError('未知 usage 子命令或缺少参数');
      return 0;
    }
    case 'improve': {
      if (arg === 'draft') {
        const candidate = getCandidate(root, positionals[2] ?? '');
        const id = positionals[3];
        newChange(root, id);
        writeFileSync(join(changeDir(root, id), 'proposal.md'), `# 优化候选\n\n## 为什么\n\n候选信息仅供核查，不代表因果结论。\n\n\`\`\`json\n${JSON.stringify(candidate, null, 2)}\n\`\`\`\n\n## 改什么\n\n待核实假设与验收标准后补齐。\n`);
        console.log(JSON.stringify({ id, candidate, status: 'draft' }, null, 2));
      } else if (arg === 'resolve' && opts.report) console.log(JSON.stringify(resolveCandidate(root, positionals[2] ?? '', resolve(opts.report)), null, 2));
      else console.log(JSON.stringify(listCandidates(root), null, 2));
      return 0;
    }
    case 'eval': {
      const result = arg === 'run' && opts.suite === 'workflow' ? runWorkflowSuite(VERSION) : arg === 'compare' && positionals[2] && positionals[3] ? compareReports(readReport(resolve(positionals[2])), readReport(resolve(positionals[3]))) : null;
      if (!result) throw new DevflowError('用法：eval run --suite workflow 或 eval compare <baseline> <candidate>');
      if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      return 'samples' in result && result.samples.some((s) => s.outcome !== 'pass') ? 1 : 0;
    }
    case 'init': {
      const guessed = opts.agents ? null : guessAgents(root);
      const agents = opts.agents ? parseAgents(opts.agents) : guessed ?? [...AGENTS];
      const r = init(root);
      const a = installAgents(root, agents);
      if (opts.json) console.log(JSON.stringify({ ...r, agents: a }, null, 2));
      else {
        for (const f of r.created) console.log(`+ ${f}`);
        if (r.hook === 'foreign') {
          console.warn(`! ${r.hookPath} 已有其他 hook，未覆盖。请在其中加一行：tenon check --staged`);
        } else console.log(`✓ pre-commit hook 已${r.hook === 'installed' ? '安装' : '更新'}：${r.hookPath}`);
        for (const c of r.codeHooks) {
          if (c.hook === 'missing') console.warn(`! ${c.repo} 不是 Git 仓库，没有安装 hook；检查 project.yaml 的 code_roots`);
          else if (c.hook === 'foreign') console.warn(`! ${c.hookPath} 已有其他 hook，未覆盖。请在其中加一行：${c.line}`);
          else console.log(`✓ 代码仓库 pre-commit hook 已${c.hook === 'installed' ? '安装' : '更新'}：${c.hookPath}`);
        }
        printAgents(a);
        if (!opts.agents && !guessed) console.warn(`! 未检测到 Agent，已为全部安装（${AGENTS.join(', ')}）；可用 --agents claude 或 --agents codex 只装一种`);
      }
      return 0;
    }
    case 'update': {
      requireInit(root);
      const agents = opts.agents ? parseAgents(opts.agents) : detectAgents(root);
      if (!agents.length) throw new DevflowError('没有找到已安装的 Agent 文件', '用 tenon update --agents claude,codex 指定');
      const a = installAgents(root, agents);
      if (opts.json) console.log(JSON.stringify(a, null, 2));
      else printAgents(a);
      return 0;
    }
    case 'wiki': {
      requireInit(root);
      if (arg !== 'lint') throw new DevflowError(`未知子命令：wiki ${arg ?? ''}`, '用法：tenon wiki lint');
      const { issues, pages } = lintWiki(root);
      // 只在 wiki lint 与 doctor 提醒；check 也用 lintWiki，不能每次提交都提醒
      if (!pages.length) issues.push({ level: 'warn', file: `${dfOf(root)}/knowledge/pages/`, message: '知识页为空', hint: '用 tenon-scan 技能生成知识页；小项目可以跳过' });
      return report(issues, `✓ ${pages.length} 个知识页校验通过`);
    }
    case 'new': {
      const files = newChange(root, arg, opts.schema === undefined ? 2 : Number(opts.schema));
      if (opts.json) console.log(JSON.stringify({ files }, null, 2));
      else {
        for (const f of files) console.log(`+ ${f}`);
        console.log(`填写完成后运行 tenon validate ${arg}`);
      }
      return 0;
    }
    case 'validate': {
      requireInit(root);
      const id = requireChange(root, arg);
      return report([...validateProject(root), ...validateChange(root, id, true), ...reviewIssues(root, id)], `✓ ${id} 校验通过`);
    }
    case 'status': {
      requireInit(root);
      const list = (arg ? [requireChange(root, arg)] : listChanges(root)).map((id) => { const st = deriveStatus(root, id); return { ...st, todo: humanTodo(root, id, st), stale_hours: staleHours(root, id, st) }; });
      const archived = opts.all && !arg ? listArchived(root) : [];
      if (opts.json) console.log(JSON.stringify([...list, ...archived], null, 2));
      else if (!list.length && !archived.length) console.log('没有进行中的变更。用 tenon new <id> 新建');
      else {
        // 行尾标出轮到谁：人的待办，或 Agent 进行中（已归档的变更没有这一段）
        for (const s of list) console.log(`${s.id}  ${s.status}  任务 ${s.tasks.done}/${s.tasks.total}  ${s.reason}  ← ${s.todo ?? 'Agent 进行中'}${s.stale_hours === null ? '' : ` · ${staleText(s.stale_hours)}`}`);
        for (const a of archived) console.log(`${a.id}  archived  ${a.archived_at ? a.archived_at.slice(0, 16).replace('T', ' ') + ' UTC' : '归档时间未知'}`);
      }
      return 0;
    }
    case 'review': {
      requireHuman('review');
      requireInit(root);
      const token = randomBytes(16).toString('hex');
      const server = reviewServer(root, token, VERSION);
      await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}/${arg ? `c/${requireChange(root, arg)}` : ''}`;
      console.log(`审查台已启动：${url}`);
      console.log('保持这个终端打开；按 Ctrl+C 结束。地址里带有本次启动的令牌，不要贴给 Agent。');
      // 打不开浏览器不算失败：地址已经打印在终端里
      spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      await new Promise(() => {}); // 一直服务到 Ctrl+C
      return 0;
    }
    case 'wait': {
      requireInit(root);
      const id = requireChange(root, arg);
      const seconds = opts.timeout === undefined ? 1800 : Number(opts.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new DevflowError('--timeout 必须是正数（秒）');
      // 只有人能产生这三类事件；归档后变更目录被移走
      const acted = () => (existsSync(changeDir(root, id)) ? readEvents(root, id).filter((e) => ['approved', 'evidence-confirmed', 'archived'].includes(e.type)).length : Infinity);
      const start = acted();
      const deadline = Date.now() + seconds * 1000;
      // 审查台据此显示「Agent 正在等待」；被杀掉时标记会残留，审查台按进程是否存活判断
      const unmark = markWaiting(root, id);
      const bye = () => { unmark(); process.exit(130); };
      process.once('SIGINT', bye).once('SIGTERM', bye);
      try {
        while (acted() === start) {
          const fb = takeFeedback(root, id);
          if (fb.length) {
            console.log(formatFeedback(fb));
            console.log(`处理完后再次运行 tenon wait ${id}`);
            return 0;
          }
          if (Date.now() >= deadline) {
            console.log(`等待超时：${id} 还没有新的人工操作（批准、确认证据、归档或批注）`);
            return 1;
          }
          await sleep(2000);
        }
      } finally {
        unmark();
        process.off('SIGINT', bye).off('SIGTERM', bye);
      }
      if (!existsSync(changeDir(root, id))) console.log(`${id}: archived — 已归档`);
      else {
        const st = deriveStatus(root, id);
        console.log(`${id}: ${st.status} — ${st.reason}`);
        console.log(`下一步：tenon resume ${id}`);
      }
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
      if (opts.hash !== undefined) {
        // 复制审查页上的命令就是确认：前缀一致即批准，不再问 y
        if (!/^[0-9a-f]{12,64}$/.test(opts.hash)) throw new DevflowError('--hash 至少需要 12 位十六进制', '从审查页复制完整的 tenon approve 命令');
        if (!ev.hash.startsWith(`sha256:${opts.hash}`)) {
          throw new DevflowError('--hash 与当前内容哈希不一致，未批准', `可能是审查后被审文件又被修改，或命令没有复制完整；重新运行 tenon render ${id}，从新页面复制命令`);
        }
      } else if (!(await confirm('确认批准？输入 y 确认：', ''))) {
        const st = deriveStatus(root, id);
        console.log(`✗ 未批准：${id} 状态仍为 ${st.status}（${st.reason}）。要批准，请重新运行并输入 y`);
        return 1;
      }
      approve(root, id, ev.hash);
      console.log(`✓ 已批准 ${id}`);
      console.log(`下一步：在 Agent 里说"用 tenon-apply 实现变更 ${id}"`);
      return 0;
    }
    case 'apply': {
      if (!opts.start) throw new DevflowError('用法：tenon apply <id> --start', '记录开工；开工前状态必须为 approved');
      const ev = applyStart(root, arg!);
      if (opts.json) console.log(JSON.stringify(ev, null, 2));
      else console.log(`✓ ${arg} 已开工（基于 ${ev.type === 'apply-started' ? ev.head.slice(0, 7) : ''}）`);
      return 0;
    }
    case 'task': {
      if (arg !== 'done') throw new DevflowError(`未知子命令：task ${arg ?? ''}`, '用法：tenon task done <id> <任务ID>');
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
          if (c.quiet) console.warn(`! ${c.name} 没有任何输出：日志无法用来核对证据（去掉 -q 之类的静默参数，让它打印跑了哪些测试）`);
        }
        console.log(`配置检查结果：${r.result}${r.note ? `（${r.note}）` : ''}；状态：${deriveStatus(root, arg!).status}`);
      }
      return r.result === 'pass' ? 0 : 1;
    }
    case 'archive': {
      requireHuman('archive');
      requireInit(root);
      if (!arg) throw new DevflowError('缺少变更 ID', '用法：tenon archive <id>');
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
        console.log(`  审查后由人批准：在审查台（tenon review）里点「批准此版本」，或在自己的终端运行 tenon approve ${id}`);
        console.log(`  等待批准：tenon wait ${id}`);
      }
      return 0;
    }
    case 'check':
      return report(opts.project ? checkCodeRepo(resolve(opts.project), root) : check(root, { staged: !!opts.staged }), '✓ tenon check 通过');
    default:
      throw new DevflowError(`未知命令：${cmd}`, HELP);
  }
}

async function main(): Promise<number> {
  let root: string;
  try { root = repoRoot(process.cwd()); } catch { return dispatch(); }
  const internal = ['usage', 'improve', 'eval', 'guard'].includes(cmd ?? '');
  const changeId = cmd === 'task' || cmd === 'evidence' ? positionals[2] : arg;
  const state = () => { try { return changeId && /^[a-z0-9][a-z0-9-]*$/.test(changeId) ? deriveStatus(root, changeId) : undefined; } catch { return undefined; } };
  const before = state();
  let approval_id: string | undefined;
  try { if (before) approval_id = approvalCycle(root, changeId!).approval_id.replace(':', '-'); } catch { /* reporting cannot block commands */ }
  const handle = internal ? undefined : startUsage(root, { tool_version: VERSION, command: cmd ?? 'help', subcommand: ['task', 'evidence', 'wiki'].includes(cmd ?? '') ? arg : undefined, change_id: before || cmd === 'new' ? changeId : undefined, approval_id, status_before: before?.status });
  try {
    const mutate = ['apply', 'task', 'verify', 'approve', 'archive', 'evidence'].includes(cmd ?? '');
    // Interactive confirmation keeps the worktree lock until the command finishes.
    let code: number;
    if (mutate) {
      // dispatch is async; keep ownership until its promise resolves.
      code = await withWorktreeLock(root, dispatch);
    } else code = await dispatch();
    finishUsage(handle, { outcome: code === 0 ? 'success' : 'failure', status_after: state()?.status, reason_code: code === 0 ? 'completed' : 'check-failed' });
    return code;
  } catch (e) {
    const message = e instanceof DevflowError ? e.message : '';
    const reason = /持锁|占用/.test(message) ? 'worktree-busy' : /证据/.test(message) ? 'evidence-incomplete' : /哈希|批准|审批|draft/.test(message) ? 'approval-invalid' : /rebase_required|规范/.test(message) ? 'spec-conflict' : /任务|依赖/.test(message) ? 'task-blocked' : /交互终端/.test(message) ? 'human-required' : 'command-failed';
    finishUsage(handle, { outcome: 'failure', status_after: state()?.status, error_code: e instanceof DevflowError ? 'DEVFLOW_ERROR' : 'UNEXPECTED_ERROR', reason_code: reason }); throw e;
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
