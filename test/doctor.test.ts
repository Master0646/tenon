import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installAgents } from '../src/agents.ts';
import { doctor, type Finding } from '../src/doctor.ts';
import { cli, g, makeRepo, write } from './fixture.ts';

const levelOf = (fs: Finding[], item: string) => fs.find((f) => f.item === item)?.level;
const setVerify = (dir: string) => {
  const f = join(dir, '.tenon/project.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^verify: \[\]$/m, 'verify:\n  - name: t\n    run: "true"'));
};

test('doctor：全部正常时没有 warn / error，CLI 退出码 0', () => {
  const dir = makeRepo();
  installAgents(dir, ['claude', 'codex']);
  setVerify(dir);
  write(dir, '.tenon/knowledge/pages/readme.md', `---\nschema_version: 1\ntitle: 说明\nverified_commit: "${g(dir, 'rev-parse', '--short', 'HEAD').trim()}"\nsources:\n  - path: docs/readme.md\n---\n# 说明\n`);
  write(dir, '.tenon/knowledge/index.md', '# 知识索引\n\n- [说明](pages/readme.md) — 说明\n');
  const fs = doctor(dir);
  assert.deepEqual(fs.filter((f) => f.level !== 'ok'), []);
  assert.equal(cli(dir, 'doctor').status, 0);
});

test('doctor：hook 缺失、hook 指向不存在的路径 → error 并提示 tenon init；CLI 退出码 1', () => {
  const dir = makeRepo();
  const hook = join(dir, '.git/hooks/pre-commit');
  writeFileSync(hook, readFileSync(hook, 'utf8').replace(/'[^']*cli\.ts'/, `'/nonexistent/cli.js'`));
  let f = doctor(dir).find((x) => x.item === 'hook')!;
  assert.equal(f.level, 'error');
  assert.match(f.message, /\/nonexistent\/cli\.js/);
  assert.match(f.hint!, /tenon init/);
  assert.equal(cli(dir, 'doctor').status, 1);

  rmSync(hook);
  f = doctor(dir).find((x) => x.item === 'hook')!;
  assert.equal(f.level, 'error');
  assert.match(f.message, /没有 pre-commit hook/);
});

test('doctor：别人的 hook 未调用 tenon → warn', () => {
  const dir = makeRepo();
  write(dir, '.git/hooks/pre-commit', '#!/bin/sh\nnpx lint-staged\n');
  assert.equal(levelOf(doctor(dir), 'hook'), 'warn');
});

test('doctor：Agent 技能被改动或入口段过期 → warn 并提示 tenon update', () => {
  const dir = makeRepo();
  installAgents(dir, ['claude']);
  write(dir, '.claude/skills/tenon-ask/SKILL.md', '改坏了\n');
  const f = doctor(dir).find((x) => x.item === 'Agent 文件（claude）')!;
  assert.equal(f.level, 'warn');
  assert.match(f.message, /tenon-ask\/SKILL\.md/);
  assert.match(f.hint!, /tenon update --agents claude/);

  installAgents(dir, ['claude']);
  writeFileSync(join(dir, 'CLAUDE.md'), readFileSync(join(dir, 'CLAUDE.md'), 'utf8').replace('Tenon', 'OldFlow'));
  assert.match(doctor(dir).find((x) => x.item === 'Agent 文件（claude）')!.message, /CLAUDE\.md/);
});

test('doctor：未声明验证命令、未安装 Agent、未忽略 runtime → warn（退出码仍为 0）', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, '.gitignore'), '');
  const fs = doctor(dir);
  assert.equal(levelOf(fs, 'project.yaml'), 'warn');
  assert.equal(levelOf(fs, 'Agent 文件'), 'warn');
  assert.equal(levelOf(fs, '.gitignore'), 'warn');
  assert.equal(cli(dir, 'doctor').status, 0);
});

test('doctor：Node 版本过低 → error；不在 Git 仓库中只查环境项', () => {
  const dir = makeRepo();
  assert.equal(levelOf(doctor(dir, '20.11.0'), 'Node'), 'error');

  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-nogit-')));
  const fs = doctor(plain);
  assert.deepEqual(fs.map((f) => f.item), ['Node', 'git', '仓库']);
  assert.match(fs[2].message, /其余检查已跳过/);
  const r = cli(plain, 'doctor');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('doctor：未初始化 → error 并提示 tenon init', () => {
  const dir = makeRepo();
  rmSync(join(dir, '.tenon'), { recursive: true });
  const f = doctor(dir).at(-1)!;
  assert.equal(f.level, 'error');
  assert.match(f.hint!, /tenon init/);
});

test('--version 输出 package.json 的版本号', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const r = cli(realpathSync(tmpdir()), '--version');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});
