// 内核公共部分：git、文件哈希、变更目录、事件日志
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  openSync, closeSync, writeFileSync, appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
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

/**
 * 仓库内某目录下 git 会跟踪的文件：已跟踪的，加上未被 .gitignore 等规则忽略的新文件。
 * 返回相对 relDir 的路径（/ 分隔、已排序），格式同 listFiles；已从磁盘删除的文件不返回。
 */
export function repoFiles(root: string, relDir: string): string[] {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relDir]);
  const prefix = `${relDir.replace(/\/$/, '')}/`;
  return [...new Set(out.split('\0').filter((f) => f.startsWith(prefix) && existsSync(join(root, f))))]
    .map((f) => f.slice(prefix.length))
    .sort();
}

export const sha256 =(data: string | Buffer): string =>
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
    ...repoFiles(root, changeRel(id)).filter((f) => f !== 'events.jsonl' && !(changeSchema(root, id) === 2 && f === 'execution.md')).map((f) => `${changeRel(id)}/${f}`),
    `${DF}/project.yaml`,
  ];
}

/** 变更要修改的能力：specs/<cap>/spec.md */
export function specCaps(root: string, id: string): string[] {
  return repoFiles(root, `${changeRel(id)}/specs`)
    .filter((f) => /^[^/]+\/spec\.md$/.test(f))
    .map((f) => f.split('/')[0]);
}

export function currentSpecHash(root: string, cap: string): string | null {
  const f = join(root, DF, 'specs', cap, 'spec.md');
  return existsSync(f) ? sha256(readFileSync(f)) : null;
}

// ---------- 事件日志 ----------

export interface EvidenceRecord {
  type: 'evidence-recorded'; at: string; evidence_id: string; approval_id: string; worktree_hash: string;
  task: string; acceptance: string; kind: 'automated' | 'manual'; summary: string;
  artifacts: { path: string; hash: string }[]; verify_run?: string; check?: string; test?: string; assertion?: string;
  procedure?: string; expected?: string; observed?: string;
  /** 日志里的一行原文；quote_checked 表示记录时已在该次验证的日志中核对到它 */
  log_quote?: string; quote_checked?: boolean;
  /** 记录时验收条件的指纹；重新批准后指纹没变，这条证据继续有效 */
  condition_hash?: string;
}

export type DevflowEvent =
  | { type: 'approved'; at: string; actor: string; hash: string; base_commit: string; spec_base: Record<string, string | null>; approval_id?: string; snapshot_hash?: string; base_commits?: Record<string, string>; decisions?: { question: string; answer: string }[] }
  | { type: 'apply-started'; at: string; head: string; approval_id?: string }
  | { type: 'task-done'; at: string; task: string; approval_id?: string; worktree_hash?: string }
  | { type: 'verified'; at: string; diff_hash: string; result: 'pass' | 'fail' | 'unknown'; checks: { name: string; exit: number | null; log_hash?: string }[]; run_id?: string; approval_id?: string }
  | EvidenceRecord
  | { type: 'evidence-confirmed'; at: string; evidence_id: string; approval_id: string; worktree_hash: string; actor: string }
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
    case 'evidence-recorded':
      return [ev.evidence_id, ev.approval_id, ev.worktree_hash, ev.task, ev.acceptance].every(isStr) && ['automated', 'manual'].includes(ev.kind) && isStr(ev.summary) && Array.isArray(ev.artifacts) && ev.artifacts.every((a: any) => a && isStr(a.path) && isStr(a.hash)) ? null : 'evidence-recorded 字段不完整';
    case 'evidence-confirmed':
      return [ev.evidence_id, ev.approval_id, ev.worktree_hash, ev.actor].every(isStr) ? null : 'evidence-confirmed 字段不完整';
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

/** project.yaml 的 code_roots：代码所在的 Git 仓库（相对本仓库根，可以是兄弟目录）。未声明时为 null */
export function codeRoots(root: string): string[] | null {
  let p: any;
  try { p = parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8')); } catch { return null; }
  const list = p?.code_roots;
  return Array.isArray(list) && list.length && list.every((r: unknown) => typeof r === 'string' && r.trim()) ? list : null;
}

/** path 属于哪个 code_root（最长前缀）；不属于任何一个时为 null。rest 是去掉前缀后的仓库内路径 */
export function rootOf(root: string, path: string): { rel: string; rest: string } | null {
  const hit = (codeRoots(root) ?? []).map((r) => r.replace(/\/+$/, '')).filter((r) => path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  return hit ? { rel: hit, rest: path.slice(hit.length + 1) } : null;
}

/** 把影响路径按仓库分组：本仓库的键是 '.'，代码仓库的键是它在 code_roots 里的写法，值是仓库内的 glob */
export function splitPaths(root: string, globs: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of globs) {
    const hit = rootOf(root, g);
    const key = hit?.rel ?? '.';
    out.set(key, [...(out.get(key) ?? []), hit?.rest ?? g]);
  }
  return out;
}

/** project.yaml 的 stale_hours：已批准或已开工的变更多久没有新记录算停滞。默认 24 */
export function staleLimit(root: string): number {
  try {
    const n = parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8'))?.stale_hours;
    return typeof n === 'number' && n > 0 ? n : 24;
  } catch { return 24; }
}

/**
 * 代码内容哈希。未声明 code_roots 时是本仓库的工作树哈希；
 * 声明后只算列出的仓库：代码在兄弟仓库时改动能被发现，本仓库里的文档改动也不再让验证失效。
 */
export function worktreeHash(root: string): string {
  const roots = codeRoots(root);
  if (!roots) return 'git-tree:' + treeHash(root);
  const h = createHash('sha256');
  for (const rel of [...roots].sort()) {
    let tree: string;
    try { tree = treeHash(resolve(root, rel)); }
    catch { throw new DevflowError(`code_roots 中的 ${rel} 不是可用的 Git 仓库`, `检查 ${DF}/project.yaml；路径相对本仓库根目录`); }
    h.update(rel + '\0' + tree + '\0');
  }
  return 'git-trees:' + h.digest('hex');
}

/**
 * 一个仓库的工作树内容哈希（排除 .devflow/，遵守 .gitignore）。
 * 用临时索引 + write-tree 得到 git 树哈希：不受文件是否暂存、是否已提交影响。
 */
function treeHash(root: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-idx-'));
  const index = join(tmp, 'index');
  const real = resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  if (existsSync(real)) copyFileSync(real, index); // 复用 stat 缓存，避免大仓库全量重算
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(root, ['add', '-A', '--', '.'], env);
    git(root, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', DF], env);
    return git(root, ['write-tree'], env).trim();
  } finally {
    rmSync(dirname(index), { recursive: true, force: true });
  }
}

export function changeSchema(root: string, id: string): number {
  try { return parse(readFileSync(join(changeDir(root, id), 'change.yaml'), 'utf8'))?.schema_version ?? 1; }
  catch { return 1; }
}

/**
 * 已标记完成的任务。v2 认当前代码哈希下的记录，重新批准后沿用（验收证据是否仍有效由调用方另查）；
 * v1 只认本轮批准内的记录。
 */
export function doneTasks(root: string, id: string, hash?: string): Set<string> {
  if (changeSchema(root, id) === 2) {
    const current = hash ?? worktreeHash(root);
    return new Set(readEvents(root, id).flatMap((e) => (e.type === 'task-done' && e.worktree_hash === current ? [e.task] : [])));
  }
  const cycle = approvalCycle(root, id);
  return new Set(cycle.events.flatMap((e) => (e.type === 'task-done' && (!e.approval_id || e.approval_id === cycle.approval_id) ? [e.task] : [])));
}

export function approvalCycle(root: string, id: string) {
  const all = readEvents(root, id);
  const index = all.findLastIndex((e) => e.type === 'approved');
  const approved = index >= 0 ? all[index] as Extract<DevflowEvent, {type: 'approved'}> : undefined;
  return { approved, approval_id: approved?.approval_id ?? `legacy:${index}`, events: index < 0 ? [] : all.slice(index + 1) };
}

export function withWorktreeLock<T>(root: string, action: () => T): T {
  const path = resolve(root, git(root, ['rev-parse', '--git-path', 'devflow.lock']).trim());
  let fd: number;
  try { fd = openSync(path, 'wx'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new DevflowError('无法创建工作树锁，请检查 Git 目录写权限', path);
    throw new DevflowError('当前工作树有状态改变命令持锁', `检查 ${path} 的进程信息；仅在确认进程已退出后删除锁文件`);
  }
  const release = () => { closeSync(fd); rmSync(path, { force: true }); };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const result = action();
    if (result instanceof Promise) return result.finally(release) as T;
    release();
    return result;
  } catch (e) { release(); throw e; }
}
