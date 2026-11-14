// 审查台变更页布局：首屏进展与待办、顶部操作栏与左侧目录、批注记录
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { saveFeedback, takeFeedback } from '../src/feedback.ts';
import { applyStart } from '../src/exec.ts';
import { buildDraft, progressRow, renderHtml } from '../src/render.ts';
import { reviewServer } from '../src/review.ts';
import { approve } from '../src/status.ts';
import { commit, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'layout-case';
const TOKEN = 'tok-layout';

function repo(): string {
  const dir = makeRepo();
  writeChange(dir, ID);
  const base = `.devflow/changes/${ID}`;
  write(dir, '.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: echo ok\nexclude: []\nenforce: warn\n');
  write(dir, `${base}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: 布局\naffected_paths: [backend/**]\nsummary: [要点甲, 要点乙]\ndecisions:\n  - question: 返回什么？\n    options: [返回 403, 返回空列表]\n    recommend: 返回 403\n  - question: 记日志吗？\n    options: [记, 不记]\n    recommend: 记\n');
  write(dir, `${base}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: 甲\n    acceptance:\n      - id: AC1\n        text: 看过甲\n        method: manual\n');
  commit(dir, 'change', true);
  return dir;
}

/** 草稿按「## 」切成面板 */
const panels = (draft: string) => draft.split(/\n(?=## )/).slice(1);

async function page(dir: string): Promise<string> {
  const server = reviewServer(dir, TOKEN, 'test');
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${TOKEN}/c/${ID}`)).text();
  } finally { server.close(); }
}

test('AC1 首屏是进展与待办：5 段进度条、工作节点、要你做什么、待拍板事项；方案要点在下一个面板；离线页同样', () => {
  const dir = repo();
  const [first, second] = panels(buildDraft(dir, ID).draft);
  assert.match(first, /^## 进展与待办\n/);
  assert.match(first, /\| ✓ 方案 \| \*\*批准\*\* \| 实现 \| 验证与证据 \| 归档 \|/);
  assert.match(first, /\*\*待你批准\*\*/);
  assert.match(first, /\*\*要你做什么\*\*：选好 2 个待拍板事项后点批准/);
  assert.match(first, /### 待你拍板（2 项）[\s\S]*```+ask\n返回什么？[\s\S]*记日志吗？/);
  assert.doesNotMatch(first, /方案要点|影响范围/);
  assert.match(second, /^## 方案要点与影响范围\n### 方案要点\n\n- 要点甲\n- 要点乙\n\n### 影响范围\n\n- `backend\/\*\*`/);

  approve(dir, ID);
  applyStart(dir, ID);
  const [now] = panels(buildDraft(dir, ID).draft);
  assert.match(now, /\| ✓ 方案 \| ✓ 批准 \| \*\*实现\*\* \| 验证与证据 \| 归档 \|\n\| --- \| --- \| --- \| --- \| --- \|\n\|   \|   \| \*\*实现中（任务 0\/1）\*\* \|/);
  assert.match(now, /现在不需要你操作：Agent 当前在「实现中（任务 0\/1）」/);
  assert.match(now, /### 已拍板（2 项）/);
  // 离线页用同一份草稿：首屏结构一样
  assert.match(renderHtml(dir, ID).html, /进展与待办[\s\S]*方案要点与影响范围/);

  for (const [label, stage] of [['写方案中', '方案'], ['补证据中', '验证与证据'], ['待你确认 2 条', '验证与证据'], ['归档准备中', '归档'], ['待你归档', '归档']]) {
    assert.match(progressRow(label), new RegExp(`\\*\\*${stage}\\*\\*`), label);
  }
});

test('AC2 审查台操作栏固定在顶部、有左侧目录且脚本哈希已登记、没有行内事件处理器、渲染器大纲隐藏；离线页没有目录', async () => {
  const dir = repo();
  const html = await page(dir);
  assert.match(html, /\.df-bar\{position:fixed;left:0;right:0;top:0;/);
  assert.doesNotMatch(html, /\.df-bar\{[^}]*bottom:0/);
  assert.match(html, /<nav class="df-toc" aria-label="目录"><\/nav>/);
  assert.match(html, /\.am-toc\{display:none!important\}/);
  assert.match(html, /@media \(max-width:1023px\)\{\.df-toc\{display:none\}\}/); // 窄屏隐藏目录（拍板结果）
  const toc = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('.df-toc'));
  assert.ok(toc, '没有目录脚本');
  assert.match(toc, /df-closed[\s\S]*\.am-panel-head'\)\.click\(\)[\s\S]*scrollIntoView/); // 折叠的面板先展开再跳
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(toc).digest('base64')}'`));
  assert.doesNotMatch(html, /\son[a-z]+="/);
  const offline = renderHtml(dir, ID).html;
  assert.doesNotMatch(offline, /df-toc|df-bar/);
});

test('AC3 批注记录：已读与未读分开标注；HTML 与 Markdown 原样显示为文字；没有批注时没有面板；离线页没有', async () => {
  const dir = repo();
  assert.doesNotMatch(await page(dir), /批注记录/);

  saveFeedback(dir, ID, { hash: 'sha256:aa', items: [{ panel: 'C 设计', quote: '第一句', note: '第一次的意见' }] });
  takeFeedback(dir, ID); // Agent 读了第一次
  await new Promise((r) => setTimeout(r, 5));
  saveFeedback(dir, ID, { hash: 'sha256:aa', items: [
    { panel: 'A 提案', quote: '第二句', note: '<script>alert(1)</script> 和 [链接](javascript:alert(1)) 以及 `代码` | 竖线' },
  ] });

  const html = await page(dir);
  assert.match(html, /批注记录（2 条）/);
  assert.match(html, /第一次的意见[\s\S]*?Agent 已读[\s\S]*?&lt;script&gt;alert\(1\)&lt;\/script&gt;[\s\S]*?未读/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /\[链接\]\(javascript:alert\(1\)\)/); // 原样显示，不变成链接
  assert.match(html, /`代码` \| 竖线/);
  assert.doesNotMatch(renderHtml(dir, ID).html, /批注记录/);
});
