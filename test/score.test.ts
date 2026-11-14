import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractCitations, loadQuestions, scoreAnswer, summarize } from '../eval/score.ts';
import { listFiles } from '../src/core.ts';

const FILES = [
  'backend/src/main/java/com/example/admin/user/UserController.java',
  'backend/src/main/java/com/example/admin/user/UserService.java',
  'backend/src/main/resources/application.yml',
  'frontend/src/api/user.js',
  'frontend/src/views/UserList.vue',
  'frontend/package.json',
  'backend/pom.xml',
];

test('extractCitations：完整路径、带行号、只写文件名、忽略 Tenon 自身文件、记录找不到的', () => {
  const r = extractCitations(
    '见 backend/src/main/java/com/example/admin/user/UserController.java:25，以及 `UserService.java#list`、' +
    './frontend/src/api/user.js，参考 .tenon/knowledge/pages/user.md 和 CLAUDE.md；另见 RedisConfig.java。' +
    "路由里写的是 import('../views/UserList.vue')。",
    FILES,
  );
  assert.deepEqual(r.cited, [FILES[0], FILES[1], FILES[3], FILES[4]].sort());
  assert.deepEqual(r.unresolved, ['RedisConfig.java']);
});

test('extractCitations：不把 URL 片段、版本号、类名当成文件', () => {
  const r = extractCitations('接口 GET /api/users，版本 3.3.4，类 UserController#list，域名 mybatis.org', FILES);
  assert.deepEqual(r, { cited: [], unresolved: [] });
});

test('scoreAnswer：召回按 must 组计算，准确率扣无关引用', () => {
  const q = {
    id: 'q', q: '?',
    must: [[FILES[0]], [FILES[1], FILES[3]]],
    ok: [FILES[4]],
  };
  const full = scoreAnswer(q, 'UserController.java 与 user.js', FILES);
  assert.equal(full.recall, 1);
  assert.equal(full.precision, 1);
  const partial = scoreAnswer(q, 'UserController.java，另外 pom.xml', FILES);
  assert.equal(partial.recall, 0.5);
  assert.equal(partial.precision, 0.5);
  const none = scoreAnswer(q, '在用户控制器里', FILES);
  assert.equal(none.noCitation, true);
  assert.equal(none.precision, 0);
});

test('scoreAnswer：不可回答题看是否说了未知', () => {
  const q = { id: 'u', q: '?', unanswerable: true };
  assert.equal(scoreAnswer(q, '未知：代码中未找到消息队列相关依赖', FILES).correct, true);
  assert.equal(scoreAnswer(q, '项目没有使用 Redis，token 存在内存中', FILES).correct, true);
  assert.equal(scoreAnswer(q, '使用 RabbitMQ，配置在 application.yml', FILES).correct, false);
});

test('结论正则：正确答案匹配、常见错误答案不匹配', () => {
  const qs = loadQuestions(readFileSync(new URL('../eval/questions.yaml', import.meta.url), 'utf8'));
  const ok = (id: string, answer: string) => scoreAnswer(qs.find((q) => q.id === id)!, answer, FILES).conclusion;
  assert.equal(ok('q21', '仍然可以访问，直到 2 小时过期，因为 verify 只检查过期时间'), true);
  assert.equal(ok('q21', '不能继续访问，拦截器会检查用户状态'), false);
  assert.equal(ok('q22', '需要重新登录：token 存在内存的 ConcurrentHashMap 中，重启后全部失效'), true);
  assert.equal(ok('q22', '不需要，token 是 JWT，无状态'), false);
  assert.equal(ok('q23', '能。disable 没有校验操作者的角色，只限制不能禁用自己和 ADMIN'), true);
  assert.equal(ok('q23', '不能，只有 ADMIN 才能调用'), false);
  assert.equal(ok('q24', '最多 100 条（MAX_PAGE_SIZE）'), true);
  assert.equal(ok('q24', '返回 500 条'), false);
  assert.equal(ok('q26', '不一致：前端对当前登录用户自己那一行仍显示按钮，后端会拒绝'), true);
  assert.equal(ok('q26', '完全一致'), false);
  assert.equal(ok('q27', '显示"用户名或密码错误"'), true);
});

test('summarize 与题库：前缀展开后，题库中的文件都真实存在于演示项目', () => {
  const s = summarize([
    { id: 'a', cited: [], unresolved: ['x.java'], recall: 1, precision: 0.5, noCitation: false, saidUnknown: false },
    { id: 'b', cited: [], unresolved: [], recall: 0, precision: 0, noCitation: true, saidUnknown: true },
    { id: 'u', cited: [], unresolved: [], saidUnknown: true, correct: true },
  ]);
  assert.deepEqual(s, { answerable: 2, unanswerable: 1, recall: 0.5, precision: 0.25, noCitationRate: 0.5, unknownCorrectRate: 1, unresolvedCitations: 1, reasoning: 0, conclusionRate: 0 });

  const qs = loadQuestions(readFileSync(new URL('../eval/questions.yaml', import.meta.url), 'utf8'));
  const files = new Set(listFiles(new URL('../examples/user-admin', import.meta.url).pathname));
  assert.equal(qs.length, 27);
  for (const q of qs) for (const f of [...(q.must ?? []).flat(), ...(q.ok ?? [])]) assert.ok(files.has(f), `${q.id}: ${f}`);
});
