import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviewedFiles } from '../src/core.ts';
import { renderRequirement } from '../src/requirement.ts';
import { approve, deriveStatus } from '../src/status.ts';
import { validateChange } from '../src/validate.ts';
import { append, cli, makeRepo, write, writeChange } from './fixture.ts';

const ID = 'role-access';
const REQ = '.tenon/requirements/4.4.1.2-access-channel';
const MD = `# 4.4.1.2 接入通道配置

- 来源：详细设计说明书 V1.0，4.4.1.2，接受修订后的版本

## 功能描述

配置五种通道类型。见原文图 8：接入通道列表。

## 业务规则

| 规则 | 取值 |
| --- | --- |
| 心跳超时 | 5 分钟 |

### 约束

**示意**：

\`\`\`yaml
host: 10.0.0.1
\`\`\`
`;

const errors = (dir: string) => validateChange(dir, ID, true).filter((i) => i.level === 'error').map((i) => i.message).join('|');
const linkRequirement = (dir: string, value: string) => append(dir, `.tenon/changes/${ID}/change.yaml`, `requirement: ${value}\n`);

test('AC1 requirement 指向 requirements/ 下已存在的 md：validate 通过，计入被审文件', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `${REQ}/requirement.md`, MD);
  linkRequirement(dir, `${REQ}/requirement.md`);
  assert.equal(errors(dir), '');
  assert.ok(reviewedFiles(dir, ID).includes(`${REQ}/requirement.md`));
});

test('AC2 requirement 路径非法时 validate 报错', () => {
  for (const [value, want] of [
    [`${REQ}/missing.md`, /不存在/],
    ['docs/readme.md', /路径无效/],
    [`${REQ}/requirement.txt`, /路径无效/],
    [`${REQ}/../x/requirement.md`, /路径无效/],
    ['{ a: 1 }', /字符串或字符串数组/],
  ] as const) {
    const dir = makeRepo();
    writeChange(dir, ID);
    write(dir, `${REQ}/requirement.md`, MD);
    write(dir, `${REQ}/requirement.txt`, MD);
    linkRequirement(dir, value);
    assert.match(errors(dir), want, value);
  }
});

test('AC3 批准后修改关联的需求 md，状态回到 draft', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  write(dir, `${REQ}/requirement.md`, MD);
  linkRequirement(dir, `[${REQ}/requirement.md]`);
  approve(dir, ID);
  assert.equal(deriveStatus(dir, ID).status, 'approved');
  append(dir, `${REQ}/requirement.md`, '\n补充一条规则。\n');
  assert.equal(deriveStatus(dir, ID).status, 'draft');
});

test('AC4 不写 requirement：校验与被审文件和原来一致', () => {
  const dir = makeRepo();
  writeChange(dir, ID);
  assert.equal(errors(dir), '');
  assert.deepEqual(reviewedFiles(dir, ID).filter((f) => f.includes('requirements')), []);
});

test('AC5 req render：每个 ## 小节一个面板，追加修订记录，默认写到 runtime/rendered/requirements/', () => {
  const dir = makeRepo();
  write(dir, `${REQ}/requirement.md`, MD);
  write(dir, `${REQ}/revisions.md`, '# 修订记录\n\n## 4.4.1.2\n\n- 删除：分类分级标签与\n');
  const r = cli(dir, 'req', 'render', REQ, '--json');
  assert.equal(r.status, 0, r.stderr);
  const file = JSON.parse(r.stdout).file;
  assert.equal(file, join(dir, '.tenon/runtime/rendered/requirements/4.4.1.2-access-channel.html'));
  const html = readFileSync(file, 'utf8');
  for (const s of ['功能描述', '业务规则', '修订记录', '删除：分类分级标签与', '心跳超时', '4.4.1.2 接入通道配置']) assert.ok(html.includes(s), s);
  assert.match(html, /<html[^>]*data-theme="stripe"/); // 默认就是仿 Stripe 主题
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org|github\.com\/QingYunA)/); // 不引用外部资源
  // 参数也可以是 requirement.md 本身；-o 指定输出
  assert.equal(renderRequirement(dir, join(dir, REQ, 'requirement.md'), join(dir, 'out.html')).file, join(dir, 'out.html'));
  assert.ok(existsSync(join(dir, 'out.html')));
});

test('AC6 需求 md 含 html 块、图片或 ::: 块：不出页面，报错带文件与行号', () => {
  for (const [bad, line] of [['```html\n<b>\n```', 3], ['![图](/a.png)', 3], [':::flow\nA -> B\n:::', 3]] as const) {
    const dir = makeRepo();
    write(dir, `${REQ}/requirement.md`, `# 标题\n\n${bad}\n`);
    assert.throws(() => renderRequirement(dir, join(dir, REQ)), (e: any) => /不允许的写法/.test(e.message) && e.hint.includes(`${REQ}/requirement.md:${line}`));
    assert.ok(!existsSync(join(dir, '.tenon/runtime/rendered/requirements/4.4.1.2-access-channel.html')));
  }
});

test('AC7 参数不在 requirements/ 下、目录里没有 requirement.md、子命令不对：报错并给出用法', () => {
  const dir = makeRepo();
  write(dir, 'docs/x/requirement.md', MD);
  write(dir, '.tenon/requirements/empty/.keep', '');
  for (const args of [['req', 'render', 'docs/x'], ['req', 'render', '.tenon/requirements/empty'], ['req', 'render'], ['req', 'show', REQ]]) {
    const r = cli(dir, ...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /用法：tenon req render/, args.join(' '));
  }
});
