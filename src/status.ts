// 派生状态与批准：状态不落盘，每次由 变更文件 + 事件日志 + git 现算
import {
  DevflowError, appendEvent, changedPaths, currentSpecHash, git, hashFiles, headCommit, readEvents,
  requireChange, requireInit, reviewedFiles, specCaps, worktreeHash, type DevflowEvent,
} from './core.ts';
import { loadChangeMeta, loadTasks, validateChange } from './validate.ts';

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
  const done = new Set(ev.flatMap((e) => (e.type === 'task-done' ? [e.task] : [])));
  const tasks = { done: taskIds.filter((t) => done.has(t)).length, total: taskIds.length };
  const r = (status: Status, reason: string): ChangeStatus => ({ id, status, reason, tasks });

  if (ev.some((e) => e.type === 'archived')) return r('archived', '已归档');

  const ok = lastOf(ev, 'approved');
  if (!ok) return r('draft', '尚未批准');
  if (ok.hash !== hashFiles(root, reviewedFiles(root, id))) {
    return r('draft', '批准后被审文件或 project.yaml 有改动，需要重新批准');
  }

  // 开工、验证只认最近一次批准之后的记录：重新批准意味着方案变了
  const after = ev.slice(ev.lastIndexOf(ok) + 1);
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
  if (tasks.done < tasks.total) return r('applying', `还有 ${tasks.total - tasks.done} 个任务未完成`);
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
  appendEvent(root, id, ev);
  return ev;
}
