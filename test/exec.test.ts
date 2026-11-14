import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { archive, archiveTarget, commitArchive, pendingTx, stageArchive } from '../src/archive.ts';
import { check } from '../src/check.ts';
import { applyStart, taskDone, verify } from '../src/exec.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { lintWiki } from '../src/wiki.ts';
import { DELTA_ADD, cli, commit, g, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const status = (dir: string, id = ID) => deriveStatus(dir, id).status;

/** 把 verify 命令写进 project.yaml（须在批准前：project.yaml 计入批准哈希） */
function setVerify(dir: string, cmds: { name: string; run: string }[]) {
  const f = join(dir, '.tenon/project.yaml');
  const body = cmds.map((c) => `  - name: ${c.name}\n    run: ${JSON.stringify(c.run)}`).join('\n');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^verify: \[\]$/m, `verify:\n${body}`));
}

function ready(dir: string, cmds = [{ name: 'ok', run: 'true' }]) {
  setVerify(dir, cmds);
  writeChange(dir, ID);
  approve(dir, ID);
  applyStart(dir, ID);
}

test('apply --start：只能从 approved 开工', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  assert.throws(() => applyStart(dir, ID), /draft，不能开工/);
  approve(dir, ID);
  write(dir, 'backend/src/Auth.java', 'class Auth { int x; }\n');
  commit(dir, 'other', true);
  assert.throws(() => applyStart(dir, ID), /rebase_required/);
  approve(dir, ID);
  applyStart(dir, ID);
  assert.equal(status(dir), 'applying');
  assert.throws(() => applyStart(dir, ID), /applying，不能开工/);
});

test('task done：依赖顺序、未知任务、重复标记、未开工', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  assert.throws(() => taskDone(dir, ID, 'T1'), /approved，不能标记/);
  applyStart(dir, ID);
  assert.throws(() => taskDone(dir, ID, 'T2'), /依赖的任务尚未完成：T1/);
  assert.throws(() => taskDone(dir, ID, 'T9'), /任务不存在/);
  taskDone(dir, ID, 'T1');
  assert.throws(() => taskDone(dir, ID, 'T1'), /已标记完成/);
  taskDone(dir, ID, 'T2');
  assert.deepEqual(deriveStatus(dir, ID).tasks, { done: 2, total: 2 });
});

test('verify：通过 → ready_to_archive；失败 → needs_fix；验证后改代码 → 需要重新验证', () => {
  const dir = makeRepo();
  ready(dir);
  taskDone(dir, ID, 'T1');
  taskDone(dir, ID, 'T2');
  write(dir, 'backend/src/Role.java', 'enum Role {}\n');
  assert.equal(verify(dir, ID).result, 'pass');
  assert.equal(status(dir), 'ready_to_archive');
  write(dir, 'backend/src/Role.java', 'enum Role { ADMIN }\n');
  assert.equal(status(dir), 'applying');
  assert.equal(verify(dir, ID).result, 'pass');
  assert.equal(status(dir), 'ready_to_archive');

  const dir2 = makeRepo();
  ready(dir2, [{ name: 'ok', run: 'true' }, { name: 'bad', run: 'echo boom; exit 3' }]);
  const r = verify(dir2, ID);
  assert.equal(r.result, 'fail');
  assert.deepEqual(r.checks.map((c) => c.exit), [0, 3]);
  assert.match(readFileSync(r.checks[1].log, 'utf8'), /boom/);
  assert.equal(status(dir2), 'needs_fix');
});

test('verify：命令无法运行、没有声明命令、验证中改动工作树 → unknown（不算通过）', () => {
  const missing = makeRepo();
  ready(missing, [{ name: 'x', run: 'definitely-not-a-command-xyz' }]);
  assert.equal(verify(missing, ID).result, 'unknown');
  assert.equal(status(missing), 'needs_fix');

  const none = makeRepo();
  writeChange(none, ID);
  approve(none, ID);
  applyStart(none, ID);
  assert.match(verify(none, ID).note ?? '', /没有声明/);

  const dirty = makeRepo();
  ready(dirty, [{ name: 'build', run: 'echo out > build-output.txt' }]);
  const r = verify(dirty, ID);
  assert.equal(r.result, 'unknown');
  assert.match(r.note ?? '', /工作树发生变化/);
});

test('verify：批准后改 project.yaml（例如改弱验证命令）会使批准失效，verify 被拒', () => {
  const dir = makeRepo();
  ready(dir, [{ name: 'test', run: 'exit 1' }]);
  const f = join(dir, '.tenon/project.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace('exit 1', 'true'));
  assert.equal(status(dir), 'draft');
  assert.throws(() => verify(dir, ID), /draft，不能验证/);
});

function readyToArchive(dir: string, id = ID) {
  if (id === ID) ready(dir);
  else {
    writeChange(dir, id);
    approve(dir, id);
    applyStart(dir, id);
  }
  taskDone(dir, id, 'T1');
  taskDone(dir, id, 'T2');
  assert.equal(verify(dir, id).result, 'pass');
}

test('archive：合并新能力规范、更新 specs.lock、移动到 archive，check 仍通过', () => {
  const dir = makeRepo();
  readyToArchive(dir);
  const r = archive(dir, ID);
  assert.equal(r.target, archiveTarget(dir, ID));
  assert.deepEqual(r.specs, ['.tenon/specs/auth/spec.md']);
  const spec = readFileSync(join(dir, '.tenon/specs/auth/spec.md'), 'utf8');
  assert.match(spec, /^# auth\n[\s\S]*### Requirement: 用户列表需要 ADMIN/);
  assert.equal(existsSync(join(dir, '.tenon/changes', ID)), false);
  const archived = join(dir, r.target);
  assert.ok(existsSync(join(archived, 'proposal.md')));
  assert.match(readFileSync(join(archived, 'events.jsonl'), 'utf8'), /"type":"archived","at":"[^"]+","actor":"tester"/);
  assert.equal(pendingTx(dir, ID), false);
  assert.deepEqual(check(dir, { staged: false }).filter((i) => i.level === 'error'), []);
});

test('归档前写好的设计原因链接：lint 认为有效，归档后链接真实存在', () => {
  const dir = makeRepo();
  readyToArchive(dir);
  const head = g(dir, 'rev-parse', '--short', 'HEAD').trim();
  const link = `../../changes/archive/${archiveTarget(dir, ID).split('/').pop()}/proposal.md`;
  write(dir, '.tenon/knowledge/pages/auth.md', `---\nschema_version: 1\ntitle: 认证\nverified_commit: "${head}"\nsources:\n  - path: docs/readme.md\n---\n# 认证\n\n见 [原因](${link})，以及 [错的](../../changes/archive/nope/design.md)\n`);
  write(dir, '.tenon/knowledge/index.md', '- [认证](pages/auth.md)\n');
  assert.deepEqual(lintWiki(dir).issues.map((i) => i.message), ['链接 ../../changes/archive/nope/design.md 指向的文件不存在']);
  write(dir, '.tenon/knowledge/pages/auth.md', readFileSync(join(dir, '.tenon/knowledge/pages/auth.md'), 'utf8').replace('，以及 [错的](../../changes/archive/nope/design.md)', ''));
  archive(dir, ID);
  assert.deepEqual(lintWiki(dir).issues, []);
});

test('archive：未验证、验证失败、知识页有错误时拒绝', () => {
  const dir = makeRepo();
  ready(dir);
  assert.throws(() => archive(dir, ID), /applying，不能归档/);
  taskDone(dir, ID, 'T1');
  taskDone(dir, ID, 'T2');
  verify(dir, ID);
  write(dir, '.tenon/knowledge/pages/x.md', '没有 frontmatter\n');
  assert.throws(() => archive(dir, ID), /知识页有 \d+ 个错误/);
  assert.equal(pendingTx(dir, ID), false);
});

test('archive：两个变更改同一能力，后归档者因 spec_base 不一致被拒', () => {
  const dir = makeRepo();
  readyToArchive(dir);
  // 第二个变更在第一个归档前批准，基线是"auth 规范不存在"
  writeChange(dir, 'other');
  write(dir, '.tenon/changes/other/specs/auth/spec.md', DELTA_ADD.replace('用户列表需要 ADMIN', '详情需要 ADMIN'));
  approve(dir, 'other');
  applyStart(dir, 'other');
  taskDone(dir, 'other', 'T1');
  taskDone(dir, 'other', 'T2');
  verify(dir, 'other');
  archive(dir, ID);
  // 规范基线变化提前进入可恢复的重批状态
  assert.equal(status(dir, 'other'), 'rebase_required');
  assert.throws(() => archive(dir, 'other'), /rebase_required/);
});

test('archive 中断后重跑：从事务日志前滚，不重复写事件，结果与一次完成相同', () => {
  for (const crashAt of ['staged', 'specWritten', 'eventWritten'] as const) {
    const dir = makeRepo();
    readyToArchive(dir);
    const tx = stageArchive(dir, ID);
    const move = (w: { from: string; to: string }) => {
      mkdirSync(dirname(join(dir, w.to)), { recursive: true });
      renameSync(join(dir, w.from), join(dir, w.to));
    };
    if (crashAt !== 'staged') move(tx.writes[0]);
    if (crashAt === 'eventWritten') {
      for (const w of tx.writes.slice(1)) move(w);
      writeFileSync(join(dir, '.tenon/changes', ID, 'events.jsonl'),
        readFileSync(join(dir, '.tenon/changes', ID, 'events.jsonl'), 'utf8') + JSON.stringify({ type: 'archived', at: 'x', actor: 'tester' }) + '\n');
    }
    assert.equal(pendingTx(dir, ID), true, crashAt);
    const r = archive(dir, ID); // 等同于再次运行 tenon archive
    const events = readFileSync(join(dir, r.target, 'events.jsonl'), 'utf8');
    assert.equal(events.match(/"type":"archived"/g)?.length, 1, crashAt);
    assert.ok(existsSync(join(dir, '.tenon/specs/auth/spec.md')), crashAt);
    assert.deepEqual(check(dir, { staged: false }).filter((i) => i.level === 'error'), [], crashAt);
  }
});

test('commitArchive 可重复执行：事务完成后再调用不会出错也不改变结果', () => {
  const dir = makeRepo();
  readyToArchive(dir);
  stageArchive(dir, ID);
  const tx = JSON.parse(readFileSync(join(dir, `.tenon/runtime/tx/${ID}/tx.json`), 'utf8'));
  commitArchive(dir, ID);
  // 模拟"删除事务目录之前"崩溃：恢复 tx.json 再跑一次
  write(dir, `.tenon/runtime/tx/${ID}/tx.json`, JSON.stringify(tx));
  commitArchive(dir, ID);
  assert.equal(readFileSync(join(dir, tx.move.to, 'events.jsonl'), 'utf8').match(/"type":"archived"/g)?.length, 1);
});

test('CLI：archive 非 TTY 被拒；verify 退出码反映结果；归档后提交走 hook 通过', () => {
  const dir = makeRepo();
  readyToArchive(dir);
  const a = cli(dir, 'archive', ID);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /交互终端/);
  assert.equal(cli(dir, 'verify', ID).status, 0);
  archive(dir, ID);
  commit(dir, 'archive'); // 走 pre-commit hook
});

test('v2 CLI: verify → evidence → completion, resume selects gaps; code edits invalidate proof', async () => {
  const { recordEvidence } = await import('../src/evidence.ts');
  const { cli } = await import('./fixture.ts');
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `.tenon/changes/${ID}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: Evidence\naffected_paths: [backend/**]\n');
  write(dir, `.tenon/changes/${ID}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: Access\n    acceptance:\n      - id: AC1\n        text: Reject ordinary user\n        method: automated\n        check: tests\n');
  write(dir, 'backend/access.test.ts', 'assert.equal(status, 403);\n');
  setVerify(dir, [{ name: 'tests', run: 'true' }]);
  approve(dir, ID);
  assert.equal(cli(dir, 'apply', ID, '--start', '--json').status, 0);
  const first = verify(dir, ID);
  assert.throws(() => taskDone(dir, ID, 'T1'), /验收证据/);
  const resume = JSON.parse(cli(dir, 'resume', ID, '--json').stdout);
  assert.match(resume.next, /evidence add/);
  const input = { task: 'T1', acceptance: 'AC1', kind: 'automated', summary: 'Reject ordinary user', verify_run: first.run_id, check: 'tests', test: 'backend/access.test.ts', assertion: 'status is 403' };
  recordEvidence(dir, ID, input);
  assert.match(JSON.parse(cli(dir, 'resume', ID, '--json').stdout).next, /task done/);
  taskDone(dir, ID, 'T1');
  assert.equal(deriveStatus(dir, ID).status, 'ready_to_archive');
  write(dir, 'backend/src/Auth.java', 'class Auth { int change; }\n');
  assert.equal(deriveStatus(dir, ID).tasks.done, 0);
  const second = verify(dir, ID);
  recordEvidence(dir, ID, { ...input, verify_run: second.run_id });
  taskDone(dir, ID, 'T1');
  assert.equal(deriveStatus(dir, ID).status, 'ready_to_archive');
  assert.notEqual(cli(dir, 'evidence', 'confirm', ID, 'x', '--json').status, 0);
  const page = cli(dir, 'render', ID, '--json');
  assert.equal(page.status, 0, page.stderr + page.stdout);
});

test('archive rechecks code after staging transaction and before writing specs', async () => {
  const { stageArchive, commitArchive } = await import('../src/archive.ts');
  const dir = makeRepo();
  readyToArchive(dir);
  stageArchive(dir, ID);
  write(dir, 'backend/src/Auth.java', 'class Auth { int modifiedDuringConfirmation; }\n');
  assert.throws(() => commitArchive(dir, ID), /确认或恢复期间/);
});

test('code_roots：代码哈希只算声明的仓库；兄弟仓库改动使验证过期，本仓库文档改动不影响；路径无效时 validate 报错', async () => {
  const { worktreeHash } = await import('../src/core.ts');
  const { validateProject } = await import('../src/validate.ts');
  const { g } = await import('./fixture.ts');
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = makeRepo();
  const single = worktreeHash(dir);
  assert.match(single, /^git-tree:/);
  const code = join(dir, '..', `${dir.split('/').pop()}-code`);
  mkdirSync(code);
  g(code, 'init', '-q');
  write(code, 'src/app.js', 'v1\n');
  const rel = `../${code.split('/').pop()}`;
  write(dir, '.tenon/project.yaml', `schema_version: 1\nverify: []\ncode_roots: ["${rel}"]\nenforce: warn\n`);
  assert.deepEqual(validateProject(dir), []);

  const before = worktreeHash(dir);
  assert.match(before, /^git-trees:/);
  write(dir, 'docs/readme.md', '本仓库的文档改动\n');
  assert.equal(worktreeHash(dir), before);
  write(code, 'src/app.js', 'v2\n');
  assert.notEqual(worktreeHash(dir), before);

  write(dir, '.tenon/project.yaml', 'schema_version: 1\nverify: []\ncode_roots: ["../no-such-repo", "backend"]\nenforce: warn\n');
  const messages = validateProject(dir).map((i) => i.message).join('|');
  assert.match(messages, /no-such-repo 不是 Git 仓库的根目录/);
  assert.match(messages, /backend 不是 Git 仓库的根目录/); // 仓库的子目录不算
  assert.throws(() => worktreeHash(dir), /code_roots 中的 \.\.\/no-such-repo/);
});

test('verify：检查成功但没有输出时标记 quiet，CLI 给出提醒', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, '.tenon/project.yaml', 'schema_version: 1\nverify:\n  - name: silent\n    run: "true"\n  - name: loud\n    run: echo 3 tests passed\nenforce: warn\n');
  approve(dir, ID);
  applyStart(dir, ID);
  const r = cli(dir, 'verify', ID);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /! silent 没有任何输出/);
  assert.doesNotMatch(r.stderr, /loud 没有任何输出/);
});
