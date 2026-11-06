import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/check.ts';
import { isExcluded, lintWiki } from '../src/wiki.ts';
import { commit, g, makeRepo, write } from './fixture.ts';

const page = (commitHash: string, sources: string, body = '# 认证\n\n见 [[other]]。\n') =>
  `---\nschema_version: 1\ntitle: 认证\nverified_commit: ${commitHash}\nsources:\n${sources}\n---\n${body}`;

function setup() {
  const dir = makeRepo(); // 含 backend/src/Auth.java: "class Auth {}"
  const head = g(dir, 'rev-parse', '--short', 'HEAD').trim();
  write(dir, '.devflow/knowledge/pages/auth.md', page(head, '  - path: backend/src/Auth.java\n    symbol: Auth'));
  write(dir, '.devflow/knowledge/pages/other.md', page(head, '  - path: docs/readme.md', '# 其他\n'));
  write(dir, '.devflow/knowledge/index.md', '# 知识索引\n\n- [认证](pages/auth.md) — 认证\n- [其他](pages/other.md) — 其他\n');
  return { dir, head };
}
const errs = (dir: string) => lintWiki(dir).issues.filter((i) => i.level === 'error').map((i) => i.message);
const warns = (dir: string) => lintWiki(dir).issues.filter((i) => i.level === 'warn').map((i) => i.message);

test('合法页面无问题；init 生成的空索引（含注释示例）也无问题', () => {
  assert.deepEqual(lintWiki(makeRepo()).issues, []);
  const { dir } = setup();
  assert.deepEqual(lintWiki(dir).issues, []);
  assert.deepEqual(lintWiki(dir).pages.map((p) => p.slug), ['auth', 'other']);
});

test('改动被引用文件 → stale（未提交与已提交都算）', () => {
  const { dir } = setup();
  write(dir, 'backend/src/Auth.java', 'class Auth { int x; }\n');
  assert.match(warns(dir).join(), /stale.*backend\/src\/Auth\.java/);
  commit(dir, 'change', true);
  assert.match(warns(dir).join(), /stale/);
  assert.deepEqual(errs(dir), []);
});

test('删除被引用文件、符号消失 → broken', () => {
  const { dir } = setup();
  write(dir, 'backend/src/Auth.java', 'class Login {}\n');
  assert.match(errs(dir).join(), /symbol "Auth".*找不到/);
  g(dir, 'rm', '-qf', 'backend/src/Auth.java');
  assert.match(errs(dir).join(), /文件不存在/);
});

test('符号按 # 拆分逐段匹配；lines 越界报错', () => {
  const { dir, head } = setup();
  write(dir, '.devflow/knowledge/pages/auth.md', page(head, '  - path: backend/src/Auth.java\n    symbol: Auth#login'));
  assert.match(errs(dir).join(), /找不到：login/);
  write(dir, '.devflow/knowledge/pages/auth.md', page(head, '  - path: backend/src/Auth.java\n    symbol: Auth\n    lines: [1, 9]'));
  assert.match(errs(dir).join(), /lines/);
});

test('index.md 漏列、多列；正文死链；排除路径；坏 verified_commit', () => {
  const { dir, head } = setup();
  write(dir, '.devflow/knowledge/index.md', '- [认证](pages/auth.md)\n- [没了](pages/gone.md)\n');
  write(dir, '.env.local', 'SECRET=1\n');
  write(dir, '.devflow/knowledge/pages/other.md', page(head, '  - path: .env.local', '# 其他\n\n[[missing]] 和 [文档](nope.md)\n'));
  const e = errs(dir).join('|');
  assert.match(e, /漏列了页面 pages\/other\.md/);
  assert.match(e, /列了不存在的页面 pages\/gone\.md/);
  assert.match(e, /exclude/);

  write(dir, '.devflow/knowledge/pages/other.md', page(head, '  - path: docs/readme.md', '# 其他\n\n[[missing]] 和 [文档](nope.md)\n'));
  const e2 = errs(dir).join('|');
  assert.match(e2, /\[\[missing\]\]/);
  assert.match(e2, /nope\.md/);

  write(dir, '.devflow/knowledge/pages/other.md', page('deadbeef', '  - path: docs/readme.md', '# 其他\n'));
  assert.match(errs(dir).join(), /不在当前仓库历史中/);
});

test('正文引用了未列入 sources 的文件 → 警告', () => {
  const { dir, head } = setup();
  write(dir, '.devflow/knowledge/pages/other.md', page(head, '  - path: docs/readme.md', '# 其他\n\n见 `docs/readme.md:1` 与 `backend/src/Auth.java:1`，以及 .devflow/knowledge/index.md\n'));
  const w = warns(dir);
  assert.equal(w.length, 1);
  assert.match(w[0], /未列入 sources 的文件：backend\/src\/Auth\.java$/);
});

test('frontmatter 缺失或不完整', () => {
  const { dir } = setup();
  write(dir, '.devflow/knowledge/pages/other.md', '# 没有 frontmatter\n');
  assert.match(errs(dir).join(), /缺少 frontmatter/);
  write(dir, '.devflow/knowledge/pages/other.md', '---\nschema_version: 1\ntitle: x\nverified_commit: HEAD\nsources: []\n---\n');
  const e = errs(dir).join('|');
  assert.match(e, /verified_commit/);
  assert.match(e, /sources 不能为空/);
});

test('check 把知识页问题降为警告，不拦提交', () => {
  const { dir } = setup();
  g(dir, 'rm', '-q', 'backend/src/Auth.java');
  const issues = check(dir, { staged: true });
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
  assert.ok(issues.some((i) => i.level === 'warn' && /文件不存在/.test(i.message)));
});

test('isExcluded：无 / 的模式匹配任意层级文件名', () => {
  assert.ok(isExcluded('.env', ['.env*']));
  assert.ok(isExcluded('backend/.env.prod', ['.env*']));
  assert.ok(isExcluded('a/b/key.pem', ['**/*.pem']));
  assert.ok(isExcluded('web/node_modules/x/y.js', ['**/node_modules/**']));
  assert.ok(!isExcluded('src/env.ts', ['.env*']));
});
