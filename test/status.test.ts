import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headCommit, worktreeHash } from '../src/core.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { addEvent, append, at, commit, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const status = (dir: string) => deriveStatus(dir, ID).status;

test('M0 交付：draft → approved；改 proposal 回到 draft；重新批准恢复', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  assert.equal(status(dir), 'draft');

  const ev = approve(dir, ID);
  assert.equal(ev.actor, 'tester');
  assert.equal(ev.base_commit, headCommit(dir));
  assert.deepEqual(ev.spec_base, { auth: null }); // 新能力，当前规范中还没有
  assert.equal(status(dir), 'approved');

  append(dir, `.tenon/changes/${ID}/proposal.md`, '补一句。\n');
  assert.equal(status(dir), 'draft');
  assert.match(deriveStatus(dir, ID).reason, /重新批准/);

  approve(dir, ID);
  assert.equal(status(dir), 'approved');
});

test('批准后改 project.yaml 使批准失效', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  append(dir, '.tenon/project.yaml', '# 改动\n');
  assert.equal(status(dir), 'draft');
});

test('已批准的变更不能重复批准；不完整的变更不能批准', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  assert.throws(() => approve(dir, ID), /不需要批准/);

  write(dir, '.tenon/changes/bad/change.yaml', 'schema_version: 1\ntitle: ""\naffected_paths: []\n');
  assert.throws(() => approve(dir, 'bad'), /校验有 \d+ 个错误/);
});

test('批准后有提交改动影响路径 → rebase_required；改其他路径不受影响；重新批准恢复', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);

  write(dir, 'docs/readme.md', 'changed\n');
  commit(dir, 'docs', true);
  assert.equal(status(dir), 'approved');

  write(dir, 'backend/src/Auth.java', 'class Auth { int x; }\n');
  commit(dir, 'backend', true);
  assert.equal(status(dir), 'rebase_required');
  assert.match(deriveStatus(dir, ID).reason, /backend\/src\/Auth\.java/);

  approve(dir, ID); // 人重新评估后，以新的 HEAD 为基线
  assert.equal(status(dir), 'approved');
});

test('开工 → 验证 → 任务完成 → ready_to_archive；验证后改代码需重新验证', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  assert.equal(status(dir), 'applying');

  write(dir, 'backend/src/Role.java', 'enum Role { ADMIN }\n');
  const verified = (result: 'pass' | 'fail' | 'unknown') =>
    addEvent(dir, ID, { type: 'verified', at: at(), diff_hash: worktreeHash(dir), result, checks: [] });

  verified('fail');
  assert.equal(status(dir), 'needs_fix');
  verified('unknown');
  assert.equal(status(dir), 'needs_fix'); // unknown 不算通过

  verified('pass');
  assert.equal(status(dir), 'applying'); // 任务未完成
  assert.deepEqual(deriveStatus(dir, ID).tasks, { done: 0, total: 2 });
  addEvent(dir, ID, { type: 'task-done', at: at(), task: 'T1' });
  addEvent(dir, ID, { type: 'task-done', at: at(), task: 'T2' });
  assert.equal(status(dir), 'ready_to_archive');

  // 暂存、提交不改变工作树内容，不应要求重新验证
  commit(dir, 'impl', true);
  assert.equal(status(dir), 'ready_to_archive');

  write(dir, 'backend/src/Role.java', 'enum Role { ADMIN, USER }\n');
  assert.equal(status(dir), 'applying');
  assert.match(deriveStatus(dir, ID).reason, /重新验证/);

  addEvent(dir, ID, { type: 'archived', at: at(), actor: 'tester' });
  assert.equal(status(dir), 'archived');
});

test('重新批准后，之前的开工与验证记录不再算数', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  append(dir, `.tenon/changes/${ID}/proposal.md`, '方案调整。\n');
  approve(dir, ID);
  assert.equal(status(dir), 'approved');
});

test('v1 compatibility baseline: approval input is exactly original reviewed files and config', async () => {
  const { reviewedFiles, hashFiles } = await import('../src/core.ts');
  const dir = makeRepo();
  writeChange(dir, ID);
  const files = [
    `.tenon/changes/${ID}/change.yaml`, `.tenon/changes/${ID}/proposal.md`,
    `.tenon/changes/${ID}/tasks.yaml`, `.tenon/changes/${ID}/specs/auth/spec.md`, '.tenon/project.yaml',
  ];
  assert.deepEqual(reviewedFiles(dir, ID).sort(), files.sort());
  assert.equal(approve(dir, ID).hash, hashFiles(dir, files));
});

test('重新批准后不继承旧周期任务完成，历史事件仍保留', async () => {
  const { readEvents } = await import('../src/core.ts');
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  addEvent(dir, ID, { type: 'task-done', at: at(), task: 'T1' });
  assert.equal(deriveStatus(dir, ID).tasks.done, 1);
  append(dir, `.tenon/changes/${ID}/proposal.md`, '修改验收。\n');
  approve(dir, ID);
  assert.equal(deriveStatus(dir, ID).tasks.done, 0);
  assert.equal(readEvents(dir, ID).filter((e) => e.type === 'task-done').length, 1);
});

function v2Change(dir: string) {
  writeChange(dir, ID);
  write(dir, `.tenon/changes/${ID}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 新格式\naffected_paths: [backend/**]\n');
  write(dir, `.tenon/changes/${ID}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 人工验收\n    acceptance:\n      - id: AC1\n        text: 已检查管理员页面\n        method: manual\n');
}

test('v2 批准保存快照，实施笔记保持批准，契约变化展示真实差异', async () => {
  const { approvalDiff, snapshotIssues } = await import('../src/status.ts');
  const dir = makeRepo();
  v2Change(dir);
  const ev = approve(dir, ID);
  assert.match(ev.approval_id!, /^[0-9a-f-]{36}$/);
  assert.match(ev.snapshot_hash!, /^sha256:/);
  assert.deepEqual(snapshotIssues(dir, ID), []);
  write(dir, `.tenon/changes/${ID}/execution.md`, '先做页面，再做接口。');
  assert.equal(status(dir), 'approved');
  assert.deepEqual(approvalDiff(dir, ID).files, []);
  append(dir, `.tenon/changes/${ID}/proposal.md`, '契约变化。');
  assert.equal(status(dir), 'draft');
  const diff = approvalDiff(dir, ID);
  assert.equal(diff.available, true);
  assert.equal(diff.files.length, 1);
  assert.match(diff.files[0].after!, /契约变化/);
  assert.doesNotMatch(diff.files[0].before!, /契约变化/);
});

test('v2 快照损坏阻止继续，v1 无快照不冒充 HEAD', async () => {
  const { approvalDiff, snapshotIssues } = await import('../src/status.ts');
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  assert.equal(approvalDiff(dir, ID).available, false);
  assert.deepEqual(snapshotIssues(dir, ID), []);
  const other = makeRepo();
  v2Change(other);
  const ev = approve(other, ID);
  write(other, `.tenon/reviews/${ID}/${ev.approval_id}/snapshot.json`, '{}');
  assert.equal(snapshotIssues(other, ID).length, 1);
  assert.equal(status(other), 'needs_fix');
});

test('开工后规范变化提前要求重批，恢复不会卡在禁止批准状态', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  write(dir, '.tenon/specs/auth/spec.md', '# auth\n\n## Purpose\n\n认证。\n\n## Requirements\n\n### Requirement: 登录\n系统 SHALL 登录。\n\n#### Scenario: 登录\n- WHEN 登录\n- THEN 成功\n');
  assert.equal(status(dir), 'rebase_required');
  approve(dir, ID);
  assert.equal(status(dir), 'approved');
});
