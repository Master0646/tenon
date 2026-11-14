// tenon init / tenon new：只创建缺失的文件，不覆盖已有内容
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dfOf, CHANGE_ID, DevflowError, changeDir, codeRoots, git, requireInit } from './core.ts';

const PROJECT_YAML = `schema_version: 1
# 只有这里声明的命令会被 tenon verify 执行。本文件由人维护，计入每次批准的哈希。
verify: []
#  - name: backend-test
#    run: mvn -q test
#    cwd: backend
# 代码不在本仓库时，列出代码所在的 Git 仓库（相对本仓库根）。声明后代码哈希只算这些仓库：
# 它们的改动会让验证和证据过期，本仓库里的文档改动不会。
# code_roots: ["../backend", "../frontend"]
exclude:            # 不得被知识页引用、不得出现在渲染页中
  - ".env*"
  - "**/*.pem"
  - "**/*.key"
  - "**/node_modules/**"
enforce: warn       # warn | strict：暂存了未开工变更的代码时，警告还是拒绝提交
`;

const SKELETON: Record<string, string> = {
  'project.yaml': PROJECT_YAML,
  'specs/specs.lock': '{}\n',
  'changes/archive/.gitkeep': '',
  'knowledge/index.md': '# 知识索引\n\n<!-- 每页一行：- [标题](pages/<slug>.md) — 一句话摘要 -->\n',
  'knowledge/log.md': '# 知识变更记录\n',
  'knowledge/pages/.gitkeep': '',
};

export const HOOK_MARK = '# tenon-hook';
export const OLD_HOOK_MARK = '# devflow-hook';
// 开发时运行 src/*.ts，安装后运行 dist/*.js：hook 指向与当前文件同扩展名的 cli
export const CLI = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

type HookState = 'installed' | 'updated' | 'foreign';
export interface InitResult {
  created: string[];
  hook: HookState;
  hookPath: string;
  /** code_roots 里每个仓库的钩子；missing = 目录不是 Git 仓库 */
  codeHooks: { repo: string; hook: HookState | 'missing'; hookPath: string; line: string }[];
}

export const hookFile = (repo: string): string => join(resolve(repo, git(repo, ['rev-parse', '--git-path', 'hooks']).trim()), 'pre-commit');

/** 写入带标记的 pre-commit；已有不带标记的钩子时不覆盖 */
function installHook(repo: string, line: string): { hook: HookState; hookPath: string } {
  // core.hooksPath 设置时 --git-path 会返回那个目录
  const hookPath = hookFile(repo);
  let hook: HookState = 'installed';
  if (existsSync(hookPath)) {
    // 改名前装的钩子带旧标记：同样视为自己装的，原地更新
    if (![HOOK_MARK, OLD_HOOK_MARK].some((m) => readFileSync(hookPath, 'utf8').includes(m))) return { hook: 'foreign', hookPath };
    hook = 'updated';
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, `#!/bin/sh\n${HOOK_MARK}\nexec ${line}\n`);
  chmodSync(hookPath, 0o755);
  return { hook, hookPath };
}

export function init(root: string): InitResult {
  const created: string[] = [];
  for (const [rel, content] of Object.entries(SKELETON)) {
    const f = join(root, dfOf(root), rel);
    if (existsSync(f)) continue;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
    created.push(`${dfOf(root)}/${rel}`);
  }
  mkdirSync(join(root, dfOf(root), 'runtime'), { recursive: true });

  const ignoreLine = `${dfOf(root)}/runtime/`;
  const gi = join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!giText.split('\n').some((l) => l.trim() === ignoreLine)) {
    appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}${ignoreLine}\n`);
    created.push(`.gitignore（追加 ${ignoreLine}）`);
  }

  const base = `${shq(process.execPath)} ${shq(CLI)} check --staged`;
  // 代码仓库的钩子带上本项目的绝对路径：在那边提交时回到这里读变更
  const codeHooks = (codeRoots(root) ?? []).map((rel) => {
    const repo = resolve(root, rel);
    const line = `${base} --project ${shq(root)}`;
    try { return { repo, line, ...installHook(repo, line) }; }
    catch { return { repo, line, hook: 'missing' as const, hookPath: '' }; }
  });
  return { created, ...installHook(root, base), codeHooks };
}

const CHANGE_FILES: Record<string, string> = {
  'change.yaml': `schema_version: 1
title: ""            # 一句话说明本变更
affected_paths: []   # 会改动的路径（glob），例如 backend/src/main/java/example/auth/**
summary: []          # 方案要点：最多 7 条，每条一句，显示在审查页首屏
decisions: []        # 需要人拍板的事项；没有就留空
# - question: 普通用户访问时返回 403 还是空列表？
#   options: [返回 403, 返回空列表]
#   recommend: 返回 403
`,
  'proposal.md': '# 提案\n\n## 为什么\n\n## 改什么\n\n## 影响\n',
  'design.md': '# 设计\n\n<!-- 图用 flow / sequence / tree 代码块直接写在这里 -->\n',
  'tasks.yaml': `schema_version: 1
tasks: []
# - id: T1
#   title: 定义角色与权限模型
#   acceptance: [UserRole 包含 ADMIN、USER]
#   depends_on: []
`,
  'specs/.gitkeep': '',
};

export function newChange(root: string, id: string | undefined, schema = 2): string[] {
  requireInit(root);
  if (!id || !CHANGE_ID.test(id) || id === 'archive') {
    throw new DevflowError(`变更 ID 无效：${id ?? '（缺失）'}`, '用小写字母、数字和连字符，例如 tenon new 2026-11-06-role-access');
  }
  if (![1, 2].includes(schema)) throw new DevflowError('schema 必须为 1 或 2');
  const dir = changeDir(root, id);
  if (existsSync(dir)) throw new DevflowError(`变更已存在：${id}`);
  for (const [rel, content] of Object.entries(CHANGE_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), schema === 2 && ['change.yaml', 'tasks.yaml'].includes(rel) ? content.replace('schema_version: 1', `schema_version: 2${rel === 'change.yaml' ? '\nmin_cli_version: 0.2.0' : ''}`) : content);
  }
  return Object.keys(CHANGE_FILES).map((f) => `${dfOf(root)}/changes/${id}/${f}`);
}
