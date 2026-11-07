// 端到端全流程：scan → 人审查并批准方案 → Agent 实现并验证（mvn test）→ 人提交 → Agent 更新知识页 → 人归档 → 新会话追问设计原因
// 用法：node eval/lifecycle.ts [--model <模型>]（调用 claude -p，消耗用量；需要 mvn）
// "人"的步骤由本脚本代为执行：approve / archive 通过 script 提供交互终端并输入 y
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { model: { type: 'string' } } });
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/user-admin', import.meta.url));
// M2 端到端中 Agent 写的方案，作为本次的输入
const PROPOSAL = fileURLToPath(new URL('./results/2026-11-06-04-35-propose/2026-11-06-admin-only-disable', import.meta.url));
const ID = '2026-11-06-admin-only-disable';
const OUT = fileURLToPath(new URL(`./results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-lifecycle/`, import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'devflow-lifecycle-'));
const proj = join(tmp, 'user-admin');
cpSync(DEMO, proj, { recursive: true });
mkdirSync(join(tmp, 'bin'));
writeFileSync(join(tmp, 'bin/devflow'), `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`);
chmodSync(join(tmp, 'bin/devflow'), 0o755);
const env = { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}` };
const sh = (cmd: string, ...a: string[]) => execFileSync(cmd, a, { cwd: proj, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const df = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: proj, env, encoding: 'utf8' });
const status = () => JSON.parse(df('status', ID, '--json').stdout)[0];
/** 以人的身份在交互终端里运行命令并输入 y */
const asHuman = (...a: string[]) => {
  const r = spawnSync('sh', ['-c', `(sleep 2; printf 'y\\n') | script -q /dev/null '${process.execPath}' '${CLI}' ${a.join(' ')}`], { cwd: proj, env, encoding: 'utf8', timeout: 120_000 });
  return (r.stdout + r.stderr).replace(/\r/g, '');
};

const log: Record<string, unknown> = {};
let cost = 0;
function claude(step: string, prompt: string, tools: string[], minutes: number) {
  const args = ['-p', prompt, '--max-turns', '100', '--output-format', 'json', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', '--allowedTools', ...tools];
  if (opts.model) args.push('--model', opts.model);
  console.log(`[${step}] 运行 claude …`);
  const r = spawnSync('claude', args, { cwd: proj, env, encoding: 'utf8', timeout: Math.min(minutes, 30) * 60_000, maxBuffer: 64 * 1024 * 1024 });
  let res: any = {};
  try {
    res = JSON.parse(r.stdout);
  } catch {
    res = { is_error: true, result: (r.stderr || r.stdout || String(r.error)).slice(0, 2000) };
  }
  cost += res.total_cost_usd ?? 0;
  log[step] = { turns: res.num_turns, cost: res.total_cost_usd, is_error: res.is_error, denials: res.permission_denials, result: res.result };
  console.log(`[${step}] ${res.num_turns ?? '?'} 轮，$${(res.total_cost_usd ?? 0).toFixed(2)}${res.is_error ? '，出错' : ''}`);
  return res;
}
const READ = ['Read', 'Grep', 'Glob', 'Skill', 'Bash(rg *)', 'Bash(ls *)', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git rev-parse *)', 'Bash(date *)'];
const WRITE = [...READ, 'Edit', 'Write', 'Bash(devflow *)'];

// 0. 项目准备：git、devflow init、验证命令
sh('git', 'init', '-q');
sh('git', 'config', 'user.name', 'devflow-eval');
sh('git', 'config', 'user.email', 'eval@example.invalid');
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', 'demo', '--no-verify');
sh('devflow', 'init', '--agents', 'claude');
const pf = join(proj, '.devflow/project.yaml');
writeFileSync(pf, readFileSync(pf, 'utf8').replace(/^verify: \[\]$/m, 'verify:\n  - name: backend-test\n    run: mvn -q -B test\n    cwd: backend'));
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', 'devflow init');
console.log(`临时项目：${proj}`);

// 1. scan
claude('scan', '使用 devflow-scan 技能，为本项目生成知识页。完成后运行 devflow wiki lint，确保没有错误。', WRITE, 20);
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', 'knowledge');

// 2. 方案：采用 M2 中 Agent 写的方案，按人的审查意见修改后批准
cpSync(PROPOSAL, join(proj, '.devflow/changes', ID), { recursive: true });
// 保留原始验收标准；依赖或运行环境不足必须记为 unknown，不替换成静态条件。
log.review = ['冻结原始验收；错误配置需在方案审查中发现，不能由运行器悄悄修正'];
log.acceptancePolicy = 'original-contract-or-unknown';
log.validate = JSON.parse(df('validate', ID, '--json').stdout);
df('render', ID);
log.approve = asHuman('approve', ID);
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', `proposal ${ID}`);
console.log(`[approve] 状态：${status().status}`);

// 3. 实现与验证
claude('apply', `使用 devflow-apply 技能实现变更 ${ID}，直到 devflow verify 通过。`, [...WRITE, 'Bash(mvn *)'], 45);
log.afterApply = status();
console.log(`[apply] 状态：${log.afterApply && (log.afterApply as any).status}`);

// 4. 人提交代码；Agent 更新知识页；人归档
if ((log.afterApply as any)?.status === 'ready_to_archive') {
  sh('git', 'add', '-A');
  sh('git', 'commit', '-qm', `implement ${ID}`);
  claude('archive-prep', `使用 devflow-archive 技能为变更 ${ID} 做归档准备。代码已由我提交。`, WRITE, 20);
  log.wikiLint = JSON.parse(df('wiki', 'lint', '--json').stdout || '{}');
  log.archive = asHuman('archive', ID);
  log.check = JSON.parse(df('check', '--json').stdout || '{}');
  sh('git', 'add', '-A');
  sh('git', 'commit', '-qm', `archive ${ID}`);

  // 5. 新会话：能否找回实现位置与设计原因
  claude('recall', '禁用用户为什么要求操作者是 ADMIN？是哪次变更引入的、实现在哪里？给出处。', READ, 10);
}

const archived = join(proj, '.devflow/changes/archive', ID);
const summary = {
  cost,
  finalStatus: existsSync(archived) ? 'archived' : status()?.status,
  specCreated: existsSync(join(proj, '.devflow/specs/user-management/spec.md')),
  checkOk: (log.check as any)?.ok,
  wikiLintOk: (log.wikiLint as any)?.ok,
  testsAdded: sh('git', 'log', '--name-only', '--format=', '--', 'backend/src/test').split('\n').filter(Boolean).length,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'log.json'), JSON.stringify({ summary, ...log }, null, 2));
writeFileSync(join(OUT, 'git-log.txt'), sh('git', 'log', '--stat', '--format=== %s'));
if (existsSync(join(proj, '.devflow'))) cpSync(join(proj, '.devflow'), join(OUT, 'devflow'), { recursive: true, filter: (s) => !s.includes('/runtime') });
console.log(JSON.stringify(summary, null, 2));
console.log(`结果：${OUT}\n临时项目：${proj}`);
