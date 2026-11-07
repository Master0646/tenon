// 审查页版式：场景表、任务逐条、带哈希的批准命令、长段落提醒
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDraft, formatRequirement, longParagraphs, render } from '../src/render.ts';
import { deriveStatus } from '../src/status.ts';
import { CLI, append, cli, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** 在伪终端中运行 CLI；answer 为 null 时不输入 */
function tty(dir: string, answer: string | null, ...args: string[]) {
  const cmd = [process.execPath, CLI, ...args].map(shq).join(' ');
  const pty = process.platform === 'darwin' ? `script -q /dev/null ${cmd}` : `script -qec ${shq(cmd)} /dev/null`;
  const input = answer === null ? 'sleep 2' : `sleep 1; printf '%s\\n' ${shq(answer)}; sleep 1`;
  return spawnSync('sh', ['-c', `(${input}) | ${pty}`], { cwd: dir, encoding: 'utf8' });
}
const hasScript = spawnSync('sh', ['-c', 'command -v script']).status === 0 && ['darwin', 'linux'].includes(process.platform);

const REQ = `### Requirement: 禁用用户需要 ADMIN
系统 SHALL 拒绝非 ADMIN 用户调用禁用接口。

#### Scenario: 普通用户
- WHEN USER 调用禁用
- THEN 返回 403
- AND 状态不变

#### Scenario: 管理员
- WHEN ADMIN 调用禁用
- THEN 返回 200`;

test('formatRequirement：需求名、约束、场景表；AND 并入 THEN；无法识别时返回 null', () => {
  const out = formatRequirement(REQ)!;
  assert.match(out, /^\*\*禁用用户需要 ADMIN\*\*\n\n系统 SHALL 拒绝/);
  assert.match(out, /\| 场景 \| WHEN \| THEN \|/);
  assert.match(out, /\| 普通用户 \| USER 调用禁用 \| 返回 403；状态不变 \|/);
  assert.match(out, /\| 管理员 \| ADMIN 调用禁用 \| 返回 200 \|/);
  assert.equal(formatRequirement(`${REQ}\n补充说明一句`), null);
  assert.equal(formatRequirement('### Requirement: x\n约束\n\n#### Scenario: s\n- AND 没有前文'), null);
  assert.match(formatRequirement('### Requirement: 旧需求\n**Reason**: 不再需要')!, /^\*\*旧需求\*\*\n\n\*\*Reason\*\*/);
});

test('审查页：规范按场景表、任务逐条列出验收条件、带哈希的批准命令；render 成功', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `.devflow/changes/${ID}/tasks.yaml`, 'schema_version: 1\ntasks:\n  - id: T1\n    title: 定义角色\n    acceptance:\n      - 甲\n      - 乙\n      - 丙\n  - id: T2\n    title: 接口加判断\n    depends_on: [T1]\n');
  const { draft, hash } = buildDraft(dir, ID);
  assert.match(draft, /\| 普通用户访问 \| USER 角色请求 \/api\/users \| 返回 403 \|/);
  assert.match(draft, /\*\*T1 定义角色\*\*\n\n- 甲\n- 乙\n- 丙/);
  assert.match(draft, /\*\*T2 接口加判断\*\*　依赖：T1\n\n（未写验收条件）/);
  assert.match(draft, /\[T1 定义角色\] -> \[T2 接口加判断\]/);
  assert.ok(draft.includes(`devflow approve ${ID} --hash ${hash.slice(7, 19)}`));
  assert.ok(existsSync(render(dir, ID).file));
});

test('approve --hash：一致时不问 y 直接批准；不一致、太短时拒绝；非 TTY 仍被拒绝', { skip: !hasScript && '需要 script 命令' }, () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const prefix = buildDraft(dir, ID).hash.slice(7, 19);
  const events = join(dir, `.devflow/changes/${ID}/events.jsonl`);
  const ev = () => (existsSync(events) ? readFileSync(events, 'utf8') : '');

  assert.match(cli(dir, 'approve', ID, '--hash', prefix).stderr, /交互终端/);
  assert.match(tty(dir, null, 'approve', ID, '--hash', 'abc').stdout, /至少需要 12 位/);
  append(dir, `.devflow/changes/${ID}/proposal.md`, '审查后又改了。\n');
  const stale = tty(dir, null, 'approve', ID, '--hash', prefix);
  assert.match(stale.stdout, /审查后被审文件已变化/);
  assert.equal(ev(), '');

  const fresh = buildDraft(dir, ID).hash.slice(7, 19);
  const ok = tty(dir, null, 'approve', ID, '--hash', fresh);
  assert.doesNotMatch(ok.stdout, /输入 y/);
  assert.match(ok.stdout, /已批准[\s\S]*devflow-apply/);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
});

test('长段落：超过 3 句 warn 定位首行；列表、表格、代码块不算；CLI 退出码 0', () => {
  const long = '第一句。第二句。第三句。第四句。第五句。';
  const ws = longParagraphs(`# 设计\n\n简短一段。\n\n${long}\n续行也算。\n`, 'd.md');
  assert.equal(ws.length, 1);
  assert.equal(ws[0].file, 'd.md:5');
  assert.match(ws[0].message, /6 句/);
  assert.deepEqual(longParagraphs(`- ${long}\n\n| ${long} |\n\n\`\`\`text\n${long}\n\`\`\`\n\n> ${long}\n`, 'd.md'), []);

  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `.devflow/changes/${ID}/design.md`, `# 设计\n\n${long}\n`);
  const r = cli(dir, 'validate', ID);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /design\.md:3: 段落有 5 句/);
});
