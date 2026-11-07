import assert from 'node:assert/strict';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { hashFiles, repoFiles, reviewedFiles, sha256 } from '../src/core.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { validateChange } from '../src/validate.ts';
import { lintWiki } from '../src/wiki.ts';
import { commit, g, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const DS = 'Finder 元数据\n';
const errors = (dir: string) => check(dir, { staged: true }).filter((i) => i.level === 'error');

/** 模拟 macOS 访达在 .devflow 各处生成 .DS_Store，并由 .gitignore 忽略 */
function finder(dir: string) {
  appendFileSync(join(dir, '.gitignore'), '.DS_Store\n');
  for (const d of ['.devflow/specs', `.devflow/changes/${ID}`, `.devflow/changes/${ID}/specs`, '.devflow/knowledge/pages']) {
    write(dir, `${d}/.DS_Store`, DS);
  }
}

test('repoFiles：包含已跟踪与未忽略的新文件，排除被忽略和已删除的文件', () => {
  const dir = makeRepo();
  write(dir, '.devflow/specs/a/spec.md', 'x');
  write(dir, '.devflow/specs/tracked.txt', 'x');
  commit(dir, 'tracked', true);
  write(dir, '.devflow/specs/new.md', 'x');
  appendFileSync(join(dir, '.gitignore'), '.DS_Store\n');
  write(dir, '.devflow/specs/.DS_Store', DS);
  rmSync(join(dir, '.devflow/specs/tracked.txt'));
  assert.deepEqual(repoFiles(dir, '.devflow/specs'), ['a/spec.md', 'new.md', 'specs.lock']);
});

test('被忽略的 .DS_Store 不影响 check、validate、wiki lint 与批准哈希', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, '.devflow/knowledge/index.md', '# 知识索引\n');
  const before = hashFiles(dir, reviewedFiles(dir, ID));
  assert.equal(approve(dir, ID).hash, before);
  finder(dir);
  assert.equal(hashFiles(dir, reviewedFiles(dir, ID)), before);
  assert.deepEqual(errors(dir), []);
  assert.deepEqual(validateChange(dir, ID, true).filter((i) => i.level === 'error'), []);
  assert.deepEqual(lintWiki(dir).issues, []);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'with finder files'); // 走 pre-commit hook
});

test('没被忽略的多余文件仍会被拦下；删除已跟踪的规范仍报"文件被删除"', () => {
  const dir = makeRepo();
  write(dir, '.devflow/specs/notes.md', '手写笔记\n');
  assert.match(check(dir, { staged: false }).map((i) => i.message).join(), /不在 specs\.lock 中/);
  g(dir, 'add', '-A');
  assert.match(errors(dir).map((i) => i.message).join(), /不在 specs\.lock 中/);
  g(dir, 'rm', '-q', '--cached', '.devflow/specs/notes.md');
  rmSync(join(dir, '.devflow/specs/notes.md'));

  write(dir, '.devflow/specs/auth/spec.md', '# auth\n');
  writeFileSync(join(dir, '.devflow/specs/specs.lock'), JSON.stringify({ 'auth/spec.md': sha256('# auth\n') }));
  commit(dir, 'spec', true);
  rmSync(join(dir, '.devflow/specs/auth/spec.md'));
  assert.match(check(dir, { staged: false }).map((i) => i.message).join(), /文件被删除/);
  g(dir, 'add', '-A');
  assert.match(errors(dir).map((i) => i.message).join(), /文件被删除/);
});

test('没被忽略的文件照旧参与批准哈希：变更目录里多一个文件，批准失效', () => {
  // 不用 .DS_Store：本机全局 git 忽略规则可能已经忽略它
  const dir = makeRepo();
  writeChange(dir, ID);
  approve(dir, ID);
  write(dir, `.devflow/changes/${ID}/review-notes-xyz.md`, '补充说明\n');
  assert.equal(deriveStatus(dir, ID).status, 'draft');
});
