import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareReports, loadSuite, readReport, runWorkflow, summarizeReport, type EvalReport, type WorkflowCase } from '../src/evaluate.ts';

function report(duration = 100, repetitions = 5): EvalReport {
  return {
    schema_version: 1, tool_version: 'test', protocol_hash: 'p', fixture_hash: 'f', at: new Date().toISOString(), tokens: null, cost: null, cost_source: null,
    samples: Array.from({ length: repetitions }, () => ({ case_id: 'permission', critical: true, outcome: 'pass', completed: true, duration_ms: duration, manual_interventions: null, detail: 'ok' })),
  };
}

test('compare：固定协议、至少五次样本、10% 阈值且 unknown 不冒充零', () => {
  assert.equal(compareReports(report(), report(90)).result, 'improved');
  assert.equal(compareReports(report(), report(91)).result, 'inconclusive');
  assert.equal(compareReports(report(100, 4), report(10, 4)).result, 'inconclusive');
  const candidate = report(10); candidate.samples[0].outcome = 'unknown'; candidate.samples[0].completed = false;
  assert.equal(compareReports(report(), candidate).result, 'inconclusive');
  const bothUnknown = structuredClone(candidate);
  assert.equal(compareReports(bothUnknown, candidate).result, 'inconclusive');
  assert.equal(summarizeReport(report()).median_manual_interventions, null);
  assert.equal(compareReports(report(), report(50)).statistical_significance, 'not-established');
});

test('compare：协议或夹具不一致拒绝比较，单项回退不被总体提升掩盖', () => {
  const candidate = report(10); candidate.protocol_hash = 'different';
  assert.equal(compareReports(report(), candidate).comparable, false);
  candidate.protocol_hash = 'p'; candidate.fixture_hash = 'changed';
  assert.equal(compareReports(report(), candidate).comparable, false);
  const old = report(), next = report(10);
  next.samples[0].outcome = 'fail'; next.samples[0].completed = false;
  assert.equal(compareReports(old, next).result, 'regressed');
});

test('workflow：每次在独立 Git 仓库运行并清理，校验退出码、JSON 状态和输出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-eval-test-'));
  try {
    const seen = join(dir, 'seen.txt');
    const cli = join(dir, 'fake.mjs');
    writeFileSync(cli, `import {appendFileSync,readFileSync,existsSync} from 'node:fs';
      appendFileSync(${JSON.stringify(seen)},process.cwd()+'\\n');
      if(!existsSync('.git')||readFileSync('marker.txt','utf8')!=='fixture')process.exit(3);
      console.log(JSON.stringify([{status:'needs_fix'}])); process.exit(1);`);
    const cases: WorkflowCase[] = [{ id: 'missing-proof', critical: true, files: { 'marker.txt': 'fixture' }, steps: [{ args: ['status'], expect: { exit: 1, status: 'needs_fix', output: 'needs_fix' } }] }];
    const result = runWorkflow(cases, { cli, repetitions: 2, protocol: 'frozen' });
    assert.deepEqual(result.samples.map((s) => s.outcome), ['pass', 'pass']);
    assert.equal(result.tokens, null); assert.equal(result.cost, null);
    const roots = readFileSync(seen, 'utf8').trim().split('\n');
    assert.equal(new Set(roots).size, 2);
    for (const root of roots) { assert.notEqual(root, process.cwd()); assert.equal(existsSync(root), false); }
    cases[0].steps[0].expect.exit = 0;
    const failed = runWorkflow(cases, { cli });
    assert.equal(failed.samples[0].outcome, 'fail');
    assert.notEqual(failed.fixture_hash, result.fixture_hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workflow：夹具边界和报告字段校验，缺少运行环境保留 unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-eval-test-'));
  try {
    const suite = join(dir, 'suite.json');
    writeFileSync(suite, JSON.stringify([{ id: 'escape', critical: true, files: { '../escape': 'bad' }, steps: [{ args: ['status'], expect: { exit: 0 } }] }]));
    assert.throws(() => loadSuite(suite), /临时仓库/);
    writeFileSync(suite, '{bad'); assert.throws(() => loadSuite(suite), /合法 JSON/);
    writeFileSync(suite, JSON.stringify(report())); assert.deepEqual(readReport(suite).samples.length, 5);
    const bad = report(); bad.samples[0].duration_ms = -1;
    writeFileSync(suite, JSON.stringify(bad)); assert.throws(() => readReport(suite), /样本/);
    assert.throws(() => runWorkflow([], {}), /不能为空/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('内置故障套件：实际证据、周期、附件、锁和归档恢复全部符合固定判据', async () => {
  const { runWorkflowSuite } = await import('../src/evaluate.ts');
  const result = runWorkflowSuite('test');
  assert.ok(result.samples.length >= 10);
  assert.deepEqual(result.samples.filter((s) => s.outcome !== 'pass'), []);
});
