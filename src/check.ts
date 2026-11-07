// devflow check：pre-commit hook 与 CI 的门禁
// --staged 时规范锁与事件日志按暂存区内容检查：提交的是暂存区，不是工作树
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DF, DevflowError, parseEvents, changeDir, changeRel, git, listChanges, readEvents, repoFiles, requireInit, sha256, type Issue,
} from './core.ts';
import { snapshotIssues } from './status.ts';
import { evidenceIssues } from './evidence.ts';
import { changeSchema } from './core.ts';
import { deriveStatus } from './status.ts';
import { enforceLevel, loadChangeMeta, validateChange, validateProject } from './validate.ts';
import { lintWiki } from './wiki.ts';

const STARTED = new Set(['applying', 'needs_fix', 'ready_to_archive']);

export function check(root: string, opts: { staged: boolean }): Issue[] {
  requireInit(root);
  const issues = validateProject(root);

  for (const id of listChanges(root)) {
    issues.push(...validateChange(root, id, false));
    const rel = `${changeRel(id)}/events.jsonl`;
    try {
      readEvents(root, id);
    } catch (e) {
      if (!(e instanceof DevflowError)) throw e;
      issues.push({ level: 'error', file: rel, message: e.message, hint: e.hint });
    }
    issues.push(...appendOnly(root, rel, opts.staged));
    if (!opts.staged && changeSchema(root, id) === 2) {
      for (const message of snapshotIssues(root, id)) issues.push({ level: 'error', file: rel, message });
      for (const message of evidenceIssues(root, id).filter((m) => /附件|artifact/.test(m))) issues.push({ level: 'error', file: rel, message });
    }
  }

  if (opts.staged) issues.push(...stagedProofIssues(root));
  issues.push(...checkSpecLock(root, opts.staged));
  if (opts.staged) issues.push(...checkStagedCode(root));
  // 知识页问题不拦提交：删了被引用的代码文件不应阻止提交，由 wiki lint 与 archive 把关
  issues.push(...lintWiki(root).issues.map((i) => ({ ...i, level: 'warn' as const })));
  return issues;
}

/** 暂存区中的文件内容；不在暂存区时返回 null */
function indexContent(root: string, rel: string): string | null {
  try {
    return git(root, ['show', `:${rel}`]);
  } catch {
    return null;
  }
}

/** 暂存区中某目录下的文件，返回相对该目录的路径 */
function indexFiles(root: string, relDir: string): string[] {
  const prefix = `${relDir}/`;
  return git(root, ['ls-files', '-z', '--cached', '--', relDir]).split('\0')
    .filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)).sort();
}

const worktreeText = (root: string, rel: string): string => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');

/** 已暂存的文件（相对仓库根目录）；globs 给出时只返回落在其中的 */
function stagedFiles(root: string, globs?: string[], filter?: string): string[] {
  return git(root, ['diff', '--cached', '--name-only', ...(filter ? [`--diff-filter=${filter}`] : []), '--', ...(globs ?? []).map((g) => `:(glob)${g}`)])
    .split('\n').filter(Boolean);
}

/** 事件日志只能追加：与 HEAD 中的版本相比，旧内容必须原样保留在开头 */
function appendOnly(root: string, rel: string, staged: boolean): Issue[] {
  let old = '';
  try {
    old = git(root, ['show', `HEAD:${rel}`]);
  } catch {
    return []; // HEAD 中还没有这个文件
  }
  const cur = staged ? indexContent(root, rel) ?? '' : worktreeText(root, rel);
  return cur.startsWith(old) ? [] : [{
    level: 'error', file: rel, message: '事件日志的已提交内容被修改或删除（只允许追加）',
    hint: `用 git restore ${rel} 恢复；事件只能由 devflow 命令写入`,
  }];
}

/** 当前规范只能经 archive 修改：内容必须与 specs.lock 一致 */
function checkSpecLock(root: string, staged: boolean): Issue[] {
  const rel = `${DF}/specs`;
  const lockRel = `${rel}/specs.lock`;
  // 读取源：暂存区或工作树
  const read = (f: string): string | Buffer | null => (staged ? indexContent(root, `${rel}/${f}`) : existsSync(join(root, rel, f)) ? readFileSync(join(root, rel, f)) : null);
  let lock: Record<string, string>;
  try {
    lock = JSON.parse(String(read('specs.lock')));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error();
  } catch {
    return [{ level: 'error', file: lockRel, message: 'specs.lock 缺失或不是合法的 JSON 对象', hint: `用 git restore ${lockRel} 恢复` }];
  }
  const hint = '规范只能经 devflow archive 修改。撤销手改：git restore <文件>（新加的文件直接删除）；要改规范，请新建变更并归档';
  const issues: Issue[] = [];
  const files = (staged ? indexFiles(root, rel) : repoFiles(root, rel)).filter((f) => f !== 'specs.lock' && f !== '.gitkeep');
  for (const f of files) {
    if (lock[f] !== sha256(read(f) ?? '')) {
      issues.push({ level: 'error', file: `${DF}/specs/${f}`, message: lock[f] ? '内容与 specs.lock 不符（被手动修改）' : '不在 specs.lock 中（被手动添加）', hint });
    }
  }
  for (const f of Object.keys(lock)) {
    if (!files.includes(f)) issues.push({ level: 'error', file: `${DF}/specs/${f}`, message: 'specs.lock 中有记录，但文件被删除', hint });
  }
  return issues;
}

/**
 * 暂存了变更影响路径内的代码时：变更未开工 → 警告（strict 拒绝）；已开工但事件日志未暂存 → 警告。
 * 有已开工的变更时，暂存了不属于任何进行中变更影响路径的文件 → 警告。
 */
function checkStagedCode(root: string): Issue[] {
  // affected_paths 不能在 .devflow/ 下，只暂存了 .devflow/ 时三条规则都不适用
  if (!stagedFiles(root).some((f) => !f.startsWith(`${DF}/`))) return [];
  const level = enforceLevel(root) === 'strict' ? 'error' : 'warn';
  const issues: Issue[] = [];
  const globs: string[] = [];
  const startedGlobs: string[] = [];
  const pending: { id: string; paths: string[]; status: string; reason: string }[] = [];
  for (const id of listChanges(root)) {
    const meta = loadChangeMeta(root, id);
    if (!meta?.affected_paths.length || !existsSync(changeDir(root, id))) continue;
    globs.push(...meta.affected_paths);
    let st;
    try {
      st = deriveStatus(root, id);
    } catch {
      continue; // 事件日志损坏，已在上面报告
    }
    if (STARTED.has(st.status)) {
      startedGlobs.push(...meta.affected_paths);
      const staged = stagedFiles(root, meta.affected_paths);
      const rel = `${changeRel(id)}/events.jsonl`;
      if (staged.length && (indexContent(root, rel) ?? '') !== worktreeText(root, rel)) {
        issues.push({
          level: 'warn', file: rel,
          message: `变更 ${id} 的记录未暂存：批准与验证记录（events.jsonl）不会随这次提交进入仓库`,
          hint: `git add ${changeRel(id)}`,
        });
      }
      continue;
    }
    pending.push({ id, paths: meta.affected_paths, status: st.status, reason: st.reason });
  }
  // 已被某个已开工变更覆盖的文件，不再以其他未开工变更的名义报"未开工"
  const byStarted = new Set(startedGlobs.length ? stagedFiles(root, startedGlobs) : []);
  for (const { id, paths, status, reason } of pending) {
    const staged = stagedFiles(root, paths).filter((f) => !byStarted.has(f));
    if (!staged.length) continue;
    issues.push({
      level, file: staged.slice(0, 5).join(', ') + (staged.length > 5 ? ' …' : ''),
      message: `这些文件属于变更 ${id} 的影响路径，但该变更状态为 ${status}（${reason}）`,
      hint: `先批准（devflow approve ${id}）并开工，再提交这些文件`,
    });
  }
  if (startedGlobs.length) {
    const covered = new Set(stagedFiles(root, globs, 'd'));
    const outside = stagedFiles(root, undefined, 'd').filter((f) => !covered.has(f) && !f.startsWith(`${DF}/`));
    if (outside.length) {
      issues.push({
        level: 'warn', file: outside.slice(0, 5).join(', ') + (outside.length > 5 ? ' …' : ''),
        message: '这些已暂存的文件不在任何进行中变更的 affected_paths 内',
        hint: '确认这些文件应该随本次提交；属于本变更的话，下次在 change.yaml 的 affected_paths 中写上',
      });
    }
  }
  return issues;
}

function stagedProofIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  const files = indexFiles(root, DF).map((f) => `${DF}/${f}`);
  const bytes = (path: string) => {
    if (!files.includes(path)) return null;
    try { return execFileSync('git', ['show', `:${path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return null; }
  };
  for (const file of files.filter((f) => /^\.devflow\/changes\/(?:archive\/)?[^/]+\/events\.jsonl$/.test(f))) {
    try {
      for (const event of parseEvents(bytes(file)!.toString('utf8'), file)) {
        if (event.type === 'approved' && event.snapshot_hash && event.approval_id) {
          const snapshot = files.find((f) => f.startsWith(`${DF}/reviews/`) && f.endsWith(`/${event.approval_id}/snapshot.json`));
          const data = snapshot ? bytes(snapshot) : null;
          if (!data || sha256(data) !== event.snapshot_hash) issues.push({ level: 'error', file, message: '暂存区批准快照缺失或哈希不一致' });
        }
        if (event.type === 'evidence-recorded') for (const artifact of event.artifacts) {
          const data = artifact.path.startsWith(`${DF}/evidence/`) ? bytes(artifact.path) : null;
          if (!data || sha256(data) !== artifact.hash) issues.push({ level: 'error', file: artifact.path, message: '暂存区证据附件缺失或哈希不一致' });
        }
      }
    } catch (e) { issues.push({ level: 'error', file, message: e instanceof Error ? e.message : '暂存事件日志损坏' }); }
  }
  return issues;
}
