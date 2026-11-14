// 审查台：工作节点、已归档列表与只读页、状态接口与提示后刷新
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { confirmEvidence, recordEvidence } from '../src/evidence.ts';
import { applyStart, taskDone, verify } from '../src/exec.ts';
import { buildDraft } from '../src/render.ts';
import { reviewServer } from '../src/review.ts';
import { approve, deriveStatus, workNode, type ChangeStatus } from '../src/status.ts';
import { commit, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'node-case';
const TOKEN = 'tok-wb';

function repo(): string {
  const dir = makeRepo();
  writeChange(dir, ID);
  const base = `.devflow/changes/${ID}`;
  // 验证命令看 fail.flag：有这个文件就失败，用来造出待修复
  write(dir, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: test ! -f fail.flag\nexclude: []\nenforce: warn\n');
  write(dir, `${base}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 节点\naffected_paths: [backend/**]\nsummary: [要点]\ndecisions: []\n');
  write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 甲\n    acceptance:\n      - id: AC1\n        text: 看过甲\n        method: manual\n  - id: T2\n    title: 乙\n    acceptance:\n      - id: AC2\n        text: 看过乙\n        method: manual\n');
  commit(dir, 'change', true);
  return dir;
}

const node = (dir: string, st?: ChangeStatus) => workNode(dir, ID, st ?? deriveStatus(dir, ID));
const manual = (dir: string, task: string, acceptance: string) =>
  recordEvidence(dir, ID, { task, acceptance, kind: 'manual', summary: '看过', procedure: '打开页面', expected: '正常', observed: '正常' }).evidence_id;

test('AC1 九个工作节点：写方案中、待你批准、待开工、实现中、补证据中、待你确认、修复中、待重新验证、归档准备中、待你归档', () => {
  const dir = repo();
  const base = `.devflow/changes/${ID}`;
  write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks: oops\n');
  assert.deepEqual(node(dir), { label: '写方案中', human: false });
  write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 甲\n    acceptance:\n      - id: AC1\n        text: 看过甲\n        method: manual\n  - id: T2\n    title: 乙\n    acceptance:\n      - id: AC2\n        text: 看过乙\n        method: manual\n');
  assert.deepEqual(node(dir), { label: '待你批准', human: true });
  assert.deepEqual(node(dir, { id: ID, status: 'rebase_required', reason: '', tasks: { done: 0, total: 2 } }), { label: '待你批准', human: true });

  approve(dir, ID);
  assert.deepEqual(node(dir), { label: '待开工', human: false });
  applyStart(dir, ID);
  assert.deepEqual(node(dir), { label: '实现中（任务 0/2）', human: false });

  write(dir, 'fail.flag', 'x');
  assert.equal(verify(dir, ID).result, 'fail');
  assert.deepEqual(node(dir), { label: '修复中', human: false });
  rmSync(join(dir, 'fail.flag'));
  assert.deepEqual(node(dir), { label: '实现中（任务 0/2）', human: false }); // 验证后代码有改动、任务没做完

  assert.equal(verify(dir, ID).result, 'pass');
  assert.deepEqual(node(dir), { label: '补证据中', human: false });
  const ids = [manual(dir, 'T1', 'AC1'), manual(dir, 'T2', 'AC2')];
  assert.deepEqual(node(dir), { label: '待你确认 2 条', human: true });
  for (const e of ids) confirmEvidence(dir, ID, e);
  taskDone(dir, ID, 'T1');
  taskDone(dir, ID, 'T2');
  assert.equal(deriveStatus(dir, ID).status, 'ready_to_archive');
  assert.deepEqual(node(dir), { label: '待你归档', human: true });

  // 任务都做完后又改了代码
  const st = deriveStatus(dir, ID);
  assert.deepEqual(node(dir, { ...st, status: 'applying', stage: 'code-changed' }), { label: '待重新验证', human: false });
  // 知识页检查有错误：归档会被拦，先由 Agent 更新知识页
  write(dir, '.devflow/knowledge/pages/bad.md', '没有 frontmatter\n');
  assert.deepEqual(node(dir, st), { label: '归档准备中', human: false });
});

async function start(dir: string) {
  const server = reviewServer(dir, TOKEN, 'test');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const text = (path: string) => fetch(`${origin}/${TOKEN}${path}`).then((r) => r.text());
  const state = (path: string) => fetch(`${origin}/${TOKEN}${path}`).then((r) => r.json() as Promise<{ v: string; waiting?: boolean }>);
  return { server, origin, text, state };
}

/** 一个已归档、一个进行中 */
function withArchive(): string {
  const dir = repo();
  for (const old of ['2026-01-02-older', '2026-03-04-newer']) {
    const base = `.devflow/changes/archive/${old}`;
    write(dir, `${base}/change.yaml`, `schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 旧变更 ${old}\naffected_paths: [backend/**]\nsummary: [旧要点 ${old}]\ndecisions:\n  - question: 用哪种？\n    options: [甲, 乙]\n    recommend: 甲\n`);
    write(dir, `${base}/proposal.md`, '# 提案\n\n- 旧提案 <b>原文</b>\n');
    write(dir, `${base}/design.md`, '# 设计\n\n## 一节\n\n旧设计。\n');
    write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 旧任务\n    acceptance:\n      - id: AC1\n        text: 看过\n        method: manual\n');
    write(dir, `${base}/specs/auth/spec.md`, '## ADDED Requirements\n\n### Requirement: 旧需求\n系统 SHALL 做旧事。\n\n#### Scenario: 场景\n- WHEN 甲\n- THEN 乙\n');
    const at = old === '2026-01-02-older' ? '2026-01-05T00:00:00.000Z' : '2026-03-05T00:00:00.000Z';
    write(dir, `${base}/events.jsonl`, [
      { type: 'approved', at, actor: 'tester', hash: 'sha256:x', base_commit: 'abc', spec_base: {}, decisions: [{ question: '用哪种？', answer: '乙' }] },
      { type: 'archived', at, actor: 'tester' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}

test('AC2 首页显示工作节点、没有状态列；已归档按时间倒序；只读页没有操作；/a/ 的 POST 返回 404', async () => {
  const dir = withArchive();
  const { server, origin, text } = await start(dir);
  try {
    const home = await text('/');
    assert.match(home, /<th>工作节点<\/th>/);
    assert.doesNotMatch(home, /<th>状态<\/th>|<th>轮到你<\/th>/);
    assert.match(home, /class="node" data-human>待你批准/);
    assert.match(home, /已归档（2）[\s\S]*2026-03-04-newer[\s\S]*2026-01-02-older/);
    assert.match(home, new RegExp(`href="/${TOKEN}/a/2026-03-04-newer"`));

    const page = await text('/a/2026-03-04-newer');
    assert.match(page, /旧变更 2026-03-04-newer/);
    assert.match(page, /用哪种？ → \*\*乙\*\*|用哪种？ → <strong>乙<\/strong>/);
    assert.match(page, /旧提案/);
    assert.doesNotMatch(page, /<b>原文<\/b>/); // 被审文件里的原始 HTML 不进页面
    assert.match(page, /旧设计/);
    assert.match(page, /旧需求/);
    assert.match(page, /旧任务/);
    assert.match(page, /事件时间线[\s\S]*approved[\s\S]*archived/);
    assert.match(page, /id="panel-F"[\s\S]*?概要/); // 概要不在 A–E 里，不会被默认收起
    assert.doesNotMatch(page, /data-df=|data-fb=|df-notes:|\/state/);

    assert.equal((await fetch(`${origin}/${TOKEN}/a/no-such`)).status, 404);
    assert.equal((await fetch(`${origin}/${TOKEN}/a/2026-03-04-newer/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${origin}/${TOKEN}/c/2026-03-04-newer/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  } finally { server.close(); }
});

test('AC3 不再定时整页刷新；state 的 v 在追加事件、改被审文件后变化，等待进程起停不改变 v；令牌错误 404', async () => {
  const dir = repo();
  const { server, origin, text, state } = await start(dir);
  try {
    const home = await text('/');
    const page = await text(`/c/${ID}`);
    for (const html of [home, page]) {
      assert.doesNotMatch(html, /http-equiv="refresh"/);
      assert.doesNotMatch(html, /setInterval\([^)]*location\.reload/);
    }
    assert.match(page, /有新进展，点此刷新/);
    assert.match(page, /df-view:/); // 刷新前后保存、恢复视图

    const h0 = await state('/state');
    const c0 = await state(`/c/${ID}/state`);
    assert.match(page, new RegExp(`data-v="${c0.v}"`));
    assert.match(home, new RegExp(`data-v="${h0.v}"`));
    assert.equal(c0.waiting, false);
    assert.deepEqual(await state(`/c/${ID}/state`), c0);

    // 等待标记出现：v 不变，waiting 变真
    write(dir, `.devflow/runtime/waiting/${ID}.json`, JSON.stringify({ pid: process.pid }));
    const c1 = await state(`/c/${ID}/state`);
    assert.equal(c1.v, c0.v);
    assert.equal(c1.waiting, true);

    write(dir, `.devflow/changes/${ID}/proposal.md`, '# 提案\n\n改了一句。\n');
    const c2 = await state(`/c/${ID}/state`);
    assert.notEqual(c2.v, c0.v);
    assert.equal(c2.v, (await state(`/c/${ID}/state`)).v);

    approve(dir, ID, buildDraft(dir, ID).hash);
    assert.notEqual((await state(`/c/${ID}/state`)).v, c2.v);
    assert.notEqual((await state('/state')).v, h0.v);

    assert.equal((await fetch(`${origin}/wrong/state`)).status, 404);
    assert.equal((await fetch(`${origin}/wrong/c/${ID}/state`)).status, 404);
  } finally { server.close(); }
});
