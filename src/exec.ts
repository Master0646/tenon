// 执行阶段：apply --start、task done、verify（§5.3）
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DF, DevflowError, approvalCycle, changeSchema, listChanges, sha256, appendEvent, headCommit, readEvents, requireChange, requireInit, worktreeHash, type DevflowEvent } from './core.ts';
import { evidenceIssues } from './evidence.ts';
import { deriveStatus, type Status } from './status.ts';
import { loadTasks, validateProject } from './validate.ts';

const VERIFY_TIMEOUT_MS = 30 * 60_000; // shortcut: 固定 30 分钟；有需要时加到 project.yaml 的 verify 项上

function requireStatus(root: string, id: string, allowed: Status[], action: string) {
  const st = deriveStatus(root, id);
  if (!allowed.includes(st.status)) {
    throw new DevflowError(`当前状态为 ${st.status}，不能${action}`, st.reason);
  }
  return st;
}

export function applyStart(root: string, id: string): DevflowEvent {
  requireInit(root);
  requireChange(root, id);
  requireStatus(root, id, ['approved'], '开工');
  if (changeSchema(root, id) === 2) {
    const other = listChanges(root).filter((c) => c !== id).find((c) => ['applying', 'needs_fix', 'ready_to_archive'].includes(deriveStatus(root, c).status));
    if (other) throw new DevflowError(`变更 ${other} 已占用当前工作树`, '先完成该变更，或使用独立 Git worktree');
  }
  const ev: DevflowEvent = { type: 'apply-started', at: new Date().toISOString(), head: headCommit(root), approval_id: approvalCycle(root, id).approval_id };
  appendEvent(root, id, ev);
  return ev;
}

export function taskDone(root: string, id: string, task: string | undefined): DevflowEvent {
  requireInit(root);
  requireChange(root, id);
  if (!task) throw new DevflowError('缺少任务 ID', `用法：devflow task done ${id} <任务ID>`);
  requireStatus(root, id, ['applying', 'needs_fix'], '标记任务完成');
  const tasks = loadTasks(root, id);
  const t = tasks.find((x) => x.id === task);
  if (!t) throw new DevflowError(`任务不存在：${task}`, `可选：${tasks.map((x) => x.id).join(', ')}`);
  const done = new Set(approvalCycle(root, id).events.flatMap((e) => (e.type === 'task-done' ? [e.task] : [])));
  if (done.has(task) && !(changeSchema(root, id) === 2 && approvalCycle(root, id).events.findLast((e) => e.type === 'task-done' && e.task === task && e.worktree_hash === worktreeHash(root)) === undefined)) throw new DevflowError(`任务 ${task} 已标记完成`);
  const pending = (t.depends_on ?? []).filter((d) => !done.has(d) || (changeSchema(root, id) === 2 && evidenceIssues(root, id, d).length));
  if (pending.length) throw new DevflowError(`任务 ${task} 依赖的任务尚未完成：${pending.join(', ')}`);
  if (changeSchema(root, id) === 2) {
    const issues = evidenceIssues(root, id, task);
    if (issues.length) throw new DevflowError('验收证据不完整', issues.join('\n'));
  }
  const ev: DevflowEvent = { type: 'task-done', at: new Date().toISOString(), task, approval_id: approvalCycle(root, id).approval_id, ...(changeSchema(root, id) === 2 ? { worktree_hash: worktreeHash(root) } : {}) };
  appendEvent(root, id, ev);
  return ev;
}

export interface VerifyResult {
  result: 'pass' | 'fail' | 'unknown';
  run_id: string;
  checks: { name: string; exit: number | null; log_hash: string; ms: number; log: string; note?: string }[];
  note?: string;
}

/** 运行 project.yaml 中声明的验证命令（由人维护、计入批准哈希）；结果绑定工作树哈希 */
export function verify(root: string, id: string): VerifyResult {
  requireInit(root);
  requireChange(root, id);
  if (validateProject(root).length) throw new DevflowError('project.yaml 校验不通过', '运行 devflow check 查看');
  requireStatus(root, id, ['applying', 'needs_fix', 'ready_to_archive'], '验证');
  const project = parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8'));
  const commands: { name: string; run: string; cwd?: string }[] = project.verify ?? [];

  const run_id = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = join(root, DF, 'runtime', 'verify', id, stamp);
  mkdirSync(logDir, { recursive: true });

  const before = worktreeHash(root);
  const checks: VerifyResult['checks'] = commands.map((c) => {
    const started = Date.now();
    const r = spawnSync('sh', ['-c', c.run], {
      cwd: join(root, c.cwd ?? '.'), encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    });
    const log = join(logDir, `${c.name}.log`);
    writeFileSync(log, `$ ${c.run}\n\n${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
    const timedOut = r.signal === 'SIGTERM' || (r.error as any)?.code === 'ETIMEDOUT';
    // 127 = 命令不存在、126 = 不可执行：没跑起来，不能算失败也不能算通过
    const note = timedOut ? '超时' : r.error ? r.error.message : r.status === 127 || r.status === 126 ? '命令无法运行' : undefined;
    return { name: c.name, log_hash: sha256(readFileSync(log)), exit: timedOut || r.error ? null : r.status, ms: Date.now() - started, log, note };
  });
  const after = worktreeHash(root);

  let result: VerifyResult['result'];
  let note: string | undefined;
  if (!commands.length) {
    result = 'unknown';
    note = 'project.yaml 没有声明任何验证命令';
  } else if (before !== after) {
    result = 'unknown';
    note = '验证期间工作树发生变化（构建产物是否未被 .gitignore 忽略？）';
  } else if (checks.some((c) => c.note)) result = 'unknown';
  else result = checks.every((c) => c.exit === 0) ? 'pass' : 'fail';

  appendEvent(root, id, {
    type: 'verified', run_id, approval_id: approvalCycle(root, id).approval_id, at: new Date().toISOString(), diff_hash: before, result,
    checks: checks.map((c) => ({ name: c.name, exit: c.exit, log_hash: c.log_hash })),
  });
  return { result, checks, note, run_id };
}
