import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { withWorktreeLock } from '../src/core.ts';
import { makeRepo } from './fixture.ts';

test('worktree lock owns the entire async action and releases after resolution', async (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const action = withWorktreeLock(root, async () => {
    await gate;
    assert.throws(() => withWorktreeLock(root, () => 'overlap'), /持锁/);
    return 'completed';
  });
  assert.throws(() => withWorktreeLock(root, () => 'overlap'), /持锁/);
  resume();
  assert.equal(await action, 'completed');
  assert.equal(withWorktreeLock(root, () => 'released'), 'released');
});

test('worktree lock releases when an async action rejects after await', async (t) => {
  const root = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const error = new Error('failed after await');
  const action = withWorktreeLock(root, async () => {
    await Promise.resolve();
    assert.throws(() => withWorktreeLock(root, () => {}), /持锁/);
    throw error;
  });
  await assert.rejects(action, (actual) => actual === error);
  assert.equal(withWorktreeLock(root, () => 'released'), 'released');
});

test('locks are private to actual Git worktrees', async () => {
  const { g, makeRepo } = await import('./fixture.ts');
  const { rmSync } = await import('node:fs');
  const root = makeRepo();
  const other = root + '-worktree';
  try {
    g(root, 'worktree', 'add', '--detach', other);
    withWorktreeLock(root, () => withWorktreeLock(other, () => assert.ok(true)));
  } finally {
    g(root, 'worktree', 'remove', '--force', other);
    rmSync(root, { recursive: true, force: true });
  }
});
