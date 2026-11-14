// tenon archive：合并 delta 到当前规范、更新 specs.lock、移动变更到 changes/archive/
// 事务：先把全部输出写到 runtime/tx/<id>/ 并写 tx.json（提交点），再逐步执行；每一步可重复执行，中断后重跑即前滚
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  dfOf, DevflowError, worktreeHash, hashFiles, reviewedFiles, appendEvent, archiveTarget, changeDir, currentSpecHash, git, readEvents, requireChange, requireInit, sha256, specCaps,
} from './core.ts';
import { mergeSpec, parseDelta } from './spec.ts';
import { evidenceIssues } from './evidence.ts';
import { deriveStatus } from './status.ts';
import { lintWiki } from './wiki.ts';

interface Tx {
  id: string;
  actor: string;
  guard?: { worktree_hash: string; approval_hash: string };
  writes: { from: string; to: string }[]; // 相对仓库根
  move: { from: string; to: string };
}

const txDir = (root: string, id: string) => join(root, dfOf(root), 'runtime', 'tx', id);
const txFile = (root: string, id: string) => join(txDir(root, id), 'tx.json');

export { archiveTarget };

export function pendingTx(root: string, id: string): boolean {
  return existsSync(txFile(root, id));
}

/** 计算全部输出并写入事务目录；任何检查不通过都不写任何东西 */
export function stageArchive(root: string, id: string): Tx {
  requireInit(root);
  requireChange(root, id);
  const st = deriveStatus(root, id);
  if (st.status !== 'ready_to_archive') throw new DevflowError(`当前状态为 ${st.status}，不能归档`, st.reason);

  const wikiErrors = lintWiki(root).issues.filter((i) => i.level === 'error');
  if (wikiErrors.length) {
    throw new DevflowError(`知识页有 ${wikiErrors.length} 个错误，先修正再归档`, wikiErrors.slice(0, 5).map((i) => `${i.file}: ${i.message}`).join('\n'));
  }

  const approved = readEvents(root, id).findLast((e) => e.type === 'approved');
  if (approved?.type !== 'approved') throw new DevflowError('找不到批准记录');

  const lockPath = join(root, dfOf(root), 'specs', 'specs.lock');
  const lock: Record<string, string> = JSON.parse(readFileSync(lockPath, 'utf8'));
  const outputs: { to: string; content: string }[] = [];
  for (const cap of specCaps(root, id)) {
    // 批准之后同一能力的规范被别的变更改过：拒绝，避免后归档者覆盖先归档者
    const now = currentSpecHash(root, cap);
    if ((approved.spec_base[cap] ?? null) !== now) {
      throw new DevflowError(`规范 ${cap} 在本变更批准后被修改过（可能有其他变更先归档了）`, `更新本变更的 delta 并重新批准：tenon approve ${id}`);
    }
    const curFile = join(root, dfOf(root), 'specs', cap, 'spec.md');
    const { delta, errors } = parseDelta(readFileSync(join(changeDir(root, id), 'specs', cap, 'spec.md'), 'utf8'));
    if (errors.length) throw new DevflowError(`delta 规范 ${cap} 有错误`, errors.map((e) => `${e.line}: ${e.message}`).join('\n'));
    const merged = mergeSpec(cap, existsSync(curFile) ? readFileSync(curFile, 'utf8') : null, delta);
    if (!merged.text) throw new DevflowError(`合并规范 ${cap} 失败`, merged.errors.join('\n'));
    outputs.push({ to: `${dfOf(root)}/specs/${cap}/spec.md`, content: merged.text });
    lock[`${cap}/spec.md`] = sha256(merged.text);
  }
  outputs.push({ to: `${dfOf(root)}/specs/specs.lock`, content: JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 2) + '\n' });

  const target = archiveTarget(root, id);
  if (existsSync(join(root, target))) throw new DevflowError(`归档目录已存在：${target}`);

  let actor = '';
  try {
    actor = git(root, ['config', 'user.name']).trim();
  } catch { /* 未配置 */ }
  if (!actor) throw new DevflowError('未配置 git user.name，无法记录归档人', 'git config user.name "<你的名字>"');

  const dir = txDir(root, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tx: Tx = { id, actor, guard: { worktree_hash: worktreeHash(root), approval_hash: hashFiles(root, reviewedFiles(root, id)) }, writes: [], move: { from: `${dfOf(root)}/changes/${id}`, to: target } };
  outputs.forEach((o, i) => {
    const staged = `${dfOf(root)}/runtime/tx/${id}/${i}`;
    writeFileSync(join(root, staged), o.content);
    tx.writes.push({ from: staged, to: o.to });
  });
  writeFileSync(txFile(root, id), JSON.stringify(tx, null, 2)); // 提交点：此后只能前滚
  return tx;
}

/** 人在确认时取消：提交点之前，直接丢弃事务目录 */
export function discardArchive(root: string, id: string): void {
  rmSync(txDir(root, id), { recursive: true, force: true });
}

/** 按事务日志执行（或继续执行）剩余步骤 */
export function commitArchive(root: string, id: string): { target: string; specs: string[] } {
  const tx: Tx = JSON.parse(readFileSync(txFile(root, id), 'utf8'));
  if (existsSync(join(root, tx.move.from)) && tx.guard) {
    if (worktreeHash(root) !== tx.guard.worktree_hash || hashFiles(root, reviewedFiles(root, id)) !== tx.guard.approval_hash || evidenceIssues(root, id).length) {
      throw new DevflowError('归档确认或恢复期间代码、批准内容或证据变化，已停止', '恢复对应代码与证据后重跑；已部分写入的事务不能直接删除');
    }
  }
  for (const w of tx.writes) {
    if (!existsSync(join(root, w.from))) continue; // 已完成
    mkdirSync(dirname(join(root, w.to)), { recursive: true });
    renameSync(join(root, w.from), join(root, w.to)); // 同一文件系统内原子替换
  }
  // 先写归档事件再移动目录：目录已移动说明事件已写入
  if (existsSync(join(root, tx.move.from)) && !readEvents(root, id).some((e) => e.type === 'archived')) {
    appendEvent(root, id, { type: 'archived', at: new Date().toISOString(), actor: tx.actor });
  }
  if (existsSync(join(root, tx.move.from))) {
    mkdirSync(dirname(join(root, tx.move.to)), { recursive: true });
    renameSync(join(root, tx.move.from), join(root, tx.move.to));
  }
  rmSync(txDir(root, id), { recursive: true, force: true });
  return { target: tx.move.to, specs: tx.writes.map((w) => w.to).filter((t) => t.endsWith('spec.md')) };
}

export function archive(root: string, id: string): { target: string; specs: string[] } {
  if (!pendingTx(root, id)) stageArchive(root, id);
  return commitArchive(root, id);
}
