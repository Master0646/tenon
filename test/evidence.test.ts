import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync, symlinkSync } from 'node:fs';
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

test('evidence: approval revision cannot reuse previous evidence or manual confirmation', () => {
  const root = ready();
  recordEvidence(root, ID, automatic);
  const old = recordEvidence(root, ID, manual);
  confirmEvidence(root, ID, old.evidence_id);
  append(root, `.devflow/changes/${ID}/proposal.md`, 'Revised.\n');
  approve(root, ID);
  addEvent(root, ID, { type: 'apply-started', at: at(), head: headCommit(root), approval_id: approvalCycle(root, ID).approval_id });
  assert.equal(evidenceIssues(root, ID).length, 2);
  assert.throws(() => confirmEvidence(root, ID, old.evidence_id), /没有该人工证据/);
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
