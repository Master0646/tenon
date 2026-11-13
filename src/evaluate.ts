// 固定协议的离线故障评测；用户仓库不作为故障执行目录。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DevflowError, git, withWorktreeLock } from './core.ts';
import { init } from './init.ts';
import { approve, deriveStatus } from './status.ts';
import { applyStart, taskDone, verify } from './exec.ts';
import { recordEvidence, evidenceMatrix } from './evidence.ts';
import { stageArchive, commitArchive } from './archive.ts';
import { startUsage } from './usage.ts';

export interface WorkflowCase {
  id: string;
  critical: boolean;
  files?: Record<string, string>;
  steps: { args: string[]; expect: { exit: number; status?: string; output?: string } }[];
}
export interface EvalSample {
  case_id: string;
  critical: boolean;
  outcome: 'pass' | 'fail' | 'unknown';
  completed: boolean;
  duration_ms: number;
  manual_interventions: number | null;
  detail: string;
}
export interface EvalReport {
  schema_version: 1;
  tool_version: string;
  protocol_hash: string;
  fixture_hash: string;
  at: string;
  samples: EvalSample[];
  tokens: number | null;
  cost: number | null;
  cost_source: string | null;
}
export interface Comparison {
  result: 'improved' | 'regressed' | 'inconclusive';
  comparable: boolean;
  reasons: string[];
  baseline: ReturnType<typeof summarizeReport>;
  candidate: ReturnType<typeof summarizeReport>;
  statistical_significance: 'not-established';
}

const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CLI = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));

export function loadSuite(path: string): WorkflowCase[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new DevflowError('评测夹具不是合法 JSON'); }
  validateCases(value);
  return value;
}

function validateCases(value: unknown): asserts value is WorkflowCase[] {
  if (!Array.isArray(value) || !value.length) throw new DevflowError('评测用例不能为空');
  const ids = new Set<string>();
  for (const c of value) {
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id) || ids.has(c.id) || typeof c.critical !== 'boolean') {
      throw new DevflowError('评测用例必须具有唯一 id 与 critical 标记');
    }
    ids.add(c.id);
    if (c.files !== undefined && (!c.files || typeof c.files !== 'object' || Array.isArray(c.files))) throw new DevflowError('files 必须为路径内容映射');
    for (const [path, content] of Object.entries(c.files ?? {})) {
      if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.split(/[\\/]/).includes('.git') || typeof content !== 'string') {
        throw new DevflowError('评测文件必须位于临时仓库内，不能修改 .git');
      }
    }
    if (!Array.isArray(c.steps) || !c.steps.length) throw new DevflowError('评测 steps 不能为空');
    for (const step of c.steps) {
      if (!step || !Array.isArray(step.args) || !step.args.length || !step.args.every((x: unknown) => typeof x === 'string') || !step.expect || !Number.isInteger(step.expect.exit)) {
        throw new DevflowError('评测步骤必须有 args 与整数 expect.exit');
      }
      if (step.expect.status !== undefined && typeof step.expect.status !== 'string') throw new DevflowError('expect.status 必须是字符串');
      if (step.expect.output !== undefined && typeof step.expect.output !== 'string') throw new DevflowError('expect.output 必须是字符串');
    }
  }
}

export function runWorkflow(cases: WorkflowCase[], options: { cli?: string; version?: string; protocol?: string; repetitions?: number } = {}): EvalReport {
  validateCases(cases);
  const repetitions = options.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new DevflowError('评测 repetitions 必须在 1..100');
  const samples: EvalSample[] = [];
  for (const c of cases) for (let repeat = 0; repeat < repetitions; repeat++) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-eval-')));
    const started = performance.now();
    let outcome: EvalSample['outcome'] = 'pass';
    let detail = '全部固定断言满足';
    try {
      for (const args of [['init', '-q'], ['config', 'user.name', 'devflow-eval'], ['config', 'user.email', 'eval@example.invalid'], ['config', 'commit.gpgsign', 'false']]) {
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
        if (r.error || r.status !== 0) throw new Error('临时 Git 仓库无法初始化');
      }
      for (const [path, content] of Object.entries(c.files ?? {})) {
        const target = resolve(root, path);
        if (relative(root, target).startsWith('..')) throw new Error('夹具路径越界');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      const commit = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      if (commit.error || commit.status !== 0) throw new Error('夹具提交失败');
      for (const [index, step] of c.steps.entries()) {
        const r = spawnSync(process.execPath, [options.cli ?? CLI, ...step.args], {
          cwd: root, input: '', encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, DEVFLOW_USAGE: 'off', GIT_TERMINAL_PROMPT: '0' },
        });
        if (r.error || r.status === null) { outcome = 'unknown'; detail = `步骤 ${index + 1} 未执行完成`; break; }
        const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        let status: unknown;
        if (step.expect.status !== undefined) {
          try { const parsed = JSON.parse(r.stdout); status = Array.isArray(parsed) ? parsed[0]?.status : parsed.status; }
          catch { status = undefined; }
        }
        if (r.status !== step.expect.exit || (step.expect.output !== undefined && !output.includes(step.expect.output)) || (step.expect.status !== undefined && status !== step.expect.status)) {
          outcome = 'fail'; detail = `步骤 ${index + 1} 不符合固定退出码、状态或输出断言`; break;
        }
      }
    } catch (e) { outcome = 'unknown'; detail = e instanceof Error ? e.message : '环境无法运行'; }
    finally { rmSync(root, { recursive: true, force: true }); }
    samples.push({ case_id: c.id, critical: c.critical, outcome, completed: outcome === 'pass', duration_ms: performance.now() - started, manual_interventions: null, detail });
  }
  return {
    schema_version: 1, tool_version: options.version ?? 'unknown', protocol_hash: hash(options.protocol ?? 'workflow-v1'), fixture_hash: hash(cases),
    at: new Date().toISOString(), samples, tokens: null, cost: null, cost_source: null,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
export function summarizeReport(report: EvalReport) {
  const n = report.samples.length;
  const pass = report.samples.filter((s) => s.outcome === 'pass').length;
  return {
    samples: n, pass, fail: report.samples.filter((s) => s.outcome === 'fail').length,
    unknown: report.samples.filter((s) => s.outcome === 'unknown').length,
    completion_rate: n ? report.samples.filter((s) => s.completed).length / n : null,
    critical_misses: report.samples.filter((s) => s.critical && s.outcome === 'fail').length,
    median_duration_ms: median(report.samples.map((s) => s.duration_ms)),
    median_manual_interventions: report.samples.some((s) => s.manual_interventions === null) ? null : median(report.samples.map((s) => s.manual_interventions!)),
    case_counts: Object.fromEntries([...new Set(report.samples.map((s) => s.case_id))].sort().map((id) => [id, report.samples.filter((s) => s.case_id === id).length])),
  };
}

export function compareReports(baseline: EvalReport, candidate: EvalReport): Comparison {
  validateReport(baseline); validateReport(candidate);
  const a = summarizeReport(baseline), b = summarizeReport(candidate);
  const out: Comparison = { result: 'inconclusive', comparable: true, reasons: [], baseline: a, candidate: b, statistical_significance: 'not-established' };
  if (baseline.protocol_hash !== candidate.protocol_hash || baseline.fixture_hash !== candidate.fixture_hash || JSON.stringify(Object.keys(a.case_counts)) !== JSON.stringify(Object.keys(b.case_counts))) {
    out.comparable = false; out.reasons.push('协议、夹具或任务集合不一致，拒绝可比结论'); return out;
  }
  if (a.unknown || b.unknown) { out.reasons.push('存在 unknown 样本，不能宣称改进或回退'); return out; }
  const byCase = (r: EvalReport, id: string) => r.samples.filter((s) => s.case_id === id);
  const rate = (ss: EvalSample[], f: (s: EvalSample) => boolean) => ss.filter(f).length / ss.length;
  const regression = Object.keys(a.case_counts).some((id) => {
    const old = byCase(baseline, id), next = byCase(candidate, id);
    return rate(next, (s) => s.completed) < rate(old, (s) => s.completed) || rate(next, (s) => s.critical && s.outcome === 'fail') > rate(old, (s) => s.critical && s.outcome === 'fail');
  });
  if (regression) { out.result = 'regressed'; out.reasons.push('至少一项任务完成率下降或关键故障漏检率增加'); return out; }
  if (Object.values(a.case_counts).some((n) => n < 5) || Object.values(b.case_counts).some((n) => n < 5) || !a.samples) {
    out.reasons.push('每个任务每个版本至少需要五个样本'); return out;
  }
  const faster = a.median_duration_ms !== null && a.median_duration_ms > 0 && b.median_duration_ms !== null && b.median_duration_ms <= a.median_duration_ms * .9;
  const fewer = a.median_manual_interventions !== null && a.median_manual_interventions > 0 && b.median_manual_interventions !== null && b.median_manual_interventions <= a.median_manual_interventions * .9;
  if (faster || fewer) { out.result = 'improved'; out.reasons.push('本批样本目标中位指标降低至少 10%，不代表统计显著'); }
  else out.reasons.push('目标中位指标未达到 10% 改进阈值');
  return out;
}

export function readReport(path: string): EvalReport {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new DevflowError('评测报告不是合法 JSON'); }
  validateReport(value);
  return value;
}
function validateReport(value: unknown): asserts value is EvalReport {
  const r = value as EvalReport;
  if (!r || r.schema_version !== 1 || typeof r.protocol_hash !== 'string' || typeof r.fixture_hash !== 'string' || !Array.isArray(r.samples)) throw new DevflowError('评测报告格式无效');
  for (const s of r.samples) {
    if (!s || typeof s.case_id !== 'string' || typeof s.critical !== 'boolean' || !['pass', 'fail', 'unknown'].includes(s.outcome) || typeof s.completed !== 'boolean' || (s.completed && s.outcome !== 'pass') || !Number.isFinite(s.duration_ms) || s.duration_ms < 0 || (s.manual_interventions !== null && (!Number.isFinite(s.manual_interventions) || s.manual_interventions < 0))) throw new DevflowError('评测样本字段无效');
  }
}

const WORKFLOW_IDS = ['missing-evidence', 'stale-code', 'old-approval', 'artifact-missing', 'artifact-modified', 'manual-unconfirmed', 'worktree-lock', 'spec-conflict', 'resume-summary', 'usage-write-failed', 'archive-interrupted'] as const;

/** 固定故障只在一次性仓库注入；approve 为夹具构造，不批准用户变更。 */
export function runWorkflowSuite(version = 'unknown'): EvalReport {
  const samples: EvalSample[] = [];
  for (const fault of WORKFLOW_IDS) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-fault-')));
    const started = performance.now();
    let outcome: EvalSample['outcome'] = 'pass', detail = '故障断言满足';
    const id = 'fixture';
    const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
    try {
      git(root, ['init', '-q']);
      git(root, ['config', 'user.name', 'devflow-eval']); git(root, ['config', 'user.email', 'eval@example.invalid']);
      git(root, ['config', 'commit.gpgsign', 'false']);
      init(root);
      write('test.txt', 'expected assertion');
      write('.devflow/project.yaml', 'schema_version: 1\nverify:\n  - name: unit\n    run: "true"\nexclude: []\nenforce: warn\n');
      git(root, ['add', '-A']); git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
      write(`.devflow/changes/${id}/change.yaml`, 'schema_version: 2\nmin_cli_version: 0.2.0\ntitle: Evidence fixture\naffected_paths: [test.txt]\n');
      write(`.devflow/changes/${id}/proposal.md`, '# Proposal\n\nVerify permission behavior.\n');
      const manual = fault === 'manual-unconfirmed';
      write(`.devflow/changes/${id}/tasks.yaml`, `schema_version: 2\ntasks:\n  - id: T1\n    title: Evidence fixture\n    acceptance:\n      - id: AC1\n        text: Permission behavior verified\n        method: ${manual ? 'manual' : 'automated'}\n${manual ? '' : '        check: unit\n'}`);
      if (fault === 'spec-conflict') write(`.devflow/changes/${id}/specs/auth/spec.md`, '## ADDED Requirements\n\n### Requirement: Permission\nSystem SHALL reject.\n\n#### Scenario: Rejected\n- WHEN unauthorized\n- THEN rejected\n');
      approve(root, id); applyStart(root, id);
      if (fault === 'missing-evidence') {
        assert.throws(() => taskDone(root, id, 'T1'), /证据/);
        assert.throws(() => stageArchive(root, id));
      } else if (fault === 'worktree-lock') {
        withWorktreeLock(root, () => assert.throws(() => withWorktreeLock(root, () => {}), /持锁/));
        withWorktreeLock(root, () => assert.equal(deriveStatus(root, id).status, 'applying'));
      } else if (fault === 'usage-write-failed') {
        write('.devflow/runtime/usage', 'not a directory');
        assert.equal(startUsage(root, { tool_version: version, command: 'status' }), undefined);
        assert.equal(deriveStatus(root, id).status, 'applying');
      } else if (fault === 'resume-summary') {
        const r = spawnSync(process.execPath, [CLI, 'resume', id, '--json'], { cwd: root, input: '', encoding: 'utf8', timeout: 10_000, env: { ...process.env, DEVFLOW_USAGE: 'off' } });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /AC1/);
        assert.match(r.stdout, /next|下一|command/i);
      } else if (fault === 'spec-conflict') {
        write('.devflow/specs/auth/spec.md', '# auth\n\n## Requirements\n');
        assert.equal(deriveStatus(root, id).status, 'rebase_required');
      } else if (manual) {
        recordEvidence(root, id, { task: 'T1', acceptance: 'AC1', kind: 'manual', summary: 'Observed', procedure: 'Invoke API', expected: 'Denied', observed: 'Denied' });
        assert.equal(evidenceMatrix(root, id)[0].status, 'unconfirmed');
        assert.throws(() => taskDone(root, id, 'T1'), /证据/);
      } else {
        const run = verify(root, id);
        const evidence = recordEvidence(root, id, { task: 'T1', acceptance: 'AC1', kind: 'automated', summary: 'Assertion passed', verify_run: run.run_id, check: 'unit', test: 'test.txt', assertion: 'Checks rejection and unchanged data', artifacts: ['test.txt'] });
        taskDone(root, id, 'T1');
        assert.equal(deriveStatus(root, id).status, 'ready_to_archive');
        if (fault === 'stale-code') {
          write('test.txt', 'changed');
          assert.equal(evidenceMatrix(root, id)[0].status, 'stale'); assert.notEqual(deriveStatus(root, id).status, 'ready_to_archive');
        } else if (fault === 'old-approval') {
          // 重新批准时验收条件变了：旧证据不得沿用（条件和代码都没变时才沿用）
          write(`.devflow/changes/${id}/tasks.yaml`, 'schema_version: 2\ntasks:\n  - id: T1\n    title: Evidence fixture\n    acceptance:\n      - id: AC1\n        text: Changed requirement\n        method: automated\n        check: unit\n');
          approve(root, id); applyStart(root, id);
          assert.equal(deriveStatus(root, id).tasks.done, 0); assert.equal(evidenceMatrix(root, id)[0].status, 'stale');
        } else if (fault.startsWith('artifact-')) {
          const file = join(root, evidence.artifacts[0].path);
          if (fault === 'artifact-missing') rmSync(file); else writeFileSync(file, 'tampered');
          assert.equal(evidenceMatrix(root, id)[0].status, 'invalid'); assert.throws(() => stageArchive(root, id));
        } else if (fault === 'archive-interrupted') {
          const tx = stageArchive(root, id), first = tx.writes[0];
          mkdirSync(dirname(join(root, first.to)), { recursive: true }); renameSync(join(root, first.from), join(root, first.to));
          const result = commitArchive(root, id);
          assert.equal(existsSync(join(root, result.target, 'events.jsonl')), true);
          assert.equal(existsSync(join(root, '.devflow/runtime/tx', id)), false);
        }
      }
    } catch (e) {
      outcome = e instanceof assert.AssertionError || e instanceof DevflowError ? 'fail' : 'unknown';
      detail = e instanceof Error ? e.message : '环境无法完成';
    } finally { rmSync(root, { recursive: true, force: true }); }
    samples.push({ case_id: fault, critical: true, outcome, completed: outcome === 'pass', duration_ms: performance.now() - started, manual_interventions: null, detail });
  }
  return { schema_version: 1, tool_version: version, protocol_hash: hash('workflow-fault-v2'), fixture_hash: hash({ cases: WORKFLOW_IDS, fixture_schema: 2, acceptance: ['current-acceptance', 'current-worktree', 'intact-artifact', 'manual-confirmation', 'mutual-exclusion', 'spec-baseline', 'resume-next-command', 'usage-fail-open', 'archive-roll-forward'], check: 'unit:true', method: 'automated-or-manual' }), at: new Date().toISOString(), samples, tokens: null, cost: null, cost_source: null };
}
