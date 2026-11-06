import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { headCommit, sha256 } from '../src/core.ts';
import { init, newChange } from '../src/init.ts';
import { approve } from '../src/status.ts';
import { validateChange } from '../src/validate.ts';
import { addEvent, at, cli, commit, g, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const errors = (dir: string, staged = false) => check(dir, { staged }).filter((i) => i.level === 'error');

test('init 幂等：不覆盖已有文件，hook 带标记', () => {
  const dir = makeRepo();
  write(dir, '.devflow/knowledge/index.md', '# 我的索引\n');
  const r = init(dir);
  assert.deepEqual(r.created, []);
  assert.equal(r.hook, 'updated');
  assert.equal(readFileSync(join(dir, '.devflow/knowledge/index.md'), 'utf8'), '# 我的索引\n');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').match(/\.devflow\/runtime\//g)?.length, 1);
});

test('init 不覆盖别人的 pre-commit hook', () => {
  const dir = makeRepo();
  write(dir, '.git/hooks/pre-commit', '#!/bin/sh\nnpx lint-staged\n');
  assert.equal(init(dir).hook, 'foreign');
  assert.equal(readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\nnpx lint-staged\n');
});

test('new 生成的骨架格式合法但内容不完整：check 放行，validate 拦截', () => {
  const dir = makeRepo();
  newChange(dir, ID);
  assert.deepEqual(errors(dir), []);
  const v = validateChange(dir, ID, true).filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(v.some((m) => m.includes('title')));
  assert.ok(v.some((m) => m.includes('affected_paths 不能为空')));
  assert.ok(v.some((m) => m.includes('tasks 不能为空')));
  assert.ok(v.some((m) => m.includes('只有标题')));
  assert.throws(() => newChange(dir, ID), /已存在/);
  assert.throws(() => newChange(dir, 'Bad_ID'), /无效/);
});

test('validate：依赖不存在、依赖成环、进度字段、delta 缺小节', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  assert.deepEqual(validateChange(dir, ID, true), []);
  const base = `.devflow/changes/${ID}`;
  write(dir, `${base}/tasks.yaml`, `schema_version: 1
tasks:
  - { id: T1, title: a, depends_on: [T2] }
  - { id: T2, title: b, depends_on: [T1] }
  - { id: T3, title: c, depends_on: [T9], status: done }
`);
  write(dir, `${base}/specs/auth/spec.md`, '没有小节\n');
  const msgs = validateChange(dir, ID, true).map((i) => i.message);
  assert.ok(msgs.some((m) => m.includes('成环')));
  assert.ok(msgs.some((m) => m.includes('不存在的任务：T9')));
  assert.ok(msgs.some((m) => m.includes('进度字段')));
  assert.ok(msgs.some((m) => m.includes('ADDED / MODIFIED / REMOVED')));
});

test('validate：YAML 语法错误报出行号', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `.devflow/changes/${ID}/change.yaml`, 'schema_version: 1\ntitle: [未闭合\n');
  const e = validateChange(dir, ID, true).find((i) => i.message.startsWith('YAML'));
  assert.match(e?.file ?? '', /change\.yaml:\d+$/);
});

test('check：手改、手加、手删 specs/ 都会被拒绝', () => {
  const dir = makeRepo();
  assert.deepEqual(errors(dir), []);

  write(dir, '.devflow/specs/auth/spec.md', '# 手写规范\n');
  assert.match(errors(dir)[0].message, /不在 specs\.lock 中/);

  // 模拟 archive 写入：内容与锁一致即放行
  writeFileSync(join(dir, '.devflow/specs/specs.lock'), JSON.stringify({ 'auth/spec.md': sha256('# 手写规范\n') }));
  assert.deepEqual(errors(dir), []);

  write(dir, '.devflow/specs/auth/spec.md', '# 又改了\n');
  assert.match(errors(dir)[0].message, /被手动修改/);

  rmSync(join(dir, '.devflow/specs/auth/spec.md'));
  assert.match(errors(dir)[0].message, /文件被删除/);
});

test('check：事件日志只允许追加', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  commit(dir, 'approve', true);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  assert.deepEqual(errors(dir), []); // 追加合法

  const f = join(dir, `.devflow/changes/${ID}/events.jsonl`);
  writeFileSync(f, readFileSync(f, 'utf8').split('\n').slice(1).join('\n'));
  assert.match(errors(dir).map((i) => i.message).join(), /只允许追加/);

  writeFileSync(f, '{bad json\n');
  assert.match(errors(dir).map((i) => i.message).join(), /不是合法的 JSON/);
});

test('check --staged：暂存了未开工变更的代码时警告，strict 时拒绝', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, 'backend/src/Auth.java', 'class Auth { int y; }\n');
  write(dir, 'docs/readme.md', 'other\n');
  g(dir, 'add', '-A');

  let issues = check(dir, { staged: true });
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
  assert.match(issues.find((i) => i.level === 'warn')?.file ?? '', /backend\/src\/Auth\.java/);

  const pf = join(dir, '.devflow/project.yaml');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace('enforce: warn', 'enforce: strict'));
  assert.equal(errors(dir, true).length, 1);

  approve(dir, ID);
  addEvent(dir, ID, { type: 'apply-started', at: at(), head: headCommit(dir) });
  assert.deepEqual(errors(dir, true), []);
});

test('M0 交付：pre-commit hook 拒绝手改 specs/，正常提交放行', () => {
  const dir = makeRepo();
  assert.ok(existsSync(join(dir, '.git/hooks/pre-commit')));

  write(dir, 'docs/readme.md', 'normal change\n');
  commit(dir, 'normal'); // 走 hook

  write(dir, '.devflow/specs/auth/spec.md', '# 手写规范\n');
  assert.throws(() => commit(dir, 'sneaky'), (e: any) => /specs\.lock/.test(String(e.stderr)));
});

test('approve 在非 TTY 下被拒绝（模拟 Agent 执行）', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const r = cli(dir, 'approve', ID);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /交互终端/);
  assert.equal(existsSync(join(dir, `.devflow/changes/${ID}/events.jsonl`)), false);
});

test('CLI：status 与 validate 的 --json 输出', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const v = cli(dir, 'validate', ID, '--json');
  assert.equal(v.status, 0);
  assert.equal(JSON.parse(v.stdout).ok, true);
  const s = JSON.parse(cli(dir, 'status', '--json').stdout);
  assert.deepEqual(s.map((x: any) => [x.id, x.status]), [[ID, 'draft']]);
  const bad = cli(dir, 'status', 'nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /变更不存在/);
});
