// 真实 Agent 对照：DevFlow 基线（7b03749）与候选（f99edf1），三类任务交替运行，固定协议与判据
// 用法：node eval/agent-workflow.ts [--tasks a,b] [--reps 5] [--out <目录>]（调用 claude -p，消耗用量；需要 mvn）
// 夹具中的 approve 在一次性仓库里、Agent 会话开始前构造；运行器从不批准 Agent 产出。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { compareReports, summarizeReport, type EvalReport, type EvalSample } from '../src/evaluate.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PROTOCOL_FILE = join(REPO, 'eval/protocol.yaml');
const M2_PROPOSAL = join(REPO, 'eval/results/2026-11-06-04-35-propose/2026-11-06-admin-only-disable');

export const TASKS = ['wrong-config', 'omitted-permission', 'new-session-resume'] as const;
export type TaskId = (typeof TASKS)[number];
export type Variant = 'baseline' | 'candidate';

export interface AgentCall { cwd: string; prompt: string; tools: string[]; model: string; budgetUsd: number; maxTurns: number; timeoutMs: number; env: NodeJS.ProcessEnv }
export interface AgentResult {
  exit: 'ok' | 'error' | 'timeout' | 'interrupted';
  subtype: string | null;
  result: string;
  cost: number | null;
  turns: number | null;
  denials: number | null;
  raw: string;
}
export type Agent = (call: AgentCall) => AgentResult;
export interface Score { outcome: EvalSample['outcome']; detail: string; false_block: boolean }
export type Scorer = (task: TaskId, proj: string, res: AgentResult, changeId: string) => Score;
export interface SampleRecord extends EvalSample {
  sample_id: string; task: TaskId; variant: Variant; commit: string; repeat: number;
  started_at: string; cost: number | null; turns: number | null; denials: number | null; subtype: string | null;
  false_block: boolean; raw_file: string; raw_sha256: string;
}

const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');

export function loadComparisonProtocol(file = PROTOCOL_FILE) {
  const p = parse(readFileSync(file, 'utf8'))?.agent_comparison;
  if (!p?.baseline?.commit || !p?.candidate?.commit || !p.model || !p.budget?.total_usd || !p.budget?.per_run_usd) throw new Error('protocol.yaml 缺少 agent_comparison 冻结字段');
  return p as {
    id: string; baseline: { commit: string }; candidate: { commit: string }; project_tree: string; model: string;
    budget: { total_usd: number; per_run_usd: Record<TaskId, number>; max_turns_per_run: number; max_minutes_per_run: number; retries: number };
    repetitions_per_variant: number; tools: { read: string[]; write: string[] };
  };
}

/** 交替顺序：第偶数轮基线先跑，奇数轮候选先跑；每个样本都是全新项目与新会话 */
export function schedule(tasks: readonly TaskId[], reps: number) {
  const out: { task: TaskId; variant: Variant; repeat: number }[] = [];
  for (let repeat = 0; repeat < reps; repeat++) for (const task of tasks) {
    const order: Variant[] = repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const variant of order) out.push({ task, variant, repeat });
  }
  return out;
}

/** 把指定提交的 CLI 解到临时目录；node_modules 借用本仓库（两版依赖相同：yaml） */
export function prepareVersion(commit: string, into: string): string {
  const full = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim();
  if (full !== commit) throw new Error(`提交号必须为完整哈希：${commit}`);
  mkdirSync(into, { recursive: true });
  const tar = execFileSync('git', ['archive', commit, 'src', 'templates', 'vendor', 'package.json'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', into], { input: tar });
  symlinkSync(join(REPO, 'node_modules'), join(into, 'node_modules'));
  return into;
}

const OP_ID = '2026-11-08-admin-only-disable-api';
const OP_FILES: Record<string, string> = {
  'change.yaml': `schema_version: 1\ntitle: 只有管理员可以禁用用户\naffected_paths:\n  - backend/**\n`,
  'proposal.md': `# 只有管理员可以禁用用户\n\n## 为什么\n- 目前任何登录用户都能通过 POST /api/users/{id}/disable 禁用其他普通用户。\n\n## 改什么\n- 禁用用户要求操作者角色为 ADMIN。\n\n## 不做什么\n- 不改前端。\n`,
  'design.md': `# 设计\n\n- 在 UserService#disable 中按 operatorId 查询操作者，角色不是 ADMIN 时抛出 BusinessException(403)。\n- 现有"不能禁用自己""不能禁用管理员"规则保持不变。\n`,
  'specs/user-management/spec.md': `## ADDED Requirements\n\n### Requirement: 禁用用户需要管理员\n系统 SHALL 仅允许角色为 ADMIN 的操作者禁用用户。\n\n#### Scenario: 管理员禁用普通用户\n- WHEN ADMIN 操作者禁用状态为 ACTIVE 的 USER\n- THEN 该用户状态变为 DISABLED\n\n#### Scenario: 普通用户直接调用接口\n- WHEN USER 操作者直接请求 POST /api/users/{id}/disable\n- THEN 返回 403，且目标用户状态不变\n`,
  // 初始故障：任务清单遗漏了非管理员分支，只有 spec 写了
  'tasks.yaml': `schema_version: 1\ntasks:\n  - id: T1\n    title: 后端引入测试依赖\n    acceptance:\n      - backend/pom.xml 包含 test scope 的 spring-boot-starter-test\n      - 在 backend 目录运行 mvn -q test 成功\n  - id: T2\n    title: 管理员可以禁用普通用户\n    depends_on: [T1]\n    acceptance:\n      - ADMIN 操作者禁用 ACTIVE 的 USER 后状态为 DISABLED\n      - mvn -q test 通过\n`,
};
const TEST_DEP = `    <dependency>\n      <groupId>org.springframework.boot</groupId>\n      <artifactId>spring-boot-starter-test</artifactId>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>`;

export const PROMPTS: Record<TaskId, (id: string) => string> = {
  'wrong-config': (id) => `变更 ${id} 的方案已写好，等待我审批。请审查它能否直接批准：方案里的事实、命令和验收条件是否与项目源码一致。只审查，不要修改任何文件。逐条列出问题并给出处。`,
  'omitted-permission': (id) => `使用 devflow-apply 技能实现变更 ${id}，直到 devflow verify 通过。`,
  'new-session-resume': (id) => `这是一个新会话。变更 ${id} 上次做到哪一步了？哪些验收条件还没完成？下一步具体应该做什么、运行什么命令？只回答，不要修改任何文件。`,
};

/** 全新临时项目：冻结的演示项目 + 该版本 devflow init + 任务夹具，全部提交 */
export function setupProject(task: TaskId, cliDir: string, treeCommit: string, root: string): { proj: string; changeId: string; env: NodeJS.ProcessEnv } {
  const proj = join(root, 'user-admin');
  mkdirSync(proj, { recursive: true });
  const tar = execFileSync('git', ['archive', `${treeCommit}:examples/user-admin`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', proj], { input: tar });
  const cli = join(cliDir, 'src/cli.ts');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/devflow'), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
  chmodSync(join(root, 'bin/devflow'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' };
  const sh = (cmd: string, ...a: string[]) => execFileSync(cmd, a, { cwd: proj, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (m: string) => { sh('git', 'add', '-A'); sh('git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', m); };
  sh('git', 'init', '-q');
  sh('git', 'config', 'user.name', 'devflow-eval'); sh('git', 'config', 'user.email', 'eval@example.invalid'); sh('git', 'config', 'commit.gpgsign', 'false');
  commit('demo');
  sh('devflow', 'init', '--agents', 'claude');
  const pf = join(proj, '.devflow/project.yaml');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace(/^verify: \[\]$/m, 'verify:\n  - name: backend-test\n    run: mvn -q -B test\n    cwd: backend'));
  commit('devflow init');
  // 夹具构造：调用该版本自身的 approve()，批准人是一次性仓库的 devflow-eval
  const approveFixture = (id: string) => sh(process.execPath, '--input-type=module', '-e',
    `import { approve } from ${JSON.stringify('file://' + join(cliDir, 'src/status.ts'))}; approve(process.argv[1], process.argv[2]);`, proj, id);
  if (task === 'wrong-config') {
    const id = '2026-11-06-admin-only-disable';
    cpSync(M2_PROPOSAL, join(proj, '.devflow/changes', id), { recursive: true });
    commit(`proposal ${id}`);
    return { proj, changeId: id, env };
  }
  for (const [rel, content] of Object.entries(OP_FILES)) {
    const f = join(proj, '.devflow/changes', OP_ID, rel);
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content);
  }
  commit(`proposal ${OP_ID}`);
  approveFixture(OP_ID);
  commit(`approve ${OP_ID}`);
  if (task === 'new-session-resume') {
    sh('devflow', 'apply', OP_ID, '--start');
    const pom = join(proj, 'backend/pom.xml');
    writeFileSync(pom, readFileSync(pom, 'utf8').replace('  </dependencies>', TEST_DEP));
    sh('devflow', 'task', 'done', OP_ID, 'T1');
    commit('T1');
  }
  return { proj, changeId: OP_ID, env };
}

const ORACLE_TEST = `package com.example.admin.oracle;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.example.admin.auth.TokenService;
import com.example.admin.role.RoleMapper;
import com.example.admin.user.User;
import com.example.admin.user.UserMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = "spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,org.mybatis.spring.boot.autoconfigure.MybatisAutoConfiguration")
@AutoConfigureMockMvc
class HiddenPermissionOracleTest {
    @Autowired MockMvc mvc;
    @Autowired TokenService tokens;
    @MockBean UserMapper users;
    @MockBean RoleMapper roles;

    static User user(long id, String role) {
        User u = new User();
        u.setId(id); u.setUsername("u" + id); u.setStatus(User.Status.ACTIVE);
        u.setRoleId("ADMIN".equals(role) ? 1L : 2L); u.setRoleName(role);
        return u;
    }

    @BeforeEach
    void stub() {
        when(users.selectById(1L)).thenReturn(user(1, "ADMIN"));
        when(users.selectById(2L)).thenReturn(user(2, "USER"));
        when(users.selectById(3L)).thenReturn(user(3, "USER"));
        when(users.updateStatus(any(), any())).thenReturn(1);
    }

    @Test
    void nonAdminDirectCallRejected() throws Exception {
        int s = mvc.perform(post("/api/users/3/disable").header("Authorization", "Bearer " + tokens.issue(2L))).andReturn().getResponse().getStatus();
        assertTrue(s == 401 || s == 403, "HTTP " + s);
        verify(users, never()).updateStatus(any(), any());
    }

    @Test
    void adminStillDisables() throws Exception {
        int s = mvc.perform(post("/api/users/3/disable").header("Authorization", "Bearer " + tokens.issue(1L))).andReturn().getResponse().getStatus();
        assertTrue(s == 200, "HTTP " + s);
        verify(users).updateStatus(3L, User.Status.DISABLED);
    }
}
`;

/** 隐藏 MockMvc 观察器：两个版本完全相同，在 Agent 结束后才放入项目 */
export function permissionOracle(proj: string): Score {
  const backend = join(proj, 'backend');
  const pom = join(backend, 'pom.xml');
  if (!readFileSync(pom, 'utf8').includes('spring-boot-starter-test')) writeFileSync(pom, readFileSync(pom, 'utf8').replace('  </dependencies>', TEST_DEP));
  const file = join(backend, 'src/test/java/com/example/admin/oracle/HiddenPermissionOracleTest.java');
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ORACLE_TEST);
  rmSync(join(backend, 'target/surefire-reports'), { recursive: true, force: true });
  const mvn = (...a: string[]) => spawnSync('mvn', ['-q', '-B', '-o', ...a], { cwd: backend, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  mvn('test', '-Dtest=HiddenPermissionOracleTest', '-Dsurefire.failIfNoSpecifiedTests=false');
  const xml = join(backend, 'target/surefire-reports/TEST-com.example.admin.oracle.HiddenPermissionOracleTest.xml');
  if (!existsSync(xml)) {
    const c = mvn('compile');
    return c.status === 0 ? { outcome: 'unknown', detail: '隐藏测试未能编译或运行（主代码可编译）', false_block: false } : { outcome: 'fail', detail: '主代码无法编译', false_block: false };
  }
  const report = readFileSync(xml, 'utf8');
  const caseBlock = (name: string) => report.match(new RegExp(`<testcase[^>]*name="${name}"[^>]*(/>|>[\\s\\S]*?</testcase>)`))?.[0] ?? '';
  const broken = (name: string) => /<error/.test(caseBlock(name));
  const failed = (name: string) => /<failure/.test(caseBlock(name));
  if (!caseBlock('nonAdminDirectCallRejected') || broken('nonAdminDirectCallRejected') || broken('adminStillDisables')) {
    return { outcome: 'unknown', detail: '隐藏测试上下文或运行出错', false_block: false };
  }
  const miss = failed('nonAdminDirectCallRejected'), block = failed('adminStillDisables');
  if (miss) return { outcome: 'fail', detail: '普通用户直接请求禁用接口未被拒绝或数据被修改', false_block: block };
  if (block) return { outcome: 'fail', detail: '管理员禁用普通用户被误拦', false_block: true };
  return { outcome: 'pass', detail: '普通用户被拒且数据不变，管理员仍可禁用', false_block: false };
}

/** 固定判据 agent-deterministic-v1 */
export const defaultScorer: Scorer = (task, proj, res, changeId) => {
  if (res.exit !== 'ok') return { outcome: 'unknown', detail: `Agent 未正常结束：${res.exit}${res.subtype ? `/${res.subtype}` : ''}`, false_block: false };
  if (res.subtype && res.subtype !== 'success') return { outcome: 'unknown', detail: `Agent 被截断：${res.subtype}`, false_block: false };
  const text = res.result;
  if (task === 'wrong-config') {
    const ok = /8081/.test(text) && /application\.ya?ml/.test(text);
    return { outcome: ok ? 'pass' : 'fail', detail: ok ? '指出端口应为 8081 并引用 application.yml' : '未指出端口错误或缺少 application.yml 引用', false_block: false };
  }
  if (task === 'new-session-resume') {
    const next = new RegExp(`devflow\\s+(task\\s+done\\s+${changeId}\\s+T2|verify)`).test(text);
    const ok = /T2/.test(text) && /DISABLED/.test(text) && next;
    return { outcome: ok ? 'pass' : 'fail', detail: ok ? '指出 T2 未完成验收与下一步命令' : `缺少：${[!/T2/.test(text) && 'T2', !/DISABLED/.test(text) && 'DISABLED 验收', !next && '下一步命令'].filter(Boolean).join('、')}`, false_block: false };
  }
  return permissionOracle(proj);
};

/** 真实 Agent：claude -p，不重试；超时、中断、预算截断都如实上报 */
export const claudeAgent: Agent = (c) => {
  const args = ['-p', c.prompt, '--model', c.model, '--max-turns', String(c.maxTurns), '--max-budget-usd', String(c.budgetUsd), '--output-format', 'json',
    '--setting-sources', 'project,local', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', ...c.tools];
  const r = spawnSync('claude', args, { cwd: c.cwd, env: c.env, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const raw = JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return { exit: 'timeout', subtype: null, result: '', cost: null, turns: null, denials: null, raw };
  if (r.signal === 'SIGINT' || r.signal === 'SIGTERM') return { exit: 'interrupted', subtype: null, result: '', cost: null, turns: null, denials: null, raw };
  try {
    const j = JSON.parse(r.stdout);
    return { exit: j.is_error && j.subtype === 'success' ? 'error' : 'ok', subtype: j.subtype ?? null, result: String(j.result ?? ''), cost: j.total_cost_usd ?? null, turns: j.num_turns ?? null, denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : null, raw };
  } catch { return { exit: 'error', subtype: null, result: '', cost: null, turns: null, denials: null, raw }; }
};

export interface RunOptions {
  out: string; tasks?: readonly TaskId[]; reps?: number; agent?: Agent; scorer?: Scorer;
  protocol?: ReturnType<typeof loadComparisonProtocol>; versions?: Record<Variant, string>;
  log?: (s: string) => void;
}

/** 依次运行；每个样本结束立即写 samples.jsonl，中断后已有证据仍可汇总 */
export function runComparison(o: RunOptions) {
  const p = o.protocol ?? loadComparisonProtocol();
  const tasks = o.tasks ?? TASKS, reps = o.reps ?? p.repetitions_per_variant;
  const agent = o.agent ?? claudeAgent, scorer = o.scorer ?? defaultScorer, log = o.log ?? console.log;
  mkdirSync(join(o.out, 'raw'), { recursive: true });
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-agent-cmp-')));
  const commits: Record<Variant, string> = { baseline: p.baseline.commit, candidate: p.candidate.commit };
  const versions = o.versions ?? { baseline: prepareVersion(commits.baseline, join(work, 'baseline')), candidate: prepareVersion(commits.candidate, join(work, 'candidate')) };
  const tools = { read: p.tools.read, write: [...p.tools.read, ...p.tools.write.filter((t) => t !== 'read')] };
  const records: SampleRecord[] = [];
  let spent = 0, stopped: string | null = null;
  const plan = schedule(tasks, reps);
  try {
    for (const [i, s] of plan.entries()) {
      const cap = p.budget.per_run_usd[s.task];
      if (spent + cap > p.budget.total_usd) { stopped = `剩余预算 $${(p.budget.total_usd - spent).toFixed(2)} 不足下一次上限 $${cap}`; break; }
      const sample_id = `${String(i + 1).padStart(2, '0')}-${s.task}-${s.variant}-r${s.repeat + 1}`;
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-agent-sample-')));
      const started_at = new Date().toISOString();
      let res: AgentResult, score: Score, duration_ms = 0;
      try {
        const { proj, changeId, env } = setupProject(s.task, versions[s.variant], commits.candidate, root);
        const t0 = performance.now();
        res = agent({ cwd: proj, prompt: PROMPTS[s.task](changeId), tools: s.task === 'omitted-permission' ? tools.write : tools.read, model: p.model, budgetUsd: cap, maxTurns: p.budget.max_turns_per_run, timeoutMs: p.budget.max_minutes_per_run * 60_000, env });
        duration_ms = performance.now() - t0;
        score = scorer(s.task, proj, res, changeId);
      } catch (e) {
        res ??= { exit: 'error', subtype: null, result: '', cost: null, turns: null, denials: null, raw: JSON.stringify({ setup_error: String(e) }) };
        score = { outcome: 'unknown', detail: `环境无法完成：${e instanceof Error ? e.message.slice(0, 300) : e}`, false_block: false };
      } finally { rmSync(root, { recursive: true, force: true }); }
      spent += res.cost ?? cap; // 费用未知按上限计，宁可早停
      const raw_file = `raw/${sample_id}.json`;
      writeFileSync(join(o.out, raw_file), res.raw);
      const rec: SampleRecord = {
        sample_id, task: s.task, variant: s.variant, commit: commits[s.variant], repeat: s.repeat, started_at,
        case_id: s.task, critical: true, outcome: score.outcome, completed: score.outcome === 'pass', duration_ms, manual_interventions: null, detail: score.detail,
        cost: res.cost, turns: res.turns, denials: res.denials, subtype: res.subtype, false_block: score.false_block, raw_file, raw_sha256: sha(res.raw),
      };
      records.push(rec);
      appendFileSync(join(o.out, 'samples.jsonl'), JSON.stringify(rec) + '\n');
      log(`[${i + 1}/${plan.length}] ${sample_id} ${score.outcome} $${res.cost?.toFixed(3) ?? '?'} 累计 $${spent.toFixed(2)} — ${score.detail}`);
      if (res.exit === 'interrupted') { stopped = '用户中断，停止后续样本'; break; }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return summarize(o.out, p, records, plan.length, spent, stopped);
}

export function toReport(p: ReturnType<typeof loadComparisonProtocol>, records: SampleRecord[], variant: Variant): EvalReport {
  return {
    schema_version: 1, tool_version: p[variant].commit, protocol_hash: sha(JSON.stringify(p)), fixture_hash: sha(JSON.stringify({ OP_FILES, ORACLE_TEST, PROMPTS: TASKS.map((t) => PROMPTS[t]('<id>')) })),
    at: new Date().toISOString(), samples: records.filter((r) => r.variant === variant).map(({ case_id, critical, outcome, completed, duration_ms, manual_interventions, detail }) => ({ case_id, critical, outcome, completed, duration_ms, manual_interventions, detail })),
    tokens: null, cost: records.filter((r) => r.variant === variant).reduce((a, r) => a + (r.cost ?? 0), 0), cost_source: 'claude -p total_cost_usd',
  };
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function summarize(out: string, p: ReturnType<typeof loadComparisonProtocol>, records: SampleRecord[], planned: number, spent: number | null, stopped: string | null, notes: string[] = []) {
  const baseline = toReport(p, records, 'baseline'), candidate = toReport(p, records, 'candidate');
  const comparison = compareReports(baseline, candidate);
  const rows = TASKS.flatMap((t) => (['baseline', 'candidate'] as Variant[]).map((v) => {
    const rs = records.filter((r) => r.task === t && r.variant === v);
    const known = (f: (r: SampleRecord) => number | null) => rs.map(f).filter((x): x is number => x !== null);
    return { task: t, variant: v, n: rs.length, pass: rs.filter((r) => r.outcome === 'pass').length, fail: rs.filter((r) => r.outcome === 'fail').length, unknown: rs.filter((r) => r.outcome === 'unknown').length,
      misses: rs.filter((r) => r.outcome === 'fail' && !r.false_block).length, false_blocks: rs.filter((r) => r.false_block).length,
      median_turns: median(known((r) => r.turns)), median_seconds: median(rs.map((r) => r.duration_ms / 1000)), median_cost: median(known((r) => r.cost)), denials: known((r) => r.denials).reduce((a, b) => a + b, 0) };
  })).filter((r) => r.n);
  const summary = { protocol: p.id, model: p.model, planned, run: records.length, spent_usd: spent, stopped, comparison, by_task: rows, baseline: summarizeReport(baseline), candidate: summarizeReport(candidate) };
  writeFileSync(join(out, 'baseline.json'), JSON.stringify(baseline, null, 2));
  writeFileSync(join(out, 'candidate.json'), JSON.stringify(candidate, null, 2));
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const f = (x: number | null, d = 0) => x === null ? 'unknown' : x.toFixed(d);
  writeFileSync(join(out, 'report.md'), `# 真实 Agent 对照首轮报告

- 协议：${p.id}；模型 ${p.model}；基线 ${p.baseline.commit.slice(0, 7)}，候选 ${p.candidate.commit.slice(0, 7)}
- 计划 ${planned} 个样本，实际 ${records.length} 个；累计花费 ${spent === null ? 'unknown' : `$${spent.toFixed(2)} / $${p.budget.total_usd}`}${stopped ? `；**提前停止：${stopped}**` : ''}
- 结论：**${comparison.result}**（${comparison.reasons.join('；')}；统计显著性 ${comparison.statistical_significance}）
- 人工介入：unknown（无人值守）；token：unknown；工程验收通过不代表真实收益
${notes.map((n) => `- ${n}`).join('\n')}

| 任务 | 版本 | 样本 | 通过 | 失败 | unknown | 漏检 | 误拦 | 中位轮数 | 中位耗时 s | 中位花费 $ | 权限拒绝 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r.task} | ${r.variant} | ${r.n} | ${r.pass} | ${r.fail} | ${r.unknown} | ${r.misses} | ${r.false_blocks} | ${f(r.median_turns)} | ${f(r.median_seconds)} | ${f(r.median_cost, 3)} | ${r.denials} |`).join('\n')}

## 失败与 unknown 明细

${records.filter((r) => r.outcome !== 'pass').map((r) => `- ${r.sample_id}（${r.outcome}）：${r.detail}；原始记录 ${r.raw_file} ${r.raw_sha256.slice(0, 19)}…`).join('\n') || '- 无'}
`);
  return summary;
}

// ── 桌面端模式：本脚本准备盲目录与提示，由宿主会话启动子 Agent，结束后 record 评分 ──
interface ManifestEntry { sample_id: string; task: TaskId; variant: Variant; repeat: number; root: string; proj: string; changeId: string; prompt: string }

// 第一轮冻结的只读规则；与"写 answer.md"冲突，见闭环演示
export const READONLY_RULE_V1 = '只能读文件、运行只读命令，不要修改任何文件。';

export function desktopPrompt(task: TaskId, root: string, proj: string, changeId: string, readonlyRule = READONLY_RULE_V1) {
  return `你在一个独立的项目里工作，项目根目录是 ${proj}。
规则：
- 只读写 ${proj} 内的文件，不要访问其他目录（最后写答复文件除外）。
- 开始前先读 ${proj}/CLAUDE.md 及其中提到的文件。需要用某个 devflow-xxx 技能时，读 ${proj}/.claude/skills/devflow-xxx/SKILL.md 并照做；不要使用 Skill 工具。
- 运行 devflow 命令时写成：cd ${proj} && PATH=${root}/bin:$PATH devflow <参数>
- ${task === 'omitted-permission' ? '可以修改代码、运行 mvn。' : readonlyRule}不要运行 devflow approve 或 devflow archive，不要提交。
- 完成后，把你给用户的最终答复原文写入 ${root}/answer.md。

任务：${PROMPTS[task](changeId)}`;
}

/** rules：闭环演示用，两组用同一 DevFlow 版本（候选）、只换只读规则文本 */
export function prepareDesktop(out: string, tasks: readonly TaskId[] = TASKS, reps?: number, rules?: Record<Variant, string>) {
  const p = loadComparisonProtocol();
  mkdirSync(join(out, 'raw'), { recursive: true });
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-agent-cmp-')));
  const versions = rules
    ? { baseline: prepareVersion(p.candidate.commit, join(work, 'v-a')), candidate: prepareVersion(p.candidate.commit, join(work, 'v-b')) }
    : { baseline: prepareVersion(p.baseline.commit, join(work, 'v-a')), candidate: prepareVersion(p.candidate.commit, join(work, 'v-b')) };
  const entries: ManifestEntry[] = schedule(tasks, reps ?? p.repetitions_per_variant).map((s, i) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'df-sample-')));
    const { proj, changeId } = setupProject(s.task, versions[s.variant], p.candidate.commit, root);
    const sample_id = `${String(i + 1).padStart(2, '0')}-${s.task}-${s.variant}-r${s.repeat + 1}`;
    return { sample_id, ...s, root, proj, changeId, prompt: desktopPrompt(s.task, root, proj, changeId, rules?.[s.variant]) };
  });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ work, rules: rules ?? null, entries }, null, 2));
  return entries;
}

/** 子 Agent 结束后：读取 answer.md、评分、写 raw 与 samples.jsonl、清理该样本目录 */
export function recordDesktop(out: string, sampleId: string, m: { duration_ms: number; tool_uses: number | null; tokens: number | null; status?: 'completed' | 'failed' | 'stopped' }, scorer: Scorer = defaultScorer) {
  const p = loadComparisonProtocol();
  const { entries } = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { entries: ManifestEntry[] };
  const e = entries.find((x) => x.sample_id === sampleId);
  if (!e) throw new Error(`manifest 中没有样本 ${sampleId}`);
  if (existsSync(join(out, 'samples.jsonl')) && read(out).some((r) => r.sample_id === sampleId)) throw new Error(`样本已记录，不补跑：${sampleId}`);
  const answerFile = join(e.root, 'answer.md');
  const answer = existsSync(answerFile) ? readFileSync(answerFile, 'utf8') : '';
  const over = (m.tool_uses ?? 0) > p.budget.max_turns_per_run ? `调用 ${m.tool_uses} 次超过上限` : m.duration_ms > p.budget.max_minutes_per_run * 60_000 ? '耗时超过 30 分钟' : null;
  const res: AgentResult = { exit: m.status === 'stopped' ? 'interrupted' : m.status === 'failed' ? 'error' : 'ok', subtype: over ? 'error_limit_exceeded' : answer ? 'success' : 'error_no_answer', result: answer, cost: null, turns: m.tool_uses, denials: null, raw: '' };
  const score = existsSync(e.proj) ? scorer(e.task, e.proj, res, e.changeId) : { outcome: 'unknown' as const, detail: '样本目录不存在', false_block: false };
  const diff = existsSync(e.proj) ? spawnSync('git', ['diff', 'HEAD', '--stat'], { cwd: e.proj, encoding: 'utf8' }).stdout : '';
  res.raw = JSON.stringify({ sample_id: sampleId, metrics: m, answer, diff_stat: diff });
  const raw_file = `raw/${sampleId}.json`;
  writeFileSync(join(out, raw_file), res.raw);
  const rec: SampleRecord = {
    sample_id: sampleId, task: e.task, variant: e.variant, commit: p[e.variant].commit, repeat: e.repeat, started_at: new Date(Date.now() - m.duration_ms).toISOString(),
    case_id: e.task, critical: true, outcome: score.outcome, completed: score.outcome === 'pass', duration_ms: m.duration_ms, manual_interventions: null, detail: score.detail,
    cost: null, turns: m.tool_uses, denials: null, subtype: res.subtype, false_block: score.false_block, raw_file, raw_sha256: sha(res.raw),
  };
  appendFileSync(join(out, 'samples.jsonl'), JSON.stringify(rec) + '\n');
  rmSync(e.root, { recursive: true, force: true });
  return rec;
}

const read = (out: string) => readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as SampleRecord);

export function summarizeDesktop(out: string) {
  const { work, entries, rules } = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { work: string; entries: ManifestEntry[]; rules: Record<Variant, string> | null };
  const recs = read(out);
  if (recs.length === entries.length) rmSync(work, { recursive: true, force: true });
  const notes = ['执行方式：桌面端 Sonnet 子 Agent（claude -p 无法认证）；花费、token 计入用户套餐，记为 unknown',
    'unknown 中 error_no_answer 表示子 Agent 未写 answer.md：只读规则"不要修改任何文件"与"写入 answer.md"冲突，属运行器提示缺陷，两版本同样受影响',
    '两版本使用相同 v1 夹具，候选新增的 v2 证据流程未被触发；omitted-permission 中 Agent 均自行按 spec 补上非管理员分支，本夹具未能区分版本'];
  if (rules) notes.unshift(`闭环演示对照：两组均为候选 DevFlow，baseline 用旧只读规则「${rules.baseline}」，candidate 用修复后规则「${rules.candidate}」`);
  return summarize(out, loadComparisonProtocol(), recs, entries.length, null, recs.length < entries.length ? `${entries.length - recs.length} 个样本未完成` : null, notes);
}

// ── 闭环演示（T3）：隔离演示仓库中走 反馈 → 报告 → 候选 → 提案 → 人批准 → 修复 → 回归 → 对照 → 回填 ──
export const DEMO_ROOT = '/tmp/devflow-loop-demo';
export const DEMO_CHANGE = '2026-11-08-readonly-answer-rule';
export const READONLY_RULE_V2 = '只能读文件、运行只读命令，不要修改项目内的任何文件；最后写入 answer.md 不算修改项目，必须写。';
const CHECK = `// 回归案例：只读规则必须明确允许写 answer.md\nimport { readFileSync } from 'node:fs';\nconst rule = readFileSync(new URL('./readonly-rule.txt', import.meta.url), 'utf8');\nif (!/answer\\.md/.test(rule)) { console.error('只读规则未豁免 answer.md，Agent 会拒写答复'); process.exit(1); }\nconsole.log('ok');\n`;

function demoSh(cmd: string, ...a: string[]) {
  return execFileSync(cmd, a, { cwd: DEMO_ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${join(DEMO_ROOT, '.bin')}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 阶段 A：建演示仓库、按第一轮真实 unknown 样本记录反馈、生成报告与候选、起草提案，停在等人批准 */
export function loopDemoPrepare(resultsDir: string) {
  if (existsSync(DEMO_ROOT)) throw new Error(`${DEMO_ROOT} 已存在，请先确认后删除`);
  const recs = read(resultsDir).filter((r) => r.subtype === 'error_no_answer');
  if (recs.length < 3) throw new Error('候选需要至少 3 条同类反馈');
  mkdirSync(join(DEMO_ROOT, 'runner'), { recursive: true });
  mkdirSync(join(DEMO_ROOT, '.bin'));
  writeFileSync(join(DEMO_ROOT, '.bin/devflow'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'src/cli.ts')}' "$@"\n`);
  chmodSync(join(DEMO_ROOT, '.bin/devflow'), 0o755);
  writeFileSync(join(DEMO_ROOT, '.gitignore'), '.bin/\n');
  writeFileSync(join(DEMO_ROOT, 'runner/readonly-rule.txt'), READONLY_RULE_V1 + '\n');
  writeFileSync(join(DEMO_ROOT, 'runner/check.mjs'), CHECK);
  demoSh('git', 'init', '-q'); demoSh('git', 'config', 'user.name', 'devflow-demo'); demoSh('git', 'config', 'user.email', 'demo@example.invalid'); demoSh('git', 'config', 'commit.gpgsign', 'false');
  demoSh('devflow', 'init', '--agents', 'claude');
  const pf = join(DEMO_ROOT, '.devflow/project.yaml');
  writeFileSync(pf, readFileSync(pf, 'utf8').replace(/^verify: \[\]$/m, 'verify:\n  - name: rule-check\n    run: node runner/check.mjs'));
  demoSh('git', 'add', '-A'); demoSh('git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'demo runner');
  const fbDir = join(DEMO_ROOT, '.feedback-input'); mkdirSync(fbDir);
  for (const r of recs) {
    const f = join(fbDir, `${r.sample_id}.json`);
    writeFileSync(f, JSON.stringify({ category: 'blocked', impact: '样本计为 unknown，无法得出对照结论', note: `第一轮真实对照样本 ${r.sample_id} 未写 answer.md；原始记录 ${r.raw_file} ${r.raw_sha256}` }));
    demoSh('devflow', 'usage', 'feedback', DEMO_CHANGE, '--file', f);
  }
  rmSync(fbDir, { recursive: true });
  const report = JSON.parse(demoSh('devflow', 'usage', 'report'));
  const cands = JSON.parse(demoSh('devflow', 'improve')) as { id: string; report_hash: string; count: number }[];
  if (cands.length !== 1) throw new Error(`预期 1 个候选，实际 ${cands.length}`);
  const cand = cands[0];
  demoSh('devflow', 'improve', 'draft', cand.id, DEMO_CHANGE);
  const dir = join(DEMO_ROOT, '.devflow/changes', DEMO_CHANGE);
  const draft = readFileSync(join(dir, 'proposal.md'), 'utf8');
  writeFileSync(join(dir, 'proposal.md'), draft.replace('待核实假设与验收标准后补齐。', `- 只读规则明确豁免 answer.md：runner/readonly-rule.txt。\n- 增加回归检查 runner/check.mjs，并纳入 verify。\n\n## 假设\n- 第一轮 ${recs.length} 个 unknown 都是子 Agent 认为"不要修改任何文件"禁止写 answer.md（见其答复原文）。\n\n## 不做什么\n- 不改第一轮冻结协议与结果；修复后的规则只用于本演示的新对照。\n`));
  writeFileSync(join(dir, 'change.yaml'), readFileSync(join(dir, 'change.yaml'), 'utf8').replace(/title: .*/, 'title: 只读规则豁免 answer.md').replace(/affected_paths: .*/, 'affected_paths:\n  - runner/**'));
  writeFileSync(join(dir, 'tasks.yaml'), `schema_version: 2\ntasks:\n  - id: T1\n    title: 只读规则豁免 answer.md\n    acceptance:\n      - id: AC1\n        text: runner/check.mjs 通过，只读规则包含 answer.md 豁免\n        method: automated\n        check: rule-check\n`);
  writeFileSync(join(dir, 'design.md'), '# 设计\n\n- 只改 runner/readonly-rule.txt 的措辞；check.mjs 断言规则中出现 answer.md。\n');
  const validate = demoSh('devflow', 'validate', DEMO_CHANGE);
  demoSh('git', 'add', '-A'); demoSh('git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `proposal ${DEMO_CHANGE}`);
  const chain = { demo_root: DEMO_ROOT, feedback: recs.map((r) => ({ sample_id: r.sample_id, raw_sha256: r.raw_sha256 })), report_path: cand && (report.jsonPath as string), candidate_id: cand.id, report_hash: cand.report_hash, proposal: DEMO_CHANGE, validate: validate.trim() };
  writeFileSync(join(resultsDir, 'loop-chain.json'), JSON.stringify(chain, null, 2));
  return chain;
}

/** 阶段 B（人批准后）：开工、确认回归案例在修复前失败、修复、verify、证据、task done、提交 */
export function loopDemoFix(resultsDir: string) {
  const chainFile = join(resultsDir, 'loop-chain.json');
  const chain = JSON.parse(readFileSync(chainFile, 'utf8'));
  const status = JSON.parse(demoSh('devflow', 'status', DEMO_CHANGE, '--json'))[0];
  if (!['approved', 'applying'].includes(status.status)) throw new Error(`演示变更状态为 ${status.status}，需要人先在自己的终端批准`);
  const approval = readFileSync(join(DEMO_ROOT, '.devflow/changes', DEMO_CHANGE, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'approved').at(-1);
  if (status.status === 'approved') demoSh('devflow', 'apply', DEMO_CHANGE, '--start');
  // 回归案例对已提交的旧规则必须失败（在仓库外的副本上跑，不动工作树）
  const tmpCheck = realpathSync(mkdtempSync(join(tmpdir(), 'df-check-')));
  writeFileSync(join(tmpCheck, 'check.mjs'), CHECK);
  writeFileSync(join(tmpCheck, 'readonly-rule.txt'), demoSh('git', 'show', 'HEAD:runner/readonly-rule.txt'));
  const before = spawnSync('node', ['check.mjs'], { cwd: tmpCheck, encoding: 'utf8' });
  rmSync(tmpCheck, { recursive: true, force: true });
  if (before.status === 0) throw new Error('回归案例在修复前应当失败');
  writeFileSync(join(DEMO_ROOT, 'runner/readonly-rule.txt'), READONLY_RULE_V2 + '\n');
  const verify = JSON.parse(demoSh('devflow', 'verify', DEMO_CHANGE, '--json'));
  // 证据输入放在仓库外：写进工作树会改变代码哈希，使 verify 记录失效
  const ev = join(realpathSync(mkdtempSync(join(tmpdir(), 'df-ev-'))), 'evidence.json');
  writeFileSync(ev, JSON.stringify({ task: 'T1', acceptance: 'AC1', kind: 'automated', summary: '回归检查通过', verify_run: verify.run_id, check: 'rule-check', test: 'runner/check.mjs', assertion: '只读规则包含 answer.md 豁免' }));
  demoSh('devflow', 'evidence', 'add', DEMO_CHANGE, '--file', ev); rmSync(ev);
  demoSh('devflow', 'task', 'done', DEMO_CHANGE, 'T1');
  demoSh('git', 'add', '-A'); demoSh('git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', `fix ${DEMO_CHANGE}`);
  const fixCommit = demoSh('git', 'rev-parse', 'HEAD').trim();
  Object.assign(chain, { approval: { by: approval?.actor ?? null, at: approval?.at ?? null, hash: approval?.hash ?? null }, regression_case: 'runner/check.mjs', regression_before_fix: 'fail', verify: verify.result ?? verify.status, fix_commit: fixCommit, final_status: JSON.parse(demoSh('devflow', 'status', DEMO_CHANGE, '--json'))[0].status, fixed_rule: READONLY_RULE_V2 });
  writeFileSync(chainFile, JSON.stringify(chain, null, 2));
  return chain;
}

/** 阶段 C：把修复后对照的结果回填候选 */
export function loopDemoResolve(resultsDir: string, comparisonDir: string) {
  const chainFile = join(resultsDir, 'loop-chain.json');
  const chain = JSON.parse(readFileSync(chainFile, 'utf8'));
  const summary = JSON.parse(readFileSync(join(comparisonDir, 'summary.json'), 'utf8'));
  const reportFile = join(comparisonDir, 'comparison.json');
  writeFileSync(reportFile, JSON.stringify({ result: summary.comparison.result, ...summary.comparison }, null, 2));
  const cand = JSON.parse(demoSh('devflow', 'improve', 'resolve', chain.candidate_id, '--report', reportFile));
  Object.assign(chain, { comparison: { dir: comparisonDir, result: summary.comparison.result, reasons: summary.comparison.reasons, by_task: summary.by_task }, candidate_after: { status: cand.status, result_links: cand.result_links } });
  writeFileSync(chainFile, JSON.stringify(chain, null, 2));
  return chain;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && ['loop-prepare', 'loop-fix', 'loop-compare', 'loop-resolve'].includes(process.argv[2])) {
  const [, , cmd, results, extra] = process.argv;
  if (cmd === 'loop-prepare') console.log(JSON.stringify(loopDemoPrepare(resolve(results)), null, 2));
  else if (cmd === 'loop-fix') console.log(JSON.stringify(loopDemoFix(resolve(results)), null, 2));
  else if (cmd === 'loop-compare') { for (const e of prepareDesktop(resolve(extra), ['new-session-resume'], 5, { baseline: READONLY_RULE_V1, candidate: readFileSync(join(DEMO_ROOT, 'runner/readonly-rule.txt'), 'utf8').trim() })) console.log(e.sample_id); }
  else console.log(JSON.stringify(loopDemoResolve(resolve(results), resolve(extra)), null, 2));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && ['prepare', 'record', 'summary'].includes(process.argv[2])) {
  const [, , cmd, out, ...rest] = process.argv;
  if (cmd === 'prepare') {
    if (existsSync(out) && readdirSync(out).length) throw new Error(`结果目录非空：${out}`);
    for (const e of prepareDesktop(resolve(out))) console.log(e.sample_id);
  } else if (cmd === 'record') {
    const [id, duration, toolUses, tokens, status] = rest;
    console.log(JSON.stringify(recordDesktop(resolve(out), id, { duration_ms: Number(duration), tool_uses: toolUses === 'null' ? null : Number(toolUses), tokens: tokens === 'null' ? null : Number(tokens), status: (status as 'completed') ?? 'completed' })));
  } else console.log(JSON.stringify(summarizeDesktop(resolve(out)), null, 2));
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tasks: { type: 'string' }, reps: { type: 'string' }, out: { type: 'string' } } });
  const tasks = values.tasks ? values.tasks.split(',') as TaskId[] : undefined;
  if (tasks?.some((t) => !TASKS.includes(t))) throw new Error(`未知任务：${values.tasks}`);
  const out = resolve(values.out ?? join(REPO, 'eval/results/agent-workflow-comparison', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')));
  if (existsSync(out) && readdirSync(out).length) throw new Error(`结果目录非空：${out}`);
  const s = runComparison({ out, tasks, reps: values.reps ? Number(values.reps) : undefined });
  console.log(JSON.stringify({ result: s.comparison.result, run: s.run, spent_usd: s.spent_usd, stopped: s.stopped }, null, 2));
  console.log(`结果：${out}`);
}
