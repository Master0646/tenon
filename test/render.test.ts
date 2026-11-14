import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildDraft, render, toPanelBody, type Problem } from '../src/render.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { append, cli, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';

test('toPanelBody：标题降级、去掉首个一级标题、转义 HTML、保留行内代码与代码块', () => {
  const p: Problem[] = [];
  const out = toPanelBody('# 提案\n\n## 为什么\n<script>x</script> 与 `<b>`\n```java\nif (a < b) {}\n```\n### 细节\n# 第二个一级标题', 'f', p);
  assert.deepEqual(p, []);
  // 面板标题是 h2：## 降成 h3、### 降成 h4，不跳级
  assert.match(out, /^### 为什么$/m);
  assert.match(out, /^#### 细节$/m);
  assert.doesNotMatch(out, /^# 提案/m);
  assert.match(out, /&lt;script&gt;x&lt;\/script&gt; 与 `<b>`/);
  assert.match(out, /if \(a < b\) \{\}/); // 代码块内不转义
  assert.match(out, /^### 第二个一级标题$/m);
});

test('toPanelBody：拦截 html/svg 块、带属性的代码块、::: 块、图片、未闭合代码块', () => {
  const msgs = (t: string) => { const p: Problem[] = []; toPanelBody(t, 'f', p); return p.map((x) => `${x.line}:${x.message}`).join('|'); };
  assert.match(msgs('a\n```html\n<b>\n```'), /^2:.*html/);
  assert.match(msgs('```svg\n<svg/>\n```'), /svg/);
  assert.match(msgs('```ts src=.env\n```'), /不能带属性/);
  assert.match(msgs(':::flow\nA -> B\n:::'), /:::/);
  assert.match(msgs('![x](/etc/passwd)'), /图片/);
  assert.match(msgs('```java\nint a;'), /没有闭合/);
  assert.equal(msgs('```flow LR\nA -> B\n```\n```sequence num\nA -> B: x\n```\n```java\nx\n```'), '');
});

test('buildDraft：任务依赖图、规范分色、被审文件清单', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const { draft, hash, problems } = buildDraft(dir, ID);
  assert.deepEqual(problems, []);
  assert.match(draft, /\(开始\) -> \[T1 定义角色\]/);
  assert.match(draft, /\[T1 定义角色\] -> \[T2 接口加判断\]/);
  assert.match(draft, /````callout ok 新增需求（1）/);
  assert.match(draft, /能力 auth（新能力）/);
  assert.ok(draft.includes(hash));
  assert.match(draft, /\.tenon\/project\.yaml/);
});

test('M2 交付：审查页哈希 = 批准哈希；修改后页面哈希变化、状态回到 draft、重新批准恢复', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  const r1 = render(dir, ID);
  const html1 = readFileSync(r1.file, 'utf8');
  assert.ok(html1.includes(r1.hash));
  assert.doesNotMatch(html1, /https?:\/\/(?!www\.w3\.org|github\.com\/QingYunA)/); // 不引用外部资源

  assert.equal(approve(dir, ID).hash, r1.hash);
  assert.equal(deriveStatus(dir, ID).status, 'approved');

  append(dir, `.tenon/changes/${ID}/proposal.md`, '审查意见：补充影响范围。\n');
  assert.equal(deriveStatus(dir, ID).status, 'draft');
  const r2 = render(dir, ID);
  assert.notEqual(r2.hash, r1.hash);
  assert.ok(readFileSync(r2.file, 'utf8').includes('审查意见：补充影响范围。'));
  assert.equal(approve(dir, ID).hash, r2.hash);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
});

test('render 拒绝校验不通过或含不安全写法的变更；CLI 输出', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `.tenon/changes/${ID}/design.md`, '# 设计\n\n```html\n<iframe src=x>\n```\n');
  assert.throws(() => render(dir, ID), (e: any) => /不允许的写法/.test(e.message) && /design\.md:3/.test(e.hint));
  write(dir, `.tenon/changes/${ID}/design.md`, '# 设计\n');
  write(dir, `.tenon/changes/${ID}/tasks.yaml`, 'schema_version: 1\ntasks: []\n');
  assert.throws(() => render(dir, ID), /校验有/);

  writeChange(dir, ID);
  const r = cli(dir, 'render', ID, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).file, /\.tenon\/runtime\/rendered\/role-access\.html$/);
});
