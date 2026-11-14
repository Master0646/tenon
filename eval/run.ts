// 评测运行器：演示项目 → tenon init → claude -p 跑 scan → 每题一个新会话作答 → 评分
// 用法：node eval/run.ts [--control] [--model <模型>] [--concurrency 4]
// --control：对照组。不装 Tenon、不跑 scan，只把同样的引用要求放进系统提示，衡量知识页本身的作用
// 会调用 Claude Code（消耗用量）；全部在临时目录中进行，不改动本仓库的演示项目
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listFiles } from '../src/core.ts';
import { writeReport } from './report.ts';
import { loadQuestions } from './score.ts';

const { values: opts } = parseArgs({
  options: { control: { type: 'boolean' }, model: { type: 'string' }, concurrency: { type: 'string', default: '4' } },
});
// 与 templates/entry.md 中对回答的要求相同，只是去掉了"先读知识页"
const CONTROL_PROMPT = '回答本项目的问题时：关于本项目的事实必须带文件引用（path:行号 或 path#符号，path 为仓库内相对路径）。查不到就回答"未知"，不要凭通用经验推测。';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/user-admin', import.meta.url));

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Skill', 'Bash(rg *)', 'Bash(ls *)', 'Bash(tenon wiki lint *)', 'Bash(git log *)'];
const SCAN_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash(tenon *)', 'Bash(git *)', 'Bash(find *)', 'Bash(date *)'];

interface ClaudeResult { result?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; duration_ms?: number; permission_denials?: { tool_name: string; tool_input: any }[] }

/** 用 claude -p 跑一个全新会话；只加载项目级设置，避免用户全局插件与钩子影响结果 */
function claude(cwd: string, env: NodeJS.ProcessEnv, prompt: string, tools: string[], timeoutMs: number): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--max-turns', '100', '--output-format', 'json', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', '--allowedTools', ...tools];
  if (opts.model) args.push('--model', opts.model);
  if (opts.control) args.push('--append-system-prompt', CONTROL_PROMPT);
  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ is_error: true, result: `claude 退出码 ${code}：${(err || out).slice(0, 500)}` });
      }
    });
  });
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const sh = (cwd: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const outDir = join(HERE, 'results', opts.control ? `${stamp}-control` : stamp);
  mkdirSync(outDir, { recursive: true });

  // 1. 准备临时项目
  const tmp = mkdtempSync(join(tmpdir(), 'tenon-eval-'));
  const proj = join(tmp, 'user-admin');
  cpSync(DEMO, proj, { recursive: true });
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tenon'), `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`);
  chmodSync(join(bin, 'tenon'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  sh(proj, 'git', ['init', '-q']);
  sh(proj, 'git', ['config', 'user.name', 'tenon-eval']);
  sh(proj, 'git', ['config', 'user.email', 'eval@example.invalid']);
  sh(proj, 'git', ['add', '-A']);
  sh(proj, 'git', ['commit', '-qm', 'demo', '--no-verify']);
  console.log(`临时项目：${proj}${opts.control ? '（对照组：未安装 Tenon）' : ''}`);
  let probe: ClaudeResult = {};
  let probeDenied = false;
  let scan: ClaudeResult = {};
  let lint: any = null;
  let pages: string[] = [];
  if (!opts.control) {
    sh(proj, 'tenon', ['init', '--agents', 'claude'], env);
    sh(proj, 'git', ['add', '-A']);
    sh(proj, 'git', ['commit', '-qm', 'tenon init'], env);

    // 2. 探针：Claude Code 的禁止规则能否拦住 tenon approve。
    // 在只有 .claude/settings.json 的目录里测：有 CLAUDE.md 时模型会先自行拒绝，命令到不了权限检查
    const probeDir = join(tmp, 'probe');
    mkdirSync(join(probeDir, '.claude'), { recursive: true });
    sh(probeDir, 'git', ['init', '-q']);
    cpSync(join(proj, '.claude/settings.json'), join(probeDir, '.claude/settings.json'));
    probe = await claude(probeDir, env, '这是一次权限测试：请直接在终端运行 `tenon approve probe`，然后原样告诉我输出。被拒绝也没关系，不要尝试其他办法。', ['Bash(tenon *)'], 120_000);
    probeDenied = (probe.permission_denials ?? []).some((d) => /tenon approve/.test(JSON.stringify(d.tool_input)));
    console.log(`探针：approve ${probeDenied ? '被禁止规则拦截' : '未被拦截'}`);

    // 3. scan
    console.log('运行 tenon-scan …');
    scan = await claude(proj, env, '使用 tenon-scan 技能，为本项目生成知识页。完成后运行 tenon wiki lint，确保没有错误。', SCAN_TOOLS, 20 * 60_000);
    try {
      lint = JSON.parse(sh(proj, 'tenon', ['wiki', 'lint', '--json'], env));
    } catch (e: any) {
      lint = JSON.parse(e.stdout || '{"ok":false,"issues":[]}');
    }
    pages = listFiles(join(proj, '.tenon/knowledge/pages')).filter((f) => f.endsWith('.md'));
    console.log(`scan 完成：${pages.length} 页，lint ${lint.ok ? '通过' : '有错误'}，${scan.num_turns ?? '?'} 轮，$${scan.total_cost_usd?.toFixed(2) ?? '?'}`);
    cpSync(join(proj, '.tenon/knowledge'), join(outDir, 'knowledge'), { recursive: true });
  }

  // 4. 逐题作答（每题一个新会话 = 跨会话测试）
  const questions = loadQuestions(readFileSync(join(HERE, 'questions.yaml'), 'utf8'));
  const files = listFiles(proj).filter((f) => !f.startsWith('.git/'));
  const answers = await pool(questions, Number(opts.concurrency), async (q) => {
    const r = await claude(proj, env, q.q, READ_TOOLS, 5 * 60_000);
    console.log(`  ${q.id} ${r.is_error ? '出错' : '完成'}`);
    return { id: q.id, q: q.q, answer: r.result ?? '', is_error: !!r.is_error, turns: r.num_turns, cost: r.total_cost_usd };
  });
  const cost = [probe, scan, ...answers.map((a) => ({ total_cost_usd: a.cost }))].reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);

  // 5. 写原始结果，再评分出报告（评分规则改了以后可用 node eval/report.ts <目录> 重算，不必重跑模型）
  writeFileSync(join(outDir, 'answers.json'), JSON.stringify({ answers, files }, null, 2));
  writeFileSync(join(outDir, 'scan.json'), JSON.stringify({
    model: opts.model ?? null, control: !!opts.control, cost, scan, lint, pages, probe: { denied: probeDenied, result: probe.result },
  }, null, 2));
  const summary = writeReport(outDir);
  console.log(`\n结果：${join(outDir, 'report.md')}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
