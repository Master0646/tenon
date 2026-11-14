// code_roots 覆盖影响路径、基线、门禁；证据日志引文；停滞提醒
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalCycle, headCommit, sha256, worktreeHash } from '../src/core.ts';
import { doctor } from '../src/doctor.ts';
import { evidenceMatrix, recordEvidence } from '../src/evidence.ts';
import { hookFile, init } from '../src/init.ts';
import { renderHtml } from '../src/render.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { validateChange, validateProject } from '../src/validate.ts';
import { addEvent, at, cli, commit, g, makeRepo, write } from './fixture.ts';

const ID = 'gap-case';

/** Tenon 项目仓库 + 兄弟代码仓库（已有一次提交），code_roots 指向它 */
function twoRepos(extra = '') {
  const dir = makeRepo();
  const code = `${dir}-code`;
  mkdirSync(code);
  g(code, 'init', '-q');
  g(code, 'config', 'user.name', 'tester');
  g(code, 'config', 'user.email', 'tester@example.invalid');
  g(code, 'config', 'commit.gpgsign', 'false');
  write(code, 'src/app.js', 'v1\n');
  write(code, 'test/app.test.js', 'assert.ok(true)\n');
  commit(code, 'init', true);
  const rel = `../${code.split('/').pop()}`;
  write(dir, '.tenon/project.yaml', `schema_version: 1\nverify:\n  - name: tests\n    run: "true"\ncode_roots: ["${rel}"]\nexclude: [".env*"]\nenforce: warn\n${extra}`);
  return { dir, code, rel };
}

function change(dir: string, paths: string[], tasks = 'schema_version: 1\ntasks:\n  - id: T1\n    title: 改代码\n') {
  const base = `.tenon/changes/${ID}`;
  write(dir, `${base}/change.yaml`, `schema_version: ${tasks.startsWith('schema_version: 2') ? '2\nmin_cli_version: 0.2.0' : '1'}\ntitle: 跨仓库\naffected_paths: ${JSON.stringify(paths)}\nsummary: [跨仓库改动]\n`);
  write(dir, `${base}/proposal.md`, '# 提案\n\n改代码仓库。\n');
  write(dir, `${base}/tasks.yaml`, tasks);
}

test('AC1 affected_paths 接受 code_roots 下的路径，拒绝未声明的 .. 路径', () => {
  const { dir, rel } = twoRepos();
  change(dir, [`${rel}/src/**`]);
  assert.deepEqual(validateChange(dir, ID, true).filter((i) => i.level === 'error'), []);
  change(dir, ['../other/src/**']);
  assert.match(validateChange(dir, ID, true).map((i) => i.message).join('|'), /code_roots/);
});

test('AC1 批准后兄弟仓库有提交改动影响路径时状态为 rebase_required，其他路径不影响', () => {
  const { dir, code, rel } = twoRepos();
  change(dir, [`${rel}/src/**`]);
  approve(dir, ID);
  assert.ok(approvalCycle(dir, ID).approved?.base_commits?.[rel]);
  write(code, 'README.md', 'docs\n');
  commit(code, 'docs', true);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
  write(code, 'src/app.js', 'v2\n');
  commit(code, 'change src', true);
  const st = deriveStatus(dir, ID);
  assert.equal(st.status, 'rebase_required');
  assert.match(st.reason, new RegExp(`${rel}/src/app\\.js`));
});

const TASKS2 = `schema_version: 2
tasks:
  - id: T1
    title: 改代码
    acceptance:
      - id: AC1
        text: 测试通过
        method: automated
        check: tests
`;

/** 已开工、有一次成功验证（日志写在 runtime/verify 下）的 v2 变更 */
function withRun(log = 'ok 1 - 普通用户被拒绝\n# pass 1\n') {
  const r = twoRepos();
  change(r.dir, [`${r.rel}/src/**`], TASKS2);
  approve(r.dir, ID);
  addEvent(r.dir, ID, { type: 'apply-started', at: at(), head: headCommit(r.dir), approval_id: approvalCycle(r.dir, ID).approval_id });
  const logFile = join(r.dir, '.tenon/runtime/verify', ID, '20261113T000000Z', 'tests.log');
  mkdirSync(join(logFile, '..'), { recursive: true });
  writeFileSync(logFile, log);
  addEvent(r.dir, ID, { type: 'verified', at: at(), run_id: 'run-1', approval_id: approvalCycle(r.dir, ID).approval_id, diff_hash: worktreeHash(r.dir), result: 'pass', checks: [{ name: 'tests', exit: 0, log_hash: sha256(Buffer.from(log)) }] });
  return { ...r, logFile };
}
const ev = (rel: string, more: object = {}) => ({ task: 'T1', acceptance: 'AC1', kind: 'automated', summary: '拒绝普通用户', verify_run: 'run-1', check: 'tests', test: `${rel}/test/app.test.js`, assertion: '返回 403', ...more });

test('AC2 引文出现在日志中则 quote_checked 为 true；兄弟仓库内的 test 路径被接受', () => {
  const { dir, rel } = withRun();
  const e = recordEvidence(dir, ID, ev(rel, { log_quote: 'ok 1 - 普通用户被拒绝' }));
  assert.equal(e.quote_checked, true);
  assert.equal(evidenceMatrix(dir, ID)[0].log_check, '已核对');
});

test('AC2 引文不在日志、日志被改、日志丢失、多行时拒绝；不带引文时未核对', () => {
  const { dir, rel, logFile } = withRun();
  assert.throws(() => recordEvidence(dir, ID, ev(rel, { log_quote: '37 tests passed' })), /不在 tests 的日志中/);
  assert.throws(() => recordEvidence(dir, ID, ev(rel, { log_quote: 'ok 1\n# pass' })), /只能是一行/);
  writeFileSync(logFile, 'ok 1 - 普通用户被拒绝\n# 改过\n');
  assert.throws(() => recordEvidence(dir, ID, ev(rel, { log_quote: 'ok 1 - 普通用户被拒绝' })), /日志已被改动/);
  rmSync(logFile);
  assert.throws(() => recordEvidence(dir, ID, ev(rel, { log_quote: 'ok 1 - 普通用户被拒绝' })), /找不到验证运行/);
  recordEvidence(dir, ID, ev(rel));
  assert.equal(evidenceMatrix(dir, ID)[0].log_check, '未核对');
});

test('AC2 越界的 test 路径被拒：未声明的兄弟仓库、代码仓库内的 ..', () => {
  const { dir, rel } = withRun();
  assert.throws(() => recordEvidence(dir, ID, { ...ev(rel), test: '../other/test/app.test.js' }), /仓库内/);
  assert.throws(() => recordEvidence(dir, ID, { ...ev(rel), test: `${rel}/../x` }), /仓库内/);
  assert.throws(() => recordEvidence(dir, ID, { ...ev(rel), test: `${rel}/test/missing.js` }), /不存在/);
});

test('AC8 验收矩阵四列：验收条件、状态、依据、说明；不显示证据 ID 与代码版本；依据写测试文件与已核对的日志原文', () => {
  const { dir, rel } = withRun();
  const e = recordEvidence(dir, ID, ev(rel, { log_quote: '# pass 1' }));
  const { html } = renderHtml(dir, ID);
  const table = html.slice(html.indexOf('验收矩阵'));
  assert.match(table, /<th[^>]*>验收条件<\/th>\s*<th[^>]*>状态<\/th>\s*<th[^>]*>依据<\/th>\s*<th[^>]*>说明<\/th>/);
  assert.doesNotMatch(table, /代码版本|日志核对<\/th>/);
  assert.ok(!html.includes(e.evidence_id), '不应显示证据 ID');
  assert.ok(!html.includes(e.worktree_hash.slice(0, 20)), '不应显示代码版本哈希');
  assert.match(table, new RegExp(`自动：${rel}/test/app\\.test\\.js；日志「# pass 1」已核对`));
  assert.match(table, /<td[^>]*>有效<\/td>/);
});

test('AC8 人工项：状态为「待你确认」，依据写实际观察；不带日志原文的自动项写未核对', () => {
  const r = twoRepos();
  change(r.dir, [`${r.rel}/src/**`], `${TASKS2}      - id: AC2\n        text: 管理员页面正常\n        method: manual\n`);
  approve(r.dir, ID);
  addEvent(r.dir, ID, { type: 'apply-started', at: at(), head: headCommit(r.dir), approval_id: approvalCycle(r.dir, ID).approval_id });
  addEvent(r.dir, ID, { type: 'verified', at: at(), run_id: 'run-1', approval_id: approvalCycle(r.dir, ID).approval_id, diff_hash: worktreeHash(r.dir), result: 'pass', checks: [{ name: 'tests', exit: 0 }] });
  recordEvidence(r.dir, ID, ev(r.rel));
  recordEvidence(r.dir, ID, { task: 'T1', acceptance: 'AC2', kind: 'manual', summary: '管理员页面', procedure: '登录管理员', expected: '看到列表', observed: '看到 3 个用户' });
  const rows = evidenceMatrix(r.dir, ID);
  assert.equal(rows[0].basis, `自动：${r.rel}/test/app.test.js；日志未核对`);
  assert.equal(rows[1].basis, '人工：看到 3 个用户');
  const table = renderHtml(r.dir, ID).html;
  assert.match(table, /<td[^>]*>待你确认<\/td>/);
  assert.match(table, /人工：看到 3 个用户/);
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
/** project.yaml 计入批准哈希，所以阈值要在批准前写好 */
function startedAgo(h: number, extra = '') {
  const { dir, rel } = twoRepos(extra);
  change(dir, [`${rel}/src/**`]);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: hoursAgo(h), head: headCommit(dir), approval_id: approvalCycle(dir, ID).approval_id });
  return dir;
}

test('AC4 已开工且最后事件早于阈值时 status 行尾带停滞标记；stale_hours 可调，非正数被拒', () => {
  const dir = startedAgo(30);
  assert.match(cli(dir, 'status').stdout, /applying .*停滞 30 小时\n/);
  assert.equal(JSON.parse(cli(dir, 'status', '--json').stdout)[0].stale_hours, 30);
  assert.match(cli(startedAgo(60), 'status').stdout, /停滞 2 天/);
  assert.doesNotMatch(cli(startedAgo(3), 'status').stdout, /停滞/);
  assert.match(cli(startedAgo(3, 'stale_hours: 2\n'), 'status').stdout, /停滞 3 小时/);
  assert.doesNotMatch(cli(startedAgo(30, 'stale_hours: 48\n'), 'status').stdout, /停滞/);
  for (const bad of ['0', '-1', '"x"']) {
    write(dir, '.tenon/project.yaml', `schema_version: 1\nverify: []\nstale_hours: ${bad}\n`);
    assert.match(validateProject(dir).map((i) => i.message).join('|'), /stale_hours/);
  }
});

test('AC4 草稿与刚有动静的变更不带停滞标记', () => {
  const { dir, rel } = twoRepos();
  change(dir, [`${rel}/src/**`]);
  assert.doesNotMatch(cli(dir, 'status').stdout, /停滞/);
  approve(dir, ID);
  assert.doesNotMatch(cli(dir, 'status').stdout, /停滞/);
});

test('AC7 init 给代码仓库装带标记的钩子，已有其他钩子时不覆盖；doctor 报出缺失', () => {
  const { dir, code, rel } = twoRepos();
  const r = init(dir);
  assert.equal(r.codeHooks[0].hook, 'installed');
  assert.match(readFileSync(hookFile(code), 'utf8'), /# tenon-hook[\s\S]*--project/);
  assert.equal(init(dir).codeHooks[0].hook, 'updated');
  writeFileSync(hookFile(code), '#!/bin/sh\necho mine\n');
  assert.equal(init(dir).codeHooks[0].hook, 'foreign');
  assert.equal(readFileSync(hookFile(code), 'utf8'), '#!/bin/sh\necho mine\n');
  rmSync(hookFile(code));
  const f = doctor(dir).find((x) => x.item === `hook ${rel}`);
  assert.equal(f?.level, 'error');
  assert.match(f!.message, /没有 pre-commit hook/);
});

test('AC7 代码仓库暂存未开工变更的文件：strict 拒绝提交、warn 只警告；开工后放行', () => {
  const { dir, code, rel } = twoRepos();
  change(dir, [`${rel}/src/**`]);
  init(dir);
  write(code, 'src/app.js', 'v2\n');
  g(code, 'add', '-A');
  const warn = cli(code, 'check', '--staged', '--project', dir);
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stderr, new RegExp(`变更 ${ID} 的影响路径`));

  const project = readFileSync(join(dir, '.tenon/project.yaml'), 'utf8');
  write(dir, '.tenon/project.yaml', project.replace('enforce: warn', 'enforce: strict'));
  assert.throws(() => g(code, 'commit', '-qm', 'blocked'));
  assert.ok(existsSync(join(code, 'src/app.js')));

  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir), approval_id: approvalCycle(dir, ID).approval_id });
  g(code, 'commit', '-qm', 'allowed');
  assert.match(g(code, 'log', '--oneline'), /allowed/);
});

test('AC7 check --project 指向不含该仓库的项目时报错', () => {
  const { dir } = twoRepos();
  const other = makeRepo();
  const r = cli(other, 'check', '--staged', '--project', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不在 .* 的 code_roots 中/);
});
