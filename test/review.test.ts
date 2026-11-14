// 本地审查台：令牌与 Host 校验、批准（绑定页面哈希、记录拍板结论）、批量确认人工证据、归档
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEvents } from '../src/core.ts';
import { recordEvidence } from '../src/evidence.ts';
import { applyStart, taskDone, verify } from '../src/exec.ts';
import { buildDraft } from '../src/render.ts';
import { reviewServer } from '../src/review.ts';
import { decisionAnswers, deriveStatus } from '../src/status.ts';
import { append, commit, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const TOKEN = 'secret-token';

function v2Repo(): string {
  const dir = makeRepo();
  writeChange(dir, ID);
  const base = `.devflow/changes/${ID}`;
  write(dir, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: echo ok\nexclude: []\nenforce: warn\n');
  write(dir, `${base}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 新格式\naffected_paths: [backend/**]\nsummary: [要点]\ndecisions:\n  - question: 返回什么？\n    options: [返回 403, 返回空列表]\n    recommend: 返回 403\n');
  write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 人工验收\n    acceptance:\n      - id: AC1\n        text: 已检查管理员页面\n        method: manual\n      - id: AC2\n        text: 已检查普通用户页面\n        method: manual\n');
  commit(dir, 'change', true);
  return dir;
}

async function start(dir: string) {
  const server = reviewServer(dir, TOKEN, 'test');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(`${origin}/${TOKEN}/c/${ID}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
  return { server, origin, post };
}

test('审查台：令牌或 Host 不对一律 404；首页列出轮到人的变更；页面带批准按钮和已登记哈希的脚本', async () => {
  const dir = v2Repo();
  const { server, origin } = await start(dir);
  try {
    assert.equal((await fetch(`${origin}/wrong/`)).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    // fetch 不允许改 Host，用 node:http 发一个 Host 被换掉的请求（DNS 重绑定的形态）
    const rebound = await new Promise<number>((done) => get({ host: '127.0.0.1', port: new URL(origin).port, path: `/${TOKEN}/`, headers: { host: 'evil.example' } }, (r) => { r.resume(); done(r.statusCode!); }));
    assert.equal(rebound, 404);
    const home = await (await fetch(`${origin}/${TOKEN}/`)).text();
    assert.match(home, /role-access[\s\S]*待你批准/);
    const page = await (await fetch(`${origin}/${TOKEN}/c/${ID}`)).text();
    assert.match(page, /data-df="approve" data-hash="sha256:[0-9a-f]{64}"/);
    // 注入了四段脚本（折叠、目录、操作栏、批注），内容安全策略里相应多出四个哈希
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(page)![1];
    assert.equal(csp.match(/'sha256-/g)!.length, 6);
    assert.doesNotMatch(page, /\son[a-z]+="/); // 没有行内事件处理器：会被策略拦掉
    assert.equal((await fetch(`${origin}/${TOKEN}/c/no-such-change`)).status, 400);
  } finally { server.close(); }
});

test('审查台批准：页面哈希过期被拒；未选项按序号校验；批准后记录拍板结论', async () => {
  const dir = v2Repo();
  const { server, post } = await start(dir);
  try {
    const stale = buildDraft(dir, ID).hash;
    append(dir, `.devflow/changes/${ID}/proposal.md`, '打开页面后又改了。\n');
    const rejected = await post('approve', { hash: stale, answers: [0] });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.error, /页面已过期/);
    assert.equal(deriveStatus(dir, ID).status, 'draft');

    const hash = buildDraft(dir, ID).hash;
    assert.match((await post('approve', { hash, answers: [-1] })).json.error, /还没有选择：返回什么？/);
    assert.match((await post('approve', { hash, answers: [] })).json.error, /与页面不一致/);
    assert.equal((await post('approve', { hash, answers: [1] }, { 'content-type': 'text/plain' })).status, 400);
    assert.equal(readEvents(dir, ID).length, 0);

    const ok = await post('approve', { hash, answers: [1] });
    assert.deepEqual(ok.json, { ok: true, message: '已批准' });
    assert.equal(deriveStatus(dir, ID).status, 'approved');
    assert.deepEqual(decisionAnswers(dir, ID), [{ question: '返回什么？', answer: '返回空列表', by: 'human' }]);
    assert.match(buildDraft(dir, ID).draft, /### 已拍板（1 项）\n\n- 返回什么？ → \*\*返回空列表\*\*/);
    assert.match((await post('approve', { hash, answers: [1] })).json.error, /不需要批准/);
  } finally { server.close(); }
});

test('审查台：批量确认人工证据后任务可完成，再一键归档', async () => {
  const dir = v2Repo();
  const { server, origin, post } = await start(dir);
  try {
    await post('approve', { hash: buildDraft(dir, ID).hash, answers: [0] });
    assert.deepEqual(decisionAnswers(dir, ID), [{ question: '返回什么？', answer: '返回 403', by: 'human' }]);
    applyStart(dir, ID);
    assert.equal(verify(dir, ID).result, 'pass');
    const manual = (acceptance: string) => recordEvidence(dir, ID, { task: 'T1', acceptance, kind: 'manual', summary: '看过页面', procedure: '登录后查看', expected: '按钮隐藏', observed: '按钮隐藏' }).evidence_id;
    const ids = [manual('AC1'), manual('AC2')];
    const page = await (await fetch(`${origin}/${TOKEN}/c/${ID}`)).text();
    assert.match(page, /确认人工证据（2 条）/);
    assert.match((await post('confirm', { evidence_ids: [] })).json.error, /没有勾选/);
    assert.match((await post('archive', {})).json.error, /不能归档/);

    assert.equal((await post('confirm', { evidence_ids: ids })).json.message, '已确认 2 条人工证据');
    // 确认之后、任务标记完成之前轮到 Agent：页面要说清楚，而且没有按钮
    const waiting = await (await fetch(`${origin}/${TOKEN}/c/${ID}`)).text();
    assert.match(waiting, /现在不需要你操作，等 Agent 继续/);
    assert.doesNotMatch(waiting, /<button type="button" data-df="(approve|open|archive)"/);
    taskDone(dir, ID, 'T1');
    assert.equal(deriveStatus(dir, ID).status, 'ready_to_archive');
    const ready = await (await fetch(`${origin}/${TOKEN}/c/${ID}`)).text();
    assert.match(ready, /data-df="archive"/);
    assert.doesNotMatch(ready, /confirm\('/); // 不依赖浏览器原生确认框
    assert.match((await post('archive', {})).json.message, /已归档到 \.devflow\/changes\/archive\//);
    assert.ok(!existsSync(join(dir, `.devflow/changes/${ID}`)));
  } finally { server.close(); }
});

test('devflow wait：没有人工操作时超时退出码 1；批准后退出码 0 并给出下一步', async () => {
  const { spawn } = await import('node:child_process');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const { approve } = await import('../src/status.ts');
  const { CLI, cli } = await import('./fixture.ts');
  const dir = v2Repo();
  const timedOut = cli(dir, 'wait', ID, '--timeout', '1');
  assert.equal(timedOut.status, 1);
  assert.match(timedOut.stdout, /等待超时/);

  const child = spawn(process.execPath, [CLI, 'wait', ID, '--timeout', '60'], { cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await sleep(1500);
  approve(dir, ID);
  assert.equal(await new Promise((done) => child.on('exit', done)), 0);
  assert.match(out, /approved[\s\S]*devflow resume/);
});
