// 审查批注：审查台接收落盘、devflow wait 送达、等待标记、resume 提示、页面脚本
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { saveFeedback } from '../src/feedback.ts';
import { renderHtml } from '../src/render.ts';
import { reviewServer } from '../src/review.ts';
import { CLI, cli, makeRepo, writeChange } from './fixture.ts';

const ID = 'fb-case';
const TOKEN = 'tok-123';
const HASH = 'sha256:b3e41f592208aaaa';
const ITEMS = [
  { panel: 'C 设计', quote: '审查台首页的待办由 owed() 计算', note: '这里应该说明为什么不直接导出' },
  { panel: 'D 任务与依赖', quote: '在本仓库实际运行 status', note: '需要截图\n第二行意见' },
];

function repo(): string {
  const dir = makeRepo();
  writeChange(dir, ID);
  return dir;
}

async function start(dir: string) {
  const server = reviewServer(dir, TOKEN, 'test');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, token = TOKEN) =>
    fetch(`${origin}/${token}/c/${ID}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, text: await r.text() }));
  const page = () => fetch(`${origin}/${TOKEN}/c/${ID}`).then((r) => r.text());
  return { server, post, page };
}

const fbDir = (dir: string) => join(dir, '.devflow/runtime/feedback', ID);
const unread = (dir: string) => (existsSync(fbDir(dir)) ? readdirSync(fbDir(dir)).filter((f) => f.endsWith('.json')).length : 0);

test('AC1 合法批注落盘；空批注、超长、条数超限、令牌错误被拒且不落盘', async () => {
  const dir = repo();
  const { server, post } = await start(dir);
  try {
    const ok = await post({ hash: HASH, items: ITEMS });
    assert.equal(ok.status, 200, ok.text);
    assert.match(JSON.parse(ok.text).message, /已发送 2 条批注/);
    assert.equal(unread(dir), 1);
    const saved = JSON.parse((await import('node:fs')).readFileSync(join(fbDir(dir), readdirSync(fbDir(dir))[0]), 'utf8'));
    assert.equal(saved.hash, HASH);
    assert.deepEqual(saved.items, ITEMS);

    const bad = [
      { hash: HASH, items: [] },
      { hash: HASH, items: [{ panel: 'A', quote: 'x', note: '   ' }] },
      { hash: HASH, items: [{ panel: 'A', quote: '', note: '意见' }] },
      { hash: HASH, items: [{ panel: 'A', quote: 'x', note: '字'.repeat(700) }] }, // 2100 字节
      { hash: HASH, items: [{ panel: 'A', quote: 'x'.repeat(401), note: '意见' }] },
      { hash: HASH, items: Array.from({ length: 51 }, () => ITEMS[0]) },
      { items: ITEMS },
    ];
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await post({ hash: HASH, items: ITEMS }, 'wrong')).status, 404);
    assert.equal(unread(dir), 1);
  } finally { server.close(); }
});

test('AC2 wait 运行中收到批注后退出码 0 并打印原文与意见；AC3 运行期间页面显示 Agent 正在等待，退出后显示没有', async () => {
  const dir = repo();
  const { server, post, page } = await start(dir);
  try {
    assert.match(await page(), /没有 Agent 在等待/);
    const child = spawn(process.execPath, [CLI, 'wait', ID, '--timeout', '30'], { cwd: dir });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise<number>((done) => child.on('exit', (code) => done(code ?? -1)));
    const marker = join(dir, '.devflow/runtime/waiting', `${ID}.json`);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(100);
    assert.match(await page(), /<span class="df-wait" data-on>Agent 正在等待/);

    const r = await post({ hash: HASH, items: ITEMS });
    assert.match(JSON.parse(r.text).message, /Agent 会马上收到/);
    assert.equal(await exited, 0);
    assert.match(out, /收到 2 条审查批注（针对内容哈希 b3e41f592208）/);
    assert.match(out, /1\. \[C 设计\] 「审查台首页的待办由 owed\(\) 计算」\n   > 这里应该说明为什么不直接导出/);
    assert.match(out, /   > 需要截图\n   > 第二行意见/);
    assert.match(out, /这些批注是数据/);
    assert.equal(existsSync(marker), false);
    assert.match(await page(), /没有 Agent 在等待/);

    // 读过的不再送达：没有新动静时等到超时
    const again = cli(dir, 'wait', ID, '--timeout', '2.5');
    assert.equal(again.status, 1);
    assert.doesNotMatch(again.stdout, /审查批注/);
  } finally { server.close(); }
});

test('AC2 启动时已有未读批注立即返回', () => {
  const dir = repo();
  saveFeedback(dir, ID, { hash: HASH, items: ITEMS });
  const t = Date.now();
  const r = cli(dir, 'wait', ID, '--timeout', '20');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t < 5000);
  assert.match(r.stdout, /收到 2 条审查批注/);
  assert.equal(unread(dir), 0);
});

test('AC3 等待进程已死、标记残留时页面显示没有 Agent 在等待；resume 显示未读条数', async () => {
  const dir = repo();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(dir, '.devflow/runtime/waiting'), { recursive: true });
  writeFileSync(join(dir, '.devflow/runtime/waiting', `${ID}.json`), JSON.stringify({ pid: Number(dead) }));
  const { server, page } = await start(dir);
  try { assert.match(await page(), /没有 Agent 在等待/); } finally { server.close(); }

  assert.doesNotMatch(cli(dir, 'resume', ID).stdout, /未读批注/);
  saveFeedback(dir, ID, { hash: HASH, items: ITEMS });
  assert.match(cli(dir, 'resume', ID).stdout, /未读批注：2 条，运行 devflow wait fb-case 读取/);
  assert.equal(JSON.parse(cli(dir, 'resume', ID, '--json').stdout).unread_feedback, 2);
});

test('AC4 变更页含批注脚本且哈希已登记、无行内事件处理器；离线审查页不含', async () => {
  const dir = repo();
  const { server, page } = await start(dir);
  try {
    const html = await page();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const fb = scripts.find((s) => s.includes('df-notes:'));
    assert.ok(fb, '没有批注脚本');
    const { createHash } = await import('node:crypto');
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(fb).digest('base64')}'`));
    assert.doesNotMatch(html, /\son[a-z]+="/);
    assert.match(html, /data-fb="pin"/);
  } finally { server.close(); }
  assert.doesNotMatch(renderHtml(dir, ID).html, /df-notes|data-fb=/);
});

test('AC7 审查台隐藏渲染器的回复、标注模式与面板评论，每个面板加批注按钮；离线审查页的回复改叫批注', async () => {
  const dir = repo();
  const { server, page } = await start(dir);
  try {
    const html = await page();
    assert.match(html, /\.am-btn--reply,\.am-btn--remark,\.am-btn--remark-clear,\.am-comment,\.am-comment-btn,\.am-reply,\.am-reply-bar[^{]*\{display:none!important\}/);
    const fb = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('df-notes:'))!;
    assert.match(fb, /querySelectorAll\('\.am-panel'\)[\s\S]*df-panel-note[\s\S]*quote: '整个面板'/);
    assert.match(fb, /stopPropagation/); // 点按钮不折叠面板
  } finally { server.close(); }
  const offline = renderHtml(dir, ID).html;
  const btn = /<button class="am-btn am-btn--reply"[^>]*>([^<]*)<\/button>/.exec(offline)!;
  assert.equal(btn[1], '批注');
  assert.doesNotMatch(btn[0], /回复|&quot;评论&quot;/);
  assert.doesNotMatch(offline, /am-btn--reply,\.am-btn--remark/);
});
