import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { approvalCycle, headCommit, worktreeHash } from '../src/core.ts';
import { approve } from '../src/status.ts';
import { confirmEvidence, evidenceIssues, evidenceMatrix, recordEvidence } from '../src/evidence.ts';
import { addEvent, append, at, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'evidence-case';
function ready() {
  const root = makeRepo();
  writeChange(root, ID);
  write(root, `.devflow/changes/${ID}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: Evidence\naffected_paths: [backend/**]\n');
  write(root, `.devflow/changes/${ID}/tasks.yaml`, `schema_version: 2
tasks:
  - id: T1
    title: Check access
    acceptance:
      - id: AC1
        text: Reject non-admin
        method: automated
        check: tests
      - id: AC2
        text: Admin sees updated state
        method: manual
`);
  write(root, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: tests\n    run: true\nexclude: [".env*", "**/*.key"]\nenforce: warn\n');
  write(root, 'backend/access.test.ts', 'assert.equal(response.status, 403);\n');
  write(root, 'backend/result.txt', '403, unchanged\n');
  approve(root, ID);
  addEvent(root, ID, { type: 'apply-started', at: at(), head: headCommit(root), approval_id: approvalCycle(root, ID).approval_id });
  successfulRun(root);
  return root;
}
function successfulRun(root: string, runId = 'run-1') {
  addEvent(root, ID, { type: 'verified', at: at(), run_id: runId, approval_id: approvalCycle(root, ID).approval_id, diff_hash: worktreeHash(root), result: 'pass', checks: [{ name: 'tests', exit: 0 }] });
}
const automatic = { task: 'T1', acceptance: 'AC1', kind: 'automated', summary: 'Non-admin rejected', verify_run: 'run-1', check: 'tests', test: 'backend/access.test.ts', assertion: 'status equals 403 and record unchanged' };
const manual = { task: 'T1', acceptance: 'AC2', kind: 'manual', summary: 'Admin UI', procedure: 'Sign in as admin, disable user', expected: 'Disabled state', observed: 'Disabled state' };

test('evidence: automatic checks plus explicit manual confirmation satisfy every condition', () => {
  const root = ready();
  assert.equal(evidenceIssues(root, ID).length, 2);
  recordEvidence(root, ID, automatic);
  const evidence = recordEvidence(root, ID, manual);
  assert.equal(evidenceMatrix(root, ID)[1].status, 'unconfirmed');
  confirmEvidence(root, ID, evidence.evidence_id);
  assert.deepEqual(evidenceIssues(root, ID), []);
  assert.throws(() => confirmEvidence(root, ID, 'unknown'), /没有该人工证据/);
});

test('evidence: rejects wrong runs, checks, missing assertion, unknown fields and manual method mismatch', () => {
  const root = ready();
  assert.throws(() => recordEvidence(root, ID, { ...automatic, verify_run: 'wrong' }), /指定验证检查/);
  assert.throws(() => recordEvidence(root, ID, { ...automatic, check: 'unapproved' }), /指定验证检查/);
  assert.throws(() => recordEvidence(root, ID, { ...automatic, assertion: '' }), /assertion/);
  assert.throws(() => recordEvidence(root, ID, { ...automatic, command: 'touch forbidden' }), /未知证据字段/);
  assert.throws(() => recordEvidence(root, ID, { ...manual, acceptance: 'AC1' }), /方式/);
});

test('evidence: code changes invalidate existing proof and reject stale verify runs', () => {
  const root = ready();
  recordEvidence(root, ID, automatic);
  append(root, 'backend/access.test.ts', ' // changed\n');
  assert.equal(evidenceMatrix(root, ID)[0].status, 'stale');
  assert.throws(() => recordEvidence(root, ID, automatic), /指定验证检查/);
  successfulRun(root, 'run-2');
  recordEvidence(root, ID, { ...automatic, verify_run: 'run-2' });
  assert.equal(evidenceMatrix(root, ID)[0].status, 'valid');
});

test('evidence: approval revision keeps evidence only while the acceptance condition and code are unchanged', async () => {
  const { deriveStatus } = await import('../src/status.ts');
  const { taskDone } = await import('../src/exec.ts');
  const root = ready();
  recordEvidence(root, ID, automatic);
  const old = recordEvidence(root, ID, manual);
  const reapprove = () => {
    approve(root, ID);
    addEvent(root, ID, { type: 'apply-started', at: at(), head: headCommit(root), approval_id: approvalCycle(root, ID).approval_id });
    successfulRun(root, `run-${Math.random()}`);
  };

  // 只改了提案：证据沿用，旧批准下记录的人工证据仍可确认，任务完成记录也沿用
  append(root, `.devflow/changes/${ID}/proposal.md`, 'Revised.\n');
  reapprove();
  assert.deepEqual(evidenceMatrix(root, ID).map((r) => r.status), ['valid', 'unconfirmed']);
  confirmEvidence(root, ID, old.evidence_id);
  assert.equal(evidenceIssues(root, ID).length, 0);
  taskDone(root, ID, 'T1');
  append(root, `.devflow/changes/${ID}/proposal.md`, 'Revised again.\n');
  reapprove();
  assert.equal(deriveStatus(root, ID).status, 'ready_to_archive');

  // 改了一条验收条件：只有那一条的证据作废，确认也被拒绝
  const tasks = `.devflow/changes/${ID}/tasks.yaml`;
  write(root, tasks, readFileSync(join(root, tasks), 'utf8').replace('Admin sees updated state', 'Admin sees updated state and audit log'));
  reapprove();
  assert.deepEqual(evidenceMatrix(root, ID).map((r) => r.status), ['valid', 'stale']);
  assert.throws(() => confirmEvidence(root, ID, old.evidence_id), /没有该人工证据/);
  assert.equal(deriveStatus(root, ID).tasks.done, 0);

  // 改了检查命令：引用该检查的自动证据作废
  write(root, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: tests\n    run: "true && true"\nexclude: [".env*", "**/*.key"]\nenforce: warn\n');
  reapprove();
  assert.equal(evidenceMatrix(root, ID)[0].status, 'stale');
});

test('evidence: copied attachments survive source changes but tampering and deletion invalidate proof', () => {
  const root = ready();
  const evidence = recordEvidence(root, ID, { ...automatic, artifacts: ['backend/result.txt'] });
  assert.equal(evidence.artifacts.length, 1);
  const target = evidence.artifacts[0].path;
  assert.equal(evidenceMatrix(root, ID)[0].status, 'valid');
  write(root, target, 'tampered');
  assert.equal(evidenceMatrix(root, ID)[0].status, 'invalid');
  rmSync(join(root, target));
  assert.equal(evidenceMatrix(root, ID)[0].status, 'invalid');
});

test('evidence: rejects traversal, excluded files, symlink parents and oversized summaries', () => {
  const root = ready();
  write(root, '.env-secret', 'sensitive');
  symlinkSync(join(root, 'backend'), join(root, 'linked'));
  successfulRun(root);
  for (const path of ['../outside', '.env-secret', 'linked/result.txt']) {
    assert.throws(() => recordEvidence(root, ID, { ...automatic, artifacts: [path] }), /仓库内|exclude|符号链接/);
  }
  assert.throws(() => recordEvidence(root, ID, { ...automatic, summary: 'x'.repeat(4097) }), /4096/);
});
