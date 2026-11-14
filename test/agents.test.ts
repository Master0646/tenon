import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_DENY, detectAgents, installAgents, parseAgents, upsertBlock } from '../src/agents.ts';
import { cli, makeRepo, write } from './fixture.ts';

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

test('upsertBlock：追加、原位替换、保留段外内容', () => {
  const once = upsertBlock('# 我的说明\n', 'A');
  assert.match(once, /^# 我的说明\n\n<!-- tenon:begin.*\nA\n<!-- tenon:end -->\n$/s);
  const twice = upsertBlock(`${once}\n尾部\n`, 'B');
  assert.match(twice, /# 我的说明/);
  assert.match(twice, /\nB\n/);
  assert.doesNotMatch(twice, /\nA\n/);
  assert.match(twice, /尾部/);
  assert.equal(twice.match(/tenon:begin/g)?.length, 1);
});

test('installAgents：两种 Agent 的技能、入口片段、禁止规则；重复运行幂等', () => {
  const dir = makeRepo();
  write(dir, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls *)'], deny: ['Bash(rm *)'] } }));
  write(dir, 'AGENTS.md', '# 已有内容\n');
  installAgents(dir, ['claude', 'codex']);
  installAgents(dir, ['claude', 'codex']);

  for (const p of ['.claude/skills', '.agents/skills']) {
    for (const s of ['tenon-scan', 'tenon-ask']) {
      assert.match(read(dir, `${p}/${s}/SKILL.md`), new RegExp(`^---\\nname: ${s}\\ndescription: `));
    }
  }
  assert.match(read(dir, 'AGENTS.md'), /^# 已有内容/);
  assert.equal(read(dir, 'AGENTS.md').match(/tenon:begin/g)?.length, 1);
  assert.match(read(dir, 'CLAUDE.md'), /knowledge\/index\.md/);

  const s = JSON.parse(read(dir, '.claude/settings.json'));
  assert.deepEqual(s.permissions.allow, ['Bash(ls *)']);
  assert.deepEqual(s.permissions.deny, ['Bash(rm *)', ...CLAUDE_DENY]);
  assert.match(read(dir, '.codex/rules/tenon.rules'), /forbidden/);
  assert.deepEqual(detectAgents(dir), ['claude', 'codex']);
});

test('installAgents：settings.json 不合法时不覆盖，给出警告', () => {
  const dir = makeRepo();
  write(dir, '.claude/settings.json', '{ 坏的');
  const r = installAgents(dir, ['claude']);
  assert.equal(read(dir, '.claude/settings.json'), '{ 坏的');
  assert.match(r.warnings.join(), /不是合法的 JSON/);
  assert.equal(existsSync(join(dir, '.agents')), false);
});

test('parseAgents 与 CLI update', () => {
  assert.deepEqual(parseAgents(undefined), ['claude', 'codex']);
  assert.deepEqual(parseAgents('codex,codex'), ['codex']);
  assert.throws(() => parseAgents('cursor'), /不支持/);

  const dir = makeRepo(); // makeRepo 只调用 init，没有生成 Agent 文件
  assert.match(cli(dir, 'update').stderr, /没有找到已安装的 Agent/);
  assert.equal(cli(dir, 'update', '--agents', 'codex').status, 0);
  assert.deepEqual(detectAgents(dir), ['codex']);
});
