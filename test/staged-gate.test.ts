// 门禁按暂存区检查；提示未暂存的变更记录与超出影响路径的文件
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { headCommit, sha256 } from '../src/core.ts';
import { approve } from '../src/status.ts';
import { addEvent, at, commit, g, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const msgs = (dir: string, level: 'error' | 'warn', staged = true) =>
  check(dir, { staged }).filter((i) => i.level === level).map((i) => `${i.file} ${i.message} ${i.hint ?? ''}`).join('\n');

/** 已提交一份规范 auth/spec.md */
function withSpec() {
  const dir = makeRepo();
  write(dir, '.tenon/specs/auth/spec.md', '# auth\n');
  writeFileSync(join(dir, '.tenon/specs/specs.lock'), JSON.stringify({ 'auth/spec.md': sha256('# auth\n') }));
  commit(dir, 'spec', true);
  return dir;
}

/** 已批准并开工的变更（变更目录已提交） */
function started() {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  commit(dir, 'change', true);
  return dir;
}

test('规范：未暂存的手改不影响 --staged；暂存后工作树恢复仍报错', () => {
  const dir = withSpec();
  const spec = join(dir, '.tenon/specs/auth/spec.md');
  writeFileSync(spec, '# 手改\n');
  write(dir, 'docs/readme.md', 'x\n');
  g(dir, 'add', 'docs/readme.md');
  assert.doesNotMatch(msgs(dir, 'error'), /specs\.lock/);
  assert.match(msgs(dir, 'error', false), /被手动修改/);

  g(dir, 'add', '-A');
  writeFileSync(spec, '# auth\n');
  assert.match(msgs(dir, 'error'), /auth\/spec\.md.*被手动修改/);
  assert.doesNotMatch(msgs(dir, 'error', false), /被手动修改/);
});

test('事件日志：暂存区删改已提交行时 --staged 报错，即使工作树合法', () => {
  const dir = started();
  const rel = `.tenon/changes/${ID}/events.jsonl`;
  const good = readFileSync(join(dir, rel), 'utf8');
  writeFileSync(join(dir, rel), good.split('\n').slice(1).join('\n'));
  g(dir, 'add', rel);
  writeFileSync(join(dir, rel), good);
  assert.match(msgs(dir, 'error'), /只允许追加/);
  assert.doesNotMatch(msgs(dir, 'error', false), /只允许追加/);
});

test('记录未暂存：只暂存代码时警告；与变更目录一起暂存时不警告；strict 也不拒绝', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  write(dir, 'backend/src/Auth.java', 'class Auth { int y; }\n');
  g(dir, 'add', 'backend');
  assert.match(msgs(dir, 'warn'), new RegExp(`记录未暂存.*git add \\.tenon/changes/${ID}`));

  const pf = join(dir, '.tenon/project.yaml');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace('enforce: warn', 'enforce: strict'));
  g(dir, 'add', '.tenon/project.yaml');
  assert.doesNotMatch(msgs(dir, 'error'), /记录未暂存/);

  g(dir, 'add', `.tenon/changes/${ID}`);
  assert.doesNotMatch(msgs(dir, 'warn'), /记录未暂存/);
});

test('超出影响路径：已开工时列出；.tenon/ 下不算；没有已开工变更时不提示', () => {
  const dir = started();
  write(dir, 'backend/src/Auth.java', 'class Auth { int y; }\n');
  write(dir, '.claude/launch.json', '{}\n');
  write(dir, '.tenon/knowledge/log.md', '# 知识变更记录\n- x\n');
  g(dir, 'add', '-A');
  const w = msgs(dir, 'warn');
  assert.match(w, /\.claude\/launch\.json.*不在任何进行中变更的 affected_paths 内/);
  assert.doesNotMatch(w, /backend\/src\/Auth\.java.*affected_paths 内/);
  assert.doesNotMatch(w, /knowledge\/log\.md.*affected_paths 内/);

  const plain = makeRepo();
  writeChange(plain, ID); // 未批准、未开工
  write(plain, '.claude/launch.json', '{}\n');
  g(plain, 'add', '-A');
  assert.doesNotMatch(msgs(plain, 'warn'), /affected_paths 内/);
});

test('affected_paths 重叠：已被已开工变更覆盖的文件不报另一个变更未开工；只属于未开工变更的仍报', () => {
  const dir = started(); // ID 已开工，affected_paths: backend/**
  write(dir, '.tenon/changes/other/change.yaml', 'schema_version: 1\ntitle: 另一个\naffected_paths:\n  - backend/**\n  - frontend/**\n');
  write(dir, '.tenon/changes/other/proposal.md', '# 提案\n\n另一个变更。\n');
  write(dir, '.tenon/changes/other/tasks.yaml', 'schema_version: 1\ntasks:\n  - id: T1\n    title: x\n');
  commit(dir, 'other', true);
  write(dir, 'backend/src/A.java', 'class A {}\n');
  g(dir, 'add', 'backend/src/A.java');
  assert.doesNotMatch(msgs(dir, 'warn'), /变更 other/);
  write(dir, 'frontend/B.vue', '<template/>\n');
  g(dir, 'add', 'frontend/B.vue');
  const w = msgs(dir, 'warn');
  assert.match(w, /frontend\/B\.vue .*变更 other 的影响路径/);
  assert.doesNotMatch(w, /A\.java.*变更 other/);
});
