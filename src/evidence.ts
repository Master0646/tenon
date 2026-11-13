// 验收证据只证明检查有来源；业务覆盖充分性由审查者判断。
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import {
  DF, DevflowError, appendEvent, approvalCycle, git, hashFiles, requireChange, requireInit,
  readEvents, reviewedFiles, sha256, worktreeHash, type DevflowEvent,
} from './core.ts';
import { loadTasks } from './validate.ts';
import { isExcluded, loadExcludes } from './wiki.ts';

type Recorded = Extract<DevflowEvent, { type: 'evidence-recorded' }>;
interface Condition { id: string; text: string; method: 'automated' | 'manual'; check?: string }
export interface EvidenceRow {
  task: string; acceptance: string; text: string; method: string;
  status: 'valid' | 'missing' | 'stale' | 'unconfirmed' | 'invalid';
  evidence_id?: string; worktree_hash?: string; reason?: string;
}

function text(value: unknown, label: string, limit = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new DevflowError(`${label} 必须是非空字符串且不超过 ${limit} 字节`);
  }
  return value;
}

function safeFile(root: string, path: unknown): string {
  const rel = text(path, '文件路径', 1024);
  if (isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((p) => p === '..' || !p)) {
    throw new DevflowError(`文件路径必须位于仓库内：${rel}`);
  }
  const abs = resolve(root, rel);
  if (relative(resolve(root), abs).startsWith('..') || isExcluded(rel, loadExcludes(root))) {
    throw new DevflowError(`文件越界或属于 exclude：${rel}`);
  }
  let current = resolve(root);
  try {
    for (const part of relative(resolve(root), abs).split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new DevflowError(`不允许符号链接：${rel}`);
    }
    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new DevflowError(`必须是普通文件且不超过 1 MiB：${rel}`);
  } catch (e) {
    if (e instanceof DevflowError) throw e;
    throw new DevflowError(`文件不存在或不可读：${rel}`);
  }
  return abs;
}

function conditions(root: string, id: string, task?: string): { task: string; condition: Condition }[] {
  return loadTasks(root, id).filter((t) => !task || t.id === task).flatMap((t) =>
    (t.acceptance ?? []).filter((a): a is Condition => typeof a === 'object' && a !== null).map((condition) => ({ task: t.id, condition })),
  );
}

/**
 * 验收条件的指纹：条件文本、验收方式、检查名及其命令。
 * 重新批准后指纹没变的条件，旧批准下记录的证据（代码也没变时）仍然证明它。
 */
function conditionHash(root: string, c: Condition): string {
  let command: unknown = null;
  if (c.check) {
    try {
      const v = parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8'))?.verify?.find((x: any) => x?.name === c.check);
      command = v ? [v.run, v.cwd ?? null] : null;
    } catch { /* 格式错误由 validate 报告 */ }
  }
  return sha256(JSON.stringify([c.text, c.method, c.check ?? null, command]));
}

function active(root: string, id: string) {
  requireInit(root);
  requireChange(root, id);
  const meta = parse(readFileSync(join(root, DF, 'changes', id, 'change.yaml'), 'utf8'));
  if (meta.schema_version !== 2) throw new DevflowError('验收证据命令仅适用于 schema_version: 2 变更');
  const cycle = approvalCycle(root, id);
  if (!cycle.approved || cycle.approved.hash !== hashFiles(root, reviewedFiles(root, id))) {
    throw new DevflowError('当前批准无效，需要重新批准');
  }
  if (!cycle.events.some((e) => e.type === 'apply-started')) throw new DevflowError('尚未开工');
  return cycle;
}

export function recordEvidence(root: string, id: string, input: unknown): Recorded {
  const cycle = active(root, id);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DevflowError('证据输入必须是 JSON 对象');
  const value = input as Record<string, unknown>;
  const allowed = new Set(['task', 'acceptance', 'kind', 'summary', 'verify_run', 'check', 'test', 'assertion', 'procedure', 'expected', 'observed', 'artifacts']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new DevflowError(`未知证据字段：${key}`);
  const task = text(value.task, 'task', 128);
  const acceptance = text(value.acceptance, 'acceptance', 128);
  const found = conditions(root, id, task).find((c) => c.condition.id === acceptance);
  if (!found) throw new DevflowError(`任务验收条件不存在：${task}/${acceptance}`);
  const kind = value.kind;
  if ((kind !== 'automated' && kind !== 'manual') || kind !== found.condition.method) throw new DevflowError('证据方式与批准的验收条件不一致');
  const currentHash = worktreeHash(root);
  const event: Recorded = {
    type: 'evidence-recorded', at: new Date().toISOString(), evidence_id: randomUUID(), approval_id: cycle.approval_id,
    worktree_hash: currentHash, task, acceptance, kind,
    summary: text(value.summary, 'summary'), artifacts: [], condition_hash: conditionHash(root, found.condition),
  };
  if (kind === 'automated') {
    event.verify_run = text(value.verify_run, 'verify_run', 128);
    event.check = text(value.check, 'check', 128);
    const run = cycle.events.findLast((e) => e.type === 'verified' && e.run_id === event.verify_run);
    if (run?.type !== 'verified' || run.diff_hash !== currentHash || run.result === 'unknown' ||
        (run.approval_id !== undefined && run.approval_id !== cycle.approval_id) ||
        event.check !== found.condition.check || !run.checks.some((c) => c.name === event.check && c.exit === 0)) {
      throw new DevflowError('自动证据必须引用本轮批准、当前代码下成功的指定验证检查');
    }
    event.test = text(value.test, 'test', 1024);
    safeFile(root, event.test);
    event.assertion = text(value.assertion, 'assertion');
  } else {
    event.procedure = text(value.procedure, 'procedure');
    event.expected = text(value.expected, 'expected');
    event.observed = text(value.observed, 'observed');
  }
  const artifacts = value.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 10) throw new DevflowError('artifacts 必须是最多 10 个仓库内文件路径的数组');
  // 先验证所有输入，再复制；输入文件的文本永远不会被作为命令执行。
  const files = artifacts.map((file) => safeFile(root, file));
  const dir = join(root, DF, 'evidence', id, event.evidence_id);
  let created = false;
  try {
    let parent = resolve(root);
    for (const part of relative(resolve(root), dir).split(sep)) {
      parent = join(parent, part);
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new DevflowError('证据存储目录不允许符号链接');
    }
    if (files.length) { mkdirSync(dir, { recursive: true }); created = true; }
    files.forEach((file, i) => {
      const path = `${DF}/evidence/${id}/${event.evidence_id}/${i}-${basename(file)}`;
      copyFileSync(file, join(root, path));
      event.artifacts.push({ path, hash: sha256(readFileSync(join(root, path))) });
    });
    if (currentHash !== worktreeHash(root)) throw new DevflowError('记录证据期间代码变化，请重新验证');
    appendEvent(root, id, event);
  } catch (e) {
    if (created) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return event;
}

export function confirmEvidence(root: string, id: string, evidenceId: string): DevflowEvent {
  const cycle = active(root, id);
  const recorded = readEvents(root, id).find((e) => e.type === 'evidence-recorded' && e.evidence_id === evidenceId);
  const condition = recorded?.type === 'evidence-recorded' ? conditions(root, id, recorded.task).find((c) => c.condition.id === recorded.acceptance)?.condition : undefined;
  // 旧批准下记录的证据：验收条件没变才可以继续确认
  if (recorded?.type !== 'evidence-recorded' || recorded.kind !== 'manual' || !condition || (recorded.approval_id !== cycle.approval_id && recorded.condition_hash !== conditionHash(root, condition))) {
    throw new DevflowError('本轮批准没有该人工证据');
  }
  const hash = worktreeHash(root);
  if (recorded.worktree_hash !== hash || artifactProblem(root, recorded)) throw new DevflowError('证据已失效，请重新建立');
  const actor = git(root, ['config', 'user.name']).trim();
  if (!actor) throw new DevflowError('请先配置 git user.name');
  const event: DevflowEvent = { type: 'evidence-confirmed', at: new Date().toISOString(), evidence_id: evidenceId, approval_id: cycle.approval_id, worktree_hash: hash, actor };
  appendEvent(root, id, event);
  return event;
}

function artifactProblem(root: string, event: Recorded): string | undefined {
  for (const artifact of event.artifacts) {
    try {
      if (!artifact.path.startsWith(`${DF}/evidence/`) || sha256(readFileSync(safeFile(root, artifact.path))) !== artifact.hash) return `附件内容不一致：${artifact.path}`;
    } catch { return `附件不存在或无效：${artifact.path}`; }
  }
}

export function evidenceMatrix(root: string, id: string): EvidenceRow[] {
  const cycle = approvalCycle(root, id);
  const all = readEvents(root, id);
  const hash = worktreeHash(root);
  return conditions(root, id).map(({ task, condition }) => {
    const row: EvidenceRow = { task, acceptance: condition.id, text: condition.text, method: condition.method, status: 'missing', reason: '缺少本轮验收证据' };
    const event = all.findLast((e) => e.type === 'evidence-recorded' && e.task === task && e.acceptance === condition.id);
    if (event?.type !== 'evidence-recorded') return row;
    row.evidence_id = event.evidence_id;
    row.worktree_hash = event.worktree_hash;
    // 旧批准下的证据：验收条件（含检查命令）没变、代码没变时沿用，不用重录
    const carried = event.approval_id !== cycle.approval_id;
    if ((carried && event.condition_hash !== conditionHash(root, condition)) || event.worktree_hash !== hash) return { ...row, status: 'stale', reason: '验收条件或代码已变化，需要重新验证' };
    const badArtifact = artifactProblem(root, event);
    if (badArtifact) return { ...row, status: 'invalid', reason: badArtifact };
    if (event.kind !== condition.method) return { ...row, status: 'invalid', reason: '验收方式不一致' };
    if (event.kind === 'automated') {
      const run = all.find((e) => e.type === 'verified' && e.run_id === event.verify_run);
      if (run?.type !== 'verified' || run.diff_hash !== hash || run.result === 'unknown' || event.check !== condition.check || !run.checks.some((c) => c.name === event.check && c.exit === 0)) {
        return { ...row, status: 'invalid', reason: '指定检查没有有效成功记录' };
      }
    } else if (!all.some((e) => e.type === 'evidence-confirmed' && e.evidence_id === event.evidence_id && e.worktree_hash === hash)) {
      return { ...row, status: 'unconfirmed', reason: '等待人工确认' };
    }
    return { ...row, status: 'valid', reason: undefined };
  });
}

export function evidenceIssues(root: string, id: string, taskId?: string): string[] {
  return evidenceMatrix(root, id).filter((r) => (!taskId || r.task === taskId) && r.status !== 'valid').map((r) => `${r.task}/${r.acceptance}: ${r.reason}`);
}
