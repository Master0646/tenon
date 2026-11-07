// 派生状态与批准：状态不落盘，每次由 变更文件 + 事件日志 + git 现算
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evidenceIssues } from './evidence.ts';
import {
  DF, DevflowError, appendEvent, parseEvents, changedPaths, currentSpecHash, git, hashFiles, headCommit, readEvents,
  requireChange, requireInit, reviewedFiles, specCaps, worktreeHash, changeSchema, approvalCycle, sha256, type DevflowEvent,
} from './core.ts';
import { loadChangeMeta, loadTasks, validateChange } from './validate.ts';

export interface ArchivedChange { id: string; status: 'archived'; archived_at: string | null }

/** changes/archive/ 下的已归档变更；归档时间取事件日志最后一条 archived 事件 */
export function listArchived(root: string): ArchivedChange[] {
  const dir = join(root, DF, 'changes', 'archive');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().map((id) => {
    let at: string | null = null;
    try {
      const ev = parseEvents(readFileSync(join(dir, id, 'events.jsonl'), 'utf8'), id).findLast((e) => e.type === 'archived');
      at = ev?.at ?? null;
    } catch { /* 日志缺失或损坏：时间未知 */ }
    return { id, status: 'archived' as const, archived_at: at };
  });
}

export type Status = 'draft' | 'rebase_required' | 'approved' | 'applying' | 'needs_fix' | 'ready_to_archive' | 'archived';

export interface ChangeStatus {
  id: string;
  status: Status;
  reason: string;
  tasks: { done: number; total: number };
}

type Of<T extends DevflowEvent['type']> = Extract<DevflowEvent, { type: T }>;
const lastOf = <T extends DevflowEvent['type']>(ev: DevflowEvent[], type: T): Of<T> | undefined =>
  ev.findLast((e): e is Of<T> => e.type === type);

export function deriveStatus(root: string, id: string): ChangeStatus {
  const ev = readEvents(root, id);
  const taskIds = loadTasks(root, id).map((t) => t.id);
  const cycle = approvalCycle(root, id);
  const v2 = changeSchema(root, id) === 2;
  const currentHash = v2 ? worktreeHash(root) : undefined;
  const done = new Set(cycle.events.flatMap((e) => (e.type === 'task-done' && (!v2 || e.worktree_hash === currentHash) && (e.approval_id === cycle.approval_id || (!v2 && !e.approval_id)) ? [e.task] : [])));
  const tasks = { done: taskIds.filter((t) => done.has(t) && (!v2 || !evidenceIssues(root, id, t).length)).length, total: taskIds.length };
  const r = (status: Status, reason: string): ChangeStatus => ({ id, status, reason, tasks });

  if (ev.some((e) => e.type === 'archived')) return r('archived', '已归档');

  const ok = lastOf(ev, 'approved');
  if (!ok) return r('draft', '尚未批准');
  if (ok.hash !== hashFiles(root, reviewedFiles(root, id))) {
    return r('draft', '批准后被审文件或 project.yaml 有改动，需要重新批准');
  }

  const snapshotErrors = snapshotIssues(root, id);
  if (snapshotErrors.length) return r('needs_fix', snapshotErrors.join('；'));
  for (const cap of specCaps(root, id)) {
    if ((ok.spec_base[cap] ?? null) !== currentSpecHash(root, cap)) return r('rebase_required', `规范 ${cap} 在批准后变化，需要更新 delta 并重新批准`);
  }

  // 开工、验证只认最近一次批准之后的记录：重新批准意味着方案变了
  const after = cycle.events.filter((e) => ('approval_id' in e && e.approval_id === cycle.approval_id) || (!v2 && (!('approval_id' in e) || !e.approval_id)));
  if (!lastOf(after, 'apply-started')) {
    let moved: string[];
    try {
      moved = changedPaths(root, ok.base_commit, loadChangeMeta(root, id)?.affected_paths ?? []);
    } catch {
      return r('rebase_required', `批准时的基线提交 ${ok.base_commit.slice(0, 7)} 已不在当前历史中`);
    }
    return moved.length
      ? r('rebase_required', `批准后有提交改动了影响路径：${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ' …' : ''}`)
      : r('approved', '已批准，可以开工');
  }

  const v = lastOf(after, 'verified');
  if (!v) return r('applying', '开工后尚未验证');
  if (v.diff_hash !== worktreeHash(root)) return r('applying', '验证后代码有改动，需要重新验证');
  if (v.result !== 'pass') return r('needs_fix', `最近一次验证结果为 ${v.result}`);
  if (tasks.done < tasks.total) return r('applying', `还有 ${tasks.total - tasks.done} 个任务未完成或验收证据失效`);
  return r('ready_to_archive', '验证通过，等待人工归档');
}

/** 计算批准事件（不写入）。CLI 先展示给人确认，确认后再调用 approve */
export function prepareApproval(root: string, id: string): Of<'approved'> {
  requireInit(root);
  requireChange(root, id);
  const errors = validateChange(root, id, true).filter((i) => i.level === 'error');
  if (errors.length) throw new DevflowError(`变更校验有 ${errors.length} 个错误，不能批准`, `运行 devflow validate ${id} 查看`);
  const st = deriveStatus(root, id);
  if (st.status !== 'draft' && st.status !== 'rebase_required') {
    throw new DevflowError(`当前状态为 ${st.status}，不需要批准`, st.reason);
  }
  let actor = '';
  try {
    actor = git(root, ['config', 'user.name']).trim();
  } catch { /* 未配置 */ }
  if (!actor) throw new DevflowError('未配置 git user.name，无法记录批准人', 'git config user.name "<你的名字>"');
  return {
    type: 'approved',
    at: new Date().toISOString(),
    actor,
    hash: hashFiles(root, reviewedFiles(root, id)),
    base_commit: headCommit(root),
    spec_base: Object.fromEntries(specCaps(root, id).map((c) => [c, currentSpecHash(root, c)])),
  };
}

/** 写入批准；expectHash 用于确认"人看到的"与"写入的"是同一份内容 */
export function approve(root: string, id: string, expectHash?: string): Of<'approved'> {
  const ev = prepareApproval(root, id);
  if (expectHash && ev.hash !== expectHash) {
    throw new DevflowError('确认期间被审文件发生了变化，已取消批准', `重新运行 devflow approve ${id}`);
  }
  if (changeSchema(root, id) === 2) {
    const approvalId = randomUUID();
    const files = reviewedFiles(root, id).sort().map((path) => ({ path, content: readFileSync(join(root, path)).toString('base64') }));
    const captured = createHash('sha256');
    for (const f of files) captured.update(f.path + '\0').update(Buffer.from(f.content, 'base64')).update('\0');
    if ('sha256:' + captured.digest('hex') !== ev.hash) throw new DevflowError('保存快照期间被审文件发生变化，请重新批准');
    const snapshot = JSON.stringify({ schema_version: 1, files });
    if (hashFiles(root, reviewedFiles(root, id)) !== ev.hash) throw new DevflowError('保存快照期间被审文件发生变化，请重新批准');
    const target = snapshotFile(root, id, approvalId);
    const temporary = `${dirname(target)}.tmp-${randomUUID()}`;
    mkdirSync(temporary, { recursive: true });
    try {
      writeFileSync(join(temporary, 'snapshot.json'), snapshot);
      mkdirSync(dirname(dirname(target)), { recursive: true });
      renameSync(temporary, dirname(target));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    ev.approval_id = approvalId;
    ev.snapshot_hash = sha256(snapshot);
    if (hashFiles(root, reviewedFiles(root, id)) !== ev.hash) throw new DevflowError('保存快照期间被审文件发生变化，请重新批准');
  }
  appendEvent(root, id, ev);
  return ev;
}

interface SnapshotFile { path: string; content: string }
const snapshotFile = (root: string, id: string, approvalId: string) => join(root, DF, 'reviews', id, approvalId, 'snapshot.json');

function readSnapshot(root: string, id: string): SnapshotFile[] | null {
  const approved = approvalCycle(root, id).approved;
  if (!approved) return null;
  if (!approved.approval_id || !/^[0-9a-f-]{36}$/.test(approved.approval_id) || !approved.snapshot_hash) {
    if (changeSchema(root, id) === 2) throw new Error('缺少批准快照记录');
    return null;
  }
  const text = readFileSync(snapshotFile(root, id, approved.approval_id), 'utf8');
  if (sha256(text) !== approved.snapshot_hash) throw new Error('批准快照哈希不一致');
  const snapshot = JSON.parse(text);
  if (snapshot.schema_version !== 1 || !Array.isArray(snapshot.files)) throw new Error('批准快照格式错误');
  const seen = new Set<string>();
  const hash = createHash('sha256');
  const files: SnapshotFile[] = snapshot.files;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..') || seen.has(f.path) || typeof f.content !== 'string') throw new Error('批准快照文件清单无效');
    seen.add(f.path);
    const data = Buffer.from(f.content, 'base64');
    if (data.toString('base64') !== f.content) throw new Error('批准快照内容编码无效');
    hash.update(f.path + '\0').update(data).update('\0');
  }
  if ('sha256:' + hash.digest('hex') !== approved.hash) throw new Error('批准快照与批准内容不一致');
  return files;
}

export function snapshotIssues(root: string, id: string): string[] {
  try { readSnapshot(root, id); return []; }
  catch (e) { return [`批准快照缺失或损坏，请从 Git 恢复：${e instanceof Error ? e.message : String(e)}`]; }
}

export function approvalDiff(root: string, id: string): { available: boolean; reason?: string; files: { path: string; before: string | null; after: string | null }[] } {
  let old: SnapshotFile[] | null;
  try { old = readSnapshot(root, id); }
  catch (e) { return { available: false, reason: String(e), files: [] }; }
  if (!old) return { available: false, reason: '没有上次批准快照，无法还原批准全文', files: [] };
  const before = new Map(old.map((f) => [f.path, Buffer.from(f.content, 'base64').toString('utf8')]));
  const current = reviewedFiles(root, id);
  const files = [...new Set([...before.keys(), ...current])].sort().map((path) => ({
    path, before: before.get(path) ?? null,
    after: current.includes(path) ? readFileSync(join(root, path), 'utf8') : null,
  })).filter((f) => f.before !== f.after);
  return { available: true, files };
}
