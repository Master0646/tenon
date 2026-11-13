// 体验反馈第 2 批：approve 提示、init 检测 Agent、审查页验证命令、status --all、validate 图语法、空知识页提醒
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { doctor } from '../src/doctor.ts';
import { buildDraft } from '../src/render.ts';
import { deriveStatus } from '../src/status.ts';
import { CLI, cli, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** 在伪终端中运行 CLI 并输入 answer（approve 要求交互终端）。延迟输入：太早写入会在终端就绪前被丢弃 */
function tty(dir: string, answer: string, ...args: string[]) {
  const cmd = [process.execPath, CLI, ...args].map(shq).join(' ');
  const pty = process.platform === 'darwin' ? `script -q /dev/null ${cmd}` : `script -qec ${shq(cmd)} /dev/null`;
  return spawnSync('sh', ['-c', `(sleep 1; printf '%s\\n' ${shq(answer)}; sleep 1) | ${pty}`], { cwd: dir, encoding: 'utf8' });
}
const hasScript = spawnSync('sh', ['-c', 'command -v script']).status === 0 && ['darwin', 'linux'].includes(process.platform);

test('approve：未输入 y 时说明未批准与当前状态；输入 y 时给出下一步', { skip: !hasScript && '需要 script 命令' }, () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const events = join(dir, `.devflow/changes/${ID}/events.jsonl`);
  const before = existsSync(events) ? readFileSync(events, 'utf8') : '';

  const no = tty(dir, 'n', 'approve', ID);
  assert.match(no.stdout, new RegExp(`未批准：${ID} 状态仍为 draft`));
  assert.equal(existsSync(events) ? readFileSync(events, 'utf8') : '', before);
  assert.equal(deriveStatus(dir, ID).status, 'draft');

  const yes = tty(dir, 'y', 'approve', ID);
  assert.match(yes.stdout, /已批准/);
  assert.match(yes.stdout, /devflow-apply/);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
});

test('init：只装检测到的 Agent；都检测不到时全装并提示；--agents 不检测', () => {
  const claudeOnly = makeRepo();
  write(claudeOnly, 'CLAUDE.md', '# 说明\n');
  assert.equal(cli(claudeOnly, 'init').status, 0);
  assert.ok(existsSync(join(claudeOnly, '.claude/skills/devflow-ask/SKILL.md')));
  assert.equal(existsSync(join(claudeOnly, '.agents')), false);
  assert.equal(existsSync(join(claudeOnly, 'AGENTS.md')), false);

  const none = makeRepo();
  const r = cli(none, 'init');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /未检测到 Agent.*--agents/);
  assert.ok(existsSync(join(none, '.claude/skills/devflow-ask/SKILL.md')));
  assert.ok(existsSync(join(none, '.agents/skills/devflow-ask/SKILL.md')));

  const explicit = makeRepo();
  write(explicit, 'CLAUDE.md', '# 说明\n');
  assert.equal(cli(explicit, 'init', '--agents', 'codex').status, 0);
  assert.ok(existsSync(join(explicit, '.agents/skills/devflow-ask/SKILL.md')));
  assert.equal(existsSync(join(explicit, '.claude/skills')), false);
});

test('审查页列出验证命令；未声明时写明', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  assert.match(buildDraft(dir, ID).draft, /未声明验证命令/);
  const f = join(dir, '.devflow/project.yaml');
  write(dir, '.devflow/project.yaml', readFileSync(f, 'utf8').replace(/^verify: \[\]$/m,
    'verify:\n  - name: backend-test\n    run: mvn -q test\n    cwd: backend\n  - name: lint\n    run: npm run lint'));
  const { draft } = buildDraft(dir, ID);
  assert.match(draft, /\| backend-test \| `mvn -q test` \| backend \|/);
  assert.match(draft, /\| lint \| `npm run lint` \| \. \|/);
  assert.doesNotMatch(draft, /未声明验证命令/);
});

test('status --all 列出已归档变更；不带 --all 不变', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, '.devflow/changes/archive/2026-01-01-a/events.jsonl', `${JSON.stringify({ type: 'archived', at: '2026-01-01T08:30:00.000Z', actor: 't' })}\n`);
  write(dir, '.devflow/changes/archive/2026-01-02-b/proposal.md', '# b\n');

  const all = cli(dir, 'status', '--all').stdout.trim().split('\n');
  assert.equal(all.length, 3);
  assert.match(all[0], new RegExp(`^${ID}  draft`));
  assert.equal(all[1], '2026-01-01-a  archived  2026-01-01 08:30 UTC');
  assert.equal(all[2], '2026-01-02-b  archived  归档时间未知');
  assert.deepEqual(JSON.parse(cli(dir, 'status', '--all', '--json').stdout).slice(1).map((x: any) => x.archived_at), ['2026-01-01T08:30:00.000Z', null]);

  const plain = cli(dir, 'status').stdout.trim().split('\n');
  assert.equal(plain.length, 1);
});

test('validate：报出图语法错误与带属性的代码块，定位到源文件行；合法图通过且 render 成功', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const base = `.devflow/changes/${ID}`;
  write(dir, `${base}/design.md`, '# 设计\n\n```er\nUser\n  id PK\nUSER ||--o{ ORDER : places\n```\n');
  write(dir, `${base}/proposal.md`, '# 提案\n\n```ts title=x\nlet a;\n```\n');
  const r = cli(dir, 'validate', ID, '--json');
  assert.equal(r.status, 1);
  const issues = JSON.parse(r.stdout).issues as { file: string; message: string; hint?: string }[];
  const er = issues.find((i) => i.file === `${base}/design.md:6`);
  assert.ok(er, JSON.stringify(issues));
  assert.match(er.message, /图语法错误.*Mermaid/);
  assert.match(er.hint!, /1--\*/);
  assert.doesNotMatch(er.hint!, /draft:/); // 临时文件已删除，不该出现在提示里
  assert.ok(issues.some((i) => i.file === `${base}/proposal.md:3` && /不能带属性/.test(i.message)));

  write(dir, `${base}/design.md`, '# 设计\n\n```flow LR\nA -> B: 调用\n```\n\n```er LR\nUser\n  id PK\nOrder\n  user_id FK -> User\n```\n');
  write(dir, `${base}/proposal.md`, '# 提案\n\n正文。\n');
  const ok = cli(dir, 'validate', ID);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(cli(dir, 'render', ID).status, 0);
});

test('空知识页：wiki lint 与 doctor 给出 warn；check 不提示', () => {
  const dir = makeRepo();
  const r = cli(dir, 'wiki', 'lint');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /知识页为空/);
  assert.equal(doctor(dir).find((f) => f.item === '知识页')?.level, 'warn');
  assert.ok(!check(dir, { staged: false }).some((i) => /知识页为空/.test(i.message)));
});

test('CLI usage records stable failure reasons and produces a reviewable candidate', async () => {
  const { usageReport, listCandidates } = await import('../src/usage.ts');
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = makeRepo();
  writeChange(dir, 'usage-flow');
  for (let i = 0; i < 3; i++) {
    const result = cli(dir, 'apply', 'usage-flow', '--start', '--json');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  const report = usageReport(dir);
  assert.equal(report.report.outcomes.failure, 3);
  const candidate = listCandidates(dir)[0];
  assert.equal(candidate.count, 3);
  const draft = cli(dir, 'improve', 'draft', candidate.id, 'improve-usage', '--json');
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(JSON.parse(draft.stdout).status, 'draft');
  const base = join(dir, '.devflow/runtime/usage');
  const day = readdirSync(base).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
  const row = JSON.parse(readFileSync(join(base, day, readdirSync(join(base, day))[0]), 'utf8'));
  assert.equal(row.status_before, 'draft');
  assert.equal(row.status_after, 'draft');
  assert.ok(row.reason_code);
});

test('status 行尾标出轮到谁：待你批准、待你确认 N 条人工证据、待你归档、Agent 进行中；--json 带 todo', async () => {
  const { humanTodo } = await import('../src/status.ts');
  const { applyStart, taskDone, verify } = await import('../src/exec.ts');
  const { confirmEvidence, recordEvidence } = await import('../src/evidence.ts');
  const { approve } = await import('../src/status.ts');
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: echo ok\nenforce: warn\n');
  write(dir, `.devflow/changes/${ID}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 新格式\naffected_paths: [backend/**]\nsummary: [要点]\n');
  write(dir, `.devflow/changes/${ID}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 人工验收\n    acceptance:\n      - id: AC1\n        text: 看过页面\n        method: manual\n      - id: AC2\n        text: 看过日志\n        method: manual\n');
  write(dir, '.devflow/changes/archive/2026-01-01-a/events.jsonl', `${JSON.stringify({ type: 'archived', at: '2026-01-01T08:30:00.000Z', actor: 't' })}\n`);
  const todo = () => humanTodo(dir, ID, deriveStatus(dir, ID));
  const line = () => cli(dir, 'status', '--all').stdout.trim().split('\n');

  assert.equal(todo(), '待你批准');
  assert.match(line()[0], /  ← 待你批准$/);
  assert.equal(line()[1], '2026-01-01-a  archived  2026-01-01 08:30 UTC'); // 已归档行不带这一段
  assert.equal(JSON.parse(cli(dir, 'status', '--json').stdout)[0].todo, '待你批准');

  approve(dir, ID);
  applyStart(dir, ID);
  assert.equal(todo(), null);
  assert.match(line()[0], /  ← Agent 进行中$/);
  assert.equal(JSON.parse(cli(dir, 'status', '--json').stdout)[0].todo, null);

  verify(dir, ID);
  const ids = ['AC1', 'AC2'].map((acceptance) => recordEvidence(dir, ID, { task: 'T1', acceptance, kind: 'manual', summary: 's', procedure: 'p', expected: 'e', observed: 'o' }).evidence_id);
  assert.equal(todo(), '待你确认 2 条人工证据');
  confirmEvidence(dir, ID, ids[0]);
  assert.match(line()[0], /  ← 待你确认 1 条人工证据$/);
  confirmEvidence(dir, ID, ids[1]);
  taskDone(dir, ID, 'T1');
  assert.equal(todo(), '待你归档');
});
