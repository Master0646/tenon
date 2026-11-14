// 端到端：让 Claude Code 在演示项目上用 tenon-propose 提一个变更，检查产出
// 用法：node eval/propose.ts [--model <模型>]（调用 claude -p，消耗用量）
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listChanges } from '../src/core.ts';

const { values: opts } = parseArgs({ options: { model: { type: 'string' } } });
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/user-admin', import.meta.url));
const OUT = fileURLToPath(new URL(`./results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-propose/`, import.meta.url));

const REQUEST = '使用 tenon-propose 技能，为下面的需求提出变更方案：禁用用户接口目前任何登录用户都能调用，要求只有 ADMIN 角色才能禁用用户；前端对非 ADMIN 用户隐藏禁用按钮。不要向我提问；信息不足时按最合理的理解写，并在 proposal 中写明假设。';
const TOOLS = ['Read', 'Grep', 'Glob', 'Skill', 'Edit', 'Write', 'Bash(rg *)', 'Bash(ls *)', 'Bash(tenon *)', 'Bash(git *)', 'Bash(date *)'];

const tmp = mkdtempSync(join(tmpdir(), 'tenon-propose-'));
const proj = join(tmp, 'user-admin');
cpSync(DEMO, proj, { recursive: true });
mkdirSync(join(tmp, 'bin'));
writeFileSync(join(tmp, 'bin/tenon'), `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`);
chmodSync(join(tmp, 'bin/tenon'), 0o755);
const env = { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}` };
const sh = (...a: string[]) => execFileSync(a[0], a.slice(1), { cwd: proj, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
sh('git', 'init', '-q');
sh('git', 'config', 'user.name', 'tenon-eval');
sh('git', 'config', 'user.email', 'eval@example.invalid');
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', 'demo', '--no-verify');
sh('tenon', 'init', '--agents', 'claude');
sh('git', 'add', '-A');
sh('git', 'commit', '-qm', 'tenon init');
console.log(`临时项目：${proj}`);

const args = ['-p', REQUEST, '--output-format', 'json', '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', '--allowedTools', ...TOOLS];
if (opts.model) args.push('--model', opts.model);
const r = spawnSync('claude', args, { cwd: proj, env, encoding: 'utf8', timeout: 20 * 60_000 });
const res = JSON.parse(r.stdout || '{}');

const changes = listChanges(proj);
const id = changes[0];
const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: proj, env, encoding: 'utf8' });
const validate = id ? run('validate', id, '--json') : null;
const rendered = id ? run('render', id, '--json') : null;
const status = id ? JSON.parse(run('status', id, '--json').stdout)[0] : null;
const codeChanged = sh('git', 'status', '--porcelain', '--', '.', ':(exclude).tenon').split('\n').filter(Boolean);

const report = {
  turns: res.num_turns, cost: res.total_cost_usd, changes,
  validateOk: validate ? JSON.parse(validate.stdout).ok : false,
  validateIssues: validate ? JSON.parse(validate.stdout).issues : [],
  renderOk: rendered?.status === 0, renderError: rendered?.status === 0 ? null : rendered?.stdout || rendered?.stderr,
  status: status?.status, approved: id ? existsSync(join(proj, '.tenon/changes', id, 'events.jsonl')) : false,
  codeChanged, permissionDenials: res.permission_denials ?? [], finalMessage: res.result,
};
mkdirSync(OUT, { recursive: true });
if (id) cpSync(join(proj, '.tenon/changes', id), join(OUT, id), { recursive: true });
if (rendered?.status === 0) cpSync(JSON.parse(rendered.stdout).file, join(OUT, `${id}.html`));
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, finalMessage: String(report.finalMessage).slice(0, 600) }, null, 2));
console.log(`结果：${OUT}`);
