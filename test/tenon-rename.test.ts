// 改名为 Tenon：打包与命令名、新旧数据目录、托管文件升级、生成内容的名称
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installAgents, upsertBlock } from '../src/agents.ts';
import { archive } from '../src/archive.ts';
import { applyStart, taskDone, verify } from '../src/exec.ts';
import { hookFile, init } from '../src/init.ts';
import { approve } from '../src/status.ts';
import { cli, commit, g, write } from './fixture.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 只建 Git 仓库，不初始化 */
function bare(): string {
  const r = spawnSync('mktemp', ['-d'], { encoding: 'utf8' }).stdout.trim();
  const dir = spawnSync('realpath', [r], { encoding: 'utf8' }).stdout.trim();
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.name', 'tester');
  g(dir, 'config', 'user.email', 'tester@example.invalid');
  g(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'a.txt', 'hello\n');
  return dir;
}

test('AC1 打包后的命令名是 tenon：help 与 --version 可运行，子命令不变', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tenon');
  assert.deepEqual(pkg.bin, { tenon: './dist/cli.js' });
  // --dry-run 也会跑 prepack（编译 dist/），列出将要打包的文件
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [info] = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  assert.equal(info.name, 'tenon');
  const files = info.files.map((f: { path: string }) => f.path);
  for (const f of ['dist/cli.js', 'templates/entry.md', 'templates/tenon.rules', 'templates/skills/tenon-propose/SKILL.md']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f: string) => /devflow/.test(f)), '包里不应再有 devflow 命名的文件');

  const run = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'dist/cli.js'), ...args], { encoding: 'utf8' });
  assert.equal(run('--version').stdout.trim(), pkg.version);
  const help = run('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^tenon \d/);
  assert.match(help.stdout, /用法：tenon <命令>/);
  for (const sub of ['init', 'update', 'new', 'validate', 'status', 'render', 'review', 'wait', 'approve', 'apply', 'task done', 'verify', 'resume', 'evidence add', 'evidence confirm', 'archive', 'check', 'doctor', 'wiki lint']) {
    assert.match(help.stdout, new RegExp(`\\n  ${sub}\\b`), sub);
  }
  assert.doesNotMatch(help.stdout, /devflow (?!\/)/, '帮助里只用 tenon 命令（.devflow/ 目录说明除外）');
});

test('AC2 新项目创建 .tenon/；只有 .devflow/ 的旧项目照常读取批准与归档；两个都在时报错', () => {
  const fresh = bare();
  init(fresh);
  assert.ok(existsSync(join(fresh, '.tenon/project.yaml')));
  assert.ok(!existsSync(join(fresh, '.devflow')));
  assert.match(readFileSync(join(fresh, '.gitignore'), 'utf8'), /^\.tenon\/runtime\/$/m);

  // 旧项目：数据从一开始就在 .devflow/ 里（批准哈希里的路径也是 .devflow/...）
  const old = bare();
  mkdirSync(join(old, '.devflow'));
  init(old);
  assert.ok(existsSync(join(old, '.devflow/project.yaml')));
  assert.ok(!existsSync(join(old, '.tenon')));
  write(old, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: echo ok\nexclude: []\nenforce: warn\n');
  for (const id of ['old-a', 'old-b']) {
    write(old, `.devflow/changes/${id}/change.yaml`, `schema_version: 1\ntitle: 旧变更 ${id}\naffected_paths:\n  - a.txt\n`);
    write(old, `.devflow/changes/${id}/proposal.md`, '# 提案\n\n旧项目里的变更。\n');
    write(old, `.devflow/changes/${id}/tasks.yaml`, 'schema_version: 1\ntasks:\n  - id: T1\n    title: 改 a.txt\n');
  }
  commit(old, 'old project', true);
  approve(old, 'old-a');
  approve(old, 'old-b');
  applyStart(old, 'old-b');
  assert.equal(verify(old, 'old-b').result, 'pass');
  taskDone(old, 'old-b', 'T1');
  archive(old, 'old-b');

  const status = JSON.parse(cli(old, 'status', '--all', '--json').stdout);
  const byId = Object.fromEntries((Array.isArray(status) ? status : status.changes).map((c: { id: string; status: string }) => [c.id, c.status]));
  assert.equal(byId['old-a'], 'approved');
  assert.ok(Object.keys(byId).some((id) => id.endsWith('old-b') && byId[id] === 'archived'), JSON.stringify(byId));
  assert.ok(existsSync(join(old, '.devflow/changes/archive')));
  assert.ok(!existsSync(join(old, '.tenon')), '旧项目里不应冒出 .tenon/');

  // 两个目录并存：拒绝，不挑一个写
  mkdirSync(join(old, '.tenon'));
  const both = cli(old, 'status');
  assert.equal(both.status, 1);
  assert.match(both.stderr + both.stdout, /同时有 \.tenon\/ 和 \.devflow\//);
});

test('AC2 升级托管文件：旧钩子原地更新不重复；别人的钩子不动；旧托管段落换成新标记且段外内容保留', () => {
  const dir = bare();
  init(dir);
  const hook = hookFile(dir);
  writeFileSync(hook, "#!/bin/sh\n# devflow-hook\nexec '/old/node' '/old/devflow/dist/cli.js' check --staged\n");
  chmodSync(hook, 0o755);
  assert.equal(init(dir).hook, 'updated');
  const text = readFileSync(hook, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n# tenon-hook\nexec /);
  assert.doesNotMatch(text, /devflow-hook|\/old\//);
  assert.equal(init(dir).hook, 'updated');
  assert.equal(readFileSync(hook, 'utf8').match(/tenon-hook/g)?.length, 1);

  const foreign = bare();
  init(foreign);
  writeFileSync(hookFile(foreign), '#!/bin/sh\nnpm run lint\n');
  assert.equal(init(foreign).hook, 'foreign');
  assert.equal(readFileSync(hookFile(foreign), 'utf8'), '#!/bin/sh\nnpm run lint\n');

  const old = '# 我的说明\n\n<!-- devflow:begin（由 devflow 生成；devflow update 会覆盖本段） -->\n旧内容\n<!-- devflow:end -->\n\n## 我的附录\n';
  const up = upsertBlock(old, '新内容');
  assert.match(up, /^# 我的说明\n\n<!-- tenon:begin[^\n]*-->\n新内容\n<!-- tenon:end -->\n\n## 我的附录\n$/);
  assert.equal(upsertBlock(up, '新内容'), up);
});

test('AC3 生成的技能、入口说明与规则使用 Tenon 名称；旧版生成的技能被替换，被人改过的保留', () => {
  const dir = bare();
  init(dir);
  // 改名前装过的技能：一份原样（带生成标记），一份被人改过
  write(dir, '.claude/skills/devflow-ask/SKILL.md', '---\nname: devflow-ask\n---\n<!-- 由 devflow 生成；devflow update 会覆盖本文件 -->\n');
  write(dir, '.claude/skills/devflow-mine/SKILL.md', '---\nname: devflow-mine\n---\n我自己写的技能\n');
  write(dir, '.codex/rules/devflow.rules', '# 由 devflow 生成；devflow update 会覆盖本文件。\n');
  installAgents(dir, ['claude', 'codex']);

  const skills = readdirSync(join(dir, '.claude/skills')).sort();
  assert.deepEqual(skills, ['devflow-mine', 'tenon-apply', 'tenon-archive', 'tenon-ask', 'tenon-propose', 'tenon-scan']);
  assert.deepEqual(readdirSync(join(dir, '.agents/skills')).sort(), ['tenon-apply', 'tenon-archive', 'tenon-ask', 'tenon-propose', 'tenon-scan']);
  assert.deepEqual(readdirSync(join(dir, '.codex/rules')), ['tenon.rules']);

  for (const f of [
    ...['apply', 'archive', 'ask', 'propose', 'scan'].map((s) => `.claude/skills/tenon-${s}/SKILL.md`),
    '.codex/rules/tenon.rules',
  ]) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(text, /devflow|DevFlow/i, f);
    assert.match(text, /tenon|Tenon/, f);
  }
  // 入口说明只在交代旧目录时提到 .devflow/
  const entry = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(entry, /## Tenon/);
  assert.match(entry, /`tenon approve`/);
  assert.deepEqual(entry.match(/devflow/gi), ['devflow'], '只剩旧目录说明里的一处');
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  for (const rule of ['Bash(tenon approve *)', 'Edit(/.tenon/specs/**)', 'Edit(/.devflow/specs/**)']) assert.ok(settings.permissions.deny.includes(rule), rule);
});
