// 变更 2026-11-14-codex-parity：Codex 沙箱内可运行、防线与 Claude 对齐
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS, CODEX_HOOK, agentDrift, installAgents } from '../src/agents.ts';
import { withWorktreeLock, worktreeHash } from '../src/core.ts';
import { doctor } from '../src/doctor.ts';
import { guard } from '../src/guard.ts';
import { approve } from '../src/status.ts';
import { CLI, HUMAN_ENV, cli, g, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

test('AC1 .git 不可写时 status、resume、apply --start、task done 正常运行', (t) => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  write(dir, 'backend/src/Auth.java', 'class Auth { int dirty; }\n'); // 未提交的改动：算哈希时要写新对象
  write(dir, 'backend/src/New.java', 'class New {}\n');
  execFileSync('chmod', ['-R', 'a-w', join(dir, '.git')]);
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', join(dir, '.git')]); rmSync(dir, { recursive: true, force: true }); });

  for (const args of [['status'], ['resume', ID], ['apply', ID, '--start'], ['task', 'done', ID, 'T1'], ['status']]) {
    const r = cli(dir, ...args);
    assert.equal(r.status, 0, `tenon ${args.join(' ')}：${r.stderr}`);
  }
  assert.match(cli(dir, 'status').stdout, /applying\s+任务 1\/2/);
  // 锁在数据目录的 runtime/ 下，不在 .git 里
  withWorktreeLock(dir, () => assert.equal(existsSync(join(dir, '.tenon/runtime/tenon.lock')), true));
  assert.equal(existsSync(join(dir, '.git/tenon.lock')), false);
});

test('AC2 工作树哈希与改动前的算法相同，且不往 .git 写对象；独立 worktree 不互锁', (t) => {
  const dir = makeRepo();
  const other = `${dir}-worktree`;
  t.after(() => { rmSync(other, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });
  write(dir, 'backend/src/Auth.java', 'class Auth { int dirty; }\n');
  write(dir, 'backend/src/New.java', 'class New {}\n');
  const objects = () => readdirSync(join(dir, '.git/objects'), { recursive: true }).length;
  const before = objects();
  const hash = worktreeHash(dir);
  assert.equal(objects(), before, '算哈希不应往 .git/objects 写对象');

  // 改动前的算法：临时索引，对象直接写进仓库
  const tmp = mkdtempSync(join(tmpdir(), 'tenon-old-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  const old = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  old('add', '-A', '--', '.');
  old('rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.tenon');
  assert.equal(hash, `git-tree:${old('write-tree').trim()}`);
  rmSync(tmp, { recursive: true, force: true });

  g(dir, 'worktree', 'add', '--detach', other);
  withWorktreeLock(dir, () => withWorktreeLock(other, () => assert.ok(true)));
});

const hook = (command: unknown, tool_name = 'Bash') => guard(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command } }));
const denied = (out: string) => out !== '' && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';

test('AC3 guard 拒绝换写法的人专属命令和改 specs、events.jsonl 的补丁，放行其他', () => {
  for (const c of [
    'tenon approve x', 'npx tenon approve x', '/opt/homebrew/bin/tenon archive x', 'node dist/cli.js approve x',
    'cd a && tenon approve x 2>&1', 'tenon review', 'tenon evidence confirm x e1', 'pnpm exec tenon archive x',
    'bash -lc "tenon approve x"', 'FOO=1 tenon approve x --hash abc',
  ]) assert.equal(denied(hook(c)), true, c);
  assert.equal(denied(hook(['bash', '-lc', 'tenon approve x'])), true, '参数数组形式');
  assert.match(JSON.parse(hook('npx tenon approve x')).hookSpecificOutput.permissionDecisionReason, /只能由人在自己的终端运行/);

  const patch = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n`;
  for (const f of ['.tenon/specs/user/spec.md', '.devflow/changes/x/events.jsonl', '/abs/repo/.tenon/changes/archive/2026-01-01-x/events.jsonl']) {
    assert.equal(denied(hook(patch(f), 'apply_patch')), true, f);
  }
  assert.equal(denied(hook(`apply_patch <<'EOF'\n${patch('.tenon/specs/a/spec.md')}EOF`)), true, 'shell 里的补丁');

  for (const c of ['tenon status', 'tenon evidence add x --file e.json', 'rg "tenon approve" docs', 'tenon wait x --timeout 300', 'echo tenon approve', 'git commit -m "docs: tenon review 说明"']) {
    assert.equal(hook(c), '', c);
  }
  assert.equal(hook(patch('src/core.ts'), 'apply_patch'), '');
  assert.equal(hook(patch('.tenon/changes/x/design.md'), 'apply_patch'), '');

  // 输入损坏或缺字段：放行，退出码 0
  for (const bad of ['', '{ 坏的', 'null', '{"tool_input":{}}']) assert.equal(guard(bad), '');
  const r = spawnSync(process.execPath, [CLI, 'guard'], { encoding: 'utf8', input: '{ 坏的' });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  const d = spawnSync(process.execPath, [CLI, 'guard'], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npx tenon approve x' } }) });
  assert.equal(d.status, 0);
  assert.equal(denied(d.stdout), true);
});

test('AC4 为 Codex 登记钩子：保留已有钩子、不重复登记、文件损坏时不改动', () => {
  const dir = makeRepo();
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook' }] };
  write(dir, '.codex/hooks.json', JSON.stringify({ description: '我的钩子', hooks: { PreToolUse: [mine], Stop: [] } }));
  installAgents(dir, ['codex']);
  const r = installAgents(dir, ['codex']);
  const h = JSON.parse(read(dir, '.codex/hooks.json'));
  assert.deepEqual(h, { description: '我的钩子', hooks: { PreToolUse: [mine, CODEX_HOOK], Stop: [] } });
  assert.match(r.warnings.join(), /\/hooks/);

  const fresh = makeRepo();
  assert.equal(cli(fresh, 'init', '--agents', 'codex').status, 0);
  assert.deepEqual(JSON.parse(read(fresh, '.codex/hooks.json')), { hooks: { PreToolUse: [CODEX_HOOK] } });

  const bad = makeRepo();
  write(bad, '.codex/hooks.json', '{ 坏的');
  const w = installAgents(bad, ['codex']);
  assert.equal(read(bad, '.codex/hooks.json'), '{ 坏的');
  assert.match(w.warnings.join(), /hooks\.json 不是合法的 JSON 对象.*tenon guard/);
});

test('AC5 人专属命令检测到 Agent 环境变量时拒绝并说明原因', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const clean = HUMAN_ENV;
  const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8', input: '' });

  for (const k of ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID']) {
    for (const args of [['approve', ID], ['archive', ID], ['review']]) {
      const r = run({ ...clean, [k]: '1' }, ...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, new RegExp(`只能由人在交互终端中运行（检测到 Agent 环境变量 ${k}）`));
      assert.match(r.stderr, /请在你自己的终端里执行/);
    }
  }
  // 没有这些变量时仍按交互终端判断，不提环境变量
  const plain = run(clean, 'approve', ID);
  assert.match(plain.stderr, /只能由人在交互终端中运行/);
  assert.doesNotMatch(plain.stderr, /环境变量/);

  // evidence confirm 要先开工才走到人工检查
  approve(dir, ID);
  assert.equal(cli(dir, 'apply', ID, '--start').status, 0);
  assert.match(run({ ...clean, CODEX_SANDBOX: 'seatbelt' }, 'evidence', 'confirm', ID, 'e1').stderr, /evidence confirm 只能由人在交互终端中运行（检测到 Agent 环境变量 CODEX_SANDBOX）/);
});

const TPL = join(REPO, 'templates');
const templates = ['entry.md', ...readdirSync(join(TPL, 'skills')).map((s) => `skills/${s}/SKILL.md`).filter((f) => existsSync(join(TPL, f)))];

test('AC6 提到后台运行 tenon wait 的技能和入口说明都给出前台等待的做法', () => {
  const waiting = templates.filter((f) => /后台运行 `tenon wait/.test(read(TPL, f)));
  assert.deepEqual(waiting.sort(), ['entry.md', 'skills/tenon-apply/SKILL.md', 'skills/tenon-archive/SKILL.md', 'skills/tenon-propose/SKILL.md']);
  for (const f of waiting) assert.match(read(TPL, f), /前台运行 `tenon wait <id> --timeout 300`.*超时就结束本轮/, f);
});

test('AC7 技能不要求 Claude 专有的读文件工具，本仓库的 Agent 文件与模板一致', () => {
  for (const f of templates) assert.doesNotMatch(read(TPL, f), /如 Read|Read 工具/, f);
  for (const a of AGENTS) assert.deepEqual(agentDrift(REPO, a), [], a);
});

test('AC8 防线文件缺失或不一致时 doctor 报 warn 并提示 tenon update', () => {
  const dir = makeRepo();
  installAgents(dir, ['claude', 'codex']);
  const item = (a: string) => doctor(dir).find((x) => x.item === `Agent 文件（${a}）`)!;
  assert.equal(item('claude').level, 'ok');
  assert.equal(item('codex').level, 'ok');

  rmSync(join(dir, '.codex/rules/tenon.rules'));
  assert.deepEqual([item('codex').level, item('codex').hint], ['warn', 'tenon update --agents codex']);
  assert.match(item('codex').message, /\.codex\/rules\/tenon\.rules/);
  installAgents(dir, ['codex']);

  write(dir, '.codex/hooks.json', '{"hooks":{}}');
  assert.match(item('codex').message, /\.codex\/hooks\.json/);
  write(dir, '.codex/rules/tenon.rules', '# 被改过\n');
  assert.match(item('codex').message, /tenon\.rules.*hooks\.json/);

  write(dir, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(tenon approve *)'] } }));
  assert.deepEqual([item('claude').level, item('claude').hint], ['warn', 'tenon update --agents claude']);
  assert.match(item('claude').message, /\.claude\/settings\.json/);
  rmSync(join(dir, '.claude/settings.json'));
  assert.equal(item('claude').level, 'warn');

  // 没声明验证命令的修复提示里是真实的数据目录，不是没展开的模板
  assert.match(doctor(dir).find((x) => x.item === 'project.yaml')!.hint!, /^在 \.tenon\/project\.yaml/);
});

test('AC9 README 与使用手册写明 Codex 钩子防线、需要信任项目并确认钩子', () => {
  for (const f of ['README.md', 'docs/使用手册.md']) {
    const text = read(REPO, f);
    assert.match(text, /\.codex\/hooks\.json/, f);
    assert.match(text, /tenon guard/, f);
    assert.match(text, /信任/, f);
    assert.match(text, /`\/hooks`/, f);
    assert.match(text, /CODEX_SANDBOX/, f);
    assert.doesNotMatch(text, /可被绕过/, f);
  }
  assert.match(read(REPO, 'docs/使用手册-概览.md'), /确认钩子后生效/);
});
