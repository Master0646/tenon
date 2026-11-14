// 测试用临时 Git 仓库
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvent, type DevflowEvent } from '../src/core.ts';
import { init } from '../src/init.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

export const append = (dir: string, rel: string, content: string): void => appendFileSync(join(dir, rel), content);

/** 已 init、已提交一次的仓库，含 backend/ 与 docs/ 两处代码 */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-test-')));
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.name', 'tester');
  g(dir, 'config', 'user.email', 'tester@example.invalid');
  g(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'backend/src/Auth.java', 'class Auth {}\n');
  write(dir, 'docs/readme.md', 'hello\n');
  init(dir);
  commit(dir, 'init', true);
  return dir;
}

/** noVerify：跳过 hook，用于准备测试数据 */
export function commit(dir: string, msg: string, noVerify = false): void {
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', msg, ...(noVerify ? ['--no-verify'] : []));
}

export const DELTA_ADD = `## ADDED Requirements

### Requirement: 用户列表需要 ADMIN
系统 SHALL 拒绝非 ADMIN 用户访问用户列表。

#### Scenario: 普通用户访问
- WHEN USER 角色请求 /api/users
- THEN 返回 403
`;

/** 写一个能通过 validate 的完整变更 */
export function writeChange(dir: string, id: string): void {
  const base = `.tenon/changes/${id}`;
  write(dir, `${base}/change.yaml`, 'schema_version: 1\ntitle: 新增角色权限\naffected_paths:\n  - backend/**\nsummary:\n  - 用户列表按角色控制访问\n');
  write(dir, `${base}/proposal.md`, '# 提案\n\n用户列表需要按角色控制访问。\n');
  write(dir, `${base}/tasks.yaml`, 'schema_version: 1\ntasks:\n  - id: T1\n    title: 定义角色\n  - id: T2\n    title: 接口加判断\n    depends_on: [T1]\n');
  write(dir, `${base}/specs/auth/spec.md`, DELTA_ADD);
}

export const at = (): string => new Date().toISOString();
export const addEvent = (dir: string, id: string, ev: DevflowEvent): void => appendEvent(dir, id, ev);

/** 模拟人的终端：去掉 Agent 的 shell 里才有的环境变量（测试本身可能就在 Agent 里跑） */
export const HUMAN_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'].includes(k)));

/** 以非 TTY 方式运行 CLI（stdin 为管道，模拟 Agent 的 shell 工具） */
export function cli(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: '' });
}
