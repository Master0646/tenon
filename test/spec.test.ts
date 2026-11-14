import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSpec, parseDelta, requirementNames } from '../src/spec.ts';
import { validateChange } from '../src/validate.ts';
import { makeRepo, write, writeChange } from './fixture.ts';

const req = (name: string, extra = '') => `### Requirement: ${name}\n系统 SHALL ${name}。${extra}\n\n#### Scenario: ${name}\n- WHEN x\n- THEN y`;

const CURRENT = `# auth

## Purpose

认证与权限。

## Requirements

${req('登录')}

${req('禁用')}

## 附注

保留的小节。
`;

test('parseDelta：三类小节、Purpose、行号', () => {
  const { delta, errors } = parseDelta(`## Purpose\n新能力\n\n## ADDED Requirements\n\n${req('A')}\n\n## REMOVED Requirements\n\n### Requirement: B\n**Reason**: 不再需要\n`);
  assert.deepEqual(errors, []);
  assert.equal(delta.purpose, '新能力');
  assert.deepEqual(delta.added.map((r) => [r.name, r.line]), [['A', 6]]);
  assert.deepEqual(delta.removed.map((r) => r.name), ['B']);
});

test('parseDelta：缺 Scenario、缺 SHALL、重名、未知小节、游离内容、空 delta', () => {
  const msgs = (t: string) => parseDelta(t).errors.map((e) => e.message).join('|');
  assert.match(msgs('## ADDED Requirements\n### Requirement: A\n系统 SHALL a。\n'), /Scenario/);
  assert.match(msgs('## ADDED Requirements\n### Requirement: A\n可以 a。\n#### Scenario: s\n'), /SHALL/);
  assert.match(msgs(`## ADDED Requirements\n${req('A')}\n## MODIFIED Requirements\n${req('A')}\n`), /重复：A/);
  assert.match(msgs(`## Changed Requirements\n${req('A')}\n`), /不认识的小节/);
  assert.match(msgs(`## ADDED Requirements\n这里有字\n${req('A')}\n`), /### Requirement/);
  assert.match(msgs('## ADDED Requirements\n'), /没有任何需求/);
  // 代码块中的 ## 不算小节
  assert.deepEqual(parseDelta(`## ADDED Requirements\n${req('A', '\n```\n## 不是小节\n```')}\n`).errors, []);
});

test('mergeSpec：新能力只能 ADDED，生成完整规范', () => {
  const { delta } = parseDelta(`## Purpose\n用户管理\n\n## ADDED Requirements\n${req('列表')}\n`);
  const r = mergeSpec('user', null, delta);
  assert.deepEqual(r.errors, []);
  assert.match(r.text!, /^# user\n\n## Purpose\n\n用户管理\n\n## Requirements\n\n### Requirement: 列表/);
  assert.deepEqual(requirementNames(r.text!), ['列表']);

  const bad = parseDelta(`## MODIFIED Requirements\n${req('列表')}\n`).delta;
  assert.match(mergeSpec('user', null, bad).errors.join(), /只能 ADDED/);
});

test('mergeSpec：ADDED 追加、MODIFIED 原位替换、REMOVED 删除，其他小节原样保留', () => {
  const { delta } = parseDelta(`## ADDED Requirements\n${req('改密码')}\n\n## MODIFIED Requirements\n${req('登录', '新版')}\n\n## REMOVED Requirements\n### Requirement: 禁用\n**Reason**: 合并到状态管理\n`);
  const r = mergeSpec('auth', CURRENT, delta);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(requirementNames(r.text!), ['登录', '改密码']);
  assert.match(r.text!, /SHALL 登录。新版/);
  assert.match(r.text!, /^# auth\n\n## Purpose\n\n认证与权限。\n\n## Requirements/);
  assert.match(r.text!, /## 附注\n\n保留的小节。\n$/);
  // 合并结果可再次作为当前规范继续合并（结构稳定）
  const again = mergeSpec('auth', r.text!, parseDelta(`## ADDED Requirements\n${req('注销')}\n`).delta);
  assert.deepEqual(requirementNames(again.text!), ['登录', '改密码', '注销']);
});

test('mergeSpec：名称冲突与不存在的需求', () => {
  const e = (t: string) => mergeSpec('auth', CURRENT, parseDelta(t).delta).errors.join('|');
  assert.match(e(`## ADDED Requirements\n${req('登录')}\n`), /已存在：登录/);
  assert.match(e(`## MODIFIED Requirements\n${req('注册')}\n`), /不存在：注册/);
  assert.match(e('## REMOVED Requirements\n### Requirement: 注册\n'), /不存在：注册/);
  assert.match(e(`## Purpose\nx\n## ADDED Requirements\n${req('注册')}\n`), /不能再写 ## Purpose/);
});

test('validate 对当前规范做合并试算', () => {
  const dir = makeRepo();
  writeChange(dir, 'c1');
  write(dir, '.tenon/changes/c1/specs/auth/spec.md', `## MODIFIED Requirements\n${req('登录')}\n`);
  assert.match(validateChange(dir, 'c1', true).map((i) => i.message).join(), /只能 ADDED/);
  write(dir, '.tenon/specs/auth/spec.md', CURRENT);
  assert.deepEqual(validateChange(dir, 'c1', true).filter((i) => i.level === 'error'), []);
});
