// 内核公共部分：git、文件哈希、变更目录、事件日志
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const DF = '.devflow';

export class DevflowError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export interface Issue {
  level: 'error' | 'warn';
  file: string;
  message: string;
  hint?: string;
}

export function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

export function repoRoot(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new DevflowError('当前目录不在 Git 仓库中', '在项目根目录运行 git init 后再试');
  }
}

export function headCommit(root: string): string {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    throw new DevflowError('仓库还没有任何提交', '先提交一次代码，再批准变更');
  }
}

export function requireInit(root: string): void {
  if (!existsSync(join(root, DF, 'project.yaml'))) {
    throw new DevflowError('项目尚未初始化 DevFlow', '运行 devflow init');
  }
}

/** 目录下全部文件的相对路径（/ 分隔、已排序）；目录不存在时为空 */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort();
}

export const sha256 = (data: string | Buffer): string =>
  'sha256:' + createHash('sha256').update(data).digest('hex');

/** 多个文件（相对 root）合成一个哈希；路径参与哈希，改名也会使哈希变化 */
export function hashFiles(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) h.update(f + '\0').update(readFileSync(join(root, f))).update('\0');
  return 'sha256:' + h.digest('hex');
}

// ---------- 变更目录 ----------

export const CHANGE_ID = /^[a-z0-9][a-z0-9-]*$/;

export const changeRel = (id: string): string => `${DF}/changes/${id}`;
export const changeDir = (root: string, id: string): string => join(root, changeRel(id));

export function requireChange(root: string, id: string | undefined): string {
  if (!id) throw new DevflowError('缺少变更 ID', '用法：devflow <命令> <change-id>');
  if (!CHANGE_ID.test(id) || !existsSync(changeDir(root, id))) {
    throw new DevflowError(`变更不存在：${id}`, '运行 devflow status 查看现有变更');
  }
  return id;
}

/** 变更归档后的目录（相对仓库根）：id 已以日期开头时不再加日期 */
export const archiveTarget = (id: string, date = new Date()): string =>
  `${DF}/changes/archive/${/^\d{4}-\d{2}-\d{2}-/.test(id) ? id : `${date.toISOString().slice(0, 10)}-${id}`}`;

/** 进行中的变更（不含 archive） */
export function listChanges(root: string): string[] {
  const dir = join(root, DF, 'changes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'archive')
    .map((d) => d.name)
    .sort();
}

/** 被审文件：变更目录下除事件日志外的全部文件，加上 project.yaml（防止批准后改弱验证命令） */
export function reviewedFiles(root: string, id: string): string[] {
  return [
    ...listFiles(changeDir(root, id)).filter((f) => f !== 'events.jsonl').map((f) => `${changeRel(id)}/${f}`),
    `${DF}/project.yaml`,
  ];
}

/** 变更要修改的能力：specs/<cap>/spec.md */
export function specCaps(root: string, id: string): string[] {
  return listFiles(join(changeDir(root, id), 'specs'))
    .filter((f) => /^[^/]+\/spec\.md$/.test(f))
    .map((f) => f.split('/')[0]);
}

export function currentSpecHash(root: string, cap: string): string | null {
  const f = join(root, DF, 'specs', cap, 'spec.md');
  return existsSync(f) ? sha256(readFileSync(f)) : null;
}

// ---------- 事件日志 ----------

export type DevflowEvent =
  | { type: 'approved'; at: string; actor: string; hash: string; base_commit: string; spec_base: Record<string, string | null> }
  | { type: 'apply-started'; at: string; head: string }
  | { type: 'task-done'; at: string; task: string }
  | { type: 'verified'; at: string; diff_hash: string; result: 'pass' | 'fail' | 'unknown'; checks: { name: string; exit: number | null }[] }
  | { type: 'archived'; at: string; actor: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function eventError(ev: any): string | null {
  if (!ev || typeof ev !== 'object' || !isStr(ev.at)) return '缺少 type 或 at 字段';
  switch (ev.type) {
    case 'approved':
      return isStr(ev.actor) && isStr(ev.hash) && isStr(ev.base_commit) && ev.spec_base && typeof ev.spec_base === 'object'
        ? null : 'approved 事件字段不完整';
    case 'apply-started':
      return isStr(ev.head) ? null : 'apply-started 事件缺少 head';
    case 'task-done':
      return isStr(ev.task) ? null : 'task-done 事件缺少 task';
    case 'verified':
      return isStr(ev.diff_hash) && ['pass', 'fail', 'unknown'].includes(ev.result) && Array.isArray(ev.checks)
        ? null : 'verified 事件字段不完整';
    case 'archived':
      return isStr(ev.actor) ? null : 'archived 事件缺少 actor';
    default:
      return `未知事件类型：${String(ev.type)}`;
  }
}

const EVENT_HINT = '事件日志只能由 devflow 命令追加，不要手改；用 git restore 恢复该文件';

export function parseEvents(text: string, label: string): DevflowEvent[] {
  const out: DevflowEvent[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new DevflowError(`${label}:${i + 1} 不是合法的 JSON`, EVENT_HINT);
    }
    const err = eventError(ev);
    if (err) throw new DevflowError(`${label}:${i + 1} ${err}`, EVENT_HINT);
    out.push(ev as DevflowEvent);
  });
  return out;
}

const eventsFile = (root: string, id: string): string => join(changeDir(root, id), 'events.jsonl');

export function readEvents(root: string, id: string): DevflowEvent[] {
  const f = eventsFile(root, id);
  return existsSync(f) ? parseEvents(readFileSync(f, 'utf8'), `${changeRel(id)}/events.jsonl`) : [];
}

export function appendEvent(root: string, id: string, ev: DevflowEvent): void {
  const err = eventError(ev);
  if (err) throw new DevflowError(`内部错误：${err}`);
  appendFileSync(eventsFile(root, id), JSON.stringify(ev) + '\n');
}

// ---------- git 状态 ----------

/** base..HEAD 之间改动过、且落在 globs 内的文件 */
export function changedPaths(root: string, base: string, globs: string[]): string[] {
  if (!globs.length) return [];
  return git(root, ['diff', '--name-only', base, 'HEAD', '--', ...globs.map((g) => `:(glob)${g}`)])
    .split('\n').filter(Boolean);
}

/**
 * 工作树内容哈希（排除 .devflow/，遵守 .gitignore）。
 * 用临时索引 + write-tree 得到 git 树哈希：不受文件是否暂存、是否已提交影响。
 */
export function worktreeHash(root: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-idx-'));
  const index = join(tmp, 'index');
  const real = resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  if (existsSync(real)) copyFileSync(real, index); // 复用 stat 缓存，避免大仓库全量重算
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(root, ['add', '-A', '--', '.'], env);
    git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', DF], env);
    return 'git-tree:' + git(root, ['write-tree'], env).trim();
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}
