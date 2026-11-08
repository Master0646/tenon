import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScorer, loadComparisonProtocol, prepareDesktop, recordDesktop, runComparison, summarizeDesktop, schedule, TASKS, type Agent, type AgentResult, type SampleRecord } from '../eval/agent-workflow.ts';

const ok = (result: string, cost = 0.1): AgentResult => ({ exit: 'ok', subtype: 'success', result, cost, turns: 3, denials: 0, raw: JSON.stringify({ result }) });
const read = (dir: string) => readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SampleRecord);

test('schedule：每任务每版本五次、共 30 次，逐轮交替先后', () => {
  const plan = schedule(TASKS, 5);
  assert.equal(plan.length, 30);
  for (const t of TASKS) for (const v of ['baseline', 'candidate']) assert.equal(plan.filter((s) => s.task === t && s.variant === v).length, 5);
  assert.deepEqual(plan.filter((s) => s.task === 'wrong-config').slice(0, 4).map((s) => s.variant), ['baseline', 'candidate', 'candidate', 'baseline']);
});

test('protocol：冻结字段完整，提交为完整哈希', () => {
  const p = loadComparisonProtocol();
  assert.match(p.baseline.commit, /^[0-9a-f]{40}$/);
  assert.match(p.candidate.commit, /^[0-9a-f]{40}$/);
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal(p.budget.retries, 0);
});

test('scorer：超时、截断为 unknown；固定判据区分通过与失败', () => {
  assert.equal(defaultScorer('wrong-config', '', { ...ok(''), exit: 'timeout' }, 'x').outcome, 'unknown');
  assert.equal(defaultScorer('wrong-config', '', { ...ok('8081'), subtype: 'error_max_budget_usd' }, 'x').outcome, 'unknown');
  assert.equal(defaultScorer('wrong-config', '', ok('端口应为 8081，见 backend/src/main/resources/application.yml:2'), 'x').outcome, 'pass');
  assert.equal(defaultScorer('wrong-config', '', ok('方案没有问题'), 'x').outcome, 'fail');
  assert.equal(defaultScorer('new-session-resume', '', ok('T2 未完成：ADMIN 禁用后状态为 DISABLED。下一步实现后运行 devflow task done c1 T2'), 'c1').outcome, 'pass');
  assert.equal(defaultScorer('new-session-resume', '', ok('T2 还没做'), 'c1').outcome, 'fail');
});

test('runner：全新项目、无重试、raw 关联哈希、超时计 unknown、中断即停，且不代人批准', () => {
  const out = mkdtempSync(join(tmpdir(), 'devflow-cmp-test-'));
  const cwds: string[] = [];
  let calls = 0;
  const agent: Agent = (c) => {
    calls++;
    assert.ok(!cwds.includes(c.cwd)); cwds.push(c.cwd);
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.ok(!c.tools.includes('Edit'), '只读任务不给写工具');
    const events = join(c.cwd, '.devflow/changes/2026-11-08-admin-only-disable-api/events.jsonl');
    if (c.prompt.includes('新会话')) {
      const evs = readFileSync(events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(evs.filter((e) => e.type === 'approved').length, 1, '夹具在会话前批准一次');
    } else assert.equal(existsSync(join(c.cwd, '.devflow/changes/2026-11-06-admin-only-disable/events.jsonl')), false, '待审方案保持未批准');
    if (calls === 2) return { ...ok(''), exit: 'timeout', cost: null };
    if (calls === 3) return { ...ok(''), exit: 'interrupted', cost: null };
    return ok('端口应为 8081，见 application.yml');
  };
  try {
    const s = runComparison({ out, tasks: ['wrong-config', 'new-session-resume'], reps: 1, agent, log: () => {} });
    assert.equal(calls, 3, '中断后不再启动新样本，也不补跑');
    const recs = read(out);
    assert.deepEqual(recs.map((r) => r.outcome), ['pass', 'unknown', 'unknown']);
    for (const r of recs) {
      const raw = readFileSync(join(out, r.raw_file), 'utf8');
      assert.equal(r.raw_sha256, 'sha256:' + createHash('sha256').update(raw).digest('hex'));
    }
    assert.equal(s.stopped, '用户中断，停止后续样本');
    assert.equal(s.comparison.result, 'inconclusive');
    assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /unknown/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('desktop：盲目录准备、按 answer.md 评分、超限计 unknown、不补跑', () => {
  const out = mkdtempSync(join(tmpdir(), 'devflow-cmp-test-'));
  try {
    const es = prepareDesktop(out, ['wrong-config'], 1);
    assert.equal(es.length, 2);
    for (const e of es) {
      assert.ok(!/baseline|candidate/.test(e.root + e.prompt), '目录与提示不暴露版本');
      assert.match(e.prompt, /answer\.md/);
    }
    writeFileSync(join(es[0].root, 'answer.md'), '端口应为 8081，见 application.yml');
    assert.equal(recordDesktop(out, es[0].sample_id, { duration_ms: 1000, tool_uses: 5, tokens: null }).outcome, 'pass');
    assert.throws(() => recordDesktop(out, es[0].sample_id, { duration_ms: 1, tool_uses: 1, tokens: null }), /不补跑/);
    writeFileSync(join(es[1].root, 'answer.md'), '端口应为 8081，见 application.yml');
    assert.equal(recordDesktop(out, es[1].sample_id, { duration_ms: 1000, tool_uses: 101, tokens: null }).outcome, 'unknown');
    const s = summarizeDesktop(out);
    assert.equal(s.run, 2); assert.equal(s.comparison.result, 'inconclusive');
    assert.equal(existsSync(es[0].root), false);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('runner：剩余预算不足下一次上限即停止', () => {
  const out = mkdtempSync(join(tmpdir(), 'devflow-cmp-test-'));
  const p = loadComparisonProtocol();
  p.budget.total_usd = 1;
  let calls = 0;
  try {
    const s = runComparison({ out, protocol: p, tasks: ['wrong-config'], reps: 2, agent: () => (calls++, ok('8081 application.yml', 0.5)), log: () => {} });
    assert.equal(calls, 1);
    assert.match(s.stopped ?? '', /预算/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
