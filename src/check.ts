// devflow check：pre-commit hook 与 CI 的门禁
// shortcut: 检查的是工作树内容而非暂存区内容；部分暂存（git add -p）时可能放过或误拦，需要时改为读 git show :<path>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DF, DevflowError, changeDir, changeRel, git, listChanges, listFiles, readEvents, requireInit, sha256, type Issue,
} from './core.ts';
import { deriveStatus } from './status.ts';
import { enforceLevel, loadChangeMeta, validateChange, validateProject } from './validate.ts';

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
    issues.push(...appendOnly(root, rel));
  }

  issues.push(...checkSpecLock(root));
  if (opts.staged) issues.push(...checkStagedCode(root));
  return issues;
}

/** 事件日志只能追加：与 HEAD 中的版本相比，旧内容必须原样保留在开头 */
function appendOnly(root: string, rel: string): Issue[] {
  let old = '';
  try {
    old = git(root, ['show', `HEAD:${rel}`]);
  } catch {
    return []; // HEAD 中还没有这个文件
  }
  const abs = join(root, rel);
  const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  return cur.startsWith(old) ? [] : [{
    level: 'error', file: rel, message: '事件日志的已提交内容被修改或删除（只允许追加）',
    hint: `用 git restore ${rel} 恢复；事件只能由 devflow 命令写入`,
  }];
}

/** 当前规范只能经 archive 修改：内容必须与 specs.lock 一致 */
function checkSpecLock(root: string): Issue[] {
  const dir = join(root, DF, 'specs');
  const lockRel = `${DF}/specs/specs.lock`;
  let lock: Record<string, string>;
  try {
    lock = JSON.parse(readFileSync(join(dir, 'specs.lock'), 'utf8'));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error();
  } catch {
    return [{ level: 'error', file: lockRel, message: 'specs.lock 缺失或不是合法的 JSON 对象', hint: `用 git restore ${lockRel} 恢复` }];
  }
  const hint = '规范只能经 devflow archive 修改。撤销手改：git restore <文件>（新加的文件直接删除）；要改规范，请新建变更并归档';
  const issues: Issue[] = [];
  const files = listFiles(dir).filter((f) => f !== 'specs.lock' && f !== '.gitkeep');
  for (const f of files) {
    if (lock[f] !== sha256(readFileSync(join(dir, f)))) {
      issues.push({ level: 'error', file: `${DF}/specs/${f}`, message: lock[f] ? '内容与 specs.lock 不符（被手动修改）' : '不在 specs.lock 中（被手动添加）', hint });
    }
  }
  for (const f of Object.keys(lock)) {
    if (!files.includes(f)) issues.push({ level: 'error', file: `${DF}/specs/${f}`, message: 'specs.lock 中有记录，但文件被删除', hint });
  }
  return issues;
}

/** 暂存了某变更影响路径内的代码，但该变更还没开工 */
function checkStagedCode(root: string): Issue[] {
  const level = enforceLevel(root) === 'strict' ? 'error' : 'warn';
  const issues: Issue[] = [];
  for (const id of listChanges(root)) {
    const meta = loadChangeMeta(root, id);
    if (!meta?.affected_paths.length || !existsSync(changeDir(root, id))) continue;
    const staged = git(root, ['diff', '--cached', '--name-only', '--', ...meta.affected_paths.map((g) => `:(glob)${g}`)])
      .split('\n').filter(Boolean);
    if (!staged.length) continue;
    let st;
    try {
      st = deriveStatus(root, id);
    } catch {
      continue; // 事件日志损坏，已在上面报告
    }
    if (STARTED.has(st.status)) continue;
    issues.push({
      level, file: staged.slice(0, 5).join(', ') + (staged.length > 5 ? ' …' : ''),
      message: `这些文件属于变更 ${id} 的影响路径，但该变更状态为 ${st.status}（${st.reason}）`,
      hint: `先批准（devflow approve ${id}）并开工，再提交这些文件`,
    });
  }
  return issues;
}
